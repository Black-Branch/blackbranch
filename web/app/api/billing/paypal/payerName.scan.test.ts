// Structural guard: nothing under api/billing/paypal (recursive — sweeps
// config/route.ts too), the paypal lib modules the routes delegate to,
// app/features/support (the split tip button, PayPalButton.tsx), or
// app/donate ever reads the payer's real name, their email address, the
// dispute's buyer-written free text (messages[]), or the dispute's seller{}
// block.
//
// Comments are stripped before matching: this rule must hold STRUCTURALLY,
// not as a promise written in prose next to code that could still do it.
//
// Vacuity anchors: the file-count assertions below are what stop an empty or
// mis-pathed directory read from passing every negative assertion for free.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { stripComments } from "../../../lib/testSource.ts";

const ROUTE_DIR = new URL("./", import.meta.url);
const LIB_DIR = new URL("../../../lib/", import.meta.url);
const DONATE_DIR = new URL("../../../donate/", import.meta.url);
const SUPPORT_DIR = new URL("../../../features/support/", import.meta.url);

test("nothing under api/billing/paypal, the paypal lib modules, app/features/support, or app/donate reads the payer's real name, email, or the dispute's buyer text/seller name", () => {
  const routeFiles = readdirSync(ROUTE_DIR, { recursive: true, encoding: "utf8" }).filter((p) => p.endsWith("route.ts"));
  assert.ok(routeFiles.length >= 2, `expected the order and webhook routes, found ${routeFiles.length}`);
  assert.ok(routeFiles.some((p) => p.includes("webhook")), "the webhook route must be in the scan");
  assert.ok(routeFiles.some((p) => p.includes("order")), "the order route must be in the scan");
  // The PayPal client id is served by the ONE billing-availability route,
  // api/billing/stripe/config (2026-10-19 — paypal/config was folded into it),
  // which lives outside ROUTE_DIR, so it joins the scan by name.
  const availabilityRoute = new URL("../stripe/config/route.ts", import.meta.url);
  assert.match(readFileSync(availabilityRoute, "utf8"), /paypalClientId/, "the availability route must still serve the PayPal client id");

  const libFiles = readdirSync(LIB_DIR, { encoding: "utf8" }).filter(
    (p) => p.startsWith("paypal") && p.endsWith(".ts") && !p.includes(".test."),
  );
  assert.ok(
    libFiles.length >= 3,
    `expected paypalClient.ts, paypalCapture.ts and paypalWebhookHandlers.ts, found ${libFiles.length}: ${libFiles.join(", ")}`,
  );

  const donateFiles = readdirSync(DONATE_DIR, { encoding: "utf8" }).filter(
    (p) => p.endsWith(".tsx") && !p.includes(".test."),
  );
  assert.ok(donateFiles.length > 0, `app/donate must still have at least one .tsx file to scan, found 0`);

  const supportFiles = readdirSync(SUPPORT_DIR, { encoding: "utf8" }).filter(
    (p) => p.endsWith(".tsx") && !p.includes(".test."),
  );
  assert.ok(
    supportFiles.some((p) => p.includes("PayPalButton")),
    `PayPalButton.tsx must be in the scan — it is the component that talks to PayPal's SDK directly, found: ${supportFiles.join(", ")}`,
  );

  const files = [
    availabilityRoute,
    ...routeFiles.map((p) => new URL(p, ROUTE_DIR)),
    ...libFiles.map((p) => new URL(p, LIB_DIR)),
    ...donateFiles.map((p) => new URL(p, DONATE_DIR)),
    ...supportFiles.map((p) => new URL(p, SUPPORT_DIR)),
  ];

  for (const f of files) {
    const rawSrc = readFileSync(f, "utf8");
    assert.ok(rawSrc.length > 100, `${f} read as suspiciously short — the scan below would prove nothing`);
    const src = stripComments(rawSrc);
    assert.ok(!/payer\s*[.?]\s*name/.test(src), `${f} reads payer.name — the PayPal account holder's name is never read`);
    assert.ok(!/email_address/.test(src), `${f} reads the payer's email address`);
    assert.ok(!/messages\s*\[/.test(src), `${f} reads the dispute's messages[] — buyer-written free text must never be read`);
    assert.ok(!/\bseller\b/.test(src), `${f} reads the seller{} block on the dispute payload`);
  }
});
