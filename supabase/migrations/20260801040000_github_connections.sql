-- GitHub account connections.
--
-- One row per Netherite user who has authorized the GitHub OAuth app. The
-- row exists to answer two questions: *which* GitHub account is this, and
-- *what token* do we call the GitHub API with when checking whether they may
-- scan a given repository.
--
-- Threat model, since the whole table is a credential store:
--
--   (a) `access_token` must never reach a browser. Two independent things
--       stop it. First, no code path selects it into a client response — the
--       only reader is server-side (lib/github/connection.ts). Second, and
--       the part that survives a future mistake in that code: the token
--       column is not SELECT-able by the `authenticated` role at all. See
--       the column-level grant below. A component that tried to read it with
--       the user's own client gets a permission error, not the token.
--
--   (b) A user must not be able to write a row — inserting somebody else's
--       user_id with their own token, or pointing their row at a GitHub
--       account they don't control, would defeat the ownership check that
--       gates scanning. There are no insert/update/delete policies, and with
--       RLS on, a missing policy is a denial. Every write goes through the
--       service-role key after an OAuth exchange this server performed.
--
--   (c) The row must not outlive the account. `on delete cascade` from
--       auth.users handles that.

create table if not exists public.github_connections (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- The login as of connect time. Display only: logins are renameable, so
  -- ownership comparisons use github_user_id, which is immutable.
  github_username text not null,
  github_user_id bigint not null,
  access_token text not null,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Deliberately not unique. The same GitHub account legitimately connects to
-- two Netherite accounts (personal + work), and every row is created only
-- after that GitHub account completed an OAuth round trip for that specific
-- user — so a duplicate proves possession twice rather than indicating
-- account takeover.
create index if not exists github_connections_github_user_id_idx
  on public.github_connections (github_user_id);

alter table public.github_connections enable row level security;

-- Read-only, own row only. Paired with the column grants below: the policy
-- decides *which rows*, the grant decides *which columns*, and the token is
-- excluded from the latter.
create policy "github_connections_select_own"
  on public.github_connections
  for select
  to authenticated
  using (auth.uid() = user_id);

-- Supabase grants table-wide privileges on public tables to anon/authenticated
-- by default. A table-level SELECT covers every column, which would make a
-- column-level revoke on access_token a no-op — so the table-level grant is
-- withdrawn first, then re-granted column by column, skipping the token.
revoke all on public.github_connections from anon;
revoke all on public.github_connections from authenticated;

grant select (user_id, github_username, github_user_id, connected_at, updated_at)
  on public.github_connections
  to authenticated;

-- service_role bypasses RLS but still needs the table privileges it just lost
-- if it was included in a blanket revoke elsewhere; granted explicitly so this
-- migration is self-contained.
grant all on public.github_connections to service_role;
