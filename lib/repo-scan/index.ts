import type { GitHubRepoRef } from "@/lib/github-repo";
import { CloneError, shallowClone } from "./clone";
import { collectFiles, type CollectedFile } from "./collect";
import {
  DEEP_CONCURRENCY,
  MAX_DEEP_FILES,
  MAX_TRIAGE_FILES,
  newScanBudget,
  SCAN_TIMEOUT_MS,
  TRIAGE_CONCURRENCY,
} from "./config";
import { deepScanFile, type DeepFinding } from "./deep-scan";
import { mapWithConcurrency } from "./pool";
import { RepoHostError } from "./ssrf";
import { intoBatches, triageBatch, type TriageVerdict } from "./triage";

export { CloneError } from "./clone";
export { RepoHostError } from "./ssrf";

export type ScanProgress =
  | { type: "status"; message: string }
  | { type: "collected"; filesScanned: number; skipped: number; totalBytes: number }
  | { type: "triaged"; done: number; total: number; flagged: number }
  | { type: "deep"; done: number; total: number; relPath: string }
  | { type: "report"; report: ScanReport }
  | { type: "error"; message: string };

export type ScanReport = {
  repo: string;
  ref: string | null;
  url: string;
  filesScanned: string[];
  filesFlagged: { relPath: string; reason: string; inconclusive: boolean }[];
  findings: { relPath: string; report: string }[];
  cleanFiles: string[];
  failures: { relPath: string; error: string }[];
  limits: {
    truncated: boolean;
    droppedByCap: number;
    triageSkipped: number;
    deepSkipped: number;
    excluded: Record<string, number>;
    totalBytes: number;
  };
  durationMs: number;
  markdown: string;
};

/**
 * Runs the full pipeline: clone → filter/prioritize → Tier 1 triage →
 * Tier 2 deep review → combined report. Yields progress so the caller can
 * stream it; the final `report` event carries everything.
 *
 * The clone directory is always removed, on success, failure, or abort.
 */
