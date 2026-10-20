// The Stripe setup page tells the operator which API version to give the webhook destination.
// It must be the version this release's Stripe SDK sends: stripe.ts leaves apiVersion unset, so
// every request uses the SDK's own default, and the webhook handlers read event payloads in that
// version's shape. A dependency bump that moves the SDK's version fails here until the setup
// text (config/modules.mjs, the Stripe webhook step's "API version" line) says the new one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import Stripe from "stripe";
import { MODULES } from "./instanceSchema.generated.mjs";

const LOCK = new URL("../../package-lock.json", import.meta.url);
const INSTALLED = new URL("../../node_modules/stripe/package.json", import.meta.url);

type Step = { id: string; paste: { label: string; value: string }[] };
const stripe = (MODULES as { id: string; setup?: Step[] }[]).find((m) => m.id === "stripe");
const pasted = stripe?.setup?.find((s) => s.id === "webhook")?.paste.find((p) => p.label === "API version")?.value;

test("the Stripe webhook step names the API version the installed SDK sends", () => {
  assert.ok(pasted, "the Stripe webhook step has an \"API version\" line");
  assert.equal(pasted, Stripe.API_VERSION);
});

test("the installed Stripe SDK is the one the lock file pins (so the version above is the release's)", {
  skip: existsSync(LOCK) ? false : "web/package-lock.json is absent (a tree without the lock file pins no SDK version)",
}, () => {
  const locked = JSON.parse(readFileSync(LOCK, "utf8")).packages?.["node_modules/stripe"]?.version;
  assert.ok(locked, "the lock file has a node_modules/stripe entry");
  assert.equal(JSON.parse(readFileSync(INSTALLED, "utf8")).version, locked);
});
