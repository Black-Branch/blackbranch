// The Stripe mapping's end of access (spec §3.4; security review 2026-10-21, finding 4), run.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Stripe from "stripe";
import { stripeObservation } from "./stripeRecords.ts";
import { GRACE_DAYS } from "./grace.ts";

const sub = (cpe: number | null, status = "active") => ({
  id: "sub_gadget", status, customer: "cus_gadget", cancel_at_period_end: false,
  items: { data: [{ price: { id: "price_x" }, ...(cpe ? { current_period_end: cpe } : {}) }] },
}) as unknown as Stripe.Subscription;

test("attack: a lost customer.subscription.deleted cannot leave access open for ever — a Stripe record ends at its period end + the grace days", () => {
  const end = Date.parse("2026-11-03T00:00:00Z");
  const o = stripeObservation(sub(end / 1000), new Date());
  assert.equal(o.accessUntil?.getTime(), end + GRACE_DAYS * 86_400_000);
  // Each renewal moves the period end, and with it the access.
  const next = Date.parse("2026-12-03T00:00:00Z");
  assert.equal(stripeObservation(sub(next / 1000), new Date()).accessUntil?.getTime(), next + GRACE_DAYS * 86_400_000);
  // No period end known: status alone decides, as before.
  assert.equal(stripeObservation(sub(null), new Date()).accessUntil, null);
});

test("migrate-v163 brings the records written before this to the same rule, with the same grace", () => {
  const sql = readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "migrations", "migrate-v163.sql"), "utf8");
  assert.match(sql, new RegExp(`SET access_until = period_end \\+ interval '${GRACE_DAYS} days'`));
  assert.match(sql, /WHERE provider = 'stripe' AND access_until IS NULL AND period_end IS NOT NULL;/);
});
