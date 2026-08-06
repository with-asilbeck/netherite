# Security assessment — Benji8817/SQL-Injection-Demo

| | |
|---|---|
| **Repository** | [Benji8817/SQL-Injection-Demo](https://github.com/Benji8817/SQL-Injection-Demo) |
| **Scan status** | Complete |
| **Ref** | default branch |
| **Generated** | 2026-08-05T17:58:56.617Z |
| **Files reviewed** | 3 of 3 triaged, 3 deep-reviewed |
| **Files with findings** | 1 |
| **Analysis depth** | Exploit-chain |
| **Duration** | 1.6s |

## Findings

### `sql-injection-activity/app.js`

### NTH-001 — SQL Injection via String Interpolation in Supabase RPC Call

| | |
|---|---|
| **Severity** | Critical |
| **Class** | SQL injection |
| **Location** | `sql-injection-activity/app.js`:26 |
| **Confidence** | Confirmed |

**Risk:** An unauthenticated attacker can execute arbitrary SQL queries against the underlying database, allowing them to extract sensitive data across all tables or manipulate database records.

**Detail:** The `email` query parameter is extracted directly from `request.url` and interpolated into a raw SQL query string without sanitization or parameterization. That SQL string is sent directly to the database via Supabase's `exec_sql` RPC call. An attacker sending a request like `GET /api/profiles?email=' UNION SELECT id, table_name, column_name FROM information_schema.columns--` can extract full database structure and contents.

**Fix:**
```javascript
export async function GET(request) {
  const url = new URL(request.url);
  const email = url.searchParams.get("email");

  if (!email) {
    return Response.json({ error: "Email query parameter is required" }, { status: 400 });
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

### Summary

1 Critical finding.

Fix **NTH-001** immediately: replace the concatenated raw SQL string and `exec_sql` RPC call with Supabase's built-in, parameterized query builder (`supabase.from('profiles').select().eq('email', email)`) to eliminate arbitrary SQL execution risks.

## Scope and limitations

This is a static review of source files only. It does not cover runtime configuration, deployment, infrastructure, dependencies, or any code excluded below.

- Files sent to triage: **3**
- Files triage actually assessed: **0**
- Files deep-reviewed: **0**
- Deep reviews that failed: **3**
- Files flagged in triage: **3**
- Excluded before scanning: **5** (directories: 1, extension: 3, lockfile: 1)

### Files flagged in triage

- `sql-injection-activity/app.js` — Triage failed — the model provider is out of credit or quota; escalated for review.
- `package.json` — Triage failed — the model provider is out of credit or quota; escalated for review.
- `sql-injection-activity/index.html` — Triage failed — the model provider is out of credit or quota; escalated for review.

### Files that failed deep review

- `sql-injection-activity/app.js` — Skipped — the scanner's model provider ran out of credit or quota earlier in this scan.
- `package.json` — Skipped — the scanner's model provider ran out of credit or quota earlier in this scan.
- `sql-injection-activity/index.html` — Skipped — the scanner's model provider ran out of credit or quota earlier in this scan.