export async function* scanRepository(
  repo: GitHubRepoRef,
  outerSignal?: AbortSignal,
): AsyncGenerator<ScanProgress> {
  const startedAt = Date.now();

  // Our own deadline, under the route's maxDuration, so we stop cleanly with
  // a report rather than being killed mid-flight.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  outerSignal?.addEventListener("abort", onOuterAbort, { once: true });
  const signal = controller.signal;

  let clone: Awaited<ReturnType<typeof shallowClone>> | null = null;
  const budget = newScanBudget();

  try {
    yield { type: "status", message: `Cloning ${repo.slug}…` };

    try {
      clone = await shallowClone(repo, signal);
    } catch (err) {
      if (err instanceof CloneError || err instanceof RepoHostError) {
        yield { type: "error", message: err.message };
        return;
      }
      throw err;
    }

    yield { type: "status", message: "Filtering and ranking files…" };
    const collected = await collectFiles(clone.dir);

    if (collected.files.length === 0) {
      yield {
        type: "error",
        message:
          "No reviewable source files were found in that repository — everything was excluded as binary, generated, vendored, or oversized.",
      };
      return;
    }

    const skipped = Object.values(collected.excluded).reduce((a, b) => a + b, 0);
    yield {
      type: "collected",
      filesScanned: collected.files.length,
      skipped,
      totalBytes: collected.totalBytes,
    };

    // ── Tier 1 ──────────────────────────────────────────────────────────
    // Files are already sorted riskiest-first, and path-priority files are
    // exempt from the cap, so trimming here only ever drops the low-risk
    // tail.
    const { triaged, deferred } = splitForTriage(collected.files);

    yield {
      type: "status",
      message: `Triaging ${triaged.length} file${triaged.length === 1 ? "" : "s"} with the fast model…`,
    };

    const batches = intoBatches(triaged);
    const batchResults = await mapWithConcurrency(batches, TRIAGE_CONCURRENCY, (batch) =>
      triageBatch(batch, budget, signal),
    );

    const allVerdicts: TriageVerdict[] = batchResults.flat();
    const flagged = allVerdicts.filter((v) => v.flagged);

    yield {
      type: "triaged",
      done: triaged.length,
      total: triaged.length,
      flagged: flagged.length,
    };

    // ── Tier 2 ──────────────────────────────────────────────────────────
    const byPath = new Map(collected.files.map((f) => [f.relPath, f]));
    const flaggedFiles = flagged
      .map((v) => byPath.get(v.relPath))
      .filter((f): f is CollectedFile => Boolean(f));

    // Highest-risk flagged files get the deep-review budget first.
    flaggedFiles.sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath));
    const toDeepScan = flaggedFiles.slice(0, MAX_DEEP_FILES);
    const deepSkipped = flaggedFiles.length - toDeepScan.length;

    if (toDeepScan.length > 0) {
      yield {
        type: "status",
        message: `Deep-reviewing ${toDeepScan.length} flagged file${
          toDeepScan.length === 1 ? "" : "s"
        }…`,
      };
    }

    let deepDone = 0;
    const deepResults: DeepFinding[] = [];
    await mapWithConcurrency(
      toDeepScan,
      DEEP_CONCURRENCY,
      (file) => deepScanFile(file, budget, signal),
      (result) => {
        deepDone++;
        deepResults.push(result);
      },
    );

    // Progress for the deep stage is emitted as one event after the pool
    // drains: yielding from inside the pool's callback isn't possible in an
    // async generator, and the stage is short enough not to need per-file
    // updates.
    yield {
      type: "deep",
      done: deepDone,
      total: toDeepScan.length,
      relPath: deepResults[deepResults.length - 1]?.relPath ?? "",
    };

    const report = buildReport({
      repo,
      startedAt,
      collected,
      triagedCount: triaged.length,
      triageSkipped: deferred.length,
      verdicts: allVerdicts,
      deepResults,
      deepSkipped,
    });

    yield { type: "report", report };
  } catch (err) {
    if (signal.aborted) {
      yield {
        type: "error",
        message: `The scan hit its ${Math.round(
          SCAN_TIMEOUT_MS / 1000,
        )}s limit and stopped. Try a smaller repository, or a specific branch.`,
      };
      return;
    }
    console.error("[repo-scan] unexpected failure:", err);
    yield {
      type: "error",
      message: "The scan failed unexpectedly. Nothing was left running on the server.",
    };
  } finally {
    clearTimeout(deadline);
    outerSignal?.removeEventListener("abort", onOuterAbort);
    // Always: success, error, timeout, or client disconnect.
    if (clone) await clone.cleanup();
  }
}

function splitForTriage(files: CollectedFile[]) {
  if (files.length <= MAX_TRIAGE_FILES) return { triaged: files, deferred: [] };

  const priority = files.filter((f) => f.pathPriority);
  const rest = files.filter((f) => !f.pathPriority);

  // Path-priority files are never deferred, even if they alone exceed the cap.
  const room = Math.max(0, MAX_TRIAGE_FILES - priority.length);
  return { triaged: [...priority, ...rest.slice(0, room)], deferred: rest.slice(room) };
}

function buildReport({
  repo,
  startedAt,
  collected,
  triagedCount,
  triageSkipped,
  verdicts,
  deepResults,
  deepSkipped,
}: {
  repo: GitHubRepoRef;
  startedAt: number;
  collected: Awaited<ReturnType<typeof collectFiles>>;
  triagedCount: number;
  triageSkipped: number;
  verdicts: TriageVerdict[];
  deepResults: DeepFinding[];
  deepSkipped: number;
}): ScanReport {
  const findings = deepResults
    .filter((r) => r.report)
    .map((r) => ({ relPath: r.relPath, report: r.report as string }));
  const cleanFiles = deepResults.filter((r) => !r.report && !r.error).map((r) => r.relPath);
  const failures = deepResults
    .filter((r) => r.error)
    .map((r) => ({ relPath: r.relPath, error: r.error as string }));

  const report: ScanReport = {
    repo: repo.slug,
    ref: repo.ref,
    url: repo.canonicalUrl,
    filesScanned: verdicts.map((v) => v.relPath),
    filesFlagged: verdicts
      .filter((v) => v.flagged)
      .map((v) => ({ relPath: v.relPath, reason: v.reason, inconclusive: v.inconclusive })),
    findings,
    cleanFiles,
    failures,
    limits: {
      truncated: collected.truncated,
      droppedByCap: collected.droppedByCap,
      triageSkipped,
      deepSkipped,
      excluded: collected.excluded,
      totalBytes: collected.totalBytes,
    },
    durationMs: Date.now() - startedAt,
    markdown: "",
  };

  report.markdown = renderMarkdown(report, triagedCount);
  return report;
}

