import { CodeBlock } from "@/components/code-block";

/**
 * Renders a user's own message.
 *
 * Deliberately **not** react-markdown. Everything the user typed is literal
 * text: `**auth**.js` stays `**auth**.js`, a line starting `1997.` keeps its
 * number, and `# ` at the start of a line is a comment, not a heading. People
 * paste paths, globs, regexes and shell snippets into a security tool all day,
 * and a markdown parser silently eats them.
 *
 * The one exception is a fenced code block, which is detected by scanning
 * lines for a ``` fence — a string check, not a markdown parse — and handed to
 * the same CodeBlock the assistant side uses. That is a styling decision, not
 * a parsing one: the fence tells us where the code is, and nothing inside it
 * is interpreted.
 *
 * Nothing here can inject markup. Every value below reaches the DOM as a React
 * string child, which React escapes; there is no `dangerouslySetInnerHTML` on
 * this path, and Prism's tokenizer builds elements from substrings of the same
 * literal text rather than parsing it as HTML.
 */

type Segment =
  | { type: "text"; value: string }
  | { type: "code"; value: string; language?: string };

/**
 * An opening fence: up to three spaces of indent, three or more backticks,
 * then an optional language word. Anything else on the line means it is not a
 * fence, so a line like ```` ```js const x = 1 ```` stays prose.
 */
const OPEN_FENCE = /^ {0,3}(`{3,})[ \t]*([A-Za-z0-9_+#.-]*)[ \t]*$/;

/** A closing fence: at least as many backticks as the opener, nothing else. */
function closesFence(line: string, openLength: number): boolean {
  const match = /^ {0,3}(`{3,})[ \t]*$/.exec(line);
  return match !== null && match[1].length >= openLength;
}

/**
 * Splits a message into plain-text runs and fenced code blocks.
 *
 * Line-based rather than one global regex: a single `/```[\s\S]*?```/g` pass
 * cannot tell an opening fence from a closing one, so an odd number of fences
 * (or a stray ``` inside prose) silently swallows the rest of the message.
 */
export function splitFencedCode(content: string): Segment[] {
  const lines = content.split("\n");
  const segments: Segment[] = [];
  let pending: string[] = [];

  const flushText = () => {
    const value = pending.join("\n").replace(/^\n+|\n+$/g, "");
    // Whitespace-only runs are just the gap around a fence; spacing comes
    // from CSS, not from the newlines the user happened to type.
    if (value.trim().length > 0) segments.push({ type: "text", value });
    pending = [];
  };

  let i = 0;
  while (i < lines.length) {
    const open = OPEN_FENCE.exec(lines[i]);
    if (!open) {
      pending.push(lines[i]);
      i++;
      continue;
    }

    const body: string[] = [];
    let closed = false;
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (closesFence(lines[j], open[1].length)) {
        closed = true;
        break;
      }
      body.push(lines[j]);
    }

    flushText();
    segments.push({
      type: "code",
      value: body.join("\n"),
      // `open[2]` is "" for a bare ``` fence; CodeBlock labels that "code".
      language: open[2] || undefined,
    });
    // An unclosed fence runs to the end of the message, which is both what
    // markdown does and what a half-pasted snippet looks like.
    i = closed ? j + 1 : lines.length;
  }

  flushText();
  return segments;
}

export function UserMessageContent({ content }: { content: string }) {
  const segments = splitFencedCode(content);

  // No fence anywhere: one literal text run, which is the common case.
  if (segments.length === 1 && segments[0].type === "text") {
    return <PlainText value={segments[0].value} />;
  }

  return (
    <>
      {segments.map((segment, index) =>
        segment.type === "code" ? (
          <CodeBlock key={index} code={segment.value} language={segment.language} />
        ) : (
          <PlainText key={index} value={segment.value} />
        ),
      )}
    </>
  );
}

/**
 * `whitespace-pre-wrap` rather than the browser default: the user's line
 * breaks and indentation are content here. It still wraps, so a long pasted
 * URL cannot push the bubble wider than the column.
 */
function PlainText({ value }: { value: string }) {
  return <p className="mb-3 break-words whitespace-pre-wrap last:mb-0">{value}</p>;
}
