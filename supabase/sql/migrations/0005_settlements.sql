-- Settlements: the second leg of the money's journey. A withdrawal moves
-- money from a provider (Stripe/PayPal/Square) into your bank; a settlement
-- is a separate, later event where you bundle several such withdrawals --
-- possibly from different accounts/providers, as long as they share a payout
-- currency -- into one lump payment out to your friend, taking commission
-- again at this step if you choose to.
--
-- Mirrors the withdrawals/transactions relationship exactly: a settlement
-- tags the withdrawals it covers (settlement_id) instead of destroying them,
-- so a withdrawal's own commission_pct/commission_amt/net stays intact and
-- auditable even after it's been folded into a settlement.

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

alter table withdrawals add column settlement_id text references settlements(id);
create index withdrawals_settlement_idx on withdrawals(settlement_id);

alter table settlements disable row level security;
