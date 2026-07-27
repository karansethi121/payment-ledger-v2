// Receives PayPal webhook events and auto-logs completed payments as deposits.
//
// Setup (after creating the Supabase project and running schema.sql):
//   1. In the PayPal Developer Dashboard, create a webhook pointing at:
//        https://<project-ref>.supabase.co/functions/v1/paypal-webhook
//      subscribed to: PAYMENT.CAPTURE.COMPLETED
//   2. supabase secrets set PAYPAL_CLIENT_ID=...
//      supabase secrets set PAYPAL_CLIENT_SECRET=...
//      supabase secrets set PAYPAL_WEBHOOK_ID=...        (shown after creating the webhook)
//      supabase secrets set PAYPAL_API_BASE=https://api-m.paypal.com   (or the sandbox host while testing)
//   3. supabase functions deploy paypal-webhook --no-verify-jwt
//
// Matching a payment to one of your accounts: PayPal includes the receiving
// account's email on the capture resource. Store that email in
// accounts.paypal_payee_email so this function knows which account it belongs to.

import { createClient } from "npm:@supabase/supabase-js@2";

const PAYPAL_CLIENT_ID = Deno.env.get("PAYPAL_CLIENT_ID") ?? "";
const PAYPAL_CLIENT_SECRET = Deno.env.get("PAYPAL_CLIENT_SECRET") ?? "";
const PAYPAL_WEBHOOK_ID = Deno.env.get("PAYPAL_WEBHOOK_ID") ?? "";
const PAYPAL_API_BASE = Deno.env.get("PAYPAL_API_BASE") ?? "https://api-m.paypal.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function getAccessToken(): Promise<string> {
  const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`PayPal OAuth failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function verifySignature(req: Request, rawBody: string, webhookEvent: unknown): Promise<boolean> {
  const accessToken = await getAccessToken();
  const res = await fetch(`${PAYPAL_API_BASE}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      auth_algo: req.headers.get("PAYPAL-AUTH-ALGO"),
      cert_url: req.headers.get("PAYPAL-CERT-URL"),
      transmission_id: req.headers.get("PAYPAL-TRANSMISSION-ID"),
      transmission_sig: req.headers.get("PAYPAL-TRANSMISSION-SIG"),
      transmission_time: req.headers.get("PAYPAL-TRANSMISSION-TIME"),
      webhook_id: PAYPAL_WEBHOOK_ID,
      webhook_event: webhookEvent,
    }),
  });
  const data = await res.json();
  return data.verification_status === "SUCCESS";
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const rawBody = await req.text();
  const webhookEvent = JSON.parse(rawBody);

  const verified = await verifySignature(req, rawBody, webhookEvent);
  if (!verified) {
    console.error("PayPal signature verification failed for event", webhookEvent.id);
    return new Response("Signature verification failed", { status: 400 });
  }

  const { error: dedupeError } = await supabase.from("webhook_events").insert({
    provider: "paypal",
    external_event_id: webhookEvent.id,
    payload: webhookEvent,
  });
  if (dedupeError) {
    if (dedupeError.code === "23505") {
      return new Response(JSON.stringify({ received: true, duplicate: true }), { status: 200 });
    }
    console.error("Failed to log webhook event:", dedupeError.message);
    return new Response("Failed to log event", { status: 500 });
  }

  if (webhookEvent.event_type !== "PAYMENT.CAPTURE.COMPLETED") {
    return new Response(JSON.stringify({ received: true, ignored: webhookEvent.event_type }), { status: 200 });
  }

  const resource = webhookEvent.resource;
  const amount = parseFloat(resource?.amount?.value ?? "0");
  const currency = resource?.amount?.currency_code ?? "USD";
  const payeeEmail = resource?.payee?.email_address;

  if (!payeeEmail) {
    await markEventError(webhookEvent.id, "No payee email on capture; can't match to an account");
    return new Response(JSON.stringify({ received: true, unmatched: true }), { status: 200 });
  }

  const { data: account, error: accountError } = await supabase
    .from("accounts")
    .select("id")
    .eq("paypal_payee_email", payeeEmail)
    .maybeSingle();

  if (accountError || !account) {
    await markEventError(webhookEvent.id, `No account matches paypal_payee_email=${payeeEmail}`);
    return new Response(JSON.stringify({ received: true, unmatched: true }), { status: 200 });
  }

  const { error: insertError } = await supabase.from("transactions").insert({
    account_id: account.id,
    type: "deposit",
    source: "paypal_webhook",
    amount,
    currency,
    note: "Auto-captured via PayPal",
    external_ref: resource.id,
  });

  if (insertError) {
    await markEventError(webhookEvent.id, `Failed to insert transaction: ${insertError.message}`);
    return new Response("Failed to record transaction", { status: 500 });
  }

  await supabase.from("webhook_events").update({ processed: true }).eq("provider", "paypal").eq("external_event_id", webhookEvent.id);

  return new Response(JSON.stringify({ received: true }), { status: 200 });
});

async function markEventError(eventId: string, message: string) {
  await supabase.from("webhook_events").update({ error: message }).eq("provider", "paypal").eq("external_event_id", eventId);
  console.warn(message);
}
