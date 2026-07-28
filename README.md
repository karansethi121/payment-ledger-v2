# Payment Ledger v2

A rebuild of the original [Payment Ledger](https://karansethi121.github.io/payment-ledger/),
same purpose (accounts, payment links, a ledger, cashing out) but a different core:

- **Auto-capture** — Stripe and PayPal webhooks log completed payments the moment they
  land. Manual entry becomes the fallback (invoice-only accounts, anything a webhook missed),
  not the main flow.
- **Refunds/chargebacks are corrections, not edits** — a refund posts as its own linked
  negative entry (`type = 'refund'`) against the account's running balance, same "never
  destroy history" principle as withdrawals. If the original deposit was already
  withdrawn, the balance can go negative -- that's correct, not a bug: it means the
  amount is now owed back on the next withdrawal.
- **Real wallets, not batch withdrawals** — every account has a running balance derived
  from its full transaction history. Withdrawing tags the covered deposits (and any
  pending refunds) as settled instead of deleting them, so nothing is ever destroyed and
  the full history stays visible (locked, not editable, but always there).
- **Auto-captured amounts are never editable or deletable** — whether a deposit or a
  refund, once it came from Stripe/PayPal directly it's treated as ground truth. Only
  manually-entered rows can be edited or deleted.
- **One dashboard** — balances, a 14-day trend per account, and a unified activity feed,
  instead of three separate tabs.
- **Webhook health, not just account activity** — `webhook_events` logs every verified
  delivery per account (including ones whose handler errored after verification), so a
  broken webhook shows up as its own warning distinct from "this account just hasn't had
  a sale in a while."

## Current status (this deployment)

- **Supabase project**: `payment-ledger-v2` (karansethi121 personal account, ref
  `zanmfrhhmruwebhakdwn`), schema applied, connected in `assets/app.js` -- mode pill
  shows "⚡ Supabase Live".
- **Stripe auto-capture**: deployed and verified working for both Stripe accounts
  (Karan Sethi, United Goods UK) -- confirmed end-to-end with real live payments landing
  correctly, tagged "⚡ Auto".
- **PayPal auto-capture**: deployed and verified working for both PayPal accounts
  (United Goods UK, Dilpreet Sethi) -- also confirmed with real live payments after
  fixing two webhooks that had never actually been subscribed on PayPal's side (the
  IDs given initially didn't correspond to real, saved webhooks).
- **Refunds/chargebacks**: code deployed (`charge.refunded` + `charge.dispute.funds_withdrawn`
  for Stripe, `PAYMENT.CAPTURE.REFUNDED` for PayPal), and **all webhook endpoints -- both
  Stripe and PayPal -- are now subscribed to the extra event types.** Not yet exercised
  against a real refund on either provider, so treat as wired-but-unverified until one
  actually happens; the per-account webhook health indicator will confirm it either way
  once it does.
- **Webhook health monitoring**: `webhook_events.account_id` (added directly against the
  live DB, and to `schema.sql` for future deployments) lets the frontend show a per-account
  "webhook error" / "Nd since webhook" / "no webhook activity" flag, separate from the
  general activity-based stale warning.
- **Stripe balance/fee/payout sync**: `stripe-sync` (new Edge Function) pulls real data
  straight from Stripe's own API on demand -- the ⟳ button on a Stripe account card. It (1)
  writes Stripe's actual available balance onto the account card, (2) backfills the real
  fee/net Stripe took per charge (shown in the withdraw modal, since the full charge amount
  was never what actually became available), and (3) reads Stripe's payout history and,
  since a payout's own `balance_transactions` list tells you *exactly* which charges it
  covered, auto-creates and tags the matching `withdrawals` row -- no manual checklist
  needed once a real payout has happened. Requires a **separate credential from the
  webhook secret** -- see its own section below.
- **PayPal balance/fee sync**: `paypal-sync` -- same ⟳ button, real balance + per-capture
  fee/net, reusing the OAuth credentials `paypal-webhook` already has. Deliberately skips
  payout reconciliation (see its own section below for why); those still go through the
  manual withdraw-modal checklist.

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

### Setting up `stripe-sync` (real balance/fee/payout data)

`STRIPE_ACCOUNTS_JSON` above only holds a **webhook signing secret** (`whsec_...`) --
enough to verify that an event really came from Stripe, but not enough to call Stripe's
Balance, Balance Transactions, or Payouts APIs. `stripe-sync` needs a real API key per
Stripe account, stored in its own secret so the webhook-verification secret and the
account-access key stay separate:

```bash
supabase secrets set STRIPE_API_KEYS_JSON='[{"accountId":"karan-stripe","apiKey":"rk_live_..."},{"accountId":"ugu-stripe","apiKey":"rk_live_..."}]'
supabase functions deploy stripe-sync
```

Use a **restricted key** (Stripe Dashboard -> Developers -> API keys -> Create restricted
key), not the full secret key -- read-only access to **Balance**, **Balance transactions**,
and **Payouts** is all this function ever calls. Same `accountId` values as
`STRIPE_ACCOUNTS_JSON`, one entry per Stripe account. Run the migration in
[`supabase/sql/migrations/0002_stripe_sync.sql`](supabase/sql/migrations/0002_stripe_sync.sql)
against the database first (`supabase/sql/schema.sql` already has these columns inline for
a brand-new project).

Unlike the webhook functions (deployed `--no-verify-jwt` since Stripe/PayPal call them with
no Supabase credential at all), `stripe-sync` is deployed **with** JWT verification -- the
frontend already sends the anon key automatically via `supabase.functions.invoke`, so this
costs the legitimate caller nothing, while ruling out completely credential-less requests.
It is not per-user authorization (this app has none anywhere -- single shared anon key, RLS
disabled by design, see `schema.sql`); anyone holding the anon key (which is public in
`assets/app.js`, same as every other table in this app) can still call it. What it does add:
CORS locked to the real site origin, and a one-sync-per-account-per-minute cooldown, so a
found or reused URL can't be used to hammer Stripe's API on the account's real key.

### Setting up `paypal-sync` (real balance/fee data)

Same idea as `stripe-sync`, deployed the same way (JWT verification, CORS locked to the
site origin, one-sync-per-minute cooldown):

```bash
supabase functions deploy paypal-sync
```

No new secret needed -- it reuses the `clientId`/`clientSecret` already in
`PAYPAL_ACCOUNTS_JSON` (the same OAuth client-credentials grant `paypal-webhook` already
uses to verify signatures works for other PayPal REST calls too). What it **does** need:
the **Transaction Search** API product enabled on each PayPal app (Developer Dashboard ->
Apps & Credentials -> your app -> Add features -> Transaction Search) -- without it, both
`/v1/reporting/balances` and `/v2/payments/captures/{id}` return `NOT_AUTHORIZED`, the same
class of permissions gap `stripe-sync`'s restricted key needed filled in.

**Deliberately does not attempt payout auto-reconciliation.** Stripe exposes
`balance_transactions?payout=...`, an itemized list of which charges a payout covered (for
its automatic payout schedule, at least). PayPal has no documented equivalent for "which
captures were included in this withdrawal to bank" -- a PayPal withdrawal sweeps the
available balance rather than transferring specific line items. Withdrawals from PayPal
accounts go through the manual withdraw-modal checklist, same as Stripe's manual-schedule
payouts already do.

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
supabase/sql/migrations/            Incremental changes to apply to an already-deployed DB
supabase/functions/stripe-webhook/  Auto-capture from Stripe
supabase/functions/paypal-webhook/  Auto-capture from PayPal
supabase/functions/stripe-sync/     On-demand real balance/fee/payout sync from Stripe's API
supabase/functions/paypal-sync/     On-demand real balance/fee sync from PayPal's API
```
