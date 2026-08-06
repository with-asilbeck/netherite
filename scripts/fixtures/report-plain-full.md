## Security scan — Benji8817/SQL-Injection-Demo

> ⚠️ **This scan did not complete. Do not read it as a clean result.**
>
> - The scanner's model provider rejected the calls in this scan for billing or quota reasons (HTTP 402), before any code was read. Top up or raise the quota on the account behind ANTHROPIC_API_KEY or GEMINI_API_KEY, then run the scan again. The two stages bill separately, so one working does not mean the other can run.
> - No verdict was produced for any of the 3 file(s): triage failed and the deep pass did not reach them.
> - Deep review failed for 3 file(s).
>
> No file was successfully reviewed, so the absence of findings below means nothing was examined — not that nothing is wrong.

Attempted **3** files in 1.7s. See above for why the scan stopped.

### Findings

### app/api/profiles/route.js:10 — SQL injection

**Risk:** An attacker can manipulate the `email` URL parameter to execute arbitrary SQL commands, allowing them to extract secret data, bypass authentication, or modify the database.

**Fix:**
```javascript
export async function GET(request) {
  const url = new URL(request.url);
  const email = url.searchParams.get("email");

  if (!email) {
    return Response.json({ error: "Email parameter is required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, full_name")
    .eq("email", email);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json(data);
}
```

### sql-injection-activity/app.js:26 — SQL injection

**Risk:** An attacker can manipulate the `username` login field to execute arbitrary SQL commands, allowing them to extract secret data, bypass authentication, or modify the database.

**Fix:**
```javascript
export async function GET(request) {
  const url = new URL(request.url);
  const email = url.searchParams.get("email");

  if (!email) {
    return Response.json({ error: "Email parameter is required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, full_name")
    .eq("email", email);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json(data);
}
```

### Files flagged in triage

- `sql-injection-activity/app.js` — Triage failed — the model provider is out of credit or quota; escalated for review.
- `package.json` — Triage failed — the model provider is out of credit or quota; escalated for review.
- `sql-injection-activity/index.html` — Triage failed — the model provider is out of credit or quota; escalated for review.

### Files that failed deep review

- `sql-injection-activity/app.js` — Skipped — the scanner's model provider ran out of credit or quota earlier in this scan.
- `package.json` — Skipped — the scanner's model provider ran out of credit or quota earlier in this scan.
- `sql-injection-activity/index.html` — Skipped — the scanner's model provider ran out of credit or quota earlier in this scan.

### Coverage

- Files sent to triage: 3
- Files triage actually assessed: 0
- Files deep-reviewed: 0
- Deep reviews that failed: 3
- Excluded before scanning: 5 (directories: 1, extension: 3, lockfile: 1)