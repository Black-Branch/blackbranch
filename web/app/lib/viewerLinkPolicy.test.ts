// The viewer "link YouTube" button exists only on a site with a site plugin.
// Run: node --test app/lib/viewerLinkPolicy.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { viewerLinkAllowed } from "./viewerLinkPolicy.ts";

test("YouTube: only with the owner plugin AND the switch on; every other platform unaffected", () => {
  assert.equal(viewerLinkAllowed("youtube", { ownerPlugin: false, youtubeOn: true }), false, "a public build never offers the Google scope to viewers");
  assert.equal(viewerLinkAllowed("youtube", { ownerPlugin: true, youtubeOn: false }), false, "switched off: no YouTube anything");
  assert.equal(viewerLinkAllowed("youtube", { ownerPlugin: true, youtubeOn: true }), true, "the owner's site keeps today's behaviour");
  for (const p of ["twitch", "kick", "streamplace"]) assert.equal(viewerLinkAllowed(p, { ownerPlugin: false, youtubeOn: false }), true, p);
});

test("the three link surfaces ask the policy before the platform config (list, start, return)", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const list = read("../api/account-links/route.ts");
  assert.match(list, /getConfiguredPlatforms\(\)\.filter\(\(p\) => viewerMayLink\(p\)\)/);
  for (const f of ["../api/auth/link/[platform]/initiate/route.ts", "../api/auth/link/[platform]/callback/route.ts"]) {
    assert.match(read(f), /const config = viewerMayLink\(platform\) \? getPlatformConfig\(platform\) : null;/, f);
  }
  const seam = read("./viewerLinks.ts");
  assert.match(seam, /ownerPlugin: ownerPluginInstalled\(\), youtubeOn: instanceBool\("modules\.youtube"\)/);
});

test("a switched-off payment provider's webhook answers 404 before it reads anything (Stripe and PayPal retry it)", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const stripe = read("../api/billing/webhook/route.ts");
  const s0 = stripe.indexOf("export async function POST");
  const gate = stripe.indexOf('if (!stripeModuleOn()) return new Response("Not found", { status: 404 });');
  assert.ok(gate > s0 && gate < stripe.indexOf("req.text()") && gate < stripe.indexOf("stripe.webhookSecret"), "Stripe: the switch first");
  const paypal = read("../api/billing/paypal/webhook/route.ts");
  const p0 = paypal.indexOf("export async function POST");
  const pg = paypal.indexOf('if (!paypalModuleOn()) return new Response("Not found", { status: 404 });');
  assert.ok(pg > p0 && pg < paypal.indexOf("req.text()") && pg < paypal.indexOf("paypalWebhookConfigured()"), "PayPal: the switch first");
  // Every checkout route gates on stripeConfigured(), which includes the switch.
  assert.match(read("./stripe.ts"), /return stripeModuleOn\(\) && Boolean\(instanceString\("stripe\.secretKey"\)\);/);
  assert.match(read("./paypalClient.ts"), /return paypalModuleOn\(\) && Boolean\(/);
  // Vacuity anchor at the END of a file the scans read.
  assert.match(paypal.slice(-400), /\}\s*$/);
});
