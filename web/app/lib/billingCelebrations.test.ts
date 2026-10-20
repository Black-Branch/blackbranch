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

test("the donation celebration carries a session-derived spendId", () => {
  const src = read(WEBHOOK);
  assert.match(src, /kind:\s*"donation"[\s\S]{0,400}spendId:\s*`donation:\$\{cs\.id\}`|spendId:\s*`donation:\$\{cs\.id\}`[\s\S]{0,400}kind:\s*"donation"/,
    "the donation broadcast has no spendId — a retry (or a redelivered loss) cannot be deduped");
  assert.match(src, /export async function POST/, "vacuity anchor: the webhook route's handler is gone — scan is reading the wrong file");
});

test("the sub celebration carries a subscription-derived spendId", () => {
  const src = read(WEBHOOK);
  assert.match(src, /kind:\s*"sub"[\s\S]{0,400}spendId:\s*`sub:\$\{sub\.id\}`|spendId:\s*`sub:\$\{sub\.id\}`[\s\S]{0,400}kind:\s*"sub"/,
    "the new-sub broadcast has no spendId — one lost during a restart leaves the bar short on real money");
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
    assert.match(src, /import\s*\{[^}]*broadcastChatEvent[^}]*\}\s*from\s*["'][^"']*chatEventDelivery["']/,
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

test("invoice.paid is handled, through the guarded renewal helper, with an invoice-derived spendId", () => {
  const src = read(WEBHOOK);
  assert.match(src.slice(-600), /months: 1,[\s\S]*currency: price\?\.currency \?\? "usd",\s*\}\);\s*\}\s*\}\s*$/, "vacuity anchor: the route's tail (syncSubscription's first-month card) changed — re-check the read");
  assert.match(src, /case "invoice\.paid":\s*[\s\S]{0,600}?await recordRenewal\(stripe, event\.data\.object as Stripe\.Invoice\);/,
    "invoice.paid is not routed to recordRenewal — renewals fund nothing again");
  assert.match(src, /import \{ renewalFromInvoice, tenureMonths \} from "@\/app\/lib\/subRenewal";/);
  assert.match(src, /const renewal = renewalFromInvoice\(inv\);\s*if \(!renewal\) return;/,
    "the billing_reason guard must run FIRST — subscription_create here double-credits the first month");
  assert.match(src, /kind: "sub",[\s\S]{0,400}spendId: `renewal:\$\{inv\.id\}`/,
    "the renewal card needs an invoice-derived spendId distinct from the first month's sub:<id>");
  const fn = src.match(/async function recordRenewal\([\s\S]*?\n\}\n/)?.[0] ?? "";
  assert.ok(fn.includes("broadcastChatEvent("), "vacuity anchor: recordRenewal's body was not captured");
  assert.doesNotMatch(fn, /INSERT INTO|UPDATE |pool\.query/,
    "recordRenewal must not write site.subscriptions — syncSubscription stays the only writer of tier/status");
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
