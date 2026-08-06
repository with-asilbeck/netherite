import type { GitHubRepoRef } from "@/lib/github-repo";
import type { InstallationToken } from "@/lib/github/app";
import type { Entitlement } from "@/lib/tier-features";
import { CloneError, shallowClone } from "./clone";
import { byRisk, collectFiles, type CollectedFile } from "./collect";
import {
  blockerFor,
  DEEP_CONCURRENCY,
  MAX_DEEP_FILES,
  MAX_TRIAGE_FILES,
  newScanBudget,
  SCAN_TIMEOUT_MS,
  TRIAGE_CONCURRENCY,
  type ScanBlocker,
  type ScanBudget,
} from "./config";
import { deepScanFile, type DeepFinding } from "./deep-scan";
import { mapWithConcurrency } from "./pool";
import { RepoHostError } from "./ssrf";
import { intoBatches, triageBatch, type TriageVerdict } from "./triage";

export { CloneError } from "./clone";
export { RepoHostError } from "./ssrf";
export { newScanBudget, type ScanBudget } from "./config";
export {
  acquireScanSlot,
  ScanQueueFullError,
  ScanQueueTimeoutError,
  PRIORITY_HIGH,
  PRIORITY_NORMAL,
} from "./queue";

export type ScanProgress =
  | { type: "status"; message: string }
  | { type: "collected"; filesScanned: number; skipped: number; totalBytes: number }
  | { type: "triaged"; done: number; total: number; flagged: number }
  | { type: "deep"; done: number; total: number; relPath: string }
  | { type: "report"; report: ScanReport }
  | { type: "error"; message: string };

/**
 * Whether the scan actually did what it claims to have done.
 *
 * This exists because "found nothing" and "never looked" produced identical
 * reports. Every failure path in the pipeline escalates rather than drops —
 * a triage outage flags every file instead of clearing it, which is the
 * right instinct — but the *report* then counted zero findings and said so
 * in the language of a clean result. In a security scanner that is the one
 * failure mode that must never be silent, because the user's next action is
 * to trust it.
 *
 * - `complete`  — every stage ran; a zero-finding result is meaningful.
 * - `degraded`  — some files were reviewed, some couldn't be. Findings are
 *                 real but coverage is incomplete.
 * - `failed`    — no file was actually reviewed. A zero-finding result here
 *                 carries no information at all.
 */
export type ScanStatus = "complete" | "degraded" | "failed";

export type ScanOutcome = {
  status: ScanStatus;
  /** What specifically didn't happen, in the user's terms. */
  notes: string[];
};

