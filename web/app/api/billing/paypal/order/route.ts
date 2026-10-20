import { auth } from "@/auth";
import pool from "@/lib/db";
import { paypalConfigured, createPaypalOrder, orderFundingSource } from "@/app/lib/paypalClient";
import { NextRequest } from "next/server";
import { sanitizeDisplayName, sanitizeChatMessage } from "@/app/lib/sanitize";
import { donationTtsChars } from "@/app/lib/donationTts";
import { createSlidingWindowLimiter, ipKey } from "@/app/lib/rateLimit";
import { resolveTipDisplayName } from "@/app/lib/tipDisplayNameServer";
import { PAY_MIN_CENTS, PAY_MAX_CENTS } from "@/app/lib/coins";
import { currencyName } from "@/app/lib/currency";
import { instanceBool } from "@/app/lib/instanceConfigServer";
import { orderPurpose, pointsOrders } from "@/app/lib/paypalPointsOrder";

export const runtime = "nodejs";

// Guests can call this, and every accepted call creates a PayPal order — same
// throttle shape as donate's isDonateLimited.
const isPaypalOrderLimited = createSlidingWindowLimiter(10 * 60_000, 10);

// POST /api/billing/paypal/order { purpose?, amount, message?, displayName?, anonymous? } → { orderId }
// `purpose` is absent/"tip" (a live tip — unchanged below) or "points" (a quiet
// signed-in Qorm purchase, handled in its own branch right after the amount
// is parsed, before any tip-only field is read).
//
// Opens a PayPal order for a one-time tip and writes a `site.donations` row
// with status='pending' BEFORE calling PayPal — PayPal's custom_id is capped
// at 127 characters and cannot carry the message, so the row (identified by a
// freshly minted external_id) is what actually holds it. If createPaypalOrder
// below then throws, the pending row is harmless: nothing reads
// status = 'pending', and the webhook
// is the ONLY writer of any state past this point — this route must
// never grant anything, move a total, or fire an alert.
export async function POST(req: NextRequest) {
  if (!paypalConfigured()) return new Response("Billing not configured", { status: 503 });

  const body = await req.json().catch(() => null);

  // amount arrives as dollars (number or numeric string); coerce to integer cents.
  const dollars = Number(body?.amount);
  if (!Number.isFinite(dollars)) return new Response("Bad amount", { status: 400 });
  const cents = Math.round(dollars * 100);

  // A quiet Qorm purchase. Absent = a tip, so every tip (which sends no
  // purpose) is unchanged. Anything else is a client bug, refused rather
  // than guessed at.
  const purpose = orderPurpose(body?.purpose);
  if (purpose !== "tip" && purpose !== "points") return new Response("Bad purpose", { status: 400 });

  // The button the buyer pressed (PayPal or Venmo): the order's payment_source,
  // where NO_SHIPPING lives. Absent = PayPal (a page loaded before the field).
  const fundingSource = orderFundingSource(body?.fundingSource);
  if (!fundingSource) return new Response("Bad funding source", { status: 400 });

  if (purpose === "points") {
    // The buy switch (`currency.purchasable`): a tip is never affected by it.
    if (!instanceBool("currency.purchasable")) return new Response(`Buying ${currencyName()} is switched off on this site`, { status: 403 });
    // Same range as the Store's card path (billing/points/route.ts) and a tip
    // — the shared PAY_MIN_CENTS/PAY_MAX_CENTS constants, never a copy.
    if (cents < PAY_MIN_CENTS || cents > PAY_MAX_CENTS) {
      return new Response(`Amount must be between $${PAY_MIN_CENTS / 100} and $${PAY_MAX_CENTS / 100}`, { status: 400 });
    }
    const buyer = (await auth())?.user?.id ?? null;
    if (!buyer) return new Response(`Sign in to buy ${currencyName()}`, { status: 401 });
    if (isPaypalOrderLimited(buyer)) {
      return new Response("Too many attempts — try again in a few minutes.", { status: 429 });
    }
    // Writes ONLY a pending site.paypal_coin_orders row — never donations,
    // no message, no name. The webhook credits the wallet on capture.
    const { orderId } = await pointsOrders.open({ matrixId: buyer, cents, fundingSource });
    return Response.json({ orderId });
  }

  if (cents < PAY_MIN_CENTS || cents > PAY_MAX_CENTS) {
    return new Response(`Amount must be between $${PAY_MIN_CENTS / 100} and $${PAY_MAX_CENTS / 100}`, { status: 400 });
  }

  const session = await auth();
  const matrixId = session?.user?.id ?? null;
  const anonymous = body?.anonymous === true;

  // Donor-supplied label/message get the same sanitizing every display name
  // and chat line gets — never the payer's real name (PayPal's order/capture
  // bodies can carry payer.name/payer.email_address; nothing here ever reads
  // either — see paypalClient.ts and paypalCapture.ts).
  const rawName = typeof body?.displayName === "string" ? sanitizeDisplayName(body.displayName) : "";

  // The message may be at most what the voice will read for this amount.
  // Sanitize at `maxMessage + 1`, NEVER the flat 500 default: the top tier IS
  // 500, so sanitizing at the default first would silently cut a top-tier
  // overflow to exactly 500 and `rawMsg.length > maxMessage` could then never
  // see it as over (the same bug the chat route's `charLimit + 1` fixed, and
  // the donate route's `maxMessage + 1` fixed before it).
  const maxMessage = donationTtsChars(cents / 100);
  const rawMsg = typeof body?.message === "string" ? sanitizeChatMessage(body.message, maxMessage + 1) : "";
  if (rawMsg.length > maxMessage) {
    return new Response(
      `A $${(cents / 100).toFixed(2)} tip carries a message of up to ${maxMessage} characters.`,
      { status: 400 }
    );
  }

  // Throttle AFTER every input refusal above (a typo or a stale over-length
  // draft is not a hit) and BEFORE anything reaches PayPal — the insert
  // below included.
  if (isPaypalOrderLimited(matrixId ?? ipKey(req))) {
    return new Response("Too many tip attempts — try again in a few minutes.", { status: 429 });
  }

  // Mirrors donate/route.ts: a signed-in, non-anonymous tipper who left the
  // box blank gets their own site.users.display_name, same as Stripe. The tip
  // page tells a signed-in tipper this will happen, and the webhook only ever
  // flips `status`, so this route's write is the final word on display_name.
  // Deliberately NOT ensureStripeCustomer — that is Stripe-only and has no
  // business on the PayPal path.
  const displayName = await resolveTipDisplayName({ matrixId, anonymous, rawName });
  const externalId = crypto.randomUUID();

  // Deliberately NOT setting stripe_session_id — that column is nullable
  // since v124 and this is a PayPal row. status='pending' because nothing is
  // confirmed yet; the webhook flips it to 'completed' once PayPal
  // reports the capture. Nothing reads status = 'pending', so this row is
  // harmless if createPaypalOrder below fails.
  await pool.query(
    `INSERT INTO site.donations
       (provider, external_id, status, matrix_id, display_name, message, amount_cents, currency, anonymous)
     VALUES ('paypal', $1, 'pending', $2, $3, $4, $5, 'usd', $6)`,
    [externalId, matrixId, displayName, rawMsg, cents, anonymous]
  );

  const { orderId } = await createPaypalOrder({ amountUsd: cents / 100, customId: externalId, fundingSource });

  return Response.json({ orderId });
}
