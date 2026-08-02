/**
 * Which model each stage calls, which provider serves it, and what it costs.
 *
 * Every id here is a **provider-native** id, not an OpenRouter slug. The
 * `vendor/model` form (`anthropic/claude-sonnet-4.6`) is OpenRouter's routing
 * syntax and 404s against the vendor's own API — the two namespaces look
 * similar enough that copying one into the other is the easy mistake, so the
 * provider is recorded next to each id rather than inferred from its shape.
 */

export type Provider = "anthropic" | "google";

/**
 * The advisor chatbot.
 *
 * Replaces `inclusionai/ling-3.0-flash:free`, which existed only on
 * OpenRouter and has no direct API to migrate to. It is the same model the
 * triage stage uses, so chat and scanning share one Google client and one key.
 *
 * Two things changed with it, both worth knowing before reading a bill or a
 * bug report: this model is **not** free, and it **does** accept image input —
 * see the note in CLAUDE.md about composer attachments, which were blocked on
 * the old model's text-only modality rather than on the upload backend.
 */
export const CHAT_ADVISOR_MODEL = "gemini-3.6-flash";

/**
 * Repo scanning keeps the split CLAUDE.md assigns: a cheap model for the
 * Tier 1 yes/no triage pass over every candidate file, and the strong one
 * only for the handful of files Tier 1 flags.
 *
 * The triage model is the third id in this slot, and the reason is the same
 * every time: **the previous one stopped being callable.**
 * `google/gemini-2.0-flash-001` retired; `gemini-2.5-flash` is listed by
 * Google's `/models` endpoint but its `generateContent` returns
 * `404 … no longer available to new users`, so it cannot serve a key created
 * today. `gemini-3.6-flash` was verified against the same SQL-injection probe
 * CLAUDE.md records for the earlier choice — correct `yes` verdict, in ~1s
 * with thinking minimal. `gemini-2.5-flash-lite` remains ruled out: it
 * answered verdict "no" with the reason "SQL injection vulnerability".
 *
 * A listing is not an entitlement. Check a candidate with a real
 * `generateContent` call, not by finding it in `GET /v1beta/models`.
 */
export const SCAN_TRIAGE_MODEL = "gemini-3.6-flash";

/* ------------------------------------------------------------------------ *
 * TODO(anthropic-swap-back): TEMPORARY — using Gemini for deep-scan until
 * the Anthropic API is connected. Swap to Claude Sonnet/Opus here once
 * ANTHROPIC_API_KEY is added.
 *
 *     SCAN_DEEP_MODEL = "claude-sonnet-4-6"   // was, and should be again
 *     SCAN_BEST_MODEL = "claude-opus-5"       // was, and should be again
 *
 * Both ids are still registered in MODEL_PROVIDERS and MODEL_PRICING below,
 * so reverting is these two lines and the `reasoning` argument in
 * lib/repo-scan/deep-scan.ts — nothing else. Grep `anthropic-swap-back` for
 * every site involved.
 *
 * Why this exact model, given it is also the triage model:
 * `gemini-2.5-pro` and every other Pro-tier Gemini return
 * `429 … limit: 0, model: gemini-2.5-pro` on this key — the free tier grants
 * Pro models no quota at all, so they are not a fallback, they are closed.
 * `gemini-2.5-flash` is the listed-but-dead id CLAUDE.md already records
 * (`404 … no longer available to new users`). That leaves the Flash line, of
 * which 3.6 is the newest callable member — verified with a real
 * generateContent call, not a listing.
 *
 * The step-up between the two stages is therefore reasoning depth rather
 * than model class: triage runs at `minimal` thinking, deep review at
 * `high`. That is a genuine difference in what the model does, but it is a
 * smaller one than Flash → Sonnet was. Treat deep-review quality as degraded
 * until this is reverted.
 * ------------------------------------------------------------------------ */
export const SCAN_DEEP_MODEL = "gemini-3.6-flash";

