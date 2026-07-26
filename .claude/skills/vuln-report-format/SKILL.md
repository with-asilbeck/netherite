---
name: vuln-report-format
description: Enforces the standard output contract for any final vulnerability report shown to the user — one-sentence plain-English risk explanation plus a complete fix code block, no unexplained jargon. Use whenever producing a final vulnerability report, regardless of which scan or review produced the findings.
---

# Vulnerability Report Format

Use this skill as the final formatting pass whenever you're about to present
vulnerability findings to the user — whether they came from
`security-code-review`, `supabase-rls-audit`, `secret-scan`, or an ad-hoc
review. This is the contract the product promises users: a fast, plain-
English explanation plus a fix they can paste in.

## The contract

Every finding in a final report must have exactly these two parts, in this
order:

1. **One-sentence risk explanation.** Plain English. Say what an attacker
   could actually do, not the vulnerability's textbook name. No unexplained
   jargon — if you must name a concept (e.g., "IDOR"), define it inline in
   the same sentence.
   - Bad: "This endpoint is vulnerable to IDOR."
   - Good: "Anyone logged in can change the `userId` in this request to
     read another user's private data, since the server never checks that
     the requester owns that row."

2. **Complete fix code block.** The full corrected function or block, not a
   diff, not a snippet with `// ...` gaps, not pseudocode. It must be
   something the user can copy and paste in directly.

## Step 1: Assemble the report

For each finding, use this structure:

```
### [Severity] — [short title] ([file]:[line])

[One-sentence risk explanation in plain English.]

**Fix:**
```[language]
[complete corrected code]
```
```

Order findings by severity: Critical, High, Medium, Low.

## Step 2: Plain-language check

Before finalizing, reread each risk explanation and ask: would a developer
with no security background understand the actual consequence from this
sentence alone? If a term needs a security background to parse (CSRF, IDOR,
deserialization, RLS), either drop the term or explain it in the same
breath. The severity label and category name can stay technical — the risk
sentence itself must not require jargon to understand.

## Step 3: No partial fixes

If a complete fix isn't possible without more context (e.g., you don't know
the correct ownership column for an RLS policy, or the right validation
schema for a form), don't hand back a stub. State what's missing and ask
the user for the missing detail, rather than shipping a fix block with
placeholders like `<your logic here>`.

## Step 4: Consistency across a multi-finding report

When the report includes findings from multiple sub-scans (e.g., a full
repo scan mixing code review + RLS audit + secret scan results), normalize
them all into this single format before presenting — the user should not be
able to tell which sub-check produced which finding just from the
formatting.