export type ScanReport = {
  repo: string;
  ref: string | null;
  url: string;
  outcome: ScanOutcome;
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
  // What this caller's plan buys: which models the two stages use, whether
  // the deep pass is asked for exploit chains, and which report renderer
  // runs at the end. Resolved by the route from the subscriptions table
  // (lib/tier-features.ts) and required — there is no default, so a caller
  // cannot omit it and silently get the paid behaviour.
  entitlement: Entitlement,
  outerSignal?: AbortSignal,
  // The caller may supply the budget so it can read the accumulated token
  // and cost totals once the scan drains — a scan is dozens of model calls
  // and the route records their sum as one usage_events row. Passed in
  // rather than yielded as a progress event so per-request spend never
  // reaches the browser.
  budget: ScanBudget = newScanBudget(),
  // Present only for a private repository, and only after
  // authorizePrivateScan has granted it. Scoped to this one repository and
  // revoked by the caller as soon as the scan drains; nothing here stores it,
  // and it is used for exactly one thing — the clone.
  auth?: InstallationToken,
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

  try {
    yield { type: "status", message: `Cloning ${repo.slug}…` };

    try {
      clone = await shallowClone(repo, signal, auth);
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
      triageBatch(batch, entitlement, budget, signal),
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

    // Highest-risk flagged files get the deep-review budget first — using the
    // same order collection ranked with, so real source keeps its precedence
    // over sample code all the way into the expensive pass.
    flaggedFiles.sort(byRisk);
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
      (file) => deepScanFile(file, entitlement, budget, signal),
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
      entitlement,
      blocker: blockerFor(budget),
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
  entitlement,
  blocker,
}: {
  repo: GitHubRepoRef;
  startedAt: number;
  collected: Awaited<ReturnType<typeof collectFiles>>;
  triagedCount: number;
  triageSkipped: number;
  verdicts: TriageVerdict[];
  deepResults: DeepFinding[];
  deepSkipped: number;
  entitlement: Entitlement;
  blocker: ScanBlocker;
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
    outcome: assessOutcome({ verdicts, deepResults, failures, deepSkipped, blocker }),
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

  // Which renderer runs is decided here, from the tier, and the chosen
  // markdown is what gets streamed *and* what gets persisted as the
  // assistant message — so there is no second copy of the report in a
  // richer format sitting anywhere a lower tier could ask for it.
  report.markdown = entitlement.structuredReport
    ? renderStructuredMarkdown(report, triagedCount, entitlement)
    : renderMarkdown(report, triagedCount);
  return report;
}

/**
 * Decides whether the scan can honestly claim to have reviewed anything.
 *
 * Read off the two things that can silently not happen: triage verdicts that
 * are `inconclusive` (the escalation fallback, meaning the model never
 * actually answered for that file) and deep reviews that returned an error.
 * `inconclusive` was already being recorded on every failure path and
 * carried all the way into the report — it simply had no reader until now.
 */
export function assessOutcome({
  verdicts,
  deepResults,
  failures,
  deepSkipped,
  blocker = null,
}: {
  verdicts: TriageVerdict[];
  deepResults: DeepFinding[];
  failures: { relPath: string; error: string }[];
  deepSkipped: number;
  /** Account-level fault that stopped the scan, if one did. */
  blocker?: ScanBlocker;
}): ScanOutcome {
  const inconclusive = verdicts.filter((v) => v.inconclusive).length;
  const triaged = verdicts.length - inconclusive;

  // The question is per-file and it is "do we hold a verdict we trust", not
  // "did a stage report an error". A file whose triage failed but which the
  // deep pass then reviewed successfully is fully reviewed — better covered
  // than usual, in fact, since it got the strong model instead of the
  // filter. Keying the status off stage failures instead of per-file
  // outcomes made exactly that scan announce "coverage is incomplete" while
  // its own coverage table reported every file deep-reviewed.
  const deepSucceeded = new Set(
    deepResults.filter((r) => !r.error).map((r) => r.relPath),
  );
  const unreviewed = verdicts.filter(
    (v) => v.inconclusive && !deepSucceeded.has(v.relPath),
  ).length;
  const reviewed = verdicts.length - unreviewed;

  const notes: string[] = [];

  // First, because it is the cause and everything below it is the effect.
  // Reading "no verdict was produced for any of the 12 files" and having to
  // open a collapsed list to discover the account was out of credits is what
  // made a billing problem look like a broken scanner.
  if (blocker === "auth") {
    notes.push(
      "The scanner's model API key was rejected (HTTP 401), so no model call in this scan succeeded. The key is expired, revoked, or from a deleted account — replace ANTHROPIC_API_KEY or GEMINI_API_KEY depending on which stage failed (the server log names the model). Re-running the scan will not help.",
    );
  } else if (blocker === "credits") {
    notes.push(
      "The scanner's model provider rejected the calls in this scan for billing or quota reasons (HTTP 402), before any code was read. Top up or raise the quota on the account behind ANTHROPIC_API_KEY or GEMINI_API_KEY, then run the scan again. The two stages bill separately, so one working does not mean the other can run.",
    );
  }

  if (unreviewed > 0) {
    notes.push(
      unreviewed === verdicts.length
        ? `No verdict was produced for any of the ${verdicts.length} file(s): triage failed and the deep pass did not reach them.`
        : `${unreviewed} of ${verdicts.length} file(s) ended with no verdict — triage failed for them and the deep pass did not cover them.`,
    );
  } else if (inconclusive > 0) {
    // Coverage held, so this is operational information rather than a
    // caveat on the result: worth surfacing because a silent triage outage
    // sends every file to the expensive model and quietly multiplies cost.
    notes.push(
      triaged === 0
        ? `Triage was unavailable, so all ${verdicts.length} file(s) were escalated straight to full review. Coverage is complete; this scan cost more than usual.`
        : `Triage failed for ${inconclusive} file(s), which were escalated straight to full review instead.`,
    );
  }

  if (failures.length > 0) {
    notes.push(`Deep review failed for ${failures.length} file(s).`);
  }
  if (deepSkipped > 0 && unreviewed > 0) {
    notes.push(
      `${deepSkipped} further flagged file(s) were never reached before the scan stopped.`,
    );
  }

  // "failed" is reserved for a scan holding no trustworthy verdict at all —
  // where zero findings is not a weak signal but no signal.
  if (reviewed === 0 && verdicts.length > 0) return { status: "failed", notes };
  if (unreviewed > 0) return { status: "degraded", notes };
  return { status: "complete", notes };
}

/**
 * Why a flagged file has no deep review against it.
 *
 * Previously this always read "(budget reached)", which is the right answer
 * on a healthy scan and the wrong one on a broken scan — where the deep pass
 * stopped early and the twelve-file budget had nothing to do with it. On a
 * failed scan that phrasing actively misattributes the cause.
 */
function notReviewedSuffix(
  report: ScanReport,
  file: { relPath: string },
): string {
  const reviewed =
    report.findings.some((f) => f.relPath === file.relPath) ||
    report.cleanFiles.includes(file.relPath) ||
    report.failures.some((f) => f.relPath === file.relPath);
  if (reviewed) return "";

  return report.outcome.status === "failed"
    ? " — _not deep-reviewed (the scan stopped before reaching it)_"
    : " — _not deep-reviewed (budget reached)_";
}

/**
 * Leading banner. Three shapes, because there are three different things to
 * tell the reader:
 *
 * - `failed`   — a warning that the result means nothing.
 * - `degraded` — a warning that the result is real but partial.
 * - `complete` with notes — *not* a warning. Coverage held; something
 *   unusual happened on the way (a triage outage that escalated everything)
 *   and it is worth knowing, but flagging it as a caveat on the findings
 *   would train people to ignore the banner that does carry one.
 */
function outcomeBanner(outcome: ScanOutcome): string[] {
  if (outcome.status === "complete" && outcome.notes.length === 0) return [];

  const lines: string[] = [];
  lines.push(
    outcome.status === "failed"
      ? "> ⚠️ **This scan did not complete. Do not read it as a clean result.**"
      : outcome.status === "degraded"
        ? "> ⚠️ **This scan completed only partially — coverage is incomplete.**"
        : "> ℹ️ **Every file was reviewed, but the scan did not run as designed.**",
  );
  lines.push(">");
  for (const note of outcome.notes) {
    lines.push(`> - ${note}`);
  }
  if (outcome.status === "failed") {
    lines.push(">");
    lines.push(
      "> No file was successfully reviewed, so the absence of findings below means nothing was examined — not that nothing is wrong.",
    );
  }
  lines.push("");
  return lines;
}

function renderMarkdown(report: ScanReport, triagedCount: number): string {
  const lines: string[] = [];

  lines.push(`## Security scan — ${report.repo}${report.ref ? ` (${report.ref})` : ""}`);
  lines.push("");
  lines.push(...outcomeBanner(report.outcome));

  // A failed scan must not report a finding count: "found 0 issues" is a
  // claim about the code, and this scan is in no position to make one.
  if (report.outcome.status === "failed") {
    lines.push(
      `Attempted **${triagedCount}** file${triagedCount === 1 ? "" : "s"} in ${(
        report.durationMs / 1000
      ).toFixed(1)}s. See above for why the scan stopped.`,
    );
  } else {
    lines.push(
      `Scanned **${triagedCount}** file${triagedCount === 1 ? "" : "s"}, flagged **${
        report.filesFlagged.length
      }** for deep review, and found **${report.findings.length}** file${
        report.findings.length === 1 ? "" : "s"
      } with reportable issues in ${(report.durationMs / 1000).toFixed(1)}s.`,
    );
  }
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
      report.outcome.status === "failed"
        ? "**None — because no file was reviewed.** This section is empty due to the failure described above, not because the code was examined and found clean."
        : "No issues confident enough to report. That is not a clean bill of health — it means nothing in the files reviewed crossed the reporting bar.",
    );
    lines.push("");
  }

  lines.push("### Files flagged in triage");
  lines.push("");
  if (report.filesFlagged.length === 0) {
    lines.push("_None._");
  } else {
    for (const file of report.filesFlagged) {
      lines.push(`- \`${file.relPath}\` — ${file.reason}${notReviewedSuffix(report, file)}`);
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
  // "Sent to" and "assessed" are different numbers the moment anything
  // fails, and only the second one is coverage. Counting escalations and
  // failed reviews as reviewed work is what let a dead scan report full
  // coverage of a repository it never read.
  const inconclusiveCount = report.filesFlagged.filter((f) => f.inconclusive).length;
  lines.push(`- Files sent to triage: ${triagedCount}`);
  if (inconclusiveCount > 0) {
    lines.push(`- Files triage actually assessed: ${Math.max(0, triagedCount - inconclusiveCount)}`);
  }
  lines.push(`- Files deep-reviewed: ${report.cleanFiles.length + report.findings.length}`);
  if (report.failures.length > 0) {
    lines.push(`- Deep reviews that failed: ${report.failures.length}`);
  }
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

/**
 * The Pro/Max report: the same findings, wrapped in something that can be
 * exported and handed to somebody who wasn't in the room.
 *
 * The difference from `renderMarkdown` is framing, not content — a metadata
 * header that says what was and wasn't covered, findings grouped under a
 * per-file heading with a stable anchor, and an explicit scope statement so
 * the document can't be mistaken for a clean bill of health when read on its
 * own. The findings themselves are already structured by the deep pass; see
 * STRUCTURED_REPORT_INSTRUCTIONS.
 */
function renderStructuredMarkdown(
  report: ScanReport,
  triagedCount: number,
  entitlement: Entitlement,
): string {
  const lines: string[] = [];
  // Successfully reviewed only — a failed review is not coverage.
  const deepReviewed = report.cleanFiles.length + report.findings.length;
  const inconclusiveCount = report.filesFlagged.filter((f) => f.inconclusive).length;
  const triageAssessed = Math.max(0, triagedCount - inconclusiveCount);
  const excludedTotal = Object.values(report.limits.excluded).reduce((a, b) => a + b, 0);

  lines.push(`# Security assessment — ${report.repo}`);
  lines.push("");
  lines.push(...outcomeBanner(report.outcome));
  lines.push("| | |");
  lines.push("|---|---|");
  lines.push(`| **Repository** | [${report.repo}](${report.url}) |`);
  // In the metadata table too, not only the banner: this document is meant
  // to be exported and read by somebody who wasn't here, and a status that
  // only appeared in prose could be skimmed past.
  lines.push(
    `| **Scan status** | ${
      report.outcome.status === "complete"
        ? report.outcome.notes.length === 0
          ? "Complete"
          : "Complete — see notes above"
        : report.outcome.status === "degraded"
          ? "⚠️ Partial — incomplete coverage"
          : "⚠️ Did not complete — no file was reviewed"
    } |`,
  );
  lines.push(`| **Ref** | ${report.ref ?? "default branch"} |`);
  lines.push(`| **Generated** | ${new Date().toISOString()} |`);
  lines.push(
    `| **Files reviewed** | ${triageAssessed} of ${triagedCount} triaged, ${deepReviewed} deep-reviewed |`,
  );
  lines.push(`| **Files with findings** | ${report.findings.length} |`);
  lines.push(`| **Analysis depth** | ${entitlement.exploitAnalysis ? "Exploit-chain" : "Standard"} |`);
  lines.push(`| **Duration** | ${(report.durationMs / 1000).toFixed(1)}s |`);
  lines.push("");

  lines.push("## Findings");
  lines.push("");
  if (report.findings.length === 0) {
    lines.push(
      report.outcome.status === "failed"
        ? "**No findings are listed because no file was successfully reviewed.** This is not a statement about the security of this repository — see the scan status above."
        : "No issues met the reporting bar. See **Scope and limitations** below before treating this as a clean result — it describes what was not examined.",
    );
    lines.push("");
  } else {
    for (const finding of report.findings) {
      lines.push(`### \`${finding.relPath}\``);
      lines.push("");
      lines.push(finding.report.trim());
      lines.push("");
    }
  }

  lines.push("## Scope and limitations");
  lines.push("");
  lines.push(
    "This is a static review of source files only. It does not cover runtime configuration, deployment, infrastructure, dependencies, or any code excluded below.",
  );
  lines.push("");
  lines.push(`- Files sent to triage: **${triagedCount}**`);
  if (inconclusiveCount > 0) {
    lines.push(`- Files triage actually assessed: **${triageAssessed}**`);
  }
  lines.push(`- Files deep-reviewed: **${deepReviewed}**`);
  if (report.failures.length > 0) {
    lines.push(`- Deep reviews that failed: **${report.failures.length}**`);
  }
  lines.push(`- Files flagged in triage: **${report.filesFlagged.length}**`);
  lines.push(
    `- Excluded before scanning: **${excludedTotal}**${
      excludedTotal > 0
        ? ` (${Object.entries(report.limits.excluded)
            .filter(([, n]) => n > 0)
            .map(([reason, n]) => `${reason}: ${n}`)
            .join(", ")})`
        : ""
    }`,
  );
  if (report.limits.droppedByCap > 0) {
    lines.push(
      `- Dropped at the size/count cap: **${report.limits.droppedByCap}** lower-risk file(s); path-priority files were exempt.`,
    );
  }
  if (report.limits.triageSkipped > 0) {
    lines.push(`- Not triaged (file-count cap): **${report.limits.triageSkipped}** lower-risk file(s).`);
  }
  if (report.limits.deepSkipped > 0) {
    lines.push(
      `- Flagged but not deep-reviewed (budget of ${MAX_DEEP_FILES}): **${report.limits.deepSkipped}** file(s).`,
    );
  }
  lines.push("");

  // Plain markdown, not a `<details>` disclosure. The report is rendered by
  // components/message-content.tsx, and react-markdown does not pass raw HTML
  // through — so the tags arrived in the chat as literal text reading
  // "<details> <summary>Files flagged in triage</summary>". Rendering the
  // HTML instead is the wrong way out of that: this document quotes paths and
  // model output derived from an untrusted repository, and enabling raw HTML
  // to get a collapsible section would hand that repository a way to inject
  // markup. The list is short and reads fine open, which is how the plain
  // renderer has always shown it.
  if (report.filesFlagged.length > 0) {
    lines.push("### Files flagged in triage");
    lines.push("");
    for (const file of report.filesFlagged) {
      lines.push(`- \`${file.relPath}\` — ${file.reason}${notReviewedSuffix(report, file)}`);
    }
    lines.push("");
  }

  if (report.failures.length > 0) {
    lines.push("### Files that failed deep review");
    lines.push("");
    for (const failure of report.failures) {
      lines.push(`- \`${failure.relPath}\` — ${failure.error}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
