// Receives Stripe webhook events and auto-logs completed payments as deposits.
//
// Setup (after creating the Supabase project and running schema.sql):
//   supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...   (from your Stripe webhook endpoint config)
//   supabase functions deploy stripe-webhook --no-verify-jwt
// Then in the Stripe Dashboard -> Developers -> Webhooks, add an endpoint pointing at:
//   https://<project-ref>.supabase.co/functions/v1/stripe-webhook
// listening for: checkout.session.completed
//
// Matching a payment to one of your accounts: each Stripe Payment Link has an id
// (plink_xxx). Store that id in accounts.stripe_payment_link_id so this function
// knows which account a given payment belongs to.

import Stripe from "npm:stripe@14?target=deno";
import { createClient } from "npm:@supabase/supabase-js@2";

const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const stripe = new Stripe(STRIPE_WEBHOOK_SECRET ? "sk_dummy_not_used_for_verification" : "sk_dummy", {
  apiVersion: "2023-10-16",
});
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

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Signature verification failed:", err.message);
    return new Response(`Webhook signature verification failed: ${err.message}`, { status: 400 });
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

  if (event.type !== "checkout.session.completed") {
    return new Response(JSON.stringify({ received: true, ignored: event.type }), { status: 200 });
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const paymentLinkId = typeof session.payment_link === "string" ? session.payment_link : session.payment_link?.id;
  const amount = (session.amount_total ?? 0) / 100;
  const currency = (session.currency ?? "usd").toUpperCase();

  if (!paymentLinkId) {
    await markEventError(event.id, "No payment_link on session; can't match to an account");
    return new Response(JSON.stringify({ received: true, unmatched: true }), { status: 200 });
  }

  const { data: account, error: accountError } = await supabase
    .from("accounts")
    .select("id")
    .eq("stripe_payment_link_id", paymentLinkId)
    .maybeSingle();

  if (accountError || !account) {
    await markEventError(event.id, `No account matches stripe_payment_link_id=${paymentLinkId}`);
    return new Response(JSON.stringify({ received: true, unmatched: true }), { status: 200 });
  }

  const { error: insertError } = await supabase.from("transactions").insert({
    account_id: account.id,
    type: "deposit",
    source: "stripe_webhook",
    amount,
    currency,
    note: "Auto-captured via Stripe",
    external_ref: session.id,
  });

  if (insertError) {
    await markEventError(event.id, `Failed to insert transaction: ${insertError.message}`);
    return new Response("Failed to record transaction", { status: 500 });
  }

  await supabase.from("webhook_events").update({ processed: true }).eq("provider", "stripe").eq("external_event_id", event.id);

  return new Response(JSON.stringify({ received: true }), { status: 200 });
});

async function markEventError(eventId: string, message: string) {
  await supabase.from("webhook_events").update({ error: message }).eq("provider", "stripe").eq("external_event_id", eventId);
  console.warn(message);
}
