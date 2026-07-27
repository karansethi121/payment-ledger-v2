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

Right now this runs entirely in **Demo mode**: open `index.html` and it seeds itself with
sample data in `localStorage`, no backend required. Everything below is what it takes to
wire it to a real Supabase project and real Stripe/PayPal webhooks.

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

For each account you add:

- **Stripe accounts**: paste the Stripe Payment Link's ID (`plink_...`, found in the
  Stripe Dashboard under Payment Links) into "Stripe Payment Link ID". This is how the
  webhook knows which account a payment belongs to.
- **PayPal accounts**: paste the receiving PayPal account's email into "PayPal payee
  email" — same purpose.

You can leave these blank and only use manual entry if you don't want auto-capture yet.

## 4. Deploy the webhook functions

Requires the [Supabase CLI](https://supabase.com/docs/guides/cli) (already installed,
per `supabase --version` in this environment) and linking to your new project:

```bash
supabase link --project-ref your-project-ref
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
supabase secrets set PAYPAL_CLIENT_ID=...
supabase secrets set PAYPAL_CLIENT_SECRET=...
supabase secrets set PAYPAL_WEBHOOK_ID=...
supabase secrets set PAYPAL_API_BASE=https://api-m.paypal.com   # sandbox host while testing
supabase functions deploy stripe-webhook --no-verify-jwt
supabase functions deploy paypal-webhook --no-verify-jwt
```

Then:
- **Stripe** Dashboard → Developers → Webhooks → add endpoint
  `https://your-project-ref.supabase.co/functions/v1/stripe-webhook`, listening for
  `checkout.session.completed`. Copy its signing secret into `STRIPE_WEBHOOK_SECRET` above.
- **PayPal** Developer Dashboard → your app → Webhooks → add endpoint
  `https://your-project-ref.supabase.co/functions/v1/paypal-webhook`, subscribed to
  `PAYMENT.CAPTURE.COMPLETED`. Copy the webhook ID into `PAYPAL_WEBHOOK_ID` above.

**What's been tested vs. not:** the frontend (dashboard, wallet math, non-destructive
withdrawal, account/payment CRUD, the cloud-sync retry queue) has been exercised end to
end locally. The Stripe function's signature-verification algorithm was independently
validated against Stripe's documented HMAC scheme. Neither webhook function has been
tested against a live Stripe/PayPal delivery (this environment has no Docker, so the
local Supabase function emulator isn't available, and there are no live API credentials
to test against). Validate both with a real test payment before relying on auto-capture —
Stripe's CLI (`stripe listen --forward-to <url>` + `stripe trigger checkout.session.completed`)
and PayPal's sandbox webhook simulator are the standard ways to do that.

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