function renderMarkdown(report: ScanReport, triagedCount: number): string {
  const lines: string[] = [];

  lines.push(`## Security scan — ${report.repo}${report.ref ? ` (${report.ref})` : ""}`);
  lines.push("");
  lines.push(
    `Scanned **${triagedCount}** file${triagedCount === 1 ? "" : "s"}, flagged **${
      report.filesFlagged.length
    }** for deep review, and found **${report.findings.length}** file${
      report.findings.length === 1 ? "" : "s"
    } with reportable issues in ${(report.durationMs / 1000).toFixed(1)}s.`,
  );
  lines.push("");

  if (report.findings.length > 0) {
    lines.push("### Findings");
    lines.push("");
    for (const finding of report.findings) {
      lines.push(finding.report.trim());
      lines.push("");
    }
  } else {
    lines.push("### Findings");
    lines.push("");
    lines.push(
      "No issues confident enough to report. That is not a clean bill of health — it means nothing in the files reviewed crossed the reporting bar.",
    );
    lines.push("");
  }

  lines.push("### Files flagged in triage");
  lines.push("");
  if (report.filesFlagged.length === 0) {
    lines.push("_None._");
  } else {
    for (const file of report.filesFlagged) {
      const deepReviewed =
        report.findings.some((f) => f.relPath === file.relPath) ||
        report.cleanFiles.includes(file.relPath) ||
        report.failures.some((f) => f.relPath === file.relPath);
      const suffix = deepReviewed ? "" : " — _not deep-reviewed (budget reached)_";
      lines.push(`- \`${file.relPath}\` — ${file.reason}${suffix}`);
    }
  }
  lines.push("");

  if (report.failures.length > 0) {
    lines.push("### Files that failed deep review");
    lines.push("");
    for (const failure of report.failures) {
      lines.push(`- \`${failure.relPath}\` — ${failure.error}`);
    }
    lines.push("");
  }

  lines.push("### Coverage");
  lines.push("");
  lines.push(`- Files reviewed by triage: ${triagedCount}`);
  lines.push(`- Files deep-reviewed: ${report.cleanFiles.length + report.findings.length + report.failures.length}`);
  const excludedTotal = Object.values(report.limits.excluded).reduce((a, b) => a + b, 0);
  lines.push(
    `- Excluded before scanning: ${excludedTotal} (${Object.entries(report.limits.excluded)
      .filter(([, n]) => n > 0)
      .map(([reason, n]) => `${reason}: ${n}`)
      .join(", ") || "none"})`,
  );
  if (report.limits.droppedByCap > 0) {
    lines.push(
      `- Dropped at the size/count cap: ${report.limits.droppedByCap} lower-risk file(s). Files whose path matched a priority keyword were exempt.`,
    );
  }
  if (report.limits.triageSkipped > 0) {
    lines.push(`- Not triaged (file-count cap): ${report.limits.triageSkipped} lower-risk file(s).`);
  }
  if (report.limits.deepSkipped > 0) {
    lines.push(
      `- Flagged but not deep-reviewed (deep-review budget of ${MAX_DEEP_FILES}): ${report.limits.deepSkipped} file(s).`,
    );
  }

  return lines.join("\n");
}
