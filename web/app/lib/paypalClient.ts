import { instanceBool, instanceString } from "./instanceConfigServer.ts";
// PayPal API client — low-level only. No routes, no UI live here; the routes
// that CONSUME this module:
//   POST /api/billing/paypal/order    (createPaypalOrder, paypalConfigured)
//   POST /api/billing/paypal/webhook  (verifyPaypalWebhook, paypalWebhookConfigured)
//   POST /api/billing/paypal/capture  (capturePaypalOrder)
//
// A payer's real name is NEVER read here. PayPal's order/capture bodies and
// webhook payloads can carry `payer.name` and `payer.email_address`; this
// module parses response bodies for exactly the fields named below
// (access_token/expires_in, order id, verification_status) and nothing else.
// Pinned by the source scan at the end of paypalClient.test.ts; the webhook
// tests run the same rule across the routes built on top of this.
//
// Every outbound call carries `AbortSignal.timeout(10_000)`, copying the
// platform-link callback's shape (app/api/auth/link/[platform]/callback/route.ts).

const LIVE_BASE = "https://api-m.paypal.com";
const SANDBOX_BASE = "https://api-m.sandbox.paypal.com";

/**
 * @parked part of this client's interface; consumed only by this file's own
 * paypalAccessToken/createPaypalOrder/verifyPaypalWebhook, which check-orphans
 * does not credit (same-file calls are deliberately excluded — see
 * scripts/check-orphans.mjs). Exported for a route that needs the base URL
 * directly (e.g. for logging or a health check).
 */
export function paypalApiBase(): string {
  // Unset or anything other than the literal "live" stays on the safe side —
  // sandbox — rather than defaulting to a live endpoint on a typo.
  return instanceString("paypal.env") === "live" ? LIVE_BASE : SANDBOX_BASE;
}

/**
 * True once the credentials needed to talk to PayPal at all (token + order
 * creation) are present. Deliberately does NOT require PAYPAL_WEBHOOK_ID:
 * that id cannot exist until a webhook route is registered with PayPal, so
 * gating tip creation on it would make the order path unusable until the
 * webhook is registered. See paypalWebhookConfigured() for the check the webhook route
 * itself needs.
 *
 * @parked consumed by the PayPal order route's 503 gate.
 */
export function paypalConfigured(): boolean {
  return paypalModuleOn() && Boolean(instanceString("paypal.clientId") && instanceString("paypal.clientSecret") && instanceString("paypal.env"));
}

/** The PayPal module switch (config/modules.mjs `paypal`). Off = no PayPal button or order, and
 *  the webhook route answers 404 so PayPal keeps the event and retries it (25 times, ~3 days). */
export function paypalModuleOn(): boolean {
  return instanceBool("modules.paypal");
}

/**
 * paypalConfigured() plus a registered webhook id. Only the webhook route
 * needs this — the order route must keep working without it (see
 * paypalConfigured() above).
 *
 * Consumed by app/api/billing/paypal/webhook/route.ts, which refuses to
 * attempt verification before PAYPAL_WEBHOOK_ID is registered rather than
 * send PayPal a request that can only fail.
 */
export function paypalWebhookConfigured(): boolean {
  return paypalConfigured() && Boolean(instanceString("paypal.webhookId"));
}

let cached: { token: string; expiresAt: number } | null = null;

// The in-flight request, if any. The order route and the webhook route both
// call paypalAccessToken on every request; on a cold or expired
// cache, two requests landing together would otherwise each fire their own
// token fetch. Caching the PROMISE (not just the eventually-resolved token)
// makes the second caller await the first request instead of starting a
// second one.
let inFlight: Promise<string> | null = null;

/**
 * @test-only clears the module-level token cache (and any in-flight request)
 * between tests. Neither has any other way to be reset, so state leaked by
 * one test would read as still-valid (or still-pending) in the next one —
 * paypalClient.test.ts calls this at the start of every test.
 */
export function _resetPaypalAccessTokenCache(): void {
  cached = null;
  inFlight = null;
}

/**
 * @parked consumed only by createPaypalOrder/verifyPaypalWebhook in this same
 * file (not credited by check-orphans — see paypalApiBase's docblock above);
 * part of this client's interface for the routes built on it.
 */
