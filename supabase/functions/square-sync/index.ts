// Pulls real fee/payout data from Square so the ledger reflects what
// Square's own dashboard shows, instead of relying only on the gross payment
// amounts square-webhook records as they come in. Invoked on demand from the
// frontend ("Sync" button) -- mirrors stripe-sync's structure and security
// posture (JWT required, CORS locked to the site origin, one-sync-per-minute
// cooldown; see that file for the fuller rationale).
//
// Requires a REAL Square API access token per account -- a genuinely
// different credential from the webhook signature key in
// SQUARE_ACCOUNTS_JSON, same reasoning as stripe-sync needing a separate key
// from stripe-webhook's signing-only secret. Generate a production Access
// Token from the Square Developer Dashboard -> your app -> Credentials (no
// OAuth client-credentials flow like Stripe/PayPal -- Square issues a
// long-lived token directly for a single-account integration like this one).
//   supabase secrets set SQUARE_API_KEYS_JSON='[{"accountId":"ugu-square","accessToken":"EAAA..."}]'
//   supabase functions deploy square-sync
//
// Unlike Stripe/PayPal, Square has NO "current balance" endpoint at all --
// money just settles into payouts on Square's schedule with no persistent
// balance to query. So this never writes accounts.balance_available for a
// Square account; the ledger's own computed sum is the only balance number
// that exists for this provider. It still writes balance_synced_at, reusing
// that column purely as the rate-limit cooldown marker.
//
// Two things happen per call:
//   1. GET /v2/payments/{id} backfills transactions.provider_fee/net from
//      each payment's processing_fee array (there's no separate "net"
//      field like Stripe/PayPal's breakdowns -- it's computed as
//      amount - total fee).
//   2. GET /v2/payouts + GET /v2/payouts/{id}/payout-entries returns the
//      exact payment ids bundled into a payout -- and per Square's docs,
//      this works for both a full-balance sweep and a partial payout, unlike
//      Stripe's equivalent lookup which only works for its automatic payout
//      schedule. So a real payout auto-creates and tags the matching
//      withdrawals row, same as stripe-sync -- expected to actually succeed
//      here rather than needing the manual-payout fallback stripe-sync has.
//
// Scoped to a merchant's default location (location_id omitted from the
// Payouts calls) -- fine for a single-location business; a multi-location
// account would need this extended to loop over locations.

import { createClient } from "npm:@supabase/supabase-js@2";

type SquareApiKeyConfig = { accountId: string; accessToken: string };

