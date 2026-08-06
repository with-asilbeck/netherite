// The "Copy fix prompt" reader, checked against the report formats the app
// actually emits — the plain deep-scan format from lib/repo-scan/deep-scan.ts,
// the structured one from STRUCTURED_REPORT_INSTRUCTIONS, and unlabelled
// advisor prose — plus the cases where it must stay silent.
//
// It imports lib/fix-prompt.ts itself rather than restating its rules, so a
// change to the parser that breaks a format fails here.
//
//   node scripts/fix-prompt-test.mjs

import { readFileSync } from "node:fs";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

import { check, checkEqual, section, summarise } from "./billing-env.mjs";

register("./ts-alias-hook.mjs", import.meta.url);

const fixture = (name) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

const { buildFixPrompt, indexFixPrompts, parseFindings } = await import("../lib/fix-prompt.ts");

const only = (markdown) => {
  const findings = parseFindings(markdown);
  return findings.length === 1 ? findings[0] : null;
};

// ── 1. The plain repo-scan format ───────────────────────────────────────

section("1. Plain deep-scan finding (lib/repo-scan/deep-scan.ts)");

const PLAIN = `### Findings

### app/api/users/route.ts:42 — SQL injection

**Risk:** Anyone who can call this endpoint can read, change or delete every
row in the users table by putting SQL into the \`id\` query parameter.

**Fix:**
\`\`\`ts
const { data } = await supabase
  .from("users")
  .select("id, email")
  .eq("id", id)
  .single();
\`\`\`
`;

const plain = only(PLAIN);
check("one finding parsed", plain !== null);
checkEqual("file path from the heading", plain?.filePath, "app/api/users/route.ts");
checkEqual("line from the heading", plain?.line, 42);
check(
  "risk lifted verbatim and unwrapped",
  plain?.risk ===
    "Anyone who can call this endpoint can read, change or delete every row in the users table by putting SQL into the `id` query parameter.",
  plain?.risk,
);
checkEqual("no fix prose in this format", plain?.fixSummary, null);
check("code captured whole", plain?.code.startsWith("const { data }") && plain?.code.endsWith(".single();"));
checkEqual("language captured", plain?.language, "ts");

const plainPrompt = plain ? buildFixPrompt(plain) : "";
check("prompt names the file and the line", plainPrompt.includes("in app/api/users/route.ts (line 42)."));
check("prompt points at AGENTS.md", plainPrompt.includes("Read AGENTS.md (or your project's equivalent conventions file) first if one exists."));
check("prompt has an Issue line", plainPrompt.includes("\nIssue: Anyone who can call this endpoint"));
check("prompt has a Fix line with words in it", /\nFix: [A-Z][^\n]{20,}/.test(plainPrompt));
check("prompt carries the corrected code", plainPrompt.includes('.eq("id", id)'));
check("prompt closes with the show-me line", plainPrompt.trimEnd().endsWith("After fixing, show me the corrected code — don't just confirm it's done."));
check("no placeholder left anywhere", !/\{|\}/.test(plainPrompt.replace(/```[\s\S]*```/, "")));

// ── 2. The structured Pro/Max format ────────────────────────────────────

section("2. Structured finding (STRUCTURED_REPORT_INSTRUCTIONS)");

const STRUCTURED = `# Security assessment — acme/store

### \`lib/orders.ts\`

### NTH-001 — Order records readable by any signed-in user

| | |
|---|---|
| **Severity** | High |
| **Class** | IDOR |
| **Location** | \`lib/orders.ts\`:88 |
| **Confidence** | Confirmed |

**Risk:** Any signed-in customer can read anyone else's order, including the
delivery address on it, by changing the id in the URL.

**Detail:** The query selects by \`orderId\` alone and never compares the row's
\`user_id\` against the session.

**Fix:** Scope the read to the session's own user id so a row that isn't
theirs simply isn't returned.
\`\`\`ts
const { data } = await supabase
  .from("orders")
  .select("*")
  .eq("id", orderId)
  .eq("user_id", session.user.id)
  .single();
\`\`\`
`;

