/**
 * Turns a finding this app has already produced into an instruction somebody
 * else's coding agent can act on.
 *
 * ## Why this reads markdown instead of a finding object
 *
 * Nothing in the pipeline hands the browser a structured finding. The deep
 * scan returns a markdown report per file (lib/repo-scan/deep-scan.ts), the
 * report renderers concatenate those into one document, and the chat advisor
 * writes markdown directly — all three arrive at the client as
 * `message.content` and render through components/message-content.tsx. So the
 * markdown *is* the structured data, and its shape is not incidental: it is
 * fixed by .claude/skills/vuln-report-format and by the prompt fragments in
 * lib/llm/prompts.ts, which pin the labels this file reads.
 *
 * Two authored formats exist, and both are handled:
 *
 *   ### <path>:<line> — <class>        ### NTH-001 — <title>
 *   **Risk:** …                        | **Location** | `<path>`:<line> |
 *   **Fix:**                           **Risk:** …
 *   ```ts                              **Detail:** …
 *   …                                  **Fix:**
 *   ```                                ```ts …
 *
 * Free-form advisor replies carry no labels at all, so they are matched on
 * their content instead — deliberately conservatively. See `isFixBlock`.
 *
 * ## What it does not do
 *
 * It does not call a model, and it does not change, re-word or re-grade a
 * finding. Every sentence in the generated prompt is either lifted verbatim
 * from the finding or is fixed boilerplate from this file.
 */

/** A finding that carries both a risk statement and a corrected code block. */
export type ParsedFinding = {
  /** The source file the finding names, or null when it names none. */
  filePath: string | null;
  /** Line within that file, when the finding cites one. */
  line: number | null;
  /** The finding's own one-sentence risk statement, verbatim. */
  risk: string;
  /** The fix in the model's words, or null when it only gave code. */
  fixSummary: string | null;
  /** The corrected code, without its fence. */
  code: string;
  /** The fence's language hint, as written. */
  language: string | null;
  /**
   * Offset of the fence character in the source markdown. This is the join
   * back to the rendered tree — see `indexFixPrompts`.
   */
  codeOffset: number;
};

/**
 * Stands in for the "Fix:" sentence when the finding gave none.
 *
 * The plain report format (deep-scan.ts) asks for a risk sentence and a code
 * block and nothing in between, so for those findings there are no words
 * describing the fix to lift — the code is the whole answer. Rather than
 * paraphrase a security fix, which would mean this file inventing content the
 * reviewer never wrote, the line says where to look and the code follows.
 */
const IMPLIED_FIX_SUMMARY =
  "Apply the corrected version below, keeping the surrounding code and the file's existing conventions intact.";

/**
 * AGENTS.md rather than CLAUDE.md: it is the cross-tool convention that Codex,
 * Cursor, Copilot, Gemini CLI, Aider and Windsurf all read natively, and the
 * copied text has no idea which agent it is about to be pasted into. Hedged
 * with "or your project's equivalent" so it is a sensible instruction even in
 * a repo that has no such file.
 */
const CONVENTIONS_LINE =
  "Read AGENTS.md (or your project's equivalent conventions file) first if one exists.";

const CLOSING_LINE =
  "After fixing, show me the corrected code — don't just confirm it's done.";

/**
 * Composes the prompt. Deliberately plain prose with no markdown structure
 * beyond the fenced code, because it is pasted into a chat box, a terminal
 * agent, or an IDE side panel with equal likelihood.
 */
export function buildFixPrompt(finding: ParsedFinding): string {
  // No path, no clause. A snippet pasted into chat has no file context, and a
  // guessed or placeholder path is worse than none: the agent would go and
  // edit whatever it guessed.
  const where = finding.filePath
    ? ` in ${finding.filePath}${finding.line ? ` (line ${finding.line})` : ""}`
    : "";

  const fence = fenceFor(finding.code);

  return [
    `Fix a security issue${where}. ${CONVENTIONS_LINE}`,
    "",
    `Issue: ${finding.risk}`,
    "",
    `Fix: ${finding.fixSummary ?? IMPLIED_FIX_SUMMARY}`,
    "",
    `${fence}${finding.language ?? ""}`,
    finding.code,
    fence,
    "",
    CLOSING_LINE,
  ].join("\n");
}

