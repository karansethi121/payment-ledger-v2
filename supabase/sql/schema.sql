-- Payment Ledger v2 schema
-- Run this in a NEW Supabase project (SQL Editor), separate from the old
-- payment-ledger project, so the old app stays completely untouched.
--
-- Core idea vs v1: nothing is ever deleted. A "withdrawal" tags the deposits
-- it covers (withdrawal_id) instead of destroying them, so full history is
-- always recoverable and balances are always derived from the transaction
-- log, never hand-edited.

create extension if not exists "pgcrypto"; -- for gen_random_uuid() (still used by webhook_events)

-- accounts/withdrawals/transactions use client-generated text ids (not uuid)
-- because the app writes optimistically to localStorage before the network
-- round-trip completes, and needs an id up front to do that.
create table accounts (
  id text primary key,
  name text not null,
  provider text not null check (provider in ('stripe', 'paypal', 'square', 'invoice', 'other')),
  payment_link text,                 -- the buy.stripe.com / paypal.me link people pay into
  stripe_payment_link_id text,       -- Stripe's plink_xxx id -- used to match incoming webhooks to this account
  paypal_payee_email text,           -- used to match incoming PayPal webhooks to this account
  default_currency text not null default 'USD',
  archived boolean not null default false,   -- soft delete: never hard-delete an account with history
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  -- Set by the *-sync Edge Functions (stripe-sync, later paypal-sync) which
  -- call the provider's own Balance API -- this is what's actually sitting
  -- in Stripe/PayPal, not our own computed sum of unwithdrawn transactions.
  balance_available numeric(14,2),
  balance_currency text,
  balance_synced_at timestamptz
);

create table withdrawals (
  id text primary key,
  account_id text not null references accounts(id),
  currency text not null,               -- the currency the covered deposits were actually in
  gross numeric(14,2) not null,
  commission_pct numeric(5,2) not null default 0,
  commission_amt numeric(14,2) not null,
  net numeric(14,2) not null,           -- net in the ORIGINAL currency (post-commission, pre-conversion)
  payout_currency text not null,        -- what you actually chose to receive -- equals `currency` unless converted
  payout_net numeric(14,2) not null,    -- net converted into payout_currency (equals `net` when not converted)
  fx_rate_used numeric(14,6) not null default 1,  -- rate applied at withdrawal time, kept for audit even if FX Rates later change
  transaction_count integer not null default 0,
  created_at timestamptz not null default now(),
  -- Set only for withdrawals a *-sync Edge Function auto-created from a real
  -- provider payout (as opposed to one you built by hand in the withdraw
  -- modal) -- provider_payout_id makes re-running sync idempotent (a payout
  -- Stripe/PayPal already reported once is never recorded twice).
  provider text check (provider in ('stripe', 'paypal', 'square')),
  provider_payout_id text,
  -- Set once this withdrawal has been bundled into a settlement (see below)
  -- -- null means the money's still sitting in the bank, not yet forwarded.
  settlement_id text
);
create unique index withdrawals_provider_payout_id_idx on withdrawals(provider_payout_id) where provider_payout_id is not null;
create index withdrawals_settlement_idx on withdrawals(settlement_id);

