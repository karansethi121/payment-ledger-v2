# Payment Ledger v2

A rebuild of the original [Payment Ledger](https://karansethi121.github.io/payment-ledger/),
same purpose (accounts, payment links, a ledger, cashing out) but a different core:

- **Auto-capture** — Stripe and PayPal webhooks log completed payments the moment they
  land. Manual entry becomes the fallback (invoice-only accounts, anything a webhook missed),
  not the main flow.
- **Real wallets, not batch withdrawals** — every account has a running balance derived
  from its full transaction history. Withdrawing tags the covered deposits as settled
  instead of deleting them, so nothing is ever destroyed and the full history stays visible
  (locked, not editable, but always there).
- **One dashboard** — balances, a 14-day trend per account, and a unified activity feed,
  instead of three separate tabs.

## Current status (this deployment)

- **Supabase project**: `payment-ledger-v2` (karansethi121 personal account, ref
  `zanmfrhhmruwebhakdwn`), schema applied, connected in `assets/app.js` -- mode pill
  shows "⚡ Supabase Live".
- **Stripe auto-capture**: deployed and verified working for both Stripe accounts
  (Karan Sethi, United Goods UK) -- tested end-to-end with synthetic signed events,
  confirmed correct account routing, correct amount, and idempotency on retry.
- **PayPal auto-capture**: function deployed, not yet wired to real credentials.

Since Karan Sethi and United Goods UK are **separate Stripe accounts** (not two Payment
Links under one account), the Stripe function doesn't match by Payment Link ID -- each
Stripe account gets its own webhook endpoint pointing here, and whichever signing secret
verifies the incoming request tells us which ledger account it belongs to. That mapping
lives in the `STRIPE_ACCOUNTS_JSON` secret:

```bash
supabase secrets set STRIPE_ACCOUNTS_JSON='[{"accountId":"karan-stripe","secret":"whsec_..."},{"accountId":"ugu-stripe","secret":"whsec_..."}]'
```

`accountId` must match the `accounts.id` value in the database exactly (`karan-stripe`,
`ugu-stripe`). To add another Stripe account later: create its webhook endpoint in that
Stripe account's own dashboard pointing at the same function URL, get its signing secret,
and add another `{accountId, secret}` entry to the JSON array.

## Setting this up from scratch (a new deployment)

## 1. Create a new Supabase project

Use a **new, separate** Supabase project — not the one behind the old `payment-ledger`
site — so this stays fully independent of it.

In the new project's SQL Editor, run [`supabase/sql/schema.sql`](supabase/sql/schema.sql).
It creates `accounts`, `transactions`, `withdrawals`, `webhook_events`, and a read-only
`account_balances` view, with RLS disabled (matching the security posture already chosen
for the v1 project — revisit this if the app grows beyond your own small-team use).

## 2. Point the frontend at it

Open `assets/app.js` and fill in the two constants at the top:

```js
const SUPABASE_URL = 'https://your-project-ref.supabase.co';
const SUPABASE_KEY = 'your-anon-key';
```

Reload the page — the mode pill in the header should flip from "Demo mode" to
"⚡ Supabase Live". Add your real accounts via **+ Account** (this replaces the demo
seed data; nothing from Demo mode carries over automatically).

## 3. Add accounts, with the auto-capture matching fields

- **Stripe**: if each ledger account is a *separate Stripe account*, you don't need
  any per-account field here — see `STRIPE_ACCOUNTS_JSON` above, matching is done by
  webhook secret. If instead multiple ledger accounts share *one* Stripe account with
  different Payment Links, paste that link's id (`plink_...`, from the Stripe Dashboard)
  into "Stripe Payment Link ID" and use a single shared `STRIPE_WEBHOOK_SECRET` instead
  (this path exists in the account form but isn't the one currently wired up).
- **PayPal accounts**: paste the receiving PayPal account's email into "PayPal payee
  email" — this is how that function matches a payment to an account.

You can leave these blank and only use manual entry if you don't want auto-capture yet.

## 4. Deploy the webhook functions

Requires the [Supabase CLI](https://supabase.com/docs/guides/cli) (already installed,
per `supabase --version` in this environment) and linking to your new project:

```bash
supabase link --project-ref your-project-ref
supabase secrets set STRIPE_ACCOUNTS_JSON='[{"accountId":"...","secret":"whsec_..."}]'
supabase secrets set PAYPAL_CLIENT_ID=...
supabase secrets set PAYPAL_CLIENT_SECRET=...
supabase secrets set PAYPAL_WEBHOOK_ID=...
supabase secrets set PAYPAL_API_BASE=https://api-m.paypal.com   # sandbox host while testing
supabase functions deploy stripe-webhook --no-verify-jwt
supabase functions deploy paypal-webhook --no-verify-jwt
```

Then:
- **Stripe** — in *each* Stripe account you're wiring up, Dashboard → Developers →
  Webhooks → add endpoint `https://your-project-ref.supabase.co/functions/v1/stripe-webhook`,
  listening for `checkout.session.completed`. Each account gets its own signing secret --
  add it to `STRIPE_ACCOUNTS_JSON` alongside that account's `accountId`.
- **PayPal** Developer Dashboard → your app → Webhooks → add endpoint
  `https://your-project-ref.supabase.co/functions/v1/paypal-webhook`, subscribed to
  `PAYMENT.CAPTURE.COMPLETED`. Copy the webhook ID into `PAYPAL_WEBHOOK_ID` above.

**What's been tested vs. not:** the frontend (dashboard, wallet math, non-destructive
withdrawal, account/payment CRUD, the cloud-sync retry queue) and the Stripe function
(signature verification, account routing, idempotency) have been exercised end-to-end
against the live deployed project. The PayPal function's signature-verification call
to PayPal's API hasn't been tested against a live delivery yet (no PayPal credentials
configured so far) -- validate it with PayPal's sandbox webhook simulator once wired up.

## 5. Deploy the frontend

`index.html` + `assets/` is a static site — same deployment model as the old app
(GitHub Pages, or anywhere else that serves static files). No build step.

## Project layout

```
index.html                          Dashboard shell
assets/style.css                    Styles
assets/app.js                       All frontend logic (storage adapter, rendering, modals)
supabase/sql/schema.sql             Database schema for a new Supabase project
supabase/functions/stripe-webhook/  Auto-capture from Stripe
supabase/functions/paypal-webhook/  Auto-capture from PayPal
```
