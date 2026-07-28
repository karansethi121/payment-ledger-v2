// Pulls real balance/fee data from PayPal so the ledger reflects what
// PayPal's own dashboard shows, instead of relying only on the gross capture
// amounts paypal-webhook records as they come in. Invoked on demand from the
// frontend ("Sync" button) -- mirrors stripe-sync's structure and security
// posture (see that file for the fuller rationale), with one deliberate
// scope difference:
//
// Unlike stripe-sync, this does NOT attempt payout auto-reconciliation.
// Stripe's balance_transactions?payout=... gives an itemized list of which
// charges a payout covered (for automatic-schedule payouts, at least) --
// PayPal has no documented equivalent for "which captures were included in
// this withdrawal to bank." A PayPal withdrawal is a sweep of the available
// balance, not a line-itemized transfer, so there's nothing to match against
// specific transactions. Withdrawals from PayPal accounts still go through
// the manual withdraw-modal checklist, same as Stripe's manual-schedule
// payouts already do.
//
// Requires REAL PayPal API access -- reuses the same clientId/clientSecret
// already in PAYPAL_ACCOUNTS_JSON (paypal-webhook only uses them for OAuth +
// webhook-signature verification; the same OAuth token works for other
// PayPal REST APIs), but the PayPal app needs the "Transaction Search" API
// product enabled in the Developer Dashboard for /v1/reporting/balances and
// /v2/payments/captures/{id} to actually authorize -- without it, expect a
// 403 the same way Stripe's restricted key needed extra permissions added.
//   supabase functions deploy paypal-sync

import { createClient } from "npm:@supabase/supabase-js@2";

type PayPalAccountConfig = { accountId: string; clientId: string; clientSecret: string; webhookId: string };

const PAYPAL_ACCOUNTS: PayPalAccountConfig[] = JSON.parse(Deno.env.get("PAYPAL_ACCOUNTS_JSON") ?? "[]");
const PAYPAL_API_BASE = Deno.env.get("PAYPAL_API_BASE") ?? "https://api-m.paypal.com";
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

  const account = PAYPAL_ACCOUNTS.find((a) => a.accountId === accountId);
  if (!account) {
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
    const accessToken = await getAccessToken(account.clientId, account.clientSecret);
    const balance = await syncBalance(accessToken, accountId);
    const feesBackfilled = await syncFees(accessToken, accountId);
    return json({ balance, feesBackfilled });
  } catch (err) {
    console.error(`paypal-sync failed for ${accountId}:`, (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`PayPal OAuth failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function syncBalance(accessToken: string, accountId: string) {
  const res = await fetch(`${PAYPAL_API_BASE}/v1/reporting/balances`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Balance lookup failed: ${JSON.stringify(data)}`);

  const balances: Array<{ currency: string; available_balance?: { value: string; currency_code: string } }> = data.balances ?? [];
  const primary = balances.find((b) => b.available_balance) ?? balances[0];
  if (!primary?.available_balance) return null;

  const amount = parseFloat(primary.available_balance.value);
  const currency = primary.available_balance.currency_code;
  const { error } = await supabase.from("accounts").update({
    balance_available: amount,
    balance_currency: currency,
    balance_synced_at: new Date().toISOString(),
  }).eq("id", accountId);
  if (error) throw new Error(`Failed to store balance: ${error.message}`);
  return { amount, currency };
}

async function syncFees(accessToken: string, accountId: string) {
  const { data: pending, error } = await supabase
    .from("transactions")
    .select("id, external_ref")
    .eq("account_id", accountId)
    .eq("source", "paypal_webhook")
    .eq("type", "deposit")
    .is("provider_fee", null)
    .order("occurred_at", { ascending: true })
    .limit(50);
  if (error) throw new Error(`Failed to load pending fee lookups: ${error.message}`);

  let count = 0;
  for (const t of pending ?? []) {
    if (!t.external_ref) continue;
    try {
      const res = await fetch(`${PAYPAL_API_BASE}/v2/payments/captures/${t.external_ref}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const capture = await res.json();
      if (!res.ok) {
        console.warn(`Fee lookup failed for ${t.id} (${t.external_ref}):`, JSON.stringify(capture));
        continue;
      }
      const breakdown = capture.seller_receivable_breakdown;
      const fee = breakdown?.paypal_fee;
      const net = breakdown?.net_amount;
      if (!fee || !net) continue;

      // fee/net carry their own currency_code -- almost always matches the
      // capture's own currency, but stored explicitly rather than assumed,
      // same discipline as stripe-sync's provider_currency.
      const { error: updateError } = await supabase.from("transactions").update({
        provider_fee: parseFloat(fee.value),
        provider_net: parseFloat(net.value),
        provider_currency: net.currency_code,
      }).eq("id", t.id);
      if (!updateError) count++;
    } catch (err) {
      console.warn(`Fee lookup failed for ${t.id} (${t.external_ref}):`, (err as Error).message);
    }
  }
  return count;
}
