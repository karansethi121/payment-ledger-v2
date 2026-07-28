// Receives Square webhook events: logs completed payments as deposits, and
// completed refunds as linked negative corrections (never edits or deletes
// the original deposit -- see the "refund" transaction type in schema.sql).
// Mirrors stripe-webhook/paypal-webhook's structure and account-matching
// approach.
//
// Each Square account gets its own "application" in the Developer Dashboard,
// with its own webhook subscription and signature key -- same pattern as
// Stripe: try each configured account's signature key against the incoming
// request, whichever one verifies tells us which ledger account the event
// belongs to. Uses Square's own WebhooksHelper for verification rather than
// hand-rolling the HMAC -- Square's docs don't fully specify the exact
// string-concatenation format for a manual implementation, so the official
// helper is the safer choice (same reasoning as using the Stripe SDK's
// constructEventAsync instead of manual signature checking).
//
// Setup (after creating the Supabase project and running schema.sql):
//   supabase secrets set SQUARE_ACCOUNTS_JSON='[{"accountId":"ugu-square","signatureKey":"...","notificationUrl":"https://<project-ref>.supabase.co/functions/v1/square-webhook"}]'
//   supabase functions deploy square-webhook --no-verify-jwt
// In EACH Square account's Developer Dashboard -> your app -> Webhooks, add an
// endpoint pointing at the same notificationUrl above, subscribed to:
//   payment.updated, refund.updated
// (`notificationUrl` must exactly match what's configured in the dashboard --
// Square signs against it, so a mismatch fails verification for every event.)

import { WebhooksHelper } from "npm:square@45";
import { createClient } from "npm:@supabase/supabase-js@2";

type SquareAccountConfig = { accountId: string; signatureKey: string; notificationUrl: string };

const SQUARE_ACCOUNTS: SquareAccountConfig[] = JSON.parse(Deno.env.get("SQUARE_ACCOUNTS_JSON") ?? "[]");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const signature = req.headers.get("x-square-hmacsha256-signature");
  const rawBody = await req.text();
  if (!signature) {
    return new Response("Missing x-square-hmacsha256-signature header", { status: 400 });
  }

  let matchedAccountId: string | null = null;
  for (const account of SQUARE_ACCOUNTS) {
    try {
      const valid = await WebhooksHelper.verifySignature({
        requestBody: rawBody,
        signatureHeader: signature,
        signatureKey: account.signatureKey,
        notificationUrl: account.notificationUrl,
      });
      if (valid) {
        matchedAccountId = account.accountId;
        break;
      }
    } catch (err) {
      console.warn(`Verification attempt failed for ${account.accountId}:`, (err as Error).message);
    }
  }

  if (!matchedAccountId) {
    console.error("Square signature verification failed against all configured accounts");
    return new Response("Signature verification failed", { status: 400 });
  }

  // deno-lint-ignore no-explicit-any
  const event: any = JSON.parse(rawBody);

  // Idempotency: Square retries on any non-2xx response, so duplicates are expected.
  const { error: dedupeError } = await supabase.from("webhook_events").insert({
    provider: "square",
    external_event_id: event.event_id,
    account_id: matchedAccountId,
    payload: event,
  });
  if (dedupeError) {
    if (dedupeError.code === "23505") {
      return new Response(JSON.stringify({ received: true, duplicate: true }), { status: 200 });
    }
    console.error("Failed to log webhook event:", dedupeError.message);
    return new Response("Failed to log event", { status: 500 });
  }

  try {
    if (event.type === "payment.updated") {
      await handlePayment(event, matchedAccountId);
    } else if (event.type === "refund.updated") {
      await handleRefund(event, matchedAccountId);
    } else {
      return new Response(JSON.stringify({ received: true, ignored: event.type }), { status: 200 });
    }
  } catch (err) {
    await markEventError(event.event_id, `Handler failed: ${(err as Error).message}`);
    return new Response("Failed to process event", { status: 500 });
  }

  await supabase.from("webhook_events").update({ processed: true }).eq("provider", "square").eq("external_event_id", event.event_id);
  return new Response(JSON.stringify({ received: true }), { status: 200 });
});

// payment.updated fires on every status transition (e.g. APPROVED ->
// COMPLETED), not just once -- only record a deposit the first time a given
// payment id reaches COMPLETED, and ignore every other delivery for it
// (including ones after COMPLETED, e.g. a receipt_url getting attached).
// deno-lint-ignore no-explicit-any
async function handlePayment(event: any, accountId: string) {
  const payment = event.data?.object?.payment;
  if (!payment || payment.status !== "COMPLETED") return;

  const { data: existing } = await supabase
    .from("transactions").select("id")
    .eq("account_id", accountId).eq("external_ref", payment.id).eq("type", "deposit")
    .maybeSingle();
  if (existing) return;

  const amount = (payment.amount_money?.amount ?? 0) / 100;
  const currency = (payment.amount_money?.currency ?? "USD").toUpperCase();

  const { error } = await supabase.from("transactions").insert({
    id: `square-${crypto.randomUUID()}`,
    account_id: accountId,
    type: "deposit",
    source: "square_webhook",
    amount,
    currency,
    note: "Auto-captured via Square",
    external_ref: payment.id,
  });
  if (error) throw new Error(`Failed to insert deposit: ${error.message}`);
}

// deno-lint-ignore no-explicit-any
async function handleRefund(event: any, accountId: string) {
  const refund = event.data?.object?.refund;
  if (!refund || refund.status !== "COMPLETED") return;

  const { data: existing } = await supabase
    .from("transactions").select("id")
    .eq("account_id", accountId).eq("external_ref", refund.id).eq("type", "refund")
    .maybeSingle();
  if (existing) return;

  const amount = (refund.amount_money?.amount ?? 0) / 100;
  const currency = (refund.amount_money?.currency ?? "USD").toUpperCase();

  const original = refund.payment_id
    ? (await supabase.from("transactions").select("id").eq("account_id", accountId).eq("external_ref", refund.payment_id).eq("type", "deposit").maybeSingle()).data
    : null;

  const { error } = await supabase.from("transactions").insert({
    id: `square-refund-${crypto.randomUUID()}`,
    account_id: accountId,
    type: "refund",
    source: "square_webhook",
    amount,
    currency,
    note: "Refund via Square",
    external_ref: refund.id,
    related_transaction_id: original?.id ?? null,
  });
  if (error) throw new Error(`Failed to insert refund: ${error.message}`);
}

async function markEventError(eventId: string, message: string) {
  await supabase.from("webhook_events").update({ error: message }).eq("provider", "square").eq("external_event_id", eventId);
  console.warn(message);
}
