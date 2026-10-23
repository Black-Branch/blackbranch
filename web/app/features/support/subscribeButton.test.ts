// The Subscribe button under the player (StreamMetaBar, gated by StreamView): it shows when a
// subscription is for sale through EITHER provider (k, 2026-10-21) and opens the Support panel on
// its subscribe view, where the panel shows the providers that are set. A viewer who already
// subscribes sees Gift there instead, and gifts are card checkouts, so that needs Stripe's price.
//
// Run: systemd-run --user --scope -q -p MemoryMax=8G env -u DATABASE_URL node --test app/features/support/subscribeButton.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { subscribeButton } from "./subscribeButton.ts";
import { stripComments } from "../../lib/testSource.ts";

const MONTH = { amount: 500, currency: "usd" };
// What useBillingAvailability answers on each kind of site.
const SITES = {
  stripeOnly: { stripe: true, supporter: MONTH, subscribe: MONTH },
  paypalOnly: { stripe: false, supporter: null, subscribe: MONTH },
  both: { stripe: true, supporter: MONTH, subscribe: MONTH },
  neither: { stripe: false, supporter: null, subscribe: null },
  // Stripe on with no Supporter price, PayPal selling the plan.
  stripeNoPricePaypalPlan: { stripe: true, supporter: null, subscribe: MONTH },
} as const;

test("a site that sells subscriptions through PayPal only shows the Subscribe button, opening the panel in place", () => {
  assert.deepEqual(subscribeButton({ billing: SITES.paypalOnly, subscribed: false, outsideUrl: "" }), { shown: true, inPlace: true });
  assert.deepEqual(subscribeButton({ billing: SITES.stripeNoPricePaypalPlan, subscribed: false, outsideUrl: "" }), { shown: true, inPlace: true });
});

test("Stripe only and both providers: unchanged, Subscribe and Gift both open in place", () => {
  for (const site of [SITES.stripeOnly, SITES.both]) {
    for (const subscribed of [false, true]) {
      assert.deepEqual(subscribeButton({ billing: site, subscribed, outsideUrl: "" }), { shown: true, inPlace: true });
    }
  }
});

test("nothing for sale: no button, unless the site set an outside subscribe link, which then opens", () => {
  assert.deepEqual(subscribeButton({ billing: SITES.neither, subscribed: false, outsideUrl: "" }), { shown: false, inPlace: false });
  assert.deepEqual(subscribeButton({ billing: SITES.neither, subscribed: false, outsideUrl: "https://site.test/sub" }), { shown: true, inPlace: false });
});

test("a subscriber on a site with no card price sees no Gift button: gifts are card checkouts", () => {
  assert.deepEqual(subscribeButton({ billing: SITES.paypalOnly, subscribed: true, outsideUrl: "" }), { shown: false, inPlace: false });
  assert.deepEqual(subscribeButton({ billing: SITES.stripeNoPricePaypalPlan, subscribed: true, outsideUrl: "" }), { shown: false, inPlace: false });
});

test("restart and retry: the answer follows the availability it is given, call by call (no state of its own)", () => {
  // useBillingAvailability re-reads the server on focus and keeps its last answer on a failed read;
  // this function is recomputed from that answer every render, so a plan set later shows at once.
  assert.equal(subscribeButton({ billing: SITES.neither, subscribed: false, outsideUrl: "" }).shown, false);
  assert.equal(subscribeButton({ billing: SITES.paypalOnly, subscribed: false, outsideUrl: "" }).shown, true);
  assert.equal(subscribeButton({ billing: SITES.neither, subscribed: false, outsideUrl: "" }).shown, false);
});

test("the help desk agrees: with PayPal on it says a PayPal plan sells the subscription without card payments, and where to press", async () => {
  const { MODULES } = await import("../../lib/instanceSchema.generated.mjs");
  const said = (id: string) => (MODULES as { id: string; helpdesk?: { on: string; off?: string } }[]).find((m) => m.id === id)?.helpdesk;
  const paypal = said("paypal");
  assert.ok(paypal, "vacuity anchor: the PayPal module has help-desk texts");
  assert.match(paypal!.on, /When the site has set up a PayPal plan, the Supporter subscription can be paid with PayPal too, also on a site without card payments/);
  assert.match(paypal!.on, /press Subscribe under the player/);
  // Card payments off must not read as "no subscriptions": only gifts need a card.
  assert.doesNotMatch(said("stripe")!.off ?? "", /subscriptions? (are|is) not|no subscription/i);
  assert.match(said("stripe")!.on, /When the site has set a subscription price/, "the card text no longer promises a subscription with no price");
  for (const t of [paypal!.on, said("stripe")!.on]) assert.doesNotMatch(t, /—/, "no em-dashes in viewer-facing text");
});

test("wiring: StreamView decides the Subscribe button with subscribeButton, from useBillingAvailability", () => {
  const raw = readFileSync(new URL("../../components/StreamView.tsx", import.meta.url), "utf8");
  assert.match(raw.trimEnd().slice(-200), /const GuestSupportContent = dynamic\(.*\);$/, "vacuity anchor: StreamView was read to its last line");
  const src = stripComments(raw);
  assert.match(src, /const subscribeBtn = subscribeButton\(\{ billing, subscribed, outsideUrl: subscribeUrl \}\);/);
  assert.match(src, /subscribeUrl=\{subscribeBtn\.shown \? subscribeUrl : null\}/);
  assert.match(src, /: subscribeBtn\.inPlace;/, "the in-place choice for the subscribe section is the same answer");
  assert.doesNotMatch(src, /billing\.supporter !== null/, "the Stripe price alone no longer decides that subscriptions exist");
});
