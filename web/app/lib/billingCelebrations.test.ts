// Every NATIVE money celebration must carry a spendId and ride the retrying
// delivery.
//
// Why this is a source scan and not a behavioral test: the webhook route and
// giftServer import the pg pool and Stripe at module load, so they cannot be
// required under `node --test` without a database. The scan pins the two facts
// a refactor could silently drop:
//   • each celebration carries a stable, Stripe-derived spendId — the outcome
//     store on stream-api dedups on it, making the retry legal;
//   • the import comes from chatEventDelivery (the retrying, loud-on-loss
//     broadcastChatEvent), not a bare fetch helper.
//
// Vacuity anchors: every scanned file is also
// checked for a marker near its END, so a truncated read cannot pass the
// negative-shaped assertions by scanning nothing.
//
// Run: node --test app/lib/billingCelebrations.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const WEBHOOK = "app/api/billing/webhook/route.ts";
const GIFTS = "app/lib/giftServer.ts";
const SYNC = "app/lib/subscriptionSync.ts";

test("the donation celebration carries a session-derived spendId", () => {
  const src = read(WEBHOOK);
  assert.match(src, /kind:\s*"donation"[\s\S]{0,400}spendId:\s*`donation:\$\{cs\.id\}`|spendId:\s*`donation:\$\{cs\.id\}`[\s\S]{0,400}kind:\s*"donation"/,
    "the donation broadcast has no spendId — a retry (or a redelivered loss) cannot be deduped");
  assert.match(src, /export async function POST/, "vacuity anchor: the webhook route's handler is gone — scan is reading the wrong file");
});

test("the sub celebration carries a subscription-derived spendId", () => {
  const sync = read(SYNC);
  assert.match(sync, /if \(paid\.kind === "first"\) return \{ \.\.\.base, spendId: `sub:\$\{sub\.id\}`, months: 1 \};/,
    "month one's card has no subscription-derived spendId — one lost during a restart leaves the bar short on real money");
  assert.match(sync.slice(-300), /export const syncSubscriptionState = bound\.syncSubscription;\s*$/, "vacuity anchor: subscriptionSync's tail");
});

// A1-01: the "X subscribed" card is sent from ONE place, invoice.paid. While it hung off
// customer.subscription.created's state write, a .created that lost the delivery race to
// checkout.session.completed was dropped by the recency gate, and month one with it.
test("the route sends a sub card from exactly one place, and never from a state event", () => {
  const src = read(WEBHOOK);
  assert.equal((src.match(/kind: "sub",/g) ?? []).length, 1, "a second sub card would double-announce or hang off a droppable event");
  const sync = src.match(/async function syncSubscription\([\s\S]*?\n\}\n?/)?.[0] ?? "";
  assert.match(sync, /invalidateTier\(matrixId\);/, "vacuity anchor: syncSubscription's body was not captured");
  assert.doesNotMatch(sync, /broadcastChatEvent\(/, "a state event must not announce — invoice.paid owns the card");
  assert.match(src, /case "customer\.subscription\.created":\s*case "customer\.subscription\.updated":\s*case "customer\.subscription\.deleted":\s*await syncSubscription\(event\.data\.object as Stripe\.Subscription, event\.created\);/);
});

test("the gift celebration keeps its session-derived spendId", () => {
  const src = read(GIFTS);
  assert.match(src, /spendId:\s*`gift:\$\{sessionId\}`/,
    "announceGift lost its spendId — the round-2 dedup contract for gifts is broken");
  assert.match(src, /export function startGiftExpirySweep/,
    "vacuity anchor: giftServer's exports are gone — scan is reading the wrong file");
});

test("both celebration callers use the retrying delivery, not a bare fire-and-forget", () => {
  for (const f of [WEBHOOK, GIFTS]) {
    const src = read(f);
    assert.match(src, /import\s*\{[^}]*broadcastChatEvent[^}]*\}\s*from\s*["'][^"']*chatEventDelivery(?:\.ts)?["']/,
      `${f} imports broadcastChatEvent from somewhere other than chatEventDelivery — ` +
      "a single-shot streamApiPost swallows a failed delivery");
  }
});

// ── Renewals ─────────────────────────────────────────────────────────────────
//
// Without invoice.paid a renewal reaches the webhook only as
// subscription.updated with announce off — no card, no bar credit, no
// stream.support_events row. invoice.paid is the event that says money moved
// for a cycle; its guards run in subRenewal.test.ts, this pins the wiring.

const MONEY_JS = "../stream-api/money.js";
const EVENT_BODY = "app/components/chatEventBody.tsx";

test("invoice.paid is handled, through the guarded paid-invoice helper, with an invoice-derived spendId", () => {
  const src = read(WEBHOOK);
  assert.match(src.slice(-300), /invalidateTier\(matrixId\);\s*\}\s*$/, "vacuity anchor: the route's tail (syncSubscription) changed — re-check the read");
  assert.match(src, /case "invoice\.paid":\s*[\s\S]{0,600}?await recordPaidInvoice\(event\.data\.object as Stripe\.Invoice\);/,
    "invoice.paid is not routed to recordPaidInvoice — month one and renewals fund nothing again");
  assert.match(src, /const card = await paidSubscriptionCard\(inv\);\s*if \(!card\) return;/,
    "the billing_reason guard must run FIRST");
  assert.match(src, /kind: "sub",\s*spendId: card\.spendId,/);
  const sync = read(SYNC);
  assert.match(sync, /const paid = paidSubscriptionInvoice\(inv\);\s*if \(!paid\) return null;/);
  assert.match(sync, /spendId: `renewal:\$\{paid\.invoiceId\}`/,
    "the renewal card needs an invoice-derived spendId distinct from the first month's sub:<id>");
  const fn = src.match(/async function recordPaidInvoice\([\s\S]*?\n\}\n/)?.[0] ?? "";
  assert.ok(fn.includes("broadcastChatEvent("), "vacuity anchor: recordPaidInvoice's body was not captured");
  assert.doesNotMatch(fn, /INSERT INTO|UPDATE |pool\.query/,
    "recordPaidInvoice must not write site.subscriptions — syncSubscription stays the only writer of tier/status");
  const card = sync.match(/async function paidInvoiceCard\([\s\S]*?\n {2}\}\n/)?.[0] ?? "";
  assert.ok(card.includes("tenureMonths("), "vacuity anchor: paidInvoiceCard's body was not captured");
  assert.doesNotMatch(card, /INSERT INTO|UPDATE |writeTransition|writeState/,
    "paidInvoiceCard must not write subscription state");
});

test("a renewal reads as 'resubscribed · N months' on the card and the alert", () => {
  const body = read(EVENT_BODY);
  assert.match(body.slice(-200), /\}\s*$/, "vacuity anchor");
  assert.match(body, /\{months > 1 \? "resubscribed" : "subscribed"\}/, "the chat card's sub copy no longer distinguishes a renewal");
  assert.match(body, /months > 1 \? ` · \$\{months\} months` : ""/);
  const money = read(MONEY_JS);
  assert.match(money.slice(-300), /module\.exports = \{[\s\S]*\};\s*$/, "vacuity anchor: money.js tail");
  assert.match(money, /label: msg\.months > 1 \? 'resubscribed' : 'subscribed', tier: msg\.tier, months: msg\.months,/,
    "stream-api's alert label must follow the tenure too, or OBS says 'subscribed' on a 7th month");
});
