-- Per-action usage windows.
--
-- Until now every cap was counted over the calendar month. Messages are now
-- capped per *day* instead, because that is what makes "unlimited messages
-- with a fair-use ceiling" expressible: a monthly message cap is either so
-- large it stops nothing, or small enough that one heavy day exhausts the
-- month and a paying customer is locked out for three weeks.
--
-- Snippets and repo scans stay monthly — those are the advertised numbers.
--
-- The window is passed in by the caller rather than derived from the action
-- name here, so there is exactly one place (ACTION_WINDOWS in
-- lib/usage/tiers.ts) that decides it, and this function cannot silently
-- disagree with the application about which window a cap uses.


-- ── reserve_usage, now window-aware ─────────────────────────────────────
-- Replaces the 3-argument version. The old one is dropped rather than left
-- alongside: PostgREST resolves overloads by argument names, and leaving a
-- monthly-only variant callable would mean a future caller could reserve a
-- daily-capped action against a monthly window and quietly get 30x the
-- allowance.
--
-- Everything else is unchanged from 20260731000000_usage_tracking.sql and
-- for the same reasons: the transaction-scoped advisory lock makes the
-- count and the insert one atomic operation so parallel requests cannot
-- spend the same last unit, and SECURITY INVOKER means even an accidental
-- EXECUTE grant would still be refused by usage_events' RLS on the insert.

create or replace function public.reserve_usage(
  p_user_id uuid,
  p_action_type text,
  p_limit integer,
  p_window text
)
returns table (allowed boolean, used integer, event_id uuid)
language plpgsql
as $$
declare
  v_window_start timestamptz;
  v_used integer;
  v_id uuid;
begin
  if p_limit < 0 then
    raise exception 'reserve_usage: p_limit must not be negative';
  end if;

  -- No default branch on purpose. An unrecognised window must be an error,
  -- not a fallback to the most permissive interpretation.
  if p_window = 'day' then
    v_window_start := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
  elsif p_window = 'month' then
    v_window_start := date_trunc('month', now() at time zone 'utc') at time zone 'utc';
  else
    raise exception 'reserve_usage: p_window must be day or month, got %', p_window;
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

revoke all on function public.reserve_usage(uuid, text, integer, text) from public;
revoke all on function public.reserve_usage(uuid, text, integer, text) from anon;
revoke all on function public.reserve_usage(uuid, text, integer, text) from authenticated;
grant execute on function public.reserve_usage(uuid, text, integer, text) to service_role;

drop function if exists public.reserve_usage(uuid, text, integer);


-- ── current_usage, now returning both windows ───────────────────────────
-- The dashboard needs the count in each action's *enforcement* window (to
-- show how much is left) and the month's totals (for the cost table). One
-- function returning both beats two round trips, and more importantly beats
-- the page computing a window of its own that could disagree with the one
-- the cap is enforced against.
--
-- Still SECURITY INVOKER and still takes no user argument: RLS on
-- usage_events is what scopes it to the caller.

create or replace function public.current_usage()
returns table (
  action_type text,
  window_count bigint,
  month_count bigint,
  tokens_used bigint,
  cost_usd numeric
)
language sql
stable
as $$
  with bounds as (
    select
      date_trunc('day', now() at time zone 'utc') at time zone 'utc' as day_start,
      date_trunc('month', now() at time zone 'utc') at time zone 'utc' as month_start
  )
  select
    e.action_type,
    count(*) filter (
      where e.created_at >= case
        when e.action_type = 'chat' then (select day_start from bounds)
        else (select month_start from bounds)
      end
    ) as window_count,
    count(*) as month_count,
    coalesce(sum(e.tokens_used), 0) as tokens_used,
    coalesce(sum(e.estimated_cost_usd), 0) as cost_usd
  from public.usage_events e
  where e.user_id = auth.uid()
    and e.created_at >= (select month_start from bounds)
  group by e.action_type;
$$;

grant execute on function public.current_usage() to authenticated;

drop function if exists public.current_month_usage();
