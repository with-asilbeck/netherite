import { OpenRouterRequestError, requestChatCompletion } from "@/lib/openrouter";
import type { Entitlement } from "@/lib/tier-features";
import type { CollectedFile } from "./collect";
import {
  addScanUsage,
  MAX_FILE_CHARS_FOR_TRIAGE,
  TRIAGE_BATCH_SIZE,
  type ScanBudget,
} from "./config";

export type TriageVerdict = {
  relPath: string;
  flagged: boolean;
  reason: string;
  /** True when triage itself failed and the file was escalated rather than dropped. */
  inconclusive: boolean;
};

// Tier 1 is a filter, not a reviewer: its only job is to decide which files
// deserve the expensive model. Asking for anything more here defeats the
// point of a cheap first pass, so the prompt forbids reports and fixes.
const TRIAGE_SYSTEM_PROMPT = `You are a fast security triage filter for a code scanner.

For each file you are given, decide only this: does it plausibly contain a
security vulnerability worth a deeper, expensive review?

Answer "yes" for files that handle authentication, authorization, sessions,
user input, database queries, file paths, shell commands, deserialization,
cryptography, secrets/credentials, access-control checks, CORS/CSP/headers, or
payment flows in a way that could plausibly be wrong.

Answer "no" for files that are purely presentational, static content, type
definitions, plain constants, documentation, or otherwise have no security
surface at all.

Rules:
- Do NOT write a vulnerability report, an explanation, or a fix. That happens
  in a later stage.
- Give at most one short line of reasoning per file (max 15 words).
- Be decisive. When genuinely unsure, answer "yes" — a later stage will
  confirm or clear it.

Respond with JSON only, no prose and no code fences, in exactly this shape:
{"results":[{"index":0,"verdict":"yes","reason":"..."},{"index":1,"verdict":"no","reason":"..."}]}

Include exactly one entry for every index you were given.`;

function truncate(text: string): { body: string; truncated: boolean } {
  if (text.length <= MAX_FILE_CHARS_FOR_TRIAGE) return { body: text, truncated: false };
  return { body: text.slice(0, MAX_FILE_CHARS_FOR_TRIAGE), truncated: true };
}

/**
 * Fences file content with a marker long enough that the file cannot end its
 * own block — the same reasoning as the chat composer. Repo content is
 * untrusted input to the model, and a file that breaks out of its fence can
 * pose as instructions.
 */
function fenceFor(text: string): string {
  const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

function buildBatchPrompt(batch: CollectedFile[]): string {
  return batch
    .map((file, i) => {
      const { body, truncated } = truncate(file.text);
      const fence = fenceFor(body);
      return [
        `--- index: ${i}`,
        `--- path: ${file.relPath}`,
        truncated ? `--- note: truncated to the first ${MAX_FILE_CHARS_FOR_TRIAGE} characters` : null,
        fence,
        body,
        fence,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

function parseBatchResponse(
  raw: string,
  batch: CollectedFile[],
): TriageVerdict[] | null {
  // Models sometimes wrap JSON in fences despite instructions.
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Last resort: pull the outermost object out of surrounding prose.
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  const results = (parsed as { results?: unknown })?.results;
  if (!Array.isArray(results)) return null;

  const byIndex = new Map<number, { verdict: string; reason: string }>();
  for (const entry of results) {
    if (typeof entry !== "object" || entry === null) continue;
    const { index, verdict, reason } = entry as Record<string, unknown>;
    if (typeof index !== "number" || !Number.isInteger(index)) continue;
    if (typeof verdict !== "string") continue;
    byIndex.set(index, {
      verdict: verdict.toLowerCase(),
      reason: typeof reason === "string" ? reason.slice(0, 200) : "",
    });
  }

  if (byIndex.size === 0) return null;

  return batch.map((file, i) => {
    const entry = byIndex.get(i);
    if (!entry) {
      // Missing verdict — escalate rather than silently clearing the file.
      return {
        relPath: file.relPath,
        flagged: true,
        reason: "Triage returned no verdict for this file — escalated for review.",
        inconclusive: true,
      };
    }
    return {
      relPath: file.relPath,
      flagged: entry.verdict.startsWith("y"),
      reason: entry.reason || (entry.verdict.startsWith("y") ? "Flagged by triage." : "No security surface."),
      inconclusive: false,
    };
  });
}

/** Runs Tier 1 over one batch. Never throws: failures escalate the batch. */
export async function triageBatch(
  batch: CollectedFile[],
  entitlement: Entitlement,
  budget: ScanBudget,
  signal?: AbortSignal,
): Promise<TriageVerdict[]> {
  if (budget.creditsExhausted) {
    return batch.map((file) => ({
      relPath: file.relPath,
      flagged: true,
      reason: "Not triaged — the scanner ran out of credits; escalated rather than cleared.",
      inconclusive: true,
    }));
  }

  try {
    const { content: raw, usage } = await requestChatCompletion({
      // On the `best` model tier this is the same strong model the deep pass
      // uses, so the surface stage stops being a cheap filter that can drop
      // a real issue and becomes a review in its own right. The prompt is
      // unchanged either way — its job is still a verdict per file.
      model: entitlement.models.triage,
      system: TRIAGE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildBatchPrompt(batch) }],
      // Enough for a one-line verdict per file and nothing more.
      maxTokens: 500,
      signal,
    });
    addScanUsage(budget, usage);

    const parsed = parseBatchResponse(raw, batch);
    if (parsed) return parsed;

    console.error("[repo-scan] unparseable triage response:", raw.slice(0, 300));
    return batch.map((file) => ({
      relPath: file.relPath,
      flagged: true,
      reason: "Triage response couldn't be parsed — escalated for review.",
      inconclusive: true,
    }));
  } catch (err) {
    if (signal?.aborted) throw err;
    if (err instanceof OpenRouterRequestError && err.status === 402) {
      budget.creditsExhausted = true;
    }
    console.error("[repo-scan] triage batch failed:", err);
    // Fail toward more review, not less: a triage outage must not read as
    // "these files are clean".
    return batch.map((file) => ({
      relPath: file.relPath,
      flagged: true,
      reason: "Triage call failed — escalated for review.",
      inconclusive: true,
    }));
  }
}

export function intoBatches(files: CollectedFile[]): CollectedFile[][] {
  const batches: CollectedFile[][] = [];
  for (let i = 0; i < files.length; i += TRIAGE_BATCH_SIZE) {
    batches.push(files.slice(i, i + TRIAGE_BATCH_SIZE));
  }
  return batches;
}
