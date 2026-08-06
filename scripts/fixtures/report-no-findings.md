# Security assessment — Benji8817/SQL-Injection-Demo

> ⚠️ **This scan did not complete. Do not read it as a clean result.**
>
> - The scanner's model provider rejected the calls in this scan for billing or quota reasons (HTTP 402), before any code was read. Top up or raise the quota on the account behind ANTHROPIC_API_KEY or GEMINI_API_KEY, then run the scan again. The two stages bill separately, so one working does not mean the other can run.
> - No verdict was produced for any of the 3 file(s): triage failed and the deep pass did not reach them.
> - Deep review failed for 3 file(s).
>
> No file was successfully reviewed, so the absence of findings below means nothing was examined — not that nothing is wrong.

| | |
|---|---|
| **Repository** | [Benji8817/SQL-Injection-Demo](https://github.com/Benji8817/SQL-Injection-Demo) |
| **Scan status** | ⚠️ Did not complete — no file was reviewed |
| **Ref** | default branch |
| **Generated** | 2026-08-05T17:58:56.617Z |
| **Files reviewed** | 0 of 3 triaged, 0 deep-reviewed |
| **Files with findings** | 0 |
| **Analysis depth** | Exploit-chain |
| **Duration** | 1.6s |

## Findings

**No findings are listed because no file was successfully reviewed.** This is not a statement about the security of this repository — see the scan status above.

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
