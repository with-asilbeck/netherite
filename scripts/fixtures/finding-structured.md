### NTH-001 — SQL Injection via String Interpolation in Supabase RPC Call

| | |
|---|---|
| **Severity** | Critical |
| **Class** | SQL injection |
| **Location** | `app/api/profiles/route.js`:10 |
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