const structured = only(STRUCTURED);
check("one finding parsed", structured !== null);
checkEqual("path from the Location row", structured?.filePath, "lib/orders.ts");
checkEqual("line from the Location row", structured?.line, 88);
check("risk lifted, not the Detail", structured?.risk.startsWith("Any signed-in customer can read"), structured?.risk);
check(
  "fix prose lifted from **Fix:**",
  structured?.fixSummary ===
    "Scope the read to the session's own user id so a row that isn't theirs simply isn't returned.",
  structured?.fixSummary,
);
check("Detail did not leak into the fix", !structured?.fixSummary?.includes("never compares"));
check(
  "prompt uses the model's own fix sentence",
  buildFixPrompt(structured).includes("Fix: Scope the read to the session's own user id"),
);

// ── 3. Unlabelled advisor prose, with no file to name ───────────────────

section("3. Advisor reply on a pasted snippet (no labels, no path)");

const SNIPPET = `That endpoint trusts a user id sent in the request body, so any logged-in
caller can pass someone else's id and update their profile.

Take the id from the session instead of the body — the client should not be
able to name the account it is editing:

\`\`\`js
const { data: { user } } = await supabase.auth.getUser();
await supabase.from("profiles").update(fields).eq("id", user.id);
\`\`\`
`;

const snippet = only(SNIPPET);
check("one finding parsed from unlabelled prose", snippet !== null);
checkEqual("no file path invented", snippet?.filePath, null);
checkEqual("no line invented", snippet?.line, null);
check("risk is the sentence describing the danger", snippet?.risk.includes("any logged-in caller can pass someone else's id"), snippet?.risk);
check("fix prose is the sentence describing the fix", snippet?.fixSummary?.startsWith("Take the id from the session"), snippet?.fixSummary);

