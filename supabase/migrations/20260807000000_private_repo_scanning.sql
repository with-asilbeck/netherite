-- Private repository scanning: GitHub App installations, consent, audit log.
--
-- Three tables, one per question:
--
--   github_app_installations — which GitHub App installation may this user
--     borrow a clone credential from?
--   private_scan_consents    — has this user been told, in as many words,
--     where their private code goes, and agreed?
--   private_scan_audit       — what private code was actually pulled, by
--     whom, and when?
--
-- Threat model, shared by all three:
--
--   (a) **A user must not be able to write any of these rows.** Writing
--       github_app_installations would mean pointing your account at somebody
--       else's installation and cloning their private code. Writing
--       private_scan_consents would mean granting yourself the consent you
--       never read. Writing private_scan_audit would mean erasing the record
--       of what you scanned. None of the three has an insert, update, or
--       delete policy, and with RLS on a missing policy is a denial — so the
--       `authenticated` role cannot write them at all. Every write in this
--       feature goes through the service-role key from server code.
--
--   (b) **Reads are own-row only**, which is what the task asks for and also
--       what keeps one customer from enumerating another's installations.
--
--   (c) **The rows must not outlive the account.** `on delete cascade` from
--       auth.users on all three. The audit log cascades too: it exists to
--       tell a user what was done with their code, not to survive them.
--
-- Deliberately absent: any column that could hold an installation access
-- token. Those are minted per scan and never persisted — see
-- lib/github/app.ts. There is no column here to put one in, which is a
-- stronger guarantee than a convention not to.

-- ── Installations ──────────────────────────────────────────────────────

create table if not exists public.github_app_installations (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- GitHub's numeric installation id. Not a secret on its own: it is useless
  -- without the App private key, which lives only in the server environment.
  installation_id bigint not null,
  -- The GitHub account the installation belongs to, captured at install time
  -- so the callback's ownership check can be re-verified later without a
  -- second round trip. Display and audit only.
  account_login text not null,
  account_id bigint not null,
  installed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One Netherite user per installation. A second user claiming the same
-- installation id would be claiming somebody else's private repositories,
-- and the callback verifies account ownership before writing — this
-- constraint is the structural backstop for that check.
create unique index if not exists github_app_installations_installation_id_key
  on public.github_app_installations (installation_id);

alter table public.github_app_installations enable row level security;

create policy "github_app_installations_select_own"
  on public.github_app_installations
  for select
  to authenticated
  using (auth.uid() = user_id);

revoke all on public.github_app_installations from anon;
revoke all on public.github_app_installations from authenticated;

grant select (user_id, installation_id, account_login, account_id, installed_at, updated_at)
  on public.github_app_installations
  to authenticated;

grant all on public.github_app_installations to service_role;

-- ── Consent ────────────────────────────────────────────────────────────

create table if not exists public.private_scan_consents (
  user_id uuid primary key references auth.users (id) on delete cascade,
  consent_given_at timestamptz not null default now(),
  -- Which wording they agreed to. The data-use terms this app quotes are
  -- other companies' policies and will change; a consent recorded against
  -- version 1 is not consent to version 2. Storing the version is what makes
  -- "re-ask when the terms change" possible without re-asking everybody on
  -- every deploy. See PRIVATE_SCAN_CONSENT_VERSION in lib/private-scan/consent.ts.
  consent_version integer not null,
  -- Captured for the same reason any consent record captures them: to be able
  -- to answer "who agreed, from where, when" if it is ever disputed.
  user_agent text,
  ip_address inet
);

alter table public.private_scan_consents enable row level security;

create policy "private_scan_consents_select_own"
  on public.private_scan_consents
  for select
  to authenticated
  using (auth.uid() = user_id);

revoke all on public.private_scan_consents from anon;
revoke all on public.private_scan_consents from authenticated;

-- The client is shown whether consent exists and which version — never the
-- IP or user agent, which are here for dispute resolution, not for display.
grant select (user_id, consent_given_at, consent_version)
  on public.private_scan_consents
  to authenticated;

grant all on public.private_scan_consents to service_role;

-- ── Audit log ──────────────────────────────────────────────────────────

create table if not exists public.private_scan_audit (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- owner/repo as GitHub spells it. Deliberately the full name and not a
  -- foreign key to anything: this is a record of an event, and it must stay
  -- readable after the repository is renamed or deleted.
  repo_full_name text not null,
  installation_id bigint not null,
  scanned_at timestamptz not null default now(),
  -- How the scan ended. A refused or failed scan is exactly as interesting as
  -- a successful one when the question is "what touched our private code".
  outcome text not null check (outcome in ('started', 'completed', 'failed')),
  -- Ties an audit row to the usage_events row that paid for it, so billing
  -- and access history can be reconciled without guessing by timestamp.
  usage_event_id uuid
);

create index if not exists private_scan_audit_user_id_scanned_at_idx
  on public.private_scan_audit (user_id, scanned_at desc);

alter table public.private_scan_audit enable row level security;

create policy "private_scan_audit_select_own"
  on public.private_scan_audit
  for select
  to authenticated
  using (auth.uid() = user_id);

revoke all on public.private_scan_audit from anon;
revoke all on public.private_scan_audit from authenticated;

grant select (id, user_id, repo_full_name, installation_id, scanned_at, outcome, usage_event_id)
  on public.private_scan_audit
  to authenticated;

grant all on public.private_scan_audit to service_role;