const SQUARE_API_KEYS: SquareApiKeyConfig[] = JSON.parse(Deno.env.get("SQUARE_API_KEYS_JSON") ?? "[]");
const SQUARE_API_BASE = Deno.env.get("SQUARE_API_BASE") ?? "https://connect.squareup.com";
const SQUARE_VERSION = "2025-01-23";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://karansethi121.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

  const keyConfig = SQUARE_API_KEYS.find((k) => k.accountId === accountId);
  if (!keyConfig) {
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

  try {
    const feesBackfilled = await syncFees(keyConfig.accessToken, accountId);
    const { payoutsProcessed, newWithdrawals, payoutsSkipped, skippedPayouts } = await syncPayouts(keyConfig.accessToken, accountId);
    await supabase.from("accounts").update({ balance_synced_at: new Date().toISOString() }).eq("id", accountId);
    return json({ feesBackfilled, payoutsProcessed, newWithdrawals, payoutsSkipped, skippedPayouts });
  } catch (err) {
    console.error(`square-sync failed for ${accountId}:`, (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function squareHeaders(accessToken: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Square-Version": SQUARE_VERSION,
    "Content-Type": "application/json",
  };
}

async function syncFees(accessToken: string, accountId: string) {
  const { data: pending, error } = await supabase
    .from("transactions")
    .select("id, external_ref")
    .eq("account_id", accountId)
    .eq("source", "square_webhook")
    .eq("type", "deposit")
    .is("provider_fee", null)
    .order("occurred_at", { ascending: true })
    .limit(50);
  if (error) throw new Error(`Failed to load pending fee lookups: ${error.message}`);

  let count = 0;
  for (const t of pending ?? []) {
    if (!t.external_ref) continue;
    try {
      const res = await fetch(`${SQUARE_API_BASE}/v2/payments/${t.external_ref}`, { headers: squareHeaders(accessToken) });
      const body = await res.json();
      if (!res.ok) {
        console.warn(`Fee lookup failed for ${t.id} (${t.external_ref}):`, JSON.stringify(body));
        continue;
      }
      const fees: Array<{ amount_money: { amount: number; currency: string } }> | undefined = body.payment?.processing_fee;
      if (!fees || fees.length === 0) continue;

      const currency = fees[0].amount_money.currency;
      const totalFee = fees.reduce((sum, f) => sum + f.amount_money.amount, 0) / 100;
      const grossAmount = (body.payment.amount_money?.amount ?? 0) / 100;
      const net = grossAmount - totalFee;

      const { error: updateError } = await supabase.from("transactions").update({
        provider_fee: totalFee,
        provider_net: net,
        provider_currency: currency,
      }).eq("id", t.id);
      if (!updateError) count++;
    } catch (err) {
      console.warn(`Fee lookup failed for ${t.id} (${t.external_ref}):`, (err as Error).message);
    }
  }
  return count;
}

async function syncPayouts(accessToken: string, accountId: string) {
  const res = await fetch(`${SQUARE_API_BASE}/v2/payouts?limit=10`, { headers: squareHeaders(accessToken) });
  const body = await res.json();
  if (!res.ok) throw new Error(`Payouts list failed: ${JSON.stringify(body)}`);

  const payouts: Array<{ id: string; amount_money: { amount: number; currency: string }; status: string; created_at: string }> = body.payouts ?? [];
  let payoutsProcessed = 0;
  let newWithdrawals = 0;
  let payoutsSkipped = 0;
  const skippedPayouts: { id: string; amount: number; currency: string; status: string; createdAt: string }[] = [];

  for (const payout of payouts) {
    payoutsProcessed++;
    const { data: existing } = await supabase.from("withdrawals").select("id").eq("provider_payout_id", payout.id).maybeSingle();
    if (existing) continue;

    let entries: Array<{ payment_id?: string }>;
    try {
      const entriesRes = await fetch(`${SQUARE_API_BASE}/v2/payouts/${payout.id}/payout-entries?limit=100`, { headers: squareHeaders(accessToken) });
      const entriesBody = await entriesRes.json();
      if (!entriesRes.ok) throw new Error(JSON.stringify(entriesBody));
      entries = entriesBody.payout_entries ?? [];
    } catch (err) {
      // Documented to work for both full and partial payouts, unlike
      // Stripe's equivalent -- but still handled defensively rather than
      // trusted blindly, same lesson learned from stripe-sync's manual-payout
      // failure. Skip and report rather than fail the whole sync.
      console.warn(`Skipping payout ${payout.id} (can't list its entries):`, (err as Error).message);
      payoutsSkipped++;
      skippedPayouts.push({
        id: payout.id,
        amount: payout.amount_money.amount / 100,
        currency: payout.amount_money.currency,
        status: payout.status,
        createdAt: payout.created_at?.slice(0, 10) ?? "",
      });
      continue;
    }

    const paymentIds = entries.map((e) => e.payment_id).filter((id): id is string => !!id);

    let matched: { id: string; amount: number; currency: string }[] = [];
    if (paymentIds.length > 0) {
      const { data } = await supabase
        .from("transactions")
        .select("id, amount, currency")
        .eq("account_id", accountId)
        .in("external_ref", paymentIds)
        .is("withdrawal_id", null);
      matched = data ?? [];
    }

    const currency = matched[0]?.currency ?? payout.amount_money.currency;
    const gross = matched.reduce((sum, t) => sum + Number(t.amount), 0);
    const withdrawalId = `square-payout-${payout.id}`;

    const { error: insertError } = await supabase.from("withdrawals").insert({
      id: withdrawalId,
      account_id: accountId,
      currency,
      gross,
      commission_pct: 0,
      commission_amt: 0,
      net: gross,
      payout_currency: payout.amount_money.currency,
      payout_net: payout.amount_money.amount / 100,
      fx_rate_used: 1,
      transaction_count: matched.length,
      created_at: payout.created_at ?? new Date().toISOString(),
      provider: "square",
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

  return { payoutsProcessed, newWithdrawals, payoutsSkipped, skippedPayouts };
}
