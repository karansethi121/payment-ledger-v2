-- Adds the columns stripe-sync (and later paypal-sync) needs to store real
-- balance/fee/payout data pulled from the provider's own API, instead of
-- relying only on webhook-ingested gross charge amounts. Purely additive --
-- safe to run against the live database (see schema.sql for the equivalent
-- inline in a fresh deployment).

alter table accounts
  add column if not exists balance_available numeric(14,2),
  add column if not exists balance_currency text,
  add column if not exists balance_synced_at timestamptz;

alter table withdrawals
  add column if not exists provider text check (provider in ('stripe', 'paypal')),
  add column if not exists provider_payout_id text;

create unique index if not exists withdrawals_provider_payout_id_idx
  on withdrawals(provider_payout_id) where provider_payout_id is not null;

alter table transactions
  add column if not exists provider_fee numeric(14,2),
  add column if not exists provider_net numeric(14,2);
