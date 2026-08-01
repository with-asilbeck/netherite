-- Usage tracking and tier enforcement.
-- Run this against your Supabase project (SQL editor or `supabase db push`).
--
-- Threat model for this migration, since it is the whole point of the
-- feature: a paying-or-not user must not be able to give themselves more
-- quota. Concretely they must not be able to (a) change their own tier,
-- (b) delete or backdate their own usage rows to reset a month, (c) insert
-- rows attributed to somebody else, or (d) race two requests through the
-- same last remaining unit of quota.
--
-- (a)-(c) are handled by RLS below: both tables are readable by their owner
-- and writable by *nobody* holding the anon/authenticated key. There are no
-- insert/update/delete policies at all, and with RLS enabled a missing
-- policy is a denial. Every write goes through the service_role key, which
-- bypasses RLS and lives only in server-side code.
-- (d) is handled by reserve_usage() below.


-- ── Tiers ───────────────────────────────────────────────────────────────
-- A user with no row here is treated as 'free' by the application, so this
-- table only ever needs rows for people who have actually upgraded. That
-- keeps signup free of a trigger that could fail and block registration.

create table if not exists public.user_tiers (
  user_id uuid primary key references auth.users (id) on delete cascade,
  tier text not null default 'free' check (tier in ('free', 'standard', 'pro', 'max')),
  updated_at timestamptz not null default now()
);

alter table public.user_tiers enable row level security;

-- Read-only, and only your own row. Deliberately no insert/update/delete
-- policy: tier changes come from Stripe webhooks / manual admin action
-- running under the service_role key. If a user could write here they could
-- simply set themselves to 'max' and every cap below becomes decoration.
create policy "user_tiers_select_own"
  on public.user_tiers
  for select
  to authenticated
  using (auth.uid() = user_id);


-- ── Usage ledger ────────────────────────────────────────────────────────
-- One row per metered action. Written at reservation time (before the LLM
-- call) and updated with real cost afterwards, so an in-flight request
-- already counts against the cap.

create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  action_type text not null check (action_type in ('chat', 'snippet', 'repo_scan')),
  -- Both nullable: they're filled in after the upstream call reports real
  -- numbers. A row with nulls still counts against the cap — quota is
  -- counted by row, never by a value the request could influence.
  tokens_used integer check (tokens_used is null or tokens_used >= 0),
  estimated_cost_usd numeric(12, 6) check (estimated_cost_usd is null or estimated_cost_usd >= 0),
  model text,
  created_at timestamptz not null default now()
);

-- The exact shape of the cap query: count rows for one user, one action,
-- since the start of the month.
create index if not exists usage_events_user_action_time_idx
  on public.usage_events (user_id, action_type, created_at desc);

-- The admin dashboard's per-month rollup across all users.
create index if not exists usage_events_time_idx
  on public.usage_events (created_at desc);

alter table public.usage_events enable row level security;

-- Same shape as user_tiers: own rows, read only. No delete policy is the
-- important half — otherwise "DELETE my usage_events" is a free quota
-- reset, and no amount of server-side checking upstream would stop it.
create policy "usage_events_select_own"
  on public.usage_events
  for select
  to authenticated
  using (auth.uid() = user_id);


-- ── Atomic reservation ──────────────────────────────────────────────────
-- Counting in the application and then inserting would leave a window where
-- N concurrent requests all read "9 used, limit 10" and all proceed. On the
-- repo_scan tier that window is worth real money, and it is trivially
-- reachable by firing parallel requests on purpose.
--
-- The transaction-scoped advisory lock serializes reservations per
-- (user, action) so the count and the insert are effectively one operation.
-- It is released automatically when the transaction ends, including on error.
--
-- SECURITY INVOKER (the default — deliberately not DEFINER): this runs with
-- the caller's privileges, so even if EXECUTE were somehow granted to a
-- normal user, the INSERT below would still be refused by usage_events' RLS.
-- The p_limit argument is therefore only trustworthy because the only role
-- that can both execute this and satisfy the insert is service_role.
create or replace function public.reserve_usage(
  p_user_id uuid,
  p_action_type text,
  p_limit integer
)
returns table (allowed boolean, used integer, event_id uuid)
language plpgsql
as $$
declare
  v_window_start timestamptz := date_trunc('month', now() at time zone 'utc') at time zone 'utc';
  v_used integer;
  v_id uuid;
