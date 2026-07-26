---
name: security-code-review
description: Reviews code for common web app vulnerabilities (SQL injection, XSS, broken auth, IDOR, hardcoded secrets, insecure deserialization, missing input validation, CSRF) and reports each with a risk explanation and a corrected code block. Use whenever reviewing any code — snippets, PRs, or full repos — for security issues.
---

# Security Code Review

Use this skill any time you are asked to review code for security issues,
whether it's a pasted snippet, a diff, or a full repository scan.

## Step 1: Identify the scope

- If given a snippet, review it directly.
- If given a repo or directory, walk source files under `app/`, `lib/`,
  `components/`, and any API routes. Skip `node_modules`, build output, and
  generated files.
- Prioritize files that handle user input, auth, database queries, or render
  user-controlled data.

## Step 2: Check for each vulnerability class

For every file in scope, check for:

1. **SQL injection** — string-concatenated or template-literal SQL, raw query
   builders fed unsanitized input, Supabase `.rpc()` calls with unescaped
   user input.
2. **XSS** — `dangerouslySetInnerHTML`, `innerHTML` assignment, unescaped
   template rendering of user-submitted content (code snippets, markdown,
   comments).
3. **Broken auth** — missing session checks on protected routes, auth logic
   that only runs client-side, trusting a client-supplied user ID instead of
   the session's.
4. **IDOR** — any query or mutation that takes an ID from the request
   (params, body, query string) and fetches/updates a row without verifying
   the authenticated user owns that row.
5. **Hardcoded secrets** — API keys, tokens, passwords, or connection strings
   written directly in source instead of read from environment variables.
6. **Insecure deserialization** — `eval`, `Function()`, unsafe `JSON.parse`
   of untrusted data feeding into dynamic execution, unsafe YAML/pickle-style
   loads.
7. **Missing input validation** — API routes or server actions that use
   `request.json()` / form data directly without shape/type validation
   before use.
8. **CSRF** — state-changing endpoints (POST/PUT/DELETE) that rely solely on
   cookies for auth with no CSRF token, origin check, or same-site
   protection.

## Step 3: Report every issue found

For each issue, output in this exact format:

```
### [file path]:[line number] — [vulnerability class]

**Risk:** [one sentence explaining the concrete impact — what an attacker
gains, not just the category name]

**Fix:**
```[language]
[complete corrected code block — not a diff fragment, not a snippet with
"..." — the full corrected function/block so it can be dropped in as-is]
```
```

If no issues are found in a file, do not include it in the report — only
report actual findings.

## Step 4: Never weaken a check to silence an error

If fixing one issue would require disabling, loosening, or bypassing another
security control (e.g., removing a type check to stop a build error, adding
`USING (true)` to fix an RLS error, skipping auth to fix a redirect loop):

- Do NOT make that change.
- Flag it explicitly in the report as its own finding, explain the tradeoff,
  and ask the user how they want to proceed.

This matches the project rule in CLAUDE.md: never weaken a security check
just to make an error go away.