-- Settlements: the second leg of the money's journey. A withdrawal moves
-- money from a provider (Stripe/PayPal/Square) into your bank; a settlement
-- is a separate, later event where you bundle several such withdrawals --
-- possibly from different accounts/providers, as long as they share a payout
-- currency -- into one lump payment out to your friend, taking commission
-- again at this step if you choose to. Mirrors the withdrawals/transactions
-- relationship: a settlement tags the withdrawals it covers instead of
-- destroying them, so each withdrawal's own commission stays intact and
-- auditable even after being folded into a settlement.
create table settlements (
  id text primary key,
  currency text not null,               -- the payout currency being bundled (must match every covered withdrawal's payout_currency)
  gross numeric(14,2) not null,         -- sum of payout_net across covered withdrawals, in `currency`
  commission_pct numeric(5,2) not null default 0,  -- additional cut taken at settlement time, on top of whatever each withdrawal already took
  commission_amt numeric(14,2) not null,
  net numeric(14,2) not null,           -- what actually gets sent to the friend
  withdrawal_count integer not null default 0,
  created_at timestamptz not null default now()
);
alter table withdrawals add constraint withdrawals_settlement_id_fkey foreign key (settlement_id) references settlements(id);

-- Deposits AND refunds/chargebacks live here, both as positive magnitudes --
-- `type` determines whether a row adds to or subtracts from the running
-- balance, never a negative `amount` (keeps every stored figure a plain
-- readable positive number; sign is a display/math concern, not a storage
-- one). A withdrawal is represented by a row in the withdrawals table plus
-- tagging the rows it covers (withdrawal_id) -- there is no separate
-- "withdrawal" transaction row, so there is exactly one place balances can
-- be computed from.
--
-- A refund/chargeback always subtracts from whatever's *currently* available,
-- not specifically from the deposit it corrects -- if that deposit was
-- already withdrawn, available balance can go negative, which is the correct
-- signal that the amount is now owed back on the next withdrawal.
create table transactions (
  id text primary key,
  account_id text not null references accounts(id),
  type text not null default 'deposit' check (type in ('deposit', 'adjustment', 'refund')),
  source text not null check (source in ('manual', 'stripe_webhook', 'paypal_webhook', 'square_webhook')),
  amount numeric(14,2) not null check (amount > 0),
  currency text not null,
  note text,
  external_ref text,                 -- provider's event/payment id -- traceability, not uniqueness (webhook_events handles dedupe)
  related_transaction_id text references transactions(id),  -- for refunds: the original deposit being corrected, if it could be matched
  withdrawal_id text references withdrawals(id),  -- set once this row is folded into a withdrawal; null = still pending
  occurred_at date not null default current_date,
  created_at timestamptz not null default now(),
  -- Backfilled by stripe-sync (later paypal-sync) from the provider's own
  -- Balance Transactions API -- what the processor actually took and what was
  -- actually left over, as opposed to `amount` which is the full charge. Null
  -- until synced at least once. fee/net are in provider_currency (the
  -- account's settlement currency, e.g. GBP for a UK Stripe account), which
  -- is not necessarily the same as `currency` (the original charge currency)
  -- above -- never assume they match.
  provider_fee numeric(14,2),
  provider_net numeric(14,2),
  provider_currency text
);

create index transactions_account_idx on transactions(account_id);
create index transactions_withdrawal_idx on transactions(withdrawal_id);

-- Idempotency + audit log for inbound webhooks. The unique constraint is what
-- stops a Stripe/PayPal retry from double-counting the same payment.
-- account_id is set once signature verification identifies which account the
-- event belongs to (nullable: verification-failed events are still logged
-- for audit purposes but obviously can't be attributed) -- this is what
-- powers the frontend's per-account webhook health indicator, since a
-- handler that throws after verification still leaves a row here (with
-- `error` set) even though it never produced a transaction.
create table webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('stripe', 'paypal', 'square')),
  external_event_id text not null,
  account_id text references accounts(id),
  payload jsonb not null,
  processed boolean not null default false,
  error text,
  received_at timestamptz not null default now(),
  unique (provider, external_event_id)
);
create index webhook_events_account_idx on webhook_events(account_id);

-- Balances are always computed from the ledger, never stored/mutated directly.
-- (app.js recomputes the same thing client-side; this view exists so you can
-- also query balances directly in the SQL editor / other reporting tools.)
create or replace view account_balances as
select
  a.id as account_id,
  a.name,
  a.provider,
  a.archived,
  t.currency,
  coalesce(sum(case
    when t.withdrawal_id is not null then 0
    when t.type = 'refund' then -t.amount
    else t.amount
  end), 0) as available_balance,
  coalesce(sum(case when t.type = 'deposit' then t.amount else 0 end), 0) as lifetime_deposits,
  coalesce(sum(case when t.type = 'refund' then t.amount else 0 end), 0) as lifetime_refunded,
  coalesce((
    select sum(w.gross) from withdrawals w where w.account_id = a.id and w.currency = t.currency
  ), 0) as lifetime_withdrawn,
  count(*) filter (where t.withdrawal_id is null and t.type = 'deposit') as pending_transaction_count
from accounts a
left join transactions t on t.account_id = a.id
group by a.id, a.name, a.provider, a.archived, t.currency;

-- Matches the existing v1 project's security posture (no RLS) since that's
-- the explicit choice already made for this tool. Revisit if this app starts
-- handling other people's data beyond your own small-team use case.
alter table accounts disable row level security;
alter table withdrawals disable row level security;
alter table transactions disable row level security;
alter table webhook_events disable row level security;
alter table settlements disable row level security;