/**
 * The strongest model available, used for both scan stages on the Max tier's
 * `best` model tier.
 *
 * TODO(anthropic-swap-back): TEMPORARY — using Gemini for deep-scan until the
 * Anthropic API is connected. Swap to Claude Sonnet/Opus here once
 * ANTHROPIC_API_KEY is added. This was `claude-opus-5`, and with it the whole
 * point of the tier: `best` was a *different and stronger* model on both
 * passes, and right now it is the same Gemini id the free tier triages with.
 * Max buyers are getting `fast`'s models with `high` reasoning on the deep
 * pass and their other entitlements (exploit chains, structured report,
 * priority queue) intact — worth knowing before anyone reads a Max report as
 * an Opus one.
 *
 * The cost note that used to live here is suspended with it: the reason a Max
 * scan cost an order of magnitude more than a `fast` one was Opus on the ~38
 * -call triage pass. On the same Flash id for both stages that premium is
 * currently gone, and it comes back the moment this line does.
 */
export const SCAN_BEST_MODEL = "gemini-3.6-flash";

// The Claude rows stay registered while the ids above are swapped out. They
// cost nothing unused, and their absence is what would turn the revert into a
// runtime `No provider registered for model` / null-cost bug instead of a
// one-line change.
export const MODEL_PROVIDERS: Record<string, Provider> = {
  "gemini-3.6-flash": "google",
  "claude-sonnet-4-6": "anthropic",
  "claude-opus-5": "anthropic",
};

export function providerFor(model: string): Provider {
  const provider = MODEL_PROVIDERS[model];
  if (!provider) {
    // Thrown rather than defaulted: guessing a provider from the id's shape
    // is how a typo becomes a 404 from the wrong vendor, three layers down.
    throw new Error(
      `No provider registered for model "${model}". Add it to MODEL_PROVIDERS in lib/llm/models.ts.`,
    );
  }
  return provider;
}

/**
 * Which model each scan stage uses, per tier's `model_tier`.
 *
 * `fast` is the split CLAUDE.md describes: a cheap model filters every
 * candidate file, the strong one reviews only what the filter flags.
 * `best` drops the cheap filter entirely and runs the strongest model over
 * both stages — the point being that the surface pass stops being a filter
 * that can miss things and becomes a review in its own right.
 *
 * TODO(anthropic-swap-back): that description is aspirational while both
 * rows resolve to the same Gemini id. The two tiers currently differ only in
 * the non-model entitlements; see SCAN_BEST_MODEL above.
 */
export const MODEL_TIERS = {
  fast: { triage: SCAN_TRIAGE_MODEL, deep: SCAN_DEEP_MODEL },
  best: { triage: SCAN_BEST_MODEL, deep: SCAN_BEST_MODEL },
} as const satisfies Record<string, { triage: string; deep: string }>;

export type ScanModels = { triage: string; deep: string };

/**
 * List price in USD per million tokens.
 *
 * This table exists because of what changed in the migration: OpenRouter
 * returned `usage.cost` — the actual amount it charged — on every response,
 * so nothing here had to know a price. The vendor APIs return token counts
 * only, so cost is now *derived*, and a stale row silently reports the wrong
 * number on the spend dashboard rather than failing.
 *
 * Sources: Anthropic list pricing for the Claude rows; ai.google.dev/gemini-api/docs/pricing
 * (paid tier) for the Gemini row. Re-check both against the vendors' pricing
 * pages when a model is added — and note the Gemini row is *not* what the
 * retired gemini-2.5-flash cost ($0.30 / $2.50); 3.6 Flash is five times the
 * input price, which makes it dearer per token than Claude Haiku 4.5.
 *
 * Cached and thinking tokens are deliberately not priced separately. Neither
 * stage enables prompt caching, and thinking tokens are billed as output on
 * both vendors, which is where `outputTokens` counts them — but only because
 * `usageOf` in google.ts adds them in explicitly. Gemini reports thoughts in
 * a field of their own, *outside* `candidatesTokenCount`, so that invariant
 * is maintained by code rather than given.
 */
export type ModelPricing = { inputPerMTok: number; outputPerMTok: number };

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "gemini-3.6-flash": { inputPerMTok: 1.5, outputPerMTok: 7.5 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
};

/**
 * Cost of one call, or null when it can't be computed.
 *
 * Null rather than zero on an unknown model or a missing token count, for
 * the same reason the old `costUsd` was nullable: a zero is a claim that the
 * call was free, and quietly understating spend is worse than admitting the
 * number isn't known.
 */
export function computeCostUsd(
  model: string,
  inputTokens: number | null,
  outputTokens: number | null,
): number | null {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return null;
  if (inputTokens === null && outputTokens === null) return null;
  return (
    ((inputTokens ?? 0) * pricing.inputPerMTok +
      (outputTokens ?? 0) * pricing.outputPerMTok) /
    1_000_000
  );
}
