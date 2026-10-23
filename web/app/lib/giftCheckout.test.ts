// A card subscription bought while a gift is still running starts billing when the gift ENDS
// (2026-10-21: a viewer with a gift until Oct 20 subscribed on Sep 26 and paid for 24 days the gift
// already covered). The reverse rule — a gift to a paying subscriber starts after the paid period —
// is giftServer.ts grantGift. Checkout carries it as subscription_data.trial_end, which Stripe takes
// only "at least 48 hours in the future" (docs.stripe.com/api/checkout/sessions/create); a gift
// ending sooner than that is not waited for, and the card is billed today, as before.
// PayPal subscriptions have no trial here, so the sheet says what PayPal does instead.
// Run: node --test app/lib/giftCheckout.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
import { giftTrialEnd, giftSubscribeNotes, GIFT_TRIAL_MIN_LEAD_MS } from "./supportStatus.ts";
import type Stripe from "stripe";
import { normaliseStripeStatus, stripeObservation, settleNeverPaid, needsPaymentHistory } from "./subscriptions/stripeRecords.ts";
import { isActiveStatus } from "./tiers.ts";
import { GRACE_DAYS } from "./subscriptions/grace.ts";

const NOW = new Date("2026-09-26T12:00:00Z");
const fmt = (d: Date) => d.toISOString().slice(0, 10);
const HOUR = 3_600_000;

test("an active gift → trial_end is the gift's expiry, in unix seconds", () => {
  assert.equal(giftTrialEnd("2026-10-20T08:30:00Z", NOW), Date.parse("2026-10-20T08:30:00Z") / 1000);
  assert.equal(giftTrialEnd(new Date("2026-10-20T08:30:00.900Z"), NOW), Math.floor(Date.parse("2026-10-20T08:30:00.900Z") / 1000), "whole seconds");
});

test("no gift, or one ending inside Stripe's 48-hour floor → no trial (billed today)", () => {
  assert.equal(giftTrialEnd(null, NOW), null);
  assert.ok(GIFT_TRIAL_MIN_LEAD_MS >= 48 * HOUR, "never below Stripe's documented minimum");
  assert.equal(giftTrialEnd(new Date(NOW.getTime() + 48 * HOUR), NOW), null, "exactly 48 h is too close to the edge to send");
  assert.equal(giftTrialEnd(new Date(NOW.getTime() + 10 * HOUR), NOW), null);
  assert.equal(giftTrialEnd(new Date(NOW.getTime() - HOUR), NOW), null, "an expired gift is no gift");
  assert.equal(giftTrialEnd("not a date", NOW), null);
  const justFar = new Date(NOW.getTime() + GIFT_TRIAL_MIN_LEAD_MS + 1000);
  assert.equal(giftTrialEnd(justFar, NOW), Math.floor(justFar.getTime() / 1000));
});

test("a trialing subscription still entitles — the record never reads as ended", () => {
  assert.equal(normaliseStripeStatus("trialing"), "active");
});

const view = (giftExpiresAt: string | null) => ({
  tier: null, subStatus: null, subRenewsAt: null, subCancelAtPeriodEnd: false,
  giftActive: giftExpiresAt != null, giftExpiresAt, giftFrom: null,
});

test("the subscribe sheet says when billing starts (card) and what PayPal does, while a gift runs", () => {
  const n = giftSubscribeNotes(view("2026-10-20T08:30:00Z"), NOW, fmt);
  assert.equal(n.card, "Billing starts when your gift ends on 2026-10-20 — nothing is charged today.");
  assert.equal(n.paypal, "PayPal bills today, so the rest of your gift (until 2026-10-20) goes unused.");
});

test("a gift ending inside the floor: the card line says it bills today", () => {
  const n = giftSubscribeNotes(view(new Date(NOW.getTime() + 10 * HOUR).toISOString()), NOW, fmt);
  assert.equal(n.card, "Your gift ends on 2026-09-26 — a card subscription is billed today.");
});

