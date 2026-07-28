// Receives PayPal webhook events: logs completed payments as deposits, and
// refunds as linked negative corrections (never edits or deletes the
// original deposit -- see the "refund" transaction type in schema.sql).
//
// United Goods UK and Dilpreet Sethi are separate PayPal accounts, each with
// their own app credentials and webhook subscription. Rather than matching by
// payee email (fragile if PayPal ever changes what it puts in the payload),
// this tries each configured account's credentials against PayPal's
// verify-webhook-signature API; whichever one succeeds tells us definitively
// which ledger account the event belongs to.
//
// Setup (after creating the Supabase project and running schema.sql):
//   supabase secrets set PAYPAL_ACCOUNTS_JSON='[{"accountId":"ugu-paypal","clientId":"...","clientSecret":"...","webhookId":"..."},{"accountId":"dilpreet-paypal","clientId":"...","clientSecret":"...","webhookId":"..."}]'
//   supabase secrets set PAYPAL_API_BASE=https://api-m.paypal.com   (or the sandbox host while testing)
//   supabase functions deploy paypal-webhook --no-verify-jwt
// In EACH PayPal account's Developer Dashboard, add a webhook pointing at:
//   https://<project-ref>.supabase.co/functions/v1/paypal-webhook
// subscribed to: PAYMENT.CAPTURE.COMPLETED, PAYMENT.CAPTURE.REFUNDED

import { createClient } from "npm:@supabase/supabase-js@2";

type PayPalAccountConfig = { accountId: string; clientId: string; clientSecret: string; webhookId: string };

const PAYPAL_ACCOUNTS: PayPalAccountConfig[] = JSON.parse(Deno.env.get("PAYPAL_ACCOUNTS_JSON") ?? "[]");
const PAYPAL_API_BASE = Deno.env.get("PAYPAL_API_BASE") ?? "https://api-m.paypal.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

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

async function verifyAgainstAccount(req: Request, webhookEvent: unknown, account: PayPalAccountConfig): Promise<boolean> {
  const accessToken = await getAccessToken(account.clientId, account.clientSecret);
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
      webhook_id: account.webhookId,
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

  let matchedAccountId: string | null = null;
  for (const account of PAYPAL_ACCOUNTS) {
    try {
      if (await verifyAgainstAccount(req, webhookEvent, account)) {
        matchedAccountId = account.accountId;
        break;
      }
    } catch (err) {
      console.warn(`Verification attempt failed for ${account.accountId}:`, (err as Error).message);
    }
  }

  if (!matchedAccountId) {
    console.error("PayPal signature verification failed against all configured accounts for event", webhookEvent.id);
    return new Response("Signature verification failed", { status: 400 });
  }

  // Idempotency: PayPal retries on any non-2xx response, so duplicates are expected.
  const { error: dedupeError } = await supabase.from("webhook_events").insert({
    provider: "paypal",
    external_event_id: webhookEvent.id,
    account_id: matchedAccountId,
    payload: webhookEvent,
  });
  if (dedupeError) {
    if (dedupeError.code === "23505") {
      return new Response(JSON.stringify({ received: true, duplicate: true }), { status: 200 });
    }
    console.error("Failed to log webhook event:", dedupeError.message);
    return new Response("Failed to log event", { status: 500 });
  }

  try {
    if (webhookEvent.event_type === "PAYMENT.CAPTURE.COMPLETED") {
      await handleDeposit(webhookEvent, matchedAccountId);
    } else if (webhookEvent.event_type === "PAYMENT.CAPTURE.REFUNDED") {
      await handleRefund(webhookEvent, matchedAccountId);
    } else {
      return new Response(JSON.stringify({ received: true, ignored: webhookEvent.event_type }), { status: 200 });
    }
  } catch (err) {
    await markEventError(webhookEvent.id, `Handler failed: ${(err as Error).message}`);
    return new Response("Failed to process event", { status: 500 });
  }

  await supabase.from("webhook_events").update({ processed: true }).eq("provider", "paypal").eq("external_event_id", webhookEvent.id);
  return new Response(JSON.stringify({ received: true }), { status: 200 });
});

// deno-lint-ignore no-explicit-any
async function handleDeposit(webhookEvent: any, accountId: string) {
  const resource = webhookEvent.resource;
  const amount = parseFloat(resource?.amount?.value ?? "0");
  const currency = resource?.amount?.currency_code ?? "USD";

  const { error } = await supabase.from("transactions").insert({
    id: `paypal-${crypto.randomUUID()}`,
    account_id: accountId,
    type: "deposit",
    source: "paypal_webhook",
    amount,
    currency,
    note: "Auto-captured via PayPal",
    external_ref: resource?.id ?? null,
  });
  if (error) throw new Error(`Failed to insert deposit: ${error.message}`);
}

// A PayPal refund resource doesn't carry the original capture id in a plain
// field -- it's embedded in the "up" relation link, e.g.
// ".../v2/payments/captures/{capture_id}". Each refund is its own event with
// its own resource.id (unlike Stripe's cumulative charge.refunded), so no
// incremental-delta tracking is needed here.
// deno-lint-ignore no-explicit-any
function extractCaptureId(resource: any): string | null {
  const links: Array<{ rel?: string; href?: string }> = resource?.links ?? [];
  const upLink = links.find((l) => l.rel === "up");
  if (!upLink?.href) return null;
  const parts = upLink.href.split("/");
  return parts[parts.length - 1] || null;
}

// deno-lint-ignore no-explicit-any
async function handleRefund(webhookEvent: any, accountId: string) {
  const resource = webhookEvent.resource;
  const amount = parseFloat(resource?.amount?.value ?? "0");
  const currency = resource?.amount?.currency_code ?? "USD";
  const captureId = extractCaptureId(resource);

  const original = captureId
    ? (await supabase.from("transactions").select("id").eq("account_id", accountId).eq("external_ref", captureId).eq("type", "deposit").maybeSingle()).data
    : null;

  const { error } = await supabase.from("transactions").insert({
    id: `paypal-refund-${crypto.randomUUID()}`,
    account_id: accountId,
    type: "refund",
    source: "paypal_webhook",
    amount,
    currency,
    note: "Refund via PayPal",
    external_ref: resource?.id ?? null,
    related_transaction_id: original?.id ?? null,
  });
  if (error) throw new Error(`Failed to insert refund: ${error.message}`);
}

async function markEventError(eventId: string, message: string) {
  await supabase.from("webhook_events").update({ error: message }).eq("provider", "paypal").eq("external_event_id", eventId);
  console.warn(message);
}
