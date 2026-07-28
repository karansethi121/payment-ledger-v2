// Pulls real balance/fee/payout data from Stripe so the ledger reflects what
// Stripe's own dashboard shows, instead of relying only on the gross charge
// amounts stripe-webhook records as they come in. Invoked on demand from the
// frontend ("Sync with Stripe" button) -- unlike stripe-webhook, this is
// called by the browser, not by Stripe, so it needs CORS.
//
// Requires a REAL Stripe API key per account -- not the webhook-signing-only
// secret in STRIPE_ACCOUNTS_JSON. A restricted key with read-only access to
// Balance, Balance Transactions, and Payouts is enough:
//   supabase secrets set STRIPE_API_KEYS_JSON='[{"accountId":"karan-stripe","apiKey":"rk_live_..."},{"accountId":"ugu-stripe","apiKey":"rk_live_..."}]'
//   supabase functions deploy stripe-sync
//
// Deployed WITH JWT verification (no --no-verify-jwt) -- unlike
// stripe-webhook, which Stripe calls with no Supabase credential at all,
// this is called by the frontend, which already sends the anon key as a
// bearer token via supabase-js automatically, so requiring it costs the
// legitimate caller nothing. This app has no per-user auth anywhere (single
// shared anon key, RLS disabled by deliberate design -- see schema.sql), so
// there's no "is this caller allowed to sync this account" check to layer on
// top of that; what JWT verification actually buys here is ruling out
// completely credential-less requests (blind internet scanning), not
// per-user authorization. Given this function is the only place a real
// Stripe secret key gets used to call a third-party API, it also rate-limits
// itself per account (see MIN_SYNC_INTERVAL_MS below) so repeated calls
// can't be used to hammer Stripe's API or burn through its rate limit.
//
// Three things happen per call, all idempotent (safe to click "Sync" again):
//   1. Balance.retrieve() -> accounts.balance_available/currency/synced_at
//   2. PaymentIntent lookups backfill transactions.provider_fee/provider_net
//      for deposits that don't have it yet (capped per run; next sync picks
//      up where this one left off).
//   3. Payouts.list() + balance_transactions?payout=... tells us EXACTLY
//      which charges a real payout covered -- so instead of guessing (the
//      manual withdraw-modal checklist), a real payout auto-creates its own
//      withdrawals row and tags those transactions directly.

import Stripe from "npm:stripe@14";
import { createClient } from "npm:@supabase/supabase-js@2";

type StripeApiKeyConfig = { accountId: string; apiKey: string };