test("no gift: nothing to say", () => {
  assert.deepEqual(giftSubscribeNotes(view(null), NOW, fmt), { card: null, paypal: null });
});

// The route imports through @/ (Stripe, auth, pool), so it is scanned, not run.
test("checkout reads the viewer's unexpired gift and sends its end as trial_end", () => {
  const raw = readFileSync(join(import.meta.dirname, "..", "api", "billing", "checkout", "route.ts"), "utf8");
  const src = stripComments(raw);
  assert.match(src, /return Response\.json\(\{ clientSecret: checkout\.client_secret \}\);\s*\}\s*$/, "END of the route not read");
  assert.match(src, /FROM site\.gift_subscriptions\s+WHERE recipient_matrix_id = \$1 AND expires_at > now\(\)/);
  assert.match(src, /const trialEnd = giftTrialEnd\(/);
  const create = src.slice(src.indexOf("stripe.checkout.sessions.create("));
  assert.match(create, /subscription_data: \{\s*metadata: \{ matrix_id: matrixId, tier: tier\.slug \},\s*\.\.\.\(trialEnd\s*\? \{ trial_end: trialEnd, /,
    "trial_end rides in subscription_data, only when there is one");
});

test("the sheet renders both notes", () => {
  const raw = readFileSync(join(import.meta.dirname, "..", "components", "SupportContent.tsx"), "utf8");
  const src = stripComments(raw);
  assert.match(src, /giftSubscribeNotes\(/);
  assert.match(src, /giftNotes\.card/);
  assert.match(src, /giftNotes\.paypal/);
});

// Money: a trialing subscription has paid NOTHING at creation (a $0 invoice), and Stripe charges at
// trial end as a subscription_cycle invoice, which recordRenewal credits. So the creation card must
// not credit the price too — that would be income that never arrived, then counted twice.
test("the creation card skips a trialing subscription; the trial-end charge is credited once, as month one", () => {
  const raw = readFileSync(join(import.meta.dirname, "..", "api", "billing", "webhook", "route.ts"), "utf8");
  const src = stripComments(raw);
  assert.match(src, /currency: price\?\.currency \?\? "usd",\s*\}\);\s*\}\s*\}\s*$/, "END of the webhook route not read");
  assert.match(src, /if \(sub && isActiveStatus\(sub\.status\) && sub\.status !== "trialing"\) \{/);
  assert.match(src, /months: tenureMonths\(paid, sub\.trial_end != null\),/);
});

// ─── Security review 2026-10-22: a trial is not a payment ─────────────────────────────────────────
// A subscription created with trial_end has never had a paid invoice. If the first charge after the
// trial fails, Stripe leaves it past_due — and past_due entitles, with grace days on the period end.
// That would hand out Supporter access nobody paid for. So: Checkout saves a card up front and
// cancels a trial that ends without one, and a past_due subscription that came out of a trial with
// no successful non-zero payment is treated like `incomplete` (never entitles, no grace).
const DAY = 86_400_000;
const trialEnd = Date.parse("2026-10-20T08:30:00Z") / 1000;
const nextEnd = Date.parse("2026-11-20T08:30:00Z") / 1000;
const stripeSub = (status: string, cpe: number, trial: number | null = trialEnd) => ({
  id: "sub_gadget", status, customer: "cus_gadget", cancel_at_period_end: false, cancel_at: null, trial_end: trial,
  items: { data: [{ price: { id: "price_x" }, current_period_end: cpe }] },
}) as unknown as Stripe.Subscription;
const entitles = (o: { status: string; accessUntil: Date | null }, at: number) =>
  (o.status === "active" || o.status === "past_due") && (o.accessUntil == null || o.accessUntil.getTime() > at);

test("trial ends + the first charge fails → NOT entitled, no grace, no badge", () => {
  const failed = stripeSub("past_due", nextEnd);
  assert.equal(needsPaymentHistory(failed), true, "the reconciler must look up this subscription's paid invoices");
  const settled = settleNeverPaid(failed, [0]); // only the $0 trial invoice was ever paid
  assert.equal(settled.status, "incomplete");
  const o = stripeObservation(settled, new Date());
  assert.equal(o.status, "pending");
  assert.equal(entitles(o, Date.parse("2026-10-21T00:00:00Z")), false);
  assert.equal(isActiveStatus(settled.status), false, "the legacy row (badge, /api/me) reads it as not active too");
  assert.equal(settleNeverPaid(failed, []).status, "incomplete", "no paid invoice at all");
});

test("trial ends + the first invoice is paid → entitled as normal, grace and all", () => {
  const paid = stripeSub("active", nextEnd);
  assert.equal(needsPaymentHistory(paid), false, "only a past_due trialed subscription needs the lookup");
  const o = stripeObservation(settleNeverPaid(paid, null), new Date());
  assert.equal(o.status, "active");
  assert.equal(o.accessUntil?.getTime(), nextEnd * 1000 + GRACE_DAYS * DAY);
  // A LATER renewal failing, after a real payment: past_due with grace, exactly as before.
  const laterFail = settleNeverPaid(stripeSub("past_due", nextEnd), [0, 500]);
  assert.equal(laterFail.status, "past_due");
  assert.equal(stripeObservation(laterFail, new Date()).accessUntil?.getTime(), nextEnd * 1000 + GRACE_DAYS * DAY);
});

test("a subscription that never had a trial keeps today's past_due rule", () => {
  const plain = stripeSub("past_due", nextEnd, null);
  assert.equal(needsPaymentHistory(plain), false);
  assert.equal(settleNeverPaid(plain, null).status, "past_due");
});

test("while trialing, access ends at the trial's end — no grace days on a period nobody paid for", () => {
  const o = stripeObservation(stripeSub("trialing", trialEnd), new Date());
  assert.equal(o.status, "active");
  assert.equal(o.accessUntil?.getTime(), trialEnd * 1000);
});

test("the reconciler settles every Stripe subscription before it is observed or written", () => {
  const raw = readFileSync(join(import.meta.dirname, "subscriptionSync.ts"), "utf8");
  const src = stripComments(raw);
  assert.match(src, /export const syncSubscriptionState = bound\.syncSubscription;\s*$/, "END of subscriptionSync.ts not read");
  assert.match(src, /async function settle\(sub: Stripe\.Subscription\): Promise<Stripe\.Subscription> \{[\s\S]*?needsPaymentHistory\(sub\)[\s\S]*?invoices\.list\(\{ subscription: sub\.id, status: "paid", limit: 100 \}\)[\s\S]*?settleNeverPaid\(sub, /);
  assert.match(src, /const all = await Promise\.all\(\(await viewerSubscriptions\(client, matrixId, eventCustomer\)\)\.map\(settle\)\);/);
  assert.match(src, /const sub = countsForViewer\(all\) \?\? \(await settle\(await deps\.stripe\(\)\.subscriptions\.retrieve\(ref\.id\)\)\);/);
  assert.match(src, /observations\.push\(stripeObservation\(await settle\(await deps\.stripe\(\)\.subscriptions\.retrieve\(id\)\), stamp\)\);/);
});

test("checkout cancels a trial that ends without a card, and keeps collecting one up front", () => {
  const raw = readFileSync(join(import.meta.dirname, "..", "api", "billing", "checkout", "route.ts"), "utf8");
  const src = stripComments(raw);
  assert.match(src, /\.\.\.\(trialEnd\s*\? \{ trial_end: trialEnd, trial_settings: \{ end_behavior: \{ missing_payment_method: "cancel" \} \} \}\s*: \{\}\)/);
  assert.doesNotMatch(src, /payment_method_collection/, "the default (always) saves a card even for a trial");
});
