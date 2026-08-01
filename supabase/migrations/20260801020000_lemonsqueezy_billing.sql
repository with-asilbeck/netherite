-- Lemon Squeezy billing: subscriptions + payment history.
-- Run this against your Supabase project (SQL editor or `supabase db push`).
--
-- Threat model, continuing the one in 20260731000000_usage_tracking.sql: a
-- user must not be able to give themselves a paid tier. That migration made
-- `user_tiers` read-only to `authenticated`; this one does the same for the
-- two tables that now actually decide what somebody is entitled to. Neither
-- table has an insert/update/delete policy, and with RLS enabled a missing
-- policy is a denial — so the only writer is the service_role key, which
-- lives only in the webhook route. Tier and status therefore cannot change
-- except as the result of a signature-verified Lemon Squeezy event.


-- ── Rename the 'standard' tier to 'basic' ───────────────────────────────
-- The billing spec, the Lemon Squeezy products, and the pricing page all
-- call the entry paid tier "Basic". `user_tiers` was written with
-- 'standard'. One vocabulary is worth a rename: two names for one tier is
-- how a cap gets read from the wrong row later.
--
-- Safe to run as a data update because `user_tiers` is empty in every
-- environment at the time of writing (verified against production before
-- writing this). The update is still here so the migration is correct if
-- that stops being true.
alter table public.user_tiers drop constraint if exists user_tiers_tier_check;
update public.user_tiers set tier = 'basic' where tier = 'standard';
alter table public.user_tiers
  add constraint user_tiers_tier_check check (tier in ('free', 'basic', 'pro', 'max'));


-- ── Subscriptions ───────────────────────────────────────────────────────
-- One row per user, not one per Lemon Squeezy subscription. A user who
-- cancels and later resubscribes gets a *new* LS subscription id, and what
-- the app needs to answer is always "what is this user entitled to right
-- now" — a single row makes that a primary-key lookup and makes it
-- impossible for two rows to disagree.
--
-- The cost of that choice is stale-event risk: the old subscription can
-- still emit `subscription_expired` after the new one is active. That is
-- handled in the webhook route by keying every update *except*
-- subscription_created on `lemonsqueezy_subscription_id`, so an event for a
-- superseded subscription matches no row and is ignored rather than
-- downgrading a paying customer.

create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,

  -- Nullable because a row can legitimately exist with no LS subscription
  -- behind it (a manual comp, or a row created before the first webhook
  -- lands). Unique so two users can never end up pointing at the same LS
  -- subscription — that would let one person's cancellation revoke
  -- another's access.
  lemonsqueezy_customer_id text,
  lemonsqueezy_subscription_id text unique,

  tier text not null default 'free' check (tier in ('free', 'basic', 'pro', 'max')),

  -- Null on the free tier: there is no billing period when nothing is
  -- being billed. Non-null is only meaningful alongside a paid tier.
  billing_period text check (billing_period is null or billing_period in ('monthly', 'yearly')),

  status text not null default 'active'
    check (status in ('active', 'cancelled', 'past_due', 'expired', 'refunded')),

  -- When paid access actually runs out. This is what makes `cancelled`
  -- different from `expired`: a cancelled subscription keeps its tier until
  -- this timestamp passes. Null means "no end date known", which the
  -- entitlement code treats as not-entitled for any non-active status.
  current_period_end timestamptz,

  -- For a future CLI. Stored now because it is only available at the moment
  -- the order is created; going back for it later means reconciling orders.
  license_key text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The webhook's lookup path for every event after subscription_created.
create index if not exists subscriptions_ls_subscription_idx
  on public.subscriptions (lemonsqueezy_subscription_id);

alter table public.subscriptions enable row level security;

-- Read your own row, and nothing else. Deliberately no write policy: if a
-- user could write here they would set themselves to 'max'/'active' and
-- every cap in lib/usage becomes decoration. See the header comment.
create policy "subscriptions_select_own"
  on public.subscriptions
  for select
  to authenticated
  using (auth.uid() = user_id);


-- ── Payment history ─────────────────────────────────────────────────────
-- An append-only record of money actually moving. Written only by
-- subscription_payment_success (a new row) and subscription_payment_refunded
-- (flipping `refunded` on the matching row). Nothing here feeds entitlement
-- — that is the point of keeping it in its own table.

create table if not exists public.payment_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  -- The Lemon Squeezy subscription id, as text, matching
  -- subscriptions.lemonsqueezy_subscription_id. Not a foreign key on
  -- purpose: payment history must survive the subscription row being
  -- replaced when somebody resubscribes.
  subscription_id text,

  -- The invoice this row came from. Unique, and it is what makes the
  -- webhook idempotent: Lemon Squeezy retries deliveries, and without this
  -- a retried renewal would bill the history table twice. It is also how
  -- subscription_payment_refunded finds the row to mark.
  lemonsqueezy_invoice_id text unique,
  lemonsqueezy_order_id text,

  -- Cents, as Lemon Squeezy reports it. Integer rather than numeric because
  -- that is the unit on the wire; formatting is the UI's job.
  amount integer not null check (amount >= 0),
  currency text not null default 'USD',

  status text not null check (status in ('success', 'refunded', 'failed')),
  paid_at timestamptz not null,
  refunded boolean not null default false,

  created_at timestamptz not null default now()
);

-- The billing-history list: one user's payments, newest first.
create index if not exists payment_history_user_paid_at_idx
  on public.payment_history (user_id, paid_at desc);

alter table public.payment_history enable row level security;

create policy "payment_history_select_own"
  on public.payment_history
  for select
  to authenticated
  using (auth.uid() = user_id);


-- ── updated_at ──────────────────────────────────────────────────────────
-- Set in the trigger rather than by the application so it is true even for
-- a write made by hand in the SQL editor.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists subscriptions_set_updated_at on public.subscriptions;
create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();