const STRIPE_API_KEYS: StripeApiKeyConfig[] = JSON.parse(Deno.env.get("STRIPE_API_KEYS_JSON") ?? "[]");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://karansethi121.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// One sync per account per minute, regardless of how many requests come in --
// bounds the worst case (unauthenticated but JWT-required callers hammering
// this endpoint) to a fixed rate of real Stripe API calls, independent of
// request volume.
const MIN_SYNC_INTERVAL_MS = 60_000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let accountId: string | undefined;
  try {
    ({ accountId } = await req.json());
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!accountId) return json({ error: "accountId is required" }, 400);

  const keyConfig = STRIPE_API_KEYS.find((k) => k.accountId === accountId);
  if (!keyConfig) {
    // Deliberately generic (no confirmation the account exists or is just
    // missing a key) -- costs nothing and avoids an enumeration oracle, even
    // though account ids aren't otherwise treated as secret in this app.
    return json({ error: "Sync is not available for this account." }, 404);
  }

  const { data: acct } = await supabase.from("accounts").select("balance_synced_at").eq("id", accountId).maybeSingle();
  if (acct?.balance_synced_at) {
    const sinceLast = Date.now() - new Date(acct.balance_synced_at).getTime();
    if (sinceLast < MIN_SYNC_INTERVAL_MS) {
      const wait = Math.ceil((MIN_SYNC_INTERVAL_MS - sinceLast) / 1000);
      return json({ error: `Synced too recently -- try again in ${wait}s.` }, 429);
    }
  }

  const stripe = new Stripe(keyConfig.apiKey, { apiVersion: "2023-10-16" });

  try {
    const balance = await syncBalance(stripe, accountId);
    const feesBackfilled = await syncFees(stripe, accountId);
    const { payoutsProcessed, newWithdrawals } = await syncPayouts(stripe, accountId);
    return json({ balance, feesBackfilled, payoutsProcessed, newWithdrawals });
  } catch (err) {
    console.error(`stripe-sync failed for ${accountId}:`, (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function syncBalance(stripe: Stripe, accountId: string) {
  const bal = await stripe.balance.retrieve();
  const entry = bal.available[0]; // these accounts only ever settle in one currency
  if (!entry) return null;
  const amount = entry.amount / 100;
  const currency = entry.currency.toUpperCase();
  const { error } = await supabase.from("accounts").update({
    balance_available: amount,
    balance_currency: currency,
    balance_synced_at: new Date().toISOString(),
  }).eq("id", accountId);
  if (error) throw new Error(`Failed to store balance: ${error.message}`);
  return { amount, currency };
}

async function syncFees(stripe: Stripe, accountId: string) {
  const { data: pending, error } = await supabase
    .from("transactions")
    .select("id, external_ref")
    .eq("account_id", accountId)
    .eq("source", "stripe_webhook")
    .eq("type", "deposit")
    .is("provider_fee", null)
    .order("occurred_at", { ascending: true })
    .limit(50);
  if (error) throw new Error(`Failed to load pending fee lookups: ${error.message}`);

  let count = 0;
  for (const t of pending ?? []) {
    if (!t.external_ref?.startsWith("pi_")) continue; // only PaymentIntent ids are fee-lookupable this way
    try {
      const pi = await stripe.paymentIntents.retrieve(t.external_ref, { expand: ["latest_charge.balance_transaction"] });
      const charge = pi.latest_charge as Stripe.Charge | null;
      const bt = charge?.balance_transaction as Stripe.BalanceTransaction | null;
      if (!bt) continue;
      const { error: updateError } = await supabase.from("transactions").update({
        provider_fee: bt.fee / 100,
        provider_net: bt.net / 100,
      }).eq("id", t.id);
      if (!updateError) count++;
    } catch (err) {
      console.warn(`Fee lookup failed for ${t.id} (${t.external_ref}):`, (err as Error).message);
    }
  }
  return count;
}

async function syncPayouts(stripe: Stripe, accountId: string) {
  const payouts = await stripe.payouts.list({ limit: 10 });
  let payoutsProcessed = 0;
  let newWithdrawals = 0;

  for (const payout of payouts.data) {
    payoutsProcessed++;
    const { data: existing } = await supabase.from("withdrawals").select("id").eq("provider_payout_id", payout.id).maybeSingle();
    if (existing) continue;

    const btxns = await stripe.balanceTransactions.list({ payout: payout.id, type: "charge", limit: 100, expand: ["data.source"] });
    const paymentIntentIds = btxns.data
      .map((bt) => (bt.source as Stripe.Charge | null)?.payment_intent)
      .map((pi) => (typeof pi === "string" ? pi : pi?.id))
      .filter((id): id is string => !!id);

    let matched: { id: string; amount: number; currency: string }[] = [];
    if (paymentIntentIds.length > 0) {
      const { data } = await supabase
        .from("transactions")
        .select("id, amount, currency")
        .eq("account_id", accountId)
        .in("external_ref", paymentIntentIds)
        .is("withdrawal_id", null);
      matched = data ?? [];
    }

    const currency = matched[0]?.currency ?? payout.currency.toUpperCase();
    const gross = matched.reduce((sum, t) => sum + Number(t.amount), 0);
    const withdrawalId = `stripe-payout-${payout.id}`;

    const { error: insertError } = await supabase.from("withdrawals").insert({
      id: withdrawalId,
      account_id: accountId,
      currency,
      gross,
      commission_pct: 0,
      commission_amt: 0,
      net: gross,
      payout_currency: payout.currency.toUpperCase(),
      payout_net: payout.amount / 100, // the actual amount Stripe transferred, net of Stripe's own fee
      fx_rate_used: 1,
      transaction_count: matched.length,
      created_at: new Date(payout.arrival_date * 1000).toISOString(),
      provider: "stripe",
      provider_payout_id: payout.id,
    });
    if (insertError) {
      console.warn(`Failed to record payout ${payout.id}:`, insertError.message);
      continue;
    }
    newWithdrawals++;

    if (matched.length > 0) {
      const { error: tagError } = await supabase
        .from("transactions")
        .update({ withdrawal_id: withdrawalId })
        .in("id", matched.map((t) => t.id));
      if (tagError) console.warn(`Failed to tag transactions for payout ${payout.id}:`, tagError.message);
    }
  }

  return { payoutsProcessed, newWithdrawals };
}