const snippetPrompt = snippet ? buildFixPrompt(snippet) : "";
// The opening line only — the risk sentence quoted below it is the model's
// own words and may well contain the word "in".
checkEqual(
  "the file clause is dropped, not blanked",
  snippetPrompt.split("\n")[0],
  "Fix a security issue. Read AGENTS.md (or your project's equivalent conventions file) first if one exists.",
);
check("no empty path, placeholder or dangling preposition", !/\bin\s*[.(]|\{file_path\}|unknown file/i.test(snippetPrompt));

// ── 4. What must NOT get a button ───────────────────────────────────────

section("4. Blocks that are not a fix");

checkEqual(
  "a clean verdict with no code",
  parseFindings("I looked for SQL injection and XSS in this handler and found neither.").length,
  0,
);

checkEqual(
  "a how-to answer with a code block",
  parseFindings(
    "Here's how to enable RLS on a new table:\n\n```sql\nalter table orders enable row level security;\n```",
  ).length,
  0,
);

const QUOTED_FIRST = `**Risk:** The password is compared with \`==\`, so an attacker learns it a
character at a time from how long the request takes.

Your current code:

\`\`\`js
if (submitted == stored) grantAccess();
\`\`\`

Use a constant-time comparison instead:

\`\`\`js
if (timingSafeEqual(Buffer.from(submitted), Buffer.from(stored))) grantAccess();
\`\`\`
`;

const quoted = parseFindings(QUOTED_FIRST);
checkEqual("vulnerable-code block is not copied as the fix", quoted.length, 1);
check("the corrected block is the one picked", quoted[0]?.code.includes("timingSafeEqual"), quoted[0]?.code);

checkEqual(
  "a scan report with no findings",
  parseFindings(
    "## Security scan — acme/store\n\n### Findings\n\nNo issues confident enough to report.\n\n### Coverage\n\n- Files sent to triage: 12\n",
  ).length,
  0,
);

checkEqual("indexFixPrompts returns null when there is nothing to offer", indexFixPrompts("Just prose."), null);

// ── 5. Two findings, same fix, different files ──────────────────────────

section("5. Joining prompts back to blocks");

const TWICE = `### app/api/a/route.ts:10 — Broken auth

**Risk:** Any unauthenticated caller can reach this route and read the record.

**Fix:**
\`\`\`ts
const user = await requireUser(request);
\`\`\`

### app/api/b/route.ts:20 — Broken auth

**Risk:** Any unauthenticated caller can reach this route and delete the record.

**Fix:**
\`\`\`ts
const user = await requireUser(request);
\`\`\`
`;

const both = parseFindings(TWICE);
checkEqual("both findings parsed", both.length, 2);
checkEqual("first names the first file", both[0]?.filePath, "app/api/a/route.ts");
checkEqual("second names the second file", both[1]?.filePath, "app/api/b/route.ts");
check("identical code, different offsets", both[0]?.codeOffset !== both[1]?.codeOffset);

const index = indexFixPrompts(TWICE);
checkEqual("one index entry per block", index?.byOffset.size, 2);
check(
  "the offset lookup keeps the file paths apart",
  index?.byOffset.get(both[0].codeOffset).includes("app/api/a/route.ts") &&
    index?.byOffset.get(both[1].codeOffset).includes("app/api/b/route.ts"),
);
// The offsets are the join to the rendered tree, so they must land on the
// real fence characters in the source string.
check(
  "offsets point at the opening fence",
  both.every((finding) => TWICE.slice(finding.codeOffset, finding.codeOffset + 3) === "```"),
);

// ── 6. Streaming and awkward input ──────────────────────────────────────

section("6. Streaming and edge cases");

const MID_STREAM = `### app/lib/db.ts:7 — SQL injection

**Risk:** An attacker can append their own SQL to the search term and read the
whole table.

**Fix:**
\`\`\`ts
const rows = await db.query("select * from items where name = $1", [name]);`;

const streaming = only(MID_STREAM);
check("an unterminated fence still yields a finding", streaming !== null);
check("its code is what has arrived so far", streaming?.code.includes("$1"), streaming?.code);

const FENCED_FIX = `### app/docs/page.tsx:3 — XSS

**Risk:** A comment containing a script tag runs in every other reader's browser.

**Fix:**
\`\`\`\`md
Use the renderer, not \`dangerouslySetInnerHTML\`:
\`\`\`tsx
<MessageContent content={comment} />
\`\`\`
\`\`\`\`
`;

const fenced = only(FENCED_FIX);
check("a four-backtick fence is read as one block", fenced?.code.includes("<MessageContent"), fenced?.code);
// One backtick longer than the longest run inside it, so the ```tsx block the
// fix quotes cannot close the fence the prompt wraps it in.
check(
  "the prompt re-fences long enough to hold it",
  buildFixPrompt(fenced).split("\n").includes("````md"),
);

const INSIDE_CODE = `Here is a report template, not a finding:

\`\`\`md
### app/x.ts:1 — SQL injection

**Risk:** Something bad.

**Fix:**
\`\`\`
`;
checkEqual("labels inside a code block are code", parseFindings(INSIDE_CODE).length, 0);

checkEqual("empty input", parseFindings("").length, 0);

// ── 7. Real model output ────────────────────────────────────────────────
//
// scripts/fixtures/ holds three unedited outputs from the app's own models:
// the plain deep-scan format and the structured one, both produced by running
// lib/repo-scan/deep-scan.ts over a vulnerable route, and an advisor reply to
// a pasted snippet produced through lib/llm with CHAT_ADVISOR_SYSTEM_PROMPT.
// Hand-written markdown tests what the format specifies; these test what the
// models actually write, which is not always the same thing.

section("7. Real model output (scripts/fixtures)");

const realPlain = only(fixture("finding-plain.md"));
check("real plain finding parsed", realPlain !== null);
checkEqual("path", realPlain?.filePath, "app/api/profiles/route.js");
checkEqual("line", realPlain?.line, 10);
check("risk is the model's whole sentence", realPlain?.risk.endsWith("or modify the database."), realPlain?.risk);
check("fix is the corrected handler", realPlain?.code.includes('.eq("email", email)'));

const realStructured = only(fixture("finding-structured.md"));
check("real structured finding parsed", realStructured !== null);
checkEqual("path from the Location row", realStructured?.filePath, "app/api/profiles/route.js");
checkEqual("line from the Location row", realStructured?.line, 10);
check("Detail's example attack did not become the risk", !realStructured?.risk.includes("UNION SELECT"), realStructured?.risk);
check("the Summary section adds no second finding", parseFindings(fixture("finding-structured.md")).length === 1);

const realAdvisor = parseFindings(fixture("advisor-snippet.md"));
checkEqual("one fix from the advisor reply", realAdvisor.length, 1);
checkEqual("no path invented for a pasted snippet", realAdvisor[0]?.filePath, null);
check(
  "risk carried across the heading it was stated under",
  realAdvisor[0]?.risk.includes("attacker") || realAdvisor[0]?.risk.includes("IDOR"),
  realAdvisor[0]?.risk,
);
check("fix prose is the model's, not the heading", !realAdvisor[0]?.fixSummary?.startsWith("How to Fix"), realAdvisor[0]?.fixSummary);
check("the corrected handler is the block picked", realAdvisor[0]?.code.includes("auth.getUser()"));
check(
  "the defence-in-depth RLS block is not offered as the fix",
  !realAdvisor.some((finding) => finding.code.includes("enable row level security")),
);

// ── 8. Whole reports, not just one finding ──────────────────────────────
//
// A finding never reaches the browser on its own: it arrives wrapped in a
// scan report — an outcome banner, a metadata table, `### Findings`, then a
// coverage section — and dropped into `message.content` by chat-view.tsx. The
// per-finding cases above would all pass while the wrapper broke every one of
// them, so the wrapper is tested too.
//
// Provenance of these three: the wrappers are verbatim output from real
// `scanRepository` runs against github.com/Benji8817/SQL-Injection-Demo (one
// free-tier, one pro-tier). The findings spliced into two of them are the
// real model output in finding-plain.md / finding-structured.md, placed
// exactly where the renderers place `finding.report.trim()`. A live scan that
// both completes and finds something needs model quota this key does not
// always have; the assembly is deterministic and this pins it.

section("8. Full scan reports");

const plainReport = fixture("report-plain-full.md");
const plainFindings = parseFindings(plainReport);
checkEqual("plain report: every finding found", plainFindings.length, 2);
checkEqual("first keeps its own path", plainFindings[0]?.filePath, "app/api/profiles/route.js");
checkEqual("second keeps its own path", plainFindings[1]?.filePath, "sql-injection-activity/app.js");
check(
  "the banner, table and coverage sections contribute nothing",
  plainFindings.every((f) => !/Files sent to triage|Scan status|⚠️/.test(f.risk)),
);

const structuredReport = fixture("report-structured-full.md");
const structuredFindings = parseFindings(structuredReport);
checkEqual("structured report: finding found", structuredFindings.length, 1);
checkEqual("path from the Location row", structuredFindings[0]?.filePath, "sql-injection-activity/app.js");
check(
  "the metadata table's repository link is not read as a path",
  structuredFindings[0]?.filePath !== "Benji8817/SQL-Injection-Demo",
);

// A report with nothing to report has no fix block to hang a button on, and
// that is the whole of the "why is there no button" answer.
const empty = fixture("report-no-findings.md");
checkEqual("a report with no findings yields none", parseFindings(empty).length, 0);
checkEqual("and so offers no index", indexFixPrompts(empty), null);
check("even though it is a full report", empty.includes("## Findings") && empty.length > 1000);

process.exit(summarise());
