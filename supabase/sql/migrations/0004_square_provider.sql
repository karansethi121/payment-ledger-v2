-- Adds 'square' as a recognized provider/source value alongside stripe/paypal,
-- for square-webhook (auto-capture) and square-sync (fee/payout sync).
-- Postgres has no ALTER CHECK, so each constraint is dropped and recreated
-- with the same definition plus 'square'.

alter table accounts drop constraint accounts_provider_check;
alter table accounts add constraint accounts_provider_check
  check (provider in ('stripe', 'paypal', 'square', 'invoice', 'other'));

alter table transactions drop constraint transactions_source_check;
alter table transactions add constraint transactions_source_check
  check (source in ('manual', 'stripe_webhook', 'paypal_webhook', 'square_webhook'));

alter table webhook_events drop constraint webhook_events_provider_check;
alter table webhook_events add constraint webhook_events_provider_check
  check (provider in ('stripe', 'paypal', 'square'));

alter table withdrawals drop constraint withdrawals_provider_check;
alter table withdrawals add constraint withdrawals_provider_check
  check (provider in ('stripe', 'paypal', 'square'));
