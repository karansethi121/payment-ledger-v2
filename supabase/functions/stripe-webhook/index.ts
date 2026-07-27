// Receives Stripe webhook events: logs completed payments as deposits, and
// refunds/chargebacks as linked negative corrections (never edits or deletes
// the original deposit -- see the "refund" transaction type in schema.sql).
//
// Karan Sethi and United Goods UK are separate Stripe accounts, so this
// doesn't try to match a payment to an account via Payment Link ID -- instead
// each Stripe account gets its own webhook endpoint pointing here, and since
// each account's signing secret is unique, whichever secret verifies the
// signature tells us definitively which ledger account the event belongs to.
//
// Setup (after creating the Supabase project and running schema.sql):
//   supabase secrets set STRIPE_ACCOUNTS_JSON='[{"accountId":"karan-stripe","secret":"whsec_..."},{"accountId":"ugu-stripe","secret":"whsec_..."}]'
//   supabase functions deploy stripe-webhook --no-verify-jwt
// Then in EACH Stripe account's Dashboard -> Developers -> Webhooks, add an
// endpoint pointing at:
//   https://<project-ref>.supabase.co/functions/v1/stripe-webhook
// listening for: checkout.session.completed, charge.refunded, charge.dispute.funds_withdrawn
// (Each account's endpoint gets its own signing secret -- that's the secret
// that goes in STRIPE_ACCOUNTS_JSON for that account's accountId.)

import Stripe from "npm:stripe@14";
import { createClient } from "npm:@supabase/supabase-js@2";

type StripeAccountConfig = { accountId: string; secret: string };

const STRIPE_ACCOUNTS: StripeAccountConfig[] = JSON.parse(Deno.env.get("STRIPE_ACCOUNTS_JSON") ?? "[]");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const stripe = new Stripe("sk_dummy_not_used_for_verification", { apiVersion: "2023-10-16" });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const signature = req.headers.get("Stripe-Signature");
  const rawBody = await req.text();

  if (!signature) {
    return new Response("Missing Stripe-Signature header", { status: 400 });
  }

  let event: Stripe.Event | null = null;
  let matchedAccountId: string | null = null;
  let lastError: Error | null = null;

  for (const { accountId, secret } of STRIPE_ACCOUNTS) {
    try {
      event = await stripe.webhooks.constructEventAsync(rawBody, signature, secret);
      matchedAccountId = accountId;
      break;
    } catch (err) {
      lastError = err as Error;
    }
  }

  if (!event || !matchedAccountId) {
    console.error("Signature verification failed against all configured accounts:", lastError?.message);
    return new Response(`Webhook signature verification failed: ${lastError?.message}`, { status: 400 });
  }

  // Idempotency: if we've already recorded this event, acknowledge and stop.
  // Stripe retries on any non-2xx response, so duplicates are expected and normal.
  const { error: dedupeError } = await supabase.from("webhook_events").insert({
    provider: "stripe",
    external_event_id: event.id,
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
    if (event.type === "checkout.session.completed") {
      await handleDeposit(event, matchedAccountId);
    } else if (event.type === "charge.refunded") {
      await handleRefund(event, matchedAccountId);
    } else if (event.type === "charge.dispute.funds_withdrawn") {
      await handleChargeback(event, matchedAccountId);
    } else {
      return new Response(JSON.stringify({ received: true, ignored: event.type }), { status: 200 });
    }
  } catch (err) {
    await markEventError(event.id, `Handler failed: ${(err as Error).message}`);
    return new Response("Failed to process event", { status: 500 });
  }

  await supabase.from("webhook_events").update({ processed: true }).eq("provider", "stripe").eq("external_event_id", event.id);
  return new Response(JSON.stringify({ received: true }), { status: 200 });
});

async function handleDeposit(event: Stripe.Event, accountId: string) {
  const session = event.data.object as Stripe.Checkout.Session;
  const amount = (session.amount_total ?? 0) / 100;
  const currency = (session.currency ?? "usd").toUpperCase();
  // payment_intent is the id refund/dispute events will reference later --
  // more stable to join on than the checkout session id itself.
  const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;

  const { error } = await supabase.from("transactions").insert({
    id: `stripe-${crypto.randomUUID()}`,
    account_id: accountId,
    type: "deposit",
    source: "stripe_webhook",
    amount,
    currency,
    note: "Auto-captured via Stripe",
    external_ref: paymentIntentId ?? session.id,
  });
  if (error) throw new Error(`Failed to insert deposit: ${error.message}`);
}

async function handleRefund(event: Stripe.Event, accountId: string) {
  const charge = event.data.object as Stripe.Charge;
  const paymentIntentId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  const currency = (charge.currency ?? "usd").toUpperCase();
  const totalRefunded = (charge.amount_refunded ?? 0) / 100;

  const original = paymentIntentId
    ? (await supabase.from("transactions").select("id").eq("account_id", accountId).eq("external_ref", paymentIntentId).eq("type", "deposit").maybeSingle()).data
    : null;

  // charge.refunded fires with the CUMULATIVE amount refunded so far on this
  // charge, not the incremental delta -- for a second partial refund on the
  // same charge, we only want to record the new portion, not double-count
  // what a previous charge.refunded delivery already recorded.
  let alreadyRecorded = 0;
  if (original) {
    const { data: priorRefunds } = await supabase.from("transactions").select("amount").eq("related_transaction_id", original.id).eq("type", "refund");
    alreadyRecorded = (priorRefunds ?? []).reduce((sum, r) => sum + Number(r.amount), 0);
  }
  const delta = totalRefunded - alreadyRecorded;
  if (delta <= 0) return; // nothing new to record (duplicate delivery or zero-amount edge case)

  const { error } = await supabase.from("transactions").insert({
    id: `stripe-refund-${crypto.randomUUID()}`,
    account_id: accountId,
    type: "refund",
    source: "stripe_webhook",
    amount: delta,
    currency,
    note: "Refund via Stripe",
    external_ref: paymentIntentId ?? charge.id,
    related_transaction_id: original?.id ?? null,
  });
  if (error) throw new Error(`Failed to insert refund: ${error.message}`);
}

async function handleChargeback(event: Stripe.Event, accountId: string) {
  const dispute = event.data.object as Stripe.Dispute;
  const paymentIntentId = typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id;
  const currency = (dispute.currency ?? "usd").toUpperCase();
  const amount = (dispute.amount ?? 0) / 100;

  const original = paymentIntentId
    ? (await supabase.from("transactions").select("id").eq("account_id", accountId).eq("external_ref", paymentIntentId).eq("type", "deposit").maybeSingle()).data
    : null;

  const { error } = await supabase.from("transactions").insert({
    id: `stripe-chargeback-${crypto.randomUUID()}`,
    account_id: accountId,
    type: "refund",
    source: "stripe_webhook",
    amount,
    currency,
    note: "Chargeback via Stripe",
    external_ref: paymentIntentId ?? dispute.id,
    related_transaction_id: original?.id ?? null,
  });
  if (error) throw new Error(`Failed to insert chargeback: ${error.message}`);
}

async function markEventError(eventId: string, message: string) {
  await supabase.from("webhook_events").update({ error: message }).eq("provider", "stripe").eq("external_event_id", eventId);
  console.warn(message);
}
