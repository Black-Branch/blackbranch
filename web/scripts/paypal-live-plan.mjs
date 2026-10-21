#!/usr/bin/env node
// The owner's one-time PayPal subscriptions setup, against PayPal LIVE (subscription sources S3):
//
//   node scripts/paypal-live-plan.mjs plan <price> <currency> <site origin>
//       → a product "Supporter subscription" + a MONTHLY fixed-price plan at <price> with
//         payment_failure_threshold 3 (config/modules.mjs's PayPal text says why), printing the plan
//         id to paste into Admin Panel → Payments → PayPal → "Subscription plans" as {"supporter":"P-…"}.
//   node scripts/paypal-live-plan.mjs events <site origin>
//       → the webhook that points at <site origin>/api/billing/paypal/webhook gains every event the
//         site handles (the four capture/dispute ones plus the ten subscription/sale ones).
//
// Credentials: ~/.config/blackbranch/paypal-live.env with PAYPAL_LIVE_CLIENT_ID= and
// PAYPAL_LIVE_CLIENT_SECRET= (the LIVE app, developer.paypal.com → Apps & Credentials → Live). They
// are read, sent to api-m.paypal.com only, and never printed. Nothing here touches a database.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const API = "https://api-m.paypal.com";
const EVENTS = [
  "PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED", "CUSTOMER.DISPUTE.RESOLVED",
  "BILLING.SUBSCRIPTION.CREATED", "BILLING.SUBSCRIPTION.ACTIVATED", "BILLING.SUBSCRIPTION.UPDATED", "BILLING.SUBSCRIPTION.EXPIRED",
  "BILLING.SUBSCRIPTION.CANCELLED", "BILLING.SUBSCRIPTION.SUSPENDED", "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
  "PAYMENT.SALE.COMPLETED", "PAYMENT.SALE.REFUNDED", "PAYMENT.SALE.REVERSED",
];

function creds() {
  const f = path.join(homedir(), ".config/blackbranch/paypal-live.env");
  const env = Object.fromEntries(readFileSync(f, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
  const id = env.PAYPAL_LIVE_CLIENT_ID, secret = env.PAYPAL_LIVE_CLIENT_SECRET;
  if (!id || !secret) throw new Error(`${f}: PAYPAL_LIVE_CLIENT_ID and PAYPAL_LIVE_CLIENT_SECRET are needed`);
  return { id, secret };
}
async function token() {
  const { id, secret } = creds();
  const r = await fetch(`${API}/v1/oauth2/token`, { method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
  if (!r.ok) throw new Error(`token: HTTP ${r.status}`);
  return (await r.json()).access_token;
}
async function call(tok, method, p, body) {
  const r = await fetch(API + p, { method, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", Prefer: "return=representation" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!r.ok) throw new Error(`${method} ${p}: HTTP ${r.status} ${json?.name ?? ""} ${json?.message ?? ""} ${(json?.details ?? []).map((d) => d.issue).join(", ")}`.trim());
  return json;
}

const [cmd, ...args] = process.argv.slice(2);
const tok = await token();
if (cmd === "plan") {
  const [price, currency = "USD", origin] = args;
  if (!/^\d+(\.\d{1,2})?$/.test(price || "") || !origin) throw new Error("usage: plan <price> <currency> <site origin>");
  const product = await call(tok, "POST", "/v1/catalogs/products", { name: "Supporter subscription", description: `Monthly Supporter subscription at ${new URL(origin).host}`, type: "SERVICE", category: "SOFTWARE", home_url: origin });
  const plan = await call(tok, "POST", "/v1/billing/plans", {
    product_id: product.id, name: "Supporter — monthly", description: "Supporter perks for one month, renewing monthly", status: "ACTIVE",
    billing_cycles: [{ frequency: { interval_unit: "MONTH", interval_count: 1 }, tenure_type: "REGULAR", sequence: 1, total_cycles: 0, pricing_scheme: { fixed_price: { value: Number(price).toFixed(2), currency_code: currency } } }],
    payment_preferences: { auto_bill_outstanding: true, setup_fee_failure_action: "CANCEL", payment_failure_threshold: 3 },
  });
  console.log(`product ${product.id}`);
  console.log(`plan ${plan.id} — ${currency} ${Number(price).toFixed(2)} monthly, status ${plan.status}, payment_failure_threshold 3`);
  console.log(`paste into Admin Panel → Payments → PayPal → Subscription plans:  {"supporter":"${plan.id}"}`);
} else if (cmd === "events") {
  const [origin] = args;
  if (!origin) throw new Error("usage: events <site origin>");
  const want = `${origin.replace(/\/+$/, "")}/api/billing/paypal/webhook`;
  const hooks = (await call(tok, "GET", "/v1/notifications/webhooks")).webhooks ?? [];
  const hook = hooks.find((h) => h.url === want);
  if (!hook) throw new Error(`no live webhook points at ${want} (found: ${hooks.map((h) => h.url).join(", ") || "none"})`);
  const have = new Set((hook.event_types ?? []).map((e) => e.name));
  const missing = EVENTS.filter((e) => !have.has(e));
  if (!missing.length) { console.log(`webhook ${hook.id} already sends every handled event`); process.exit(0); }
  await call(tok, "PATCH", `/v1/notifications/webhooks/${hook.id}`, [{ op: "replace", path: "/event_types", value: EVENTS.map((name) => ({ name })) }]);
  console.log(`webhook ${hook.id}: added ${missing.length} event type(s): ${missing.join(", ")}`);
} else {
  console.error("usage: plan <price> <currency> <site origin> | events <site origin>"); process.exit(2);
}