begin
  if p_limit < 0 then
    raise exception 'reserve_usage: p_limit must not be negative';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_user_id::text || ':' || p_action_type, 0)
  );

  select count(*) into v_used
  from public.usage_events
  where user_id = p_user_id
    and action_type = p_action_type
    and created_at >= v_window_start;

  if v_used >= p_limit then
    return query select false, v_used, null::uuid;
    return;
  end if;

  insert into public.usage_events (user_id, action_type)
  values (p_user_id, p_action_type)
  returning id into v_id;

  return query select true, v_used + 1, v_id;
end;
$$;

-- Belt and braces on top of the RLS reasoning above: nobody but the service
-- role should even be able to call this.
revoke all on function public.reserve_usage(uuid, text, integer) from public;
revoke all on function public.reserve_usage(uuid, text, integer) from anon;
revoke all on function public.reserve_usage(uuid, text, integer) from authenticated;
grant execute on function public.reserve_usage(uuid, text, integer) to service_role;


-- ── Monthly usage summary ───────────────────────────────────────────────
-- Used by the per-user dashboard. Runs as the caller, so RLS restricts it
-- to the caller's own rows even though it takes no user argument.
create or replace function public.current_month_usage()
returns table (action_type text, event_count bigint, tokens_used bigint, cost_usd numeric)
language sql
stable
as $$
  select
    e.action_type,
    count(*) as event_count,
    coalesce(sum(e.tokens_used), 0) as tokens_used,
    coalesce(sum(e.estimated_cost_usd), 0) as cost_usd
  from public.usage_events e
  where e.user_id = auth.uid()
    and e.created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'
  group by e.action_type;
$$;

grant execute on function public.current_month_usage() to authenticated;


-- ── Admin rollup ────────────────────────────────────────────────────────
-- Per-user totals for the owner-facing dashboard. Aggregating in SQL rather
-- than pulling rows into the app avoids both a pagination bug (PostgREST
-- caps result sets, so a JS-side sum would silently undercount once there
-- are more rows than the cap) and holding every event in memory.
--
-- Takes an explicit month start so the dashboard can look at past months.
-- Locked to service_role like reserve_usage: this returns other people's
-- data, so being SECURITY INVOKER is not sufficient protection on its own —
-- but it does mean an accidental grant still yields only the caller's own
-- rows rather than everyone's.
create or replace function public.admin_usage_summary(p_since timestamptz)
returns table (
  user_id uuid,
  chat_count bigint,
  snippet_count bigint,
  repo_scan_count bigint,
  tokens_used bigint,
  cost_usd numeric,
  last_active timestamptz
)
language sql
stable
as $$
  select
    e.user_id,
    count(*) filter (where e.action_type = 'chat') as chat_count,
    count(*) filter (where e.action_type = 'snippet') as snippet_count,
    count(*) filter (where e.action_type = 'repo_scan') as repo_scan_count,
    coalesce(sum(e.tokens_used), 0) as tokens_used,
    coalesce(sum(e.estimated_cost_usd), 0) as cost_usd,
    max(e.created_at) as last_active
  from public.usage_events e
  where e.created_at >= p_since
  group by e.user_id
  order by coalesce(sum(e.estimated_cost_usd), 0) desc, count(*) desc;
$$;

revoke all on function public.admin_usage_summary(timestamptz) from public;
revoke all on function public.admin_usage_summary(timestamptz) from anon;
revoke all on function public.admin_usage_summary(timestamptz) from authenticated;
grant execute on function public.admin_usage_summary(timestamptz) to service_role;
