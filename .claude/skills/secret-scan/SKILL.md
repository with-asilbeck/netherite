---
name: secret-scan
description: Deterministically scans a repo or file for exposed secrets — hardcoded API keys, NEXT_PUBLIC_-prefixed secrets, service_role keys in client code, and committed .env values — using scripted grep patterns rather than an LLM read-through alone. Use whenever scanning a repo or file for exposed secrets.
---

# Secret Scan

Use this skill whenever asked to scan a repo, directory, or file for exposed
secrets. Prefer the scripted checks below over eyeballing files — grep is
deterministic and won't miss occurrences the way a read-through can.

## Step 1: Run the scripted checks

Run these checks from the repo root. Adjust the path if scanning a
subdirectory or single file.

```bash
# 1. Common API key / token patterns (Supabase, Stripe, Google, GitHub, generic)
grep -rnE \
  -e 'sk_(live|test)_[A-Za-z0-9]{16,}' \
  -e 'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}' \
  -e 'ghp_[A-Za-z0-9]{36}' \
  -e 'AIza[0-9A-Za-z_-]{35}' \
  -e '(api|secret|access)[_-]?key["\x27]?\s*[:=]\s*["\x27][A-Za-z0-9_\-]{16,}' \
  --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git \
  . 2>/dev/null

# 2. service_role key specifically (Supabase) — check it never appears
#    outside server-only files
grep -rn "service_role" --include="*.ts" --include="*.tsx" --include="*.js" \
  --exclude-dir=node_modules --exclude-dir=.next .

# 3. NEXT_PUBLIC_ vars that look like they hold secrets
grep -rnE 'NEXT_PUBLIC_[A-Z_]*(KEY|SECRET|TOKEN|PASSWORD)' \
  --include="*.ts" --include="*.tsx" --include="*.env*" \
  --exclude-dir=node_modules --exclude-dir=.next .

# 4. .env files committed to git (should never be tracked)
git ls-files | grep -E '^\.env($|\.[^.]+$)' 
# if this repo isn't using git, instead check for .env files present
# without a corresponding .gitignore entry:
find . -maxdepth 2 -name ".env*" -not -name ".env.example" 2>/dev/null

# 5. Confirm .gitignore actually excludes env files
grep -n "^\.env" .gitignore 2>/dev/null
```

Note: the first pattern (`eyJ...`) matches JWT-shaped strings, which
includes Supabase anon/service keys. Anon keys appearing client-side are
expected; service_role keys appearing anywhere client-side are not — cross-
reference matches against Step 2.

## Step 2: Classify every match

For each match from Step 1, determine:

1. **Which file, which line.**
2. **Is it in a server-only context** (API route under `app/api/`, a file in
   `lib/` that's only imported server-side, a `.env.local` that's
   gitignored) **or client-exposed** (Client Component, anything imported
   into browser bundle, `NEXT_PUBLIC_` var, committed `.env`)?
3. **Severity:**
   - **Critical** — `service_role` key, Stripe secret key, or any LLM API
     key in a client-exposed location, or any secret committed to git
     history.
   - **High** — secret hardcoded in source (even server-side) instead of
     read from `process.env`.
   - **Medium** — `.env.example` or docs containing what looks like a real
     (non-placeholder) key instead of a placeholder.

## Step 3: Report format

```
### [file path]:[line number] — [secret type] — Risk: [Critical|High|Medium]

**Risk:** [one sentence: what an attacker who finds this can do]

**Fix:**
```[language]
[complete corrected code — read from process.env.X, with the key removed
from source, plus a note to rotate the exposed key since it's now
compromised]
```
```

If a secret was found committed to git history (not just the working tree),
say so explicitly and note that removing it from the current file is not
enough — the key must be rotated and history should be scrubbed
(`git filter-repo` or BFG), which requires explicit user confirmation before
running since it rewrites history.

## Step 4: Don't stop at grep

The scripted patterns catch common formats but not everything (e.g., custom
internal token formats, secrets split across concatenated strings). After
running the scripts, do a quick manual pass over any files the grep didn't
flag but that plausibly handle credentials (auth config, LLM client setup,
payment integration) to catch what the patterns miss.
