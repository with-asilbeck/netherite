"use client";

import { memo, type CSSProperties } from "react";
import SyntaxHighlighter from "react-syntax-highlighter/dist/esm/prism-light";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import diff from "react-syntax-highlighter/dist/esm/languages/prism/diff";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";

import { CopyButton, CopyFixPromptButton } from "@/components/copy-button";

/**
 * `prism-light` registers nothing by default -- every grammar is opt-in, which
 * is the point: the full `prism` build pulls in ~300 languages. This list is
 * the six the security-review prompts actually emit (javascript, typescript,
 * python, sql, json, bash) plus the ones the advisor reaches for often enough
 * to be worth the bytes: jsx/tsx for React fixes, markup for XSS examples,
 * yaml for CI and config, diff for before/after patches.
 *
 * Registering a grammar also registers whatever it is built on (typescript
 * pulls javascript, which pulls markup + clike) and its own aliases, so `js`,
 * `ts`, `py`, `sh`, `shell`, `yml`, `html`, `xml` all resolve for free. The
 * ALIASES map below only covers what that does *not* give us.
 */
const LANGUAGES = {
  bash,
  diff,
  javascript,
  json,
  jsx,
  markup,
  python,
  sql,
  tsx,
  typescript,
  yaml,
};

for (const [name, grammar] of Object.entries(LANGUAGES)) {
  SyntaxHighlighter.registerLanguage(name, grammar);
}

/**
 * Fence hints a model writes that no registered grammar answers to. Without
 * these the block still renders -- an unknown language is caught upstream and
 * falls back to unhighlighted text -- it just renders flat, which looks like a
 * bug rather than a decision.
 */
const ALIASES: Record<string, string> = {
  console: "bash",
  dotenv: "bash",
  env: "bash",
  "sh-session": "bash",
  "shell-session": "bash",
  zsh: "bash",
  node: "javascript",
  javascriptreact: "jsx",
  typescriptreact: "tsx",
  python3: "python",
  py3: "python",
  mysql: "sql",
  postgres: "sql",
  postgresql: "sql",
  psql: "sql",
  sqlite: "sql",
  json5: "json",
  jsonc: "json",
};

/** Cased the way the language's own docs case it. */
const DISPLAY_NAMES: Record<string, string> = {
  bash: "Bash",
  diff: "Diff",
  javascript: "JavaScript",
  json: "JSON",
  jsx: "JSX",
  markup: "HTML",
  python: "Python",
  sql: "SQL",
  tsx: "TSX",
  typescript: "TypeScript",
  yaml: "YAML",
};

function normalizeLanguage(hint: string): string {
  const lower = hint.toLowerCase();
  return ALIASES[lower] ?? lower;
}

/**
 * Prism token classes mapped onto the theme's `--syntax-*` tokens. Colors are
 * `var()` references rather than literals so the palette stays in globals.css
 * with the rest of the theme -- see the block there for why there is one
 * palette instead of a light and a dark one.
 *
 * Anything not listed inherits `--code-foreground`, which is intentional:
 * `parameter`, `variable` in JS and plain identifiers read better left alone
 * than turned into a fourth color competing for attention.
 */
const SYNTAX_THEME: Record<string, CSSProperties> = {
  comment: { color: "var(--syntax-comment)", fontStyle: "italic" },
  prolog: { color: "var(--syntax-comment)", fontStyle: "italic" },
  doctype: { color: "var(--syntax-comment)", fontStyle: "italic" },
  cdata: { color: "var(--syntax-comment)", fontStyle: "italic" },
  shebang: { color: "var(--syntax-comment)", fontStyle: "italic" },

  punctuation: { color: "var(--syntax-punctuation)" },
  "template-punctuation": { color: "var(--syntax-punctuation)" },
  "interpolation-punctuation": { color: "var(--syntax-punctuation)" },

  operator: { color: "var(--syntax-operator)" },
  entity: { color: "var(--syntax-operator)" },
  url: { color: "var(--syntax-operator)" },

  keyword: { color: "var(--syntax-keyword)" },
  atrule: { color: "var(--syntax-keyword)" },
  rule: { color: "var(--syntax-keyword)" },
  selector: { color: "var(--syntax-keyword)" },
  tag: { color: "var(--syntax-keyword)" },
  // `important` is deliberately absent. Prism's bash grammar tags the shebang
  // with `shebang important`, and styling both leaves the two competing --
  // the shebang came out violet and bold, shouting over the ordinary `#`
  // comment on the next line. Leaving `important` unstyled lets `shebang`
  // win, and none of the registered grammars use it for anything else.

  string: { color: "var(--syntax-string)" },
  char: { color: "var(--syntax-string)" },
  regex: { color: "var(--syntax-string)" },
  "attr-value": { color: "var(--syntax-string)" },
  "template-string": { color: "var(--syntax-string)" },
  "triple-quoted-string": { color: "var(--syntax-string)" },
  inserted: { color: "var(--syntax-string)" },

  number: { color: "var(--syntax-number)" },
  boolean: { color: "var(--syntax-number)" },
  constant: { color: "var(--syntax-number)" },
  symbol: { color: "var(--syntax-number)" },
  null: { color: "var(--syntax-number)" },
  variable: { color: "var(--syntax-number)" },
  environment: { color: "var(--syntax-number)" },

  function: { color: "var(--syntax-function)" },
  "class-name": { color: "var(--syntax-function)" },
  "attr-name": { color: "var(--syntax-function)" },
  property: { color: "var(--syntax-function)" },
  builtin: { color: "var(--syntax-function)" },

  deleted: { color: "var(--syntax-alert)" },
};

