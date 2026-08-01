import {
  DEEP_EXPLOIT_ANALYSIS_INSTRUCTIONS,
  MODEL_TIERS,
  STRUCTURED_REPORT_INSTRUCTIONS,
  type ScanModels,
} from "@/lib/openrouter";
import { hasFeature, limitsFor, type Tier, type TierLimits } from "@/lib/tiers";

// Turns a resolved tier into the concrete things the request pipeline needs:
// which models to call, which prompt fragments to append, and which report
// renderer to use.
//
// The important property of this file is its *input type*. Every function
// here takes a `Tier`, and the only producer of a `Tier` is
// `getUserTier(userId)`, which reads the subscriptions table with the
// service-role client and a session-verified user id. Nothing takes a
// feature flag, a plan name, or a boolean from a caller — so there is no
// signature in this module that a route could accidentally feed from a
// request body. That is the whole defence, and it is a type-level one
// rather than a runtime check that could be forgotten.
//
// The one deliberate exception is `GUEST_ENTITLEMENT`, which hardcodes the
// free tier for unauthenticated chat: a guest has no row to read, and the
// alternative to a hardcoded floor is a nullable tier that every caller has
// to remember to handle.

export type Entitlement = {
  tier: Tier;
  limits: TierLimits;
  models: ScanModels;
  /** Structured, exportable findings rather than the plain narrative report. */
  structuredReport: boolean;
  /** Ask the model to work out realistic exploit chains, not just name flaws. */
  exploitAnalysis: boolean;
  /** Scans are admitted ahead of free and basic. */
  priorityQueue: boolean;
};

export function entitlementFor(tier: Tier): Entitlement {
  const limits = limitsFor(tier);
  return {
    tier,
    limits,
    models: MODEL_TIERS[limits.model_tier],
    structuredReport: hasFeature(tier, "vulnerability_report"),
    exploitAnalysis: hasFeature(tier, "deep_exploit_analysis"),
    priorityQueue: hasFeature(tier, "priority_queue"),
  };
}

/**
 * What an unauthenticated guest gets. Free tier, always — a guest has no
 * subscription to read and must never be assumed into anything better.
 */
export const GUEST_ENTITLEMENT: Entitlement = entitlementFor("free");

/**
 * Appends the feature fragments a tier has earned to a base system prompt.
 *
 * Order is fixed rather than caller-chosen: the base prompt (scope, tone,
 * safety boundaries) always comes first, so an appended fragment can extend
 * the instructions but never displaces the parts that constrain the model.
 */
export function withFeaturePrompts(basePrompt: string, entitlement: Entitlement): string {
  const parts = [basePrompt];
  if (entitlement.exploitAnalysis) parts.push(DEEP_EXPLOIT_ANALYSIS_INSTRUCTIONS);
  if (entitlement.structuredReport) parts.push(STRUCTURED_REPORT_INSTRUCTIONS);
  return parts.join("\n");
}