/**
 * Long enough to hold the fix even when the fix is itself markdown containing
 * a fence — the same guard lib/repo-scan/deep-scan.ts uses on file content.
 */
function fenceFor(code: string): string {
  const longest = (code.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

// ── Reading the report ──────────────────────────────────────────────────

type Item =
  | { kind: "heading"; text: string }
  | { kind: "line"; text: string }
  | { kind: "code"; language: string | null; code: string; offset: number };

const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_OPEN_RE = /^(\s{0,3})(`{3,}|~{3,})[ \t]*([^\s`]*)/;
const FENCE_CLOSE_RE = /^\s{0,3}(`{3,}|~{3,})\s*$/;

/**
 * Splits the document into headings, lines and fenced blocks, carrying each
 * block's offset in the original string.
 *
 * Fence-aware by necessity: a `###` or a `**Fix:**` inside a code block is
 * code, and a report about markdown injection will contain exactly that.
 */
function tokenize(markdown: string): Item[] {
  const items: Item[] = [];
  let offset = 0;
  let open: { char: string; width: number; language: string | null; offset: number; body: string[] } | null =
    null;

  for (const raw of markdown.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const lineOffset = offset;
    offset += raw.length + 1;

    if (open) {
      const close = line.match(FENCE_CLOSE_RE);
      if (close && close[1][0] === open.char && close[1].length >= open.width) {
        items.push({
          kind: "code",
          language: open.language,
          code: open.body.join("\n"),
          offset: open.offset,
        });
        open = null;
      } else {
        open.body.push(line);
      }
      continue;
    }

    const fence = line.match(FENCE_OPEN_RE);
    if (fence) {
      open = {
        char: fence[2][0],
        width: fence[2].length,
        language: fence[3] ? fence[3].toLowerCase() : null,
        // The fence character, not the start of the line: that is where the
        // markdown renderer reports an indented block as starting, and the
        // two numbers have to agree for `indexFixPrompts` to join on them.
        offset: lineOffset + fence[1].length,
        body: [],
      };
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      items.push({ kind: "heading", text: heading[2] });
      continue;
    }

    items.push({ kind: "line", text: line });
  }

  // An unterminated fence is what the renderer sees on nearly every frame of
  // a streaming reply. It is already on screen as a block, so treat it as one
  // here too rather than having the button appear only once the reply lands.
  if (open) {
    items.push({
      kind: "code",
      language: open.language,
      code: open.body.join("\n"),
      offset: open.offset,
    });
  }

  return items;
}

/**
 * `**Risk:** text`, `**Risk**: text` and a bare `Risk: text` are all the same
 * label. The first is what the prompts specify; the other two are what models
 * write anyway.
 */
function labelValue(line: string, names: string): string | null {
  const bold = new RegExp(`^\\s*(?:[-*+]\\s+)?\\*\\*\\s*(?:${names})\\s*:?\\s*\\*\\*\\s*:?\\s*(.*)$`, "i");
  const plain = new RegExp(`^\\s*(?:[-*+]\\s+)?(?:${names})\\s*:\\s+(.*)$`, "i");
  const match = line.match(bold) ?? line.match(plain);
  return match ? match[1].trim() : null;
}

const RISK_LABELS = "risk|vulnerability|vuln|issue|problem";
const FIX_LABELS =
  "recommended fix|how to fix|corrected code|fixed code|corrected version|secure version|safe version|remediation|correction|corrected|solution|fixed|fix";
/** Labels that are neither, and must not be mistaken for prose about the fix. */
const OTHER_LABELS =
  "detail|details|severity|class|location|confidence|impact|exploit|exploit chain|attack chain|summary|note|notes|assumption|assumptions";

/**
 * File extensions worth treating as a path. A whitelist rather than
 * `\.\w+`, because the loose form reads `app.get` in a sentence as a file and
 * sends the agent off to edit it.
 */
const PATH_RE = new RegExp(
  "(?:^|[\\s(<\\[|])((?:[\\w@.-]+\\/)*[\\w@.-]+\\.(?:" +
    "ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|kts|php|cs|c|h|cc|cpp|hpp|swift|m|scala|ex|exs|" +
    "sql|sh|bash|zsh|ps1|yml|yaml|json|toml|ini|conf|cfg|env|xml|gradle|properties|" +
    "html|htm|css|scss|sass|less|vue|svelte|astro|" +
    "tf|tfvars|prisma|graphql|gql|proto|md|mdx|ejs|erb|hbs|twig|liquid" +
    "))(?::(\\d+))?",
);

function extractLocation(text: string): { path: string; line: number | null } | null {
  // Backticks are formatting around the path (`` `lib/db.ts`:88 ``), not part
  // of it, and removing them also joins the path to a line number sitting
  // outside the span.
  const match = text.replace(/`/g, "").match(PATH_RE);
  if (!match) return null;
  return { path: match[1], line: match[2] ? Number(match[2]) : null };
}

/**
 * Sentences that are describing a vulnerability rather than, say, walking
 * through a configuration. Only consulted for replies with no labels — a
 * labelled `**Risk:**` needs no guessing.
 *
 * The second half matters as much as the first. `vuln-report-format` asks for
 * plain English with no unexplained jargon, and a good risk sentence written
 * to that rule contains none of the vocabulary in the first half: "any
 * signed-in customer can read anyone else's order" is a textbook IDOR that
 * never says IDOR. Matching only the jargon would have skipped exactly the
 * findings the report format is trying to produce.
 */
const VULN_SIGNAL_RE = new RegExp(
  "\\b(?:" +
    // Named classes and the language of attack.
    "vulnerab\\w*|exploit\\w*|attacker|injection|inject(?:s|ed|ing)?|xss|cross-site|idor|csrf|ssrf|rce|" +
    "traversal|unauthenticated|unauthoris\\w*|unauthoriz\\w*|privilege escalation|" +
    "hard-?coded (?:secret|key|token|password|credential)\\w*|leak(?:s|ed|ing)?|bypass\\w*|" +
    "insecure\\w*|unsafe\\w*|unsanitis\\w*|unsanitiz\\w*|unescaped|unvalidated|spoof\\w*|tamper\\w*|" +
    "brute[- ]force|open redirect|prototype pollution|deserializ\\w*|deserialis\\w*" +
    "|" +
    // The same thing said in plain English.
    "any(?:one|body)\\b|any (?:logged-?in|signed-?in|authenticated|other)\\b|" +
    "some(?:one|body) else'?s|other (?:users?|people|customers?|accounts?|tenants?)'?|" +
    "without (?:logging in|signing in|authenticat\\w+|authoris\\w+|authoriz\\w+|permission|a session)|" +
    "can (?:read|see|view|change|modify|edit|delete|drop|access|impersonate|take over|run|execute)\\b" +
    ")",
  "i",
);

/**
 * Words that mean the code block coming up is the *corrected* code and not
 * the broken code being quoted back. Without this test an advisor reply that
 * shows the vulnerable line first would have its first block copied as the
 * fix, which is the one wrong answer this feature can give.
 */
const FIX_CUE_RE =
  /\b(fix(?:es|ed|ing)?|correct(?:ed|ion|ly)?|instead|replace(?:s|d)?|rewrit\w*|patch(?:ed)?|remediat\w*|mitigat\w*|harden(?:ed)?|safe version|secure version|should (?:be|use)|parameteris\w*|parameteriz\w*|prepared statement\w*|sanitis\w*|sanitiz\w*|escap\w*|validate\w*|allow-?list\w*)\b/i;

/** Horizontal rules, block HTML, image-only lines: structure, not sentences. */
const STRUCTURAL_RE = /^(?:[-*_]{3,}|<\/?[A-Za-z][^>]*>|!\[[^\]]*\]\([^)]*\))$/;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function sentences(text: string): string[] {
  return collapse(text)
    .split(/(?<=[.!?:])\s+(?=[A-Z"'`([])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/** At most two sentences: the prompt is an instruction, not a re-run of the report. */
function firstTwo(list: string[]): string | null {
  const text = list.slice(0, 2).join(" ");
  return text ? text : null;
}

/**
 * Reads every finding in a report or reply that has both a risk statement and
 * a corrected code block. Findings whose fix is prose only are not returned —
 * there is no code block for the button to live on.
 */
export function parseFindings(markdown: string): ParsedFinding[] {
  const findings: ParsedFinding[] = [];

  // Section state, reset at every heading.
  let risk: string | null = null;
  let heading = "";
  let location: { path: string; line: number | null } | null = null;
  let prose: string[] = [];
  let fixLines: string[] | null = null;
  /**
   * The last risk stated anywhere in the document, which survives headings.
   *
   * An advisor reply routinely puts the risk under one heading and the
   * corrected code under the next — a real one opens with the IDOR, explains
   * it under `### The Risk`, and only then reaches `### How to Fix It`. The
   * labelled formats never need this; the free-form one is unusable without
   * it. Only consulted when the section the fix is in states no risk itself.
   */
  let carried: string | null = null;
  /**
   * Which label's paragraph the next line belongs to. Risk statements wrap —
   * `**Risk:**` is one sentence, not one line — so a label owns every line
   * after it until a blank line or the next label.
   */
  let continuing: "risk" | "fix" | "other" | null = null;

  // The structured report nests a finding's own `### NTH-001 — title` heading
  // under a `### \`path/to/file.ts\`` one (see renderStructuredMarkdown), so
  // the path a finding belongs to can live in an earlier section.
  let inherited: { path: string; line: number | null } | null = null;

  const startSection = (text: string) => {
    // Whatever risk the section that just ended stated, before its prose is
    // thrown away.
    carried = risk || proseRisk(prose.join(" ")) || carried;
    risk = null;
    heading = text;
    location = null;
    prose = [];
    fixLines = null;
    continuing = null;
  };

  for (const item of tokenize(markdown)) {
    if (item.kind === "heading") {
      startSection(item.text);
      const where = extractLocation(item.text);
      if (where) {
        location = where;
        inherited = where;
      }
      continue;
    }

    if (item.kind === "line") {
      const text = item.text.trim();
      if (!text) {
        continuing = null;
        continue;
      }

      // Table rows carry the structured format's Location, and nothing else
      // in them is prose.
      if (text.startsWith("|")) {
        if (/\blocation\b/i.test(text)) {
          const cell = extractLocation(text.split("|").slice(2).join("|"));
          if (cell) location = cell;
        }
        continue;
      }

      const risked = labelValue(text, RISK_LABELS);
      if (risked !== null) {
        // A second risk label in one section is a second finding, so the
        // half-built one before it is abandoned rather than merged.
        risk = collapse(risked);
        prose = [];
        fixLines = null;
        continuing = "risk";
        continue;
      }

      const fixed = labelValue(text, FIX_LABELS);
      if (fixed !== null) {
        fixLines = fixed ? [fixed] : [];
        continuing = "fix";
        continue;
      }

      // Severity, Class, Detail and the rest: neither the risk nor the fix,
      // so they are dropped along with whatever lines they wrap onto.
      if (labelValue(text, OTHER_LABELS) !== null) {
        continuing = "other";
        continue;
      }

      if (continuing === "risk") risk = collapse(`${risk ?? ""} ${text}`);
      else if (continuing === "fix" && fixLines) fixLines.push(text);
      // Rules, block-level HTML and the like are structure, not sentences.
      else if (continuing !== "other" && !STRUCTURAL_RE.test(text)) prose.push(text);
      continue;
    }

    // ── A code block: decide whether it is a fix, and for what ──────────
    const fixText = fixLines;
    const context = prose.join(" ");
    const statedRisk = (risk || null) ?? proseRisk(context) ?? carried;
    continuing = null;

    // The heading counts towards "is this the fix" — `### How to Fix It` is
    // the cue, and the section under it may not repeat the word. It is
    // deliberately not part of `context`: a heading is a label, and quoting
    // it into the prompt's Fix line reads as a fragment.
    if (!statedRisk || !isFixBlock(fixText !== null, `${heading} ${context}`)) {
      // Not a finding's fix — the vulnerable code quoted back, a config
      // sample, a shell command. Reset so the next block is judged on its
      // own surroundings rather than these.
      prose = [];
      fixLines = null;
      continue;
    }

    findings.push({
      filePath: (location ?? inherited)?.path ?? null,
      line: (location ?? inherited)?.line ?? null,
      risk: statedRisk,
      fixSummary:
        fixText !== null
          ? firstTwo(sentences(fixText.join(" ")))
          : proseFix(context, statedRisk),
      code: item.code,
      language: item.language,
      codeOffset: item.offset,
    });

    // One fix per risk statement. A second block in the same section (a
    // migration, an example of the attack) is not another finding.
    risk = null;
    prose = [];
    fixLines = null;
  }

  return findings;
}

/**
 * Whether the block that just arrived is the corrected code.
 *
 * A `**Fix:**` label settles it. Without one — an ordinary advisor reply —
 * the prose leading into the block has to say so itself. Requiring that cue
 * is what keeps the button off the "here is your current code" block and off
 * every code block in a reply that is teaching rather than reporting.
 */
function isFixBlock(labelled: boolean, context: string): boolean {
  return labelled || FIX_CUE_RE.test(context);
}

/** The first sentence that actually describes the danger. */
function proseRisk(context: string): string | null {
  if (!VULN_SIGNAL_RE.test(context)) return null;
  return sentences(context).find((sentence) => VULN_SIGNAL_RE.test(sentence)) ?? null;
}

/** What the reply said about the fix, which is whatever came after the risk. */
function proseFix(context: string, statedRisk: string): string | null {
  const all = sentences(context);
  const at = all.indexOf(statedRisk);
  const after = at === -1 ? all : all.slice(at + 1);
  const cued = after.filter((sentence) => FIX_CUE_RE.test(sentence));
  return firstTwo(cued.length > 0 ? cued : after);
}

// ── The join back to the rendered document ──────────────────────────────

export type FixPromptIndex = {
  /** By the offset of the block's opening fence — unique per block. */
  byOffset: Map<number, string>;
  /**
   * By the code itself, for renderers that hand back no position. Two
   * identical fixes in one report collapse to one entry here, which is why
   * it is the fallback and not the key.
   */
  byCode: Map<string, string>;
};

/**
 * Builds the lookup components/message-content.tsx uses to hand each fenced
 * block its prompt. Returns null when the document has no findings, which is
 * most documents — the caller can then render exactly as it did before.
 */
export function indexFixPrompts(markdown: string): FixPromptIndex | null {
  const findings = parseFindings(markdown);
  if (findings.length === 0) return null;

  const byOffset = new Map<number, string>();
  const byCode = new Map<string, string>();
  for (const finding of findings) {
    const prompt = buildFixPrompt(finding);
    byOffset.set(finding.codeOffset, prompt);
    byCode.set(finding.code, prompt);
  }
  return { byOffset, byCode };
}