/**
 * The highlighter wants to paint its own surface. It must not: the block sits
 * on `bg-code` so it stays in step with the rest of the theme, and a hardcoded
 * background here would survive a theme change that the token would not.
 */
const PRE_STYLE: CSSProperties = {
  margin: 0,
  padding: "0.75rem",
  background: "transparent",
  overflowX: "auto",
  fontSize: "13px",
  lineHeight: 1.6,
};

/**
 * One fenced code block: a header strip carrying the language and the copy
 * buttons, over the highlighted source.
 *
 * `fixPrompt` is set only when this block is the **Fix:** of a finding, and
 * message-content.tsx decides that — the block itself has no idea what it is
 * part of. When it is set, a footer appears under the code with a button that
 * copies the finding as an instruction for a coding agent instead of copying
 * the code. That footer is deliberately *not* in the header strip, which is
 * hidden until hover from `sm` up; a block with no fix prompt renders exactly
 * as it did before, with no footer at all.
 *
 * Memoized because the chat streams. Without it, every token appended to a
 * reply re-tokenizes *every* code block already rendered in that message, not
 * just the one still being written. With it, finished blocks hold their props
 * and are skipped, and only the block currently streaming is re-highlighted.
 * `fixPrompt` is a plain string, so it compares by value and does not defeat
 * that.
 */
export const CodeBlock = memo(function CodeBlock({
  code,
  language,
  fixPrompt,
}: {
  code: string;
  language?: string;
  fixPrompt?: string;
}) {
  const normalized = language ? normalizeLanguage(language) : "";
  const label = normalized ? (DISPLAY_NAMES[normalized] ?? normalized) : "code";

  return (
    // A named group: the message row in chat-view.tsx is already an unnamed
    // `group`, and an unnamed `group-hover` here would also fire when the
    // pointer is anywhere else in the message.
    <div className="group/code mb-3 overflow-hidden rounded-lg bg-code last:mb-0">
      <div className="flex h-8 items-center justify-between gap-2 border-b border-code-hover pl-3 pr-1">
        <span className="font-mono text-[11px] leading-none tracking-wide text-code-muted select-none">
          {label}
        </span>
        {/* Same reveal the message-level copy button uses: always there on
            touch, where nothing can hover, and on hover/focus from `sm` up.
            Only the plain copy button lives here — the fix-prompt button is
            below the code and never hidden. */}
        <div className="flex min-w-0 items-center gap-0.5 opacity-100 transition-opacity focus-within:opacity-100 sm:opacity-0 sm:group-hover/code:opacity-100 sm:group-focus-within/code:opacity-100">
          <CopyButton text={code} tone="code" label={`Copy ${label} code`} />
        </div>
      </div>

      <SyntaxHighlighter
        language={normalized}
        style={SYNTAX_THEME}
        customStyle={PRE_STYLE}
        PreTag="pre"
        CodeTag="code"
        codeTagProps={{ className: "font-mono text-code-foreground" }}
      >
        {code}
      </SyntaxHighlighter>

      {/* The fix-prompt action, under the code it belongs to and outside the
          hover-revealed strip above, so it is visible at rest on every device.
          The line of text beside it is what makes the button legible without a
          tooltip: "copy" on a code block reads as "copy the code", and this
          one copies something else entirely. */}
      {fixPrompt && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-code-hover px-3 py-2">
          <span className="min-w-0 text-[11px] leading-snug text-code-muted">
            Hand this fix to your coding agent
          </span>
          <CopyFixPromptButton prompt={fixPrompt} />
        </div>
      )}
    </div>
  );
});
