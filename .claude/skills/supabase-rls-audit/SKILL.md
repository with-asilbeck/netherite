---
name: supabase-rls-audit
description: Audits Supabase schema and Row Level Security policies for missing or unsafe RLS, flags USING (true) or missing policies, and simulates cross-user access. Use whenever reviewing Supabase schema, migrations, or client-side supabase.from() queries.
---

# Supabase RLS Audit

Use this skill whenever reviewing Supabase schema files, SQL migrations, or
any code that queries Supabase — especially client-side `supabase.from()`
calls.

## Step 1: Inventory tables and queries

- Find all table definitions (migration files, `schema.sql`, or Supabase
  dashboard exports if provided).
- Find every `supabase.from(...)` call across the codebase, noting whether
  it runs client-side (in a Client Component / browser context) or
  server-side (API route, server action, using the service role key).
- Per the project convention, client components should never query Supabase
  directly — flag any client-side `supabase.from()` call as a finding on its
  own, separate from RLS issues.

## Step 2: Check RLS status per table

For each table, determine:

1. **Is RLS enabled?** Look for `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`.
   If missing, this is a **Critical** finding — the table is fully exposed
   to anyone with the anon key if any policy would otherwise allow access,
   and fully locked if not, but should be enabled explicitly regardless.
2. **Do policies exist for all needed operations?** Check SELECT, INSERT,
   UPDATE, DELETE separately — a table can have a safe SELECT policy but a
   wide-open UPDATE policy.
3. **Is any policy `USING (true)` or `WITH CHECK (true)`?** This is always a
   **Critical** finding — never suggest this as a fix, per project rules.
4. **Does the policy actually scope by owner?** A correct policy should
   reference the row's owner column against `auth.uid()`, e.g.:
   ```sql
   USING (auth.uid() = user_id)
   ```
   Watch for policies that check the wrong column, use `auth.uid()` loosely
   (e.g., comparing against a nullable or spoofable column), or scope by a
   value the client can control.

## Step 3: Simulate cross-user access

For each table with row ownership (has a `user_id` or similar column):

- Walk through: "Could authenticated User B, using their own valid session,
  read/update/delete a row belonging to User A?"
- Trace this through the actual policy SQL, not assumptions. If the policy
  is missing, `USING (true)`, or scoped incorrectly, the answer is yes —
  mark it exploitable.
- Note any table where this check can't be determined from available files
  (e.g., policy defined only in the Supabase dashboard, not in migrations)
  and say so explicitly rather than assuming it's safe.

## Step 4: Report format

For each table, output:

```
### Table: [table_name] — Risk: [Critical | High | Medium | Low | OK]

[One-sentence explanation of the issue, or "RLS correctly scoped to
owner" if OK.]

**Cross-user read/write test:** [Yes, exploitable — explain how | No |
Cannot determine from available files]

**Corrected policy:**
```sql
[complete CREATE POLICY / ALTER TABLE statements — full, runnable SQL,
not a fragment]
```
```

Only include the "Corrected policy" block when there is an actual issue to
fix. For tables that are already correctly scoped, just state that they're
OK — no SQL block needed.

## Step 5: Never suggest USING (true)

If a policy is broken and the "quick fix" would be to loosen it to
`USING (true)` or remove RLS entirely, do not suggest this — even as a
temporary measure. Propose the correctly scoped policy instead, and if the
right scoping isn't obvious from context, ask the user what ownership model
the table uses rather than guessing with an open policy.