export async function paypalAccessToken(f: typeof fetch = fetch): Promise<string> {
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    // A FAILED fetch must clear `inFlight` too (the `finally` below), or one
    // failure poisons every later call for the rest of the process — worse
    // than the duplicate-request problem this cache exists to fix.
    try {
      const basic = Buffer.from(
        `${instanceString("paypal.clientId")}:${instanceString("paypal.clientSecret")}`,
      ).toString("base64");
      const res = await f(`${paypalApiBase()}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`paypal token: ${res.status}`);
      const json = (await res.json()) as { access_token: string; expires_in: number };
      // 60s short of the stated lifetime so an in-flight request can't expire mid-call.
      cached = { token: json.access_token, expiresAt: Date.now() + (json.expires_in - 60) * 1000 };
      return cached.token;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Which of PayPal's buttons the buyer pressed. The order names it as its
 *  `payment_source`, so each carries its own experience_context. */
export type PaypalFundingSource = "paypal" | "venmo";

/** The order body's `fundingSource`: absent or "paypal" = paypal (a client
 *  from before the field existed sends none), "venmo" = venmo, anything else
 *  = null (the route refuses it rather than guess). */
export function orderFundingSource(raw: unknown): PaypalFundingSource | null {
  if (raw === undefined || raw === null || raw === "paypal") return "paypal";
  if (raw === "venmo") return "venmo";
  return null;
}

/**
 * @parked consumed by the PayPal order route (billing/paypal/order).
 *
 * `shipping_preference: "NO_SHIPPING"`: a tip or a points purchase ships
 * nothing, and PayPal's default (GET_FROM_FILE) shows the buyer a shipping
 * address and returns it in the order — an address this site has no use for.
 * Where it goes depends on the button pressed:
 *   - PayPal: `payment_source.paypal.experience_context` (the v2 form; proven
 *     end to end in the sandbox — approve, capture, success).
 *   - Venmo: NOT `payment_source.venmo`. PayPal answers that order
 *     PAYER_ACTION_REQUIRED with no approval link at all, and the SDK's Venmo
 *     popup failed on it ("check info and try again") before onApprove. A plain
 *     order (no payment_source) is CREATED with an `approve` link — the shape the
 *     SDK's own Venmo flow approves — and carries NO_SHIPPING in
 *     `application_context`, which applies to whichever funding source approves
 *     it. Deprecated in PayPal's reference but read: the sandbox refuses a bogus
 *     value at /application_context/shipping_preference.
 * `user_action: "PAY_NOW"` matches
 * the button: the SDK loads with its default commit=true and `onApprove`
 * captures at once, so the buyer's last press is the payment. No `brand_name`:
 * the site has never passed one, so PayPal shows the account's own.
 */
export async function createPaypalOrder(
  args: { amountUsd: number; customId: string; fundingSource?: PaypalFundingSource },
  f: typeof fetch = fetch,
): Promise<{ orderId: string }> {
  const source: PaypalFundingSource = args.fundingSource ?? "paypal";
  const token = await paypalAccessToken(f);
  const res = await f(`${paypalApiBase()}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: { currency_code: "USD", value: args.amountUsd.toFixed(2) },
          custom_id: args.customId,
        },
      ],
      ...(source === "venmo"
        ? { application_context: { shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW" } }
        : { payment_source: { paypal: { experience_context: { shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW" } } } }),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`paypal create order: ${res.status}`);
  const json = (await res.json()) as { id: string };
  return { orderId: json.id };
}

/**
 * Consumed by app/api/billing/paypal/webhook/route.ts.
 */
export async function verifyPaypalWebhook(
  args: { headers: Headers; rawBody: string },
  f: typeof fetch = fetch,
): Promise<boolean> {
  // A body that isn't even JSON is not a transient PayPal-side failure and
  // can never become one — unlike the non-200 thrown below, it must be
  // rejected (false), not thrown. Caught narrowly, on just this parse, so it
  // cannot swallow the "PayPal is down" throw a few lines down: a bare
  // try/wrap-the-whole-function here would make that throw indistinguishable
  // from this one, reopening exactly the ambiguity this split exists to
  // close. Checked before the token fetch, too — an unparseable body can
  // never be verified, so there is nothing for a token to buy here.
  let webhookEvent: unknown;
  try {
    webhookEvent = JSON.parse(args.rawBody);
  } catch {
    return false;
  }
  const token = await paypalAccessToken(f);
  const res = await f(`${paypalApiBase()}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      auth_algo: args.headers.get("paypal-auth-algo"),
      cert_url: args.headers.get("paypal-cert-url"),
      transmission_id: args.headers.get("paypal-transmission-id"),
      transmission_sig: args.headers.get("paypal-transmission-sig"),
      transmission_time: args.headers.get("paypal-transmission-time"),
      webhook_id: instanceString("paypal.webhookId"),
      webhook_event: webhookEvent,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  // A non-200 here is OUR/PayPal's failure, not "signature invalid" — the
  // caller (the webhook route) must answer PayPal with a 500 so it
  // retries, not a 400 so it gives up. Returning false on a transient outage
  // would make that outage indistinguishable from a forged webhook and
  // silently drop a real tip.
  if (!res.ok) throw new Error(`paypal verify webhook: ${res.status}`);
  const json = (await res.json()) as { verification_status?: string };
  // Anything else — an explicit FAILURE, or the field simply absent — is a failure.
  return json.verification_status === "SUCCESS";
}

/**
 * createPaypalOrder mints an order with
 * `intent: "CAPTURE"`, but approving it in the browser does NOT capture it —
 * something must call this. Consumed by
 * app/api/billing/paypal/capture/route.ts, which is invoked from `onApprove`
 * on the client. Server-side on purpose: the credentialed call stays on our
 * side, so a failed capture is something we can see and log rather than
 * something that dies in a tab.
 *
 * The response body is read AT MOST ONCE and never logged — it can carry
 * payer fields (see the module header).
 */
export async function capturePaypalOrder(
  orderId: string,
  f: typeof fetch = fetch,
): Promise<{ captured: boolean; alreadyCaptured: boolean }> {
  const token = await paypalAccessToken(f);
  const res = await f(`${paypalApiBase()}/v2/checkout/orders/${orderId}/capture`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.ok) return { captured: true, alreadyCaptured: false };

  // A double-submit or a retry lands here on the SECOND capture attempt —
  // the money is already taken and the webhook has already been told, so
  // this must not read as a failure. Any other 422 (or any other status)
  // falls through to the same throw createPaypalOrder uses for a non-2xx.
  const bodyText = await res.text().catch(() => "");
  if (res.status === 422 && isOrderAlreadyCaptured(bodyText)) {
    return { captured: true, alreadyCaptured: true };
  }
  throw new Error(`paypal capture order: ${res.status}`);
}

// PayPal's real 422 envelope echoes the issue code into `links[].href` (its
// own documentation URL) —
//   {"details":[{"issue":"ORDER_NOT_APPROVED",…}],
//    "links":[{"href":"https://developer.paypal.com/api/…#ORDER_NOT_APPROVED"}]}
// — captured from a real sandbox call, not inferred. A substring match over
// the WHOLE body reads that URL as data: a 422 for a DIFFERENT reason whose
// doc link happens to mention ORDER_ALREADY_CAPTURED (a plausible PayPal
// copy change one day) would misread as "already captured" and tell a
// tipper the money went through when it did not. So the real check is
// structural — `details[].issue === "ORDER_ALREADY_CAPTURED"` — and the
// substring match survives ONLY as a fallback for a 422 whose body does not
// parse as JSON at all: a 422 we cannot read structurally is still a 422,
// and reading it as a failure is strictly safer than reading it as either
// certainty. The JSON.parse sits in its OWN narrow try/catch — same
// discipline verifyPaypalWebhook uses for its rawBody parse — so a parse
// failure can never be mistaken for anything else going wrong below it.
function isOrderAlreadyCaptured(bodyText: string): boolean {
  let parsed: { details?: Array<{ issue?: unknown }> } | null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    // Not JSON at all — a 422 we cannot read structurally is still a 422.
    // The substring floor here is strictly for THIS case, not a general
    // second chance: once the body DOES parse, the structural check below
    // is authoritative even if it finds no matching issue, precisely
    // because falling back to a substring scan on well-formed-but-
    // differently-shaped JSON is the same "trust unrelated text" mistake
    // this whole function exists to avoid.
    return bodyText.includes("ORDER_ALREADY_CAPTURED");
  }
  return Array.isArray(parsed?.details) && parsed.details.some((d) => d?.issue === "ORDER_ALREADY_CAPTURED");
}
