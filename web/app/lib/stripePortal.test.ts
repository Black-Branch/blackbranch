// "Manage subscription" when the streamer never saved Stripe's customer portal (A1-07, KG-06).
//
// billingPortal.sessions.create refuses without the account's DEFAULT portal configuration, which
// exists only once its settings were saved. The route had no catch: the subscriber saw "Couldn't
// open the billing portal." (the one in-site way to cancel, dead) and the streamer saw a bare 500,
// no Doctor row and no Check. Now the refusal is classified: the route logs the exact Stripe step,
// answers 409 portal_not_set_up, and the panel tells the viewer the site has not finished setting it
// up; the Stripe Check and the Doctor's Stripe row name the step (providerChecks.test.ts).
//
// Run: node --test app/lib/stripePortal.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Stripe from "stripe";
import { isPortalNotSetUp, PORTAL_NOT_SET_UP } from "./stripePortal.ts";
import { withStripePortal } from "./doctor/stripePortalFact.ts";
import { stripComments } from "./testSource.ts";

// Stripe's refusal, as its SDK raises it (the message Stripe sends for a never-saved portal).
const neverSaved = () => new Stripe.errors.StripeInvalidRequestError({
  type: "invalid_request_error",
  message: "No configuration provided and your live mode default configuration has not been created. Provide a configuration or create your default by saving your customer portal settings in live mode at https://dashboard.stripe.com/settings/billing/portal.",
});

test("a never-saved customer portal is told apart from every other refusal", () => {
  assert.equal(isPortalNotSetUp(neverSaved()), true);
  assert.equal(isPortalNotSetUp(new Stripe.errors.StripeInvalidRequestError({ type: "invalid_request_error", message: "No such customer: 'cus_x'", code: "resource_missing" })), false);
  assert.equal(isPortalNotSetUp(new Stripe.errors.StripeRateLimitError({ message: "slow down" })), false);
  assert.equal(isPortalNotSetUp(new Error("default configuration has not been created")), false, "only Stripe's own refusal");
  assert.equal(isPortalNotSetUp(null), false);
});

test("the Doctor's Stripe row fails on a never-saved portal only once the webhook passes", async () => {
  const ok = { ok: true, code: "accepted", detail: "accepted" };
  const portal = { ok: false, code: "no_portal", detail: "the customer portal was never saved in Stripe — …" };
  const ask = (answer: typeof ok) => async (t: string) => { assert.equal(t, "stripe-portal"); return answer; };
  assert.deepEqual(await withStripePortal({ on: true, test: ok }, ask(portal)), { on: true, test: portal });
  assert.deepEqual(await withStripePortal({ on: true, test: ok }, ask(ok)), { on: true, test: ok });
  const webhookBad = { ok: false, code: "not_found", detail: "not found" };
  assert.deepEqual(await withStripePortal({ on: true, test: webhookBad }, async () => { throw new Error("not asked"); }), { on: true, test: webhookBad });
  assert.deepEqual(await withStripePortal({ on: false, test: null }, async () => { throw new Error("not asked"); }), { on: false, test: null });
  const limited = { ok: true, code: "limited", detail: "key works, but lacks a permission this check needs" };
  assert.deepEqual(await withStripePortal({ on: true, test: ok }, ask(limited)), { on: true, test: ok }, "the site cannot know: the webhook's verdict stands");
});

const read = (p: string) => readFileSync(join(import.meta.dirname, "..", "..", p), "utf8");

test("wiring: the route answers the classified refusal, the panel says so, the setup names the step", () => {
  const route = stripComments(read("app/api/billing/portal/route.ts"));
  assert.match(route, /if \(isPortalNotSetUp\(e\)\) \{[\s\S]{0,400}Response\.json\(\{ error: PORTAL_NOT_SET_UP \}, \{ status: 409 \}\)/);
  assert.match(route, /Settings → Billing → Customer portal → Save/, "the journal line names the Stripe step");
  assert.match(route.trimEnd(), /return Response\.json\(\{ url: portal\.url \}\);\s*\}$/, "END of the route read");
  const panel = stripComments(read("app/components/SupportContent.tsx"));
  assert.match(panel, /j\?\.error === "portal_not_set_up"/);
  assert.equal(PORTAL_NOT_SET_UP, "portal_not_set_up");
  const modules = read("../config/modules.mjs");
  assert.match(modules, /id: 'portal', title: 'The customer portal'/);
});
