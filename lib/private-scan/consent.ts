/**
 * The consent a user gives before their private source code leaves this
 * server, and the verified statements it is made of.
 *
 * ## Why the terms are data in this file rather than copy in a component
 *
 * Every sentence below is a claim about what another company does with a
 * customer's unpublished source code. Getting one wrong is not a typo — it is
 * telling somebody their code is safe on a basis that is not true. Keeping
 * them here means: one place to correct when a vendor changes policy, one
 * version number that invalidates old consents when they do, and a test that
 * can assert the screen renders exactly these strings and nothing improvised.
 *
 * ## Every claim here was checked against the vendor's own documentation
 *
 * Checked 2026-08-07. Sources are on each entry. Two things worth flagging
 * because they contradict what this feature was originally specified to say:
 *
 * 1. **Anthropic's API retention is 30 days, not 7.** The spec for this
 *    feature said 7. Anthropic's privacy centre says inputs and outputs are
 *    deleted "within 30 days of receipt or generation", with named exceptions.
 *    Understating a retention period in a consent screen is the kind of error
 *    that makes the whole screen worthless, so the real figure is used.
 *
 * 2. **Google's terms depend entirely on whether the API key is billed.** On
 *    the paid tier Google does not use prompts or responses to improve its
 *    products. On the *unpaid* tier it does, and human reviewers may read
 *    them. That is not a footnote for a feature whose entire purpose is
 *    sending private source code to that API — so the tier is a deployment
 *    setting (`GEMINI_BILLING_TIER`) and the consent text changes with it,
 *    rather than the screen making a promise the deployment may not keep.
 *    It defaults to `unpaid`, the more alarming of the two, because a
 *    misconfigured deployment must not silently show the reassuring text.
 */

/**
 * Bumping this invalidates every stored consent and re-asks. Do it whenever
 * the meaning of what a user agreed to changes — a vendor policy change, a
 * new destination for the code, a change of billing tier that alters
 * Google's terms. Do not bump it for wording polish.
 */
export const PRIVATE_SCAN_CONSENT_VERSION = 1;

export type GeminiBillingTier = "paid" | "unpaid";

/**
 * Which Gemini terms apply to this deployment.
 *
 * Fails to `unpaid` on anything unrecognized, including unset. See point 2
 * above: the safe default is the one that tells the user *more* about the
 * exposure, not less.
 */
export function geminiBillingTier(): GeminiBillingTier {
  return process.env.GEMINI_BILLING_TIER?.trim().toLowerCase() === "paid" ? "paid" : "unpaid";
}

export type ConsentClause = {
  /** Stable id, so a test can assert presence without matching prose. */
  id: string;
  text: string;
  /** Where the claim came from, shown as a link in the consent screen. */
  sourceUrl: string;
  sourceLabel: string;
  /** Renders as a warning rather than a neutral statement. */
  emphasis?: boolean;
};

const ANTHROPIC_CLAUSES: ConsentClause[] = [
  {
    id: "anthropic-purpose",
    text: "Files from your private repository are sent to Anthropic's API for analysis. Only the files selected for review are sent, and only while the scan is running.",
    sourceUrl: "https://docs.claude.com/en/docs/build-with-claude/overview",
    sourceLabel: "Anthropic API docs",
  },
  {
    id: "anthropic-retention",
    text: "Anthropic automatically deletes API inputs and outputs from its systems within 30 days of receipt or generation. Exceptions it names: services with longer retention you control, an agreed zero-retention arrangement, enforcement of its Usage Policy, and legal compliance.",
    sourceUrl: "https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-personal-data",
    sourceLabel: "Anthropic Privacy Center",
  },
  {
    id: "anthropic-training",
    text: "Anthropic's commercial terms state it may not train models on customer content submitted through the API.",
    sourceUrl: "https://www.anthropic.com/legal/commercial-terms",
    sourceLabel: "Anthropic Commercial Terms",
  },
];

const GEMINI_PAID_CLAUSES: ConsentClause[] = [
  {
    id: "gemini-paid-training",
    text: "Files are also sent to Google's Gemini API. On Google's paid tier, Google does not use your prompts or responses to improve its products.",
    sourceUrl: "https://ai.google.dev/gemini-api/terms",
    sourceLabel: "Gemini API Terms",
  },
  {
    id: "gemini-paid-retention",
    text: "Google logs paid-tier prompts and responses for a limited period, solely to detect and prevent violations of its Prohibited Use Policy.",
    sourceUrl: "https://ai.google.dev/gemini-api/terms",
    sourceLabel: "Gemini API Terms",
  },
];

const GEMINI_UNPAID_CLAUSES: ConsentClause[] = [
  {
    id: "gemini-unpaid-training",
    text: "Files are also sent to Google's Gemini API, which this deployment uses on Google's free tier. On the free tier Google uses submitted content and generated responses to provide, improve and develop Google products and services.",
    sourceUrl: "https://ai.google.dev/gemini-api/terms",
    sourceLabel: "Gemini API Terms",
    emphasis: true,
  },
  {
    id: "gemini-unpaid-reviewers",
    text: "On the free tier, Google states that human reviewers may read, annotate and process API input and output. Do not scan a private repository here unless that is acceptable for the code in it.",
    sourceUrl: "https://ai.google.dev/gemini-api/terms",
    sourceLabel: "Gemini API Terms",
    emphasis: true,
  },
];

const NETHERITE_CLAUSES: ConsentClause[] = [
  {
    id: "netherite-no-storage",
    text: "Netherite never permanently stores your code. The repository is cloned to a temporary directory, read, and deleted when the scan ends — including when it fails, times out, or you cancel it.",
    sourceUrl: "",
    sourceLabel: "",
  },
  {
    id: "netherite-report",
    text: "The finished report is saved to your chat history, and it quotes the snippets of your code that findings refer to. Delete the conversation to remove them.",
    sourceUrl: "",
    sourceLabel: "",
  },
  {
    id: "netherite-audit",
    text: "Every private repository scan is recorded — your account, the repository name, and the time — so there is a record of what was accessed.",
    sourceUrl: "",
    sourceLabel: "",
  },
];

/**
 * The full set of statements shown on the consent screen, in display order.
 *
 * A function rather than a constant because the Gemini half depends on a
 * runtime setting, and a constant evaluated at import time would freeze
 * whichever value the build happened to see.
 */
export function consentClauses(): ConsentClause[] {
  return [
    ...ANTHROPIC_CLAUSES,
    ...(geminiBillingTier() === "paid" ? GEMINI_PAID_CLAUSES : GEMINI_UNPAID_CLAUSES),
    ...NETHERITE_CLAUSES,
  ];
}

/** The sentence beside the checkbox. Deliberately concrete about the act. */
export const CONSENT_CHECKBOX_LABEL =
  "I understand that my private code will be sent to Anthropic and Google for analysis, and I agree to the terms above.";
