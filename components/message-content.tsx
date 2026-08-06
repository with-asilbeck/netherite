import type { Element, ElementContent } from "hast";
import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { CodeBlock } from "@/components/code-block";
import { indexFixPrompts, type FixPromptIndex } from "@/lib/fix-prompt";

/** Flattens a hast subtree back to the source text it was built from. */
function nodeText(node: ElementContent): string {
  if (node.type === "text") return node.value;
  if (node.type === "element") return node.children.map(nodeText).join("");
  return "";
}

/**
 * The fence's own language hint, which the model already writes (```sql) and
 * markdown carries through as a `language-sql` class. Nothing here hardcodes a
 * language -- it is read back off the parsed node.
 */
function fenceLanguage(node: Element): string | undefined {
  // hast types `className` as a string array, and that is what
  // mdast-util-to-hast produces for a fence -- exactly `["language-sql"]`.
  const classes = node.properties?.className;
  if (!Array.isArray(classes)) return undefined;

  for (const entry of classes) {
    if (entry.startsWith("language-")) return entry.slice("language-".length);
  }
  return undefined;
}

/**
 * Finds the prompt built for this block, if it is a finding's fix.
 *
 * By source offset first, because a report can legitimately contain the same
 * corrected code twice — the same missing auth check fixed the same way in two
 * routes — and only the offset tells those two apart so each carries its own
 * file path. The code itself is the fallback for the case where the parsed
 * tree comes back without positions.
 */
function fixPromptFor(node: Element | undefined, code: string, index: FixPromptIndex | null) {
  if (!index) return undefined;
  const offset = node?.position?.start?.offset;
  if (offset !== undefined) {
    const byOffset = index.byOffset.get(offset);
    if (byOffset) return byOffset;
  }
  return index.byCode.get(code);
}

function renderPre(
  node: Element | undefined,
  children: ReactNode,
  index: FixPromptIndex | null,
) {
  const child = node?.children[0];

  if (child?.type === "element" && child.tagName === "code") {
    // The trailing newline is an artifact of how the fence is parsed, not
    // part of the code -- strip it so it doesn't ride along to the clipboard
    // as a stray blank line.
    const code = nodeText(child).replace(/\n$/, "");
    return (
      <CodeBlock
        code={code}
        language={fenceLanguage(child)}
        fixPrompt={fixPromptFor(node, code, index)}
      />
    );
  }

  return (
    <pre className="mb-3 overflow-x-auto rounded-lg bg-code p-3 font-mono text-[13px] text-code-foreground last:mb-0 [&>code]:rounded-none [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit">
      {children}
    </pre>
  );
}

const markdownComponents: Components = {
  p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
  // 1.15/1.1em put h1 and h2 within ~2px of body text at the bubble's 15px —
  // technically larger, indistinguishable in practice. h3 stays where it was,
  // so the ladder reads 1.35 / 1.2 / 1.05 without the headings shouting.
  h1: ({ children }) => (
    <h1 className="mb-3 mt-4 text-[1.35em] font-semibold first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-3 mt-4 text-[1.2em] font-semibold first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-2 mt-3 text-[1.05em] font-semibold first:mt-0">{children}</h3>
  ),
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  ul: ({ children }) => <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="pl-1">{children}</li>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-2 hover:opacity-70"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mb-3 border-l-2 border-border pl-3 text-muted-foreground last:mb-0">
      {children}
    </blockquote>
  ),
  // Inline code only -- single backticks. A fenced block never reaches this,
  // because the `pre` below renders the block itself and never renders the
  // `code` child React would otherwise pass down. Deliberately plain: no
  // highlighting and no copy button on a two-word span mid-sentence.
  //
  // Absolute 13px, not `0.9em`: relative sizing compounded against the
  // enclosing block (13px x 0.9) and rendered code inside fenced blocks at
  // 11.7px, which is too small to read on a phone. Fixed size means inline
  // code and block code match at 13px wherever they appear.
  code: ({ children }) => (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[13px] text-foreground">
      {children}
    </code>
  ),
  // Fenced blocks are handled here rather than in `code` because this is the
  // only place the two can be told apart. react-markdown dropped the `inline`
  // prop in v9, and keying off "does it have a language class" would demote an
  // unlabelled ``` block to an inline span. `pre` wrapping `code` is exactly
  // the shape markdown gives a fenced block, and nothing else.
  //
  // Replaced per message when the message contains findings — see `preWith`.
  pre: ({ node, children }) => renderPre(node, children, null),
  hr: () => <hr className="my-4 border-border" />,
  table: ({ children }) => (
    <div className="mb-3 overflow-x-auto last:mb-0">
      <table className="w-full border-collapse text-left text-[0.95em]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-border px-2 py-1 font-semibold">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border-b border-border px-2 py-1 align-top">{children}</td>
  ),
};

// Renderer for **model-authored** text: assistant replies and repo-scan
// reports. Never render that content as plain text elsewhere — route it
// through this component so formatting can't drift between locations.
//
// User messages deliberately do NOT come through here. Markdown is a
// formatting language the model is writing on purpose and the user is not:
// running it over user input turns `**auth**.js` into bold and eats the
// number off a line starting `1997.`. They render literally, via
// components/user-message-content.tsx.
export function MessageContent({ content }: { content: string }) {
  // Read straight from the markdown, because the markdown is the only form
  // the finding exists in by the time it reaches the browser — see
  // lib/fix-prompt.ts. Null for anything with no findings in it, which is
  // most messages, and those render through the shared component map exactly
  // as they did before this existed.
  //
  // Not memoized: `content` changes on every streamed token, so a memo would
  // miss every time and only add a comparison. The scan is one linear pass
  // over a string react-markdown is already re-parsing on the same render.
  const fixPrompts = indexFixPrompts(content);

  const components: Components = fixPrompts
    ? { ...markdownComponents, pre: ({ node, children }) => renderPre(node, children, fixPrompts) }
    : markdownComponents;

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {content}
    </ReactMarkdown>
  );
}
