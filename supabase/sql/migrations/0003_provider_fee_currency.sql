-- stripe.balanceTransactions fee/net are denominated in the account's
-- settlement currency (e.g. GBP for a UK Stripe account), not necessarily
-- the original charge currency stored in transactions.currency (e.g. USD).
-- Without this, provider_fee/provider_net get displayed as if they were in
-- the same currency as the charge, silently misreporting the amount.

alter table transactions
  add column if not exists provider_currency text;
