#!/usr/bin/env node
// Settles, in PayPal's SANDBOX, the facts subscription sources S3 relies on that PayPal's docs do
// not confirm (spec docs/superpowers/specs/2026-10-17-subscription-sources-design.md §2.1, §13.2).
// Run it before the PayPal subscriptions are switched on; record each answer in the spec's S3
// as-built notes.
//
//   node scripts/paypal-sandbox-facts.mjs setup                 → a sandbox product + $5/month plan (prints the plan id)
//   node scripts/paypal-sandbox-facts.mjs subscribe <P-…>       → a subscription created SERVER-side with a custom_id,
//                                                                 and its approve link (approve it as a sandbox buyer)
//   node scripts/paypal-sandbox-facts.mjs check <I-…>           → F1 F2 F6: its first sale, read three ways
//   node scripts/paypal-sandbox-facts.mjs refund <sale id>      → F5: what a sale refund names its sale by
//   node scripts/paypal-sandbox-facts.mjs cancel <I-…>          → F7: what a CANCELLED subscription still says
//   node scripts/paypal-sandbox-facts.mjs simulate <webhook id> → F8: the canned PAYMENT.SALE.* / BILLING.* shapes
//   node scripts/paypal-sandbox-facts.mjs override <P-…>        → F9: may a subscription override the plan's price?
//   node scripts/paypal-sandbox-facts.mjs page <P-…> <out.html> → F3 F4: a page to open in a browser (see below)
//
// The facts, and the code that waits on each (spec §2.1 ⚠):
//   F1 a sale's billing_agreement_id is the subscription's I-… id
//        → subscriptions/paypal.ts recordSale (the sale → its subscription)
//   F2 a sale's fee is transaction_fee.value
//        → subscriptions/paypalRecords.ts saleMoney (netUsd; else the published rate is sent)
//   F3 the JS SDK's createSubscription may return a subscription the SERVER created
//        → features/support/PayPalSubscribeButton.tsx (fallback: actions.subscription.create)
//   F4 the subscription SDK (vault=true&intent=subscription, data-namespace) and the tip SDK
//      (intent=capture, window.paypal) both work on one page
//        → PayPalSubscribeButton.tsx's namespace
//   F5 a sale refund names its sale in sale_id (else a rel=up link)
//        → paypalRecords.ts saleIdOf
//   F6 GET /v1/payments/sale/{id} answers a subscription's sale
//        → subscriptions/paypal.ts paymentForRefund (a refund before its sale)
//   F7 a CANCELLED subscription's GET: does billing_info.next_billing_time survive?
//        → paypalRecords.ts paidThrough (else the record's last known end, else last payment + 1 month)
//   F8 PAYMENT.SALE.REVERSED's resource shape
//        → paypalRecords.ts saleIdOf
//
// Credentials: ~/.config/blackbranch/paypal-sandbox.env with PAYPAL_SANDBOX_CLIENT_ID= and
// PAYPAL_SANDBOX_CLIENT_SECRET=. They are read, sent to PayPal's SANDBOX only, and never printed.
// Nothing here touches a database.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = "https://api-m.sandbox.paypal.com";

function creds() {
  const file = join(homedir(), ".config", "blackbranch", "paypal-sandbox.env");
  let text;
  try { text = readFileSync(file, "utf8"); } catch { throw new Error(`no credentials file at ${file}`); }
  const get = (k) => (text.match(new RegExp(`^\\s*${k}\\s*=\\s*"?([^"\\n]+)"?\\s*$`, "m"))?.[1] ?? "").trim();
  const id = get("PAYPAL_SANDBOX_CLIENT_ID");
  const secret = get("PAYPAL_SANDBOX_CLIENT_SECRET");
  if (!id || !secret) throw new Error(`${file} must set PAYPAL_SANDBOX_CLIENT_ID and PAYPAL_SANDBOX_CLIENT_SECRET`);
  return { id, secret };
}

let token = null;
async function api(method, path, body) {
  if (!token) {
    const { id, secret } = creds();
    const r = await fetch(`${BASE}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!r.ok) throw new Error(`token: ${r.status}`);
    token = (await r.json()).access_token;
  }
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json", Prefer: "return=representation" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: r.status, json };
}

/** Field names and types only — the facts are about SHAPE, and a sandbox body still carries
 *  made-up payer details that have no business in a terminal log. */
function shape(v, depth = 0) {
  if (v === null || typeof v !== "object") return typeof v;
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1)] : [];
  if (depth > 3) return "{…}";
  const out = {};
  for (const [k, x] of Object.entries(v)) if (!/name|email|address|phone|payer_info|shipping/i.test(k)) out[k] = shape(x, depth + 1);
  return out;
}
const fact = (id, ok, note) => console.log(`${ok === true ? "✓" : ok === false ? "✗" : "?"} ${id} ${note}`);

async function setup() {
  const product = await api("POST", "/v1/catalogs/products", { name: "Supporter (sandbox facts)", type: "SERVICE", category: "SOFTWARE" });
  if (product.status >= 300) throw new Error(`product: ${product.status}`);
  const plan = await api("POST", "/v1/billing/plans", {
    product_id: product.json.id, name: "Supporter monthly (sandbox facts)", status: "ACTIVE",
    billing_cycles: [{ tenure_type: "REGULAR", sequence: 1, total_cycles: 0, frequency: { interval_unit: "MONTH", interval_count: 1 },
      pricing_scheme: { fixed_price: { value: "5.00", currency_code: "USD" } } }],
    payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3 },
  });
  if (plan.status >= 300) throw new Error(`plan: ${plan.status}`);
  console.log(`plan ${plan.json.id} (product ${product.json.id})`);
}

async function subscribe(planId) {
  const custom = `si_${"x".repeat(22)}`;
  const r = await api("POST", "/v1/billing/subscriptions", { plan_id: planId, custom_id: custom, application_context: { shipping_preference: "NO_SHIPPING" } });
  if (r.status >= 300) throw new Error(`subscribe: ${r.status}`);
  const approve = (r.json.links ?? []).find((l) => l.rel === "approve")?.href;
  console.log(`subscription ${r.json.id} status ${r.json.status}; custom_id echoed: ${r.json.custom_id === custom}`);
  console.log(`approve as a sandbox buyer: ${approve}`);
  console.log(`then: node scripts/paypal-sandbox-facts.mjs check ${r.json.id}`);
}

async function check(subId) {
  const sub = await api("GET", `/v1/billing/subscriptions/${subId}`);
  console.log("subscription:", JSON.stringify(shape(sub.json)));
  const end = new Date(Date.now() + 86_400_000).toISOString();
  const start = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const tx = await api("GET", `/v1/billing/subscriptions/${subId}/transactions?start_time=${start}&end_time=${end}`);
  const saleId = tx.json?.transactions?.[0]?.id;
  console.log(`transactions: ${tx.status}, first id ${saleId ?? "(none yet — wait for the first payment)"}`);
  if (!saleId) return;
  const sale = await api("GET", `/v1/payments/sale/${saleId}`);
  fact("F6", sale.status === 200, `GET /v1/payments/sale/{id} → ${sale.status}`);
  if (sale.status !== 200) return;
  console.log("sale:", JSON.stringify(shape(sale.json)));
  fact("F1", sale.json.billing_agreement_id === subId, `billing_agreement_id ${sale.json.billing_agreement_id === subId ? "equals" : "does NOT equal"} the subscription id`);
  fact("F2", typeof sale.json.transaction_fee?.value === "string", `transaction_fee.value is ${typeof sale.json.transaction_fee?.value}`);
  console.log(`then: node scripts/paypal-sandbox-facts.mjs refund ${saleId}`);
}

async function refund(saleId) {
  const r = await api("POST", `/v1/payments/sale/${saleId}/refund`, { amount: { total: "1.00", currency: "USD" } });
  console.log(`refund: ${r.status}`, JSON.stringify(shape(r.json)));
  fact("F5", r.json?.sale_id === saleId ? true : r.json ? false : null, `sale_id ${r.json?.sale_id === saleId ? "names the sale" : "does not name the sale (check the links)"}`);
}

async function cancel(subId) {
  const before = await api("GET", `/v1/billing/subscriptions/${subId}`);
  const c = await api("POST", `/v1/billing/subscriptions/${subId}/cancel`, { reason: "sandbox facts" });
  console.log(`cancel: ${c.status} (204 expected)`);
  const after = await api("GET", `/v1/billing/subscriptions/${subId}`);
  console.log(`status ${after.json?.status}`);
  const had = before.json?.billing_info?.next_billing_time;
  const has = after.json?.billing_info?.next_billing_time;
  fact("F7", Boolean(has) ? true : false, `next_billing_time ${had ? "was set" : "was unset"} before; ${has ? "still set" : "GONE"} after cancel (paidThrough falls back if gone)`);
}

async function simulate(webhookId) {
  for (const [type, version] of [["PAYMENT.SALE.COMPLETED", "1.0"], ["PAYMENT.SALE.REFUNDED", "1.0"], ["PAYMENT.SALE.REVERSED", "1.0"], ["BILLING.SUBSCRIPTION.ACTIVATED", "2.0"]]) {
    const r = await api("POST", "/v1/notifications/simulate-event", { webhook_id: webhookId, event_type: type, resource_version: version });
    console.log(`${type}: ${r.status}`, JSON.stringify(shape(r.json?.resource)));
    if (type === "PAYMENT.SALE.REVERSED") fact("F8", null, `REVERSED resource has ${r.json?.resource?.sale_id ? "sale_id" : "no sale_id"}, ${r.json?.resource?.billing_agreement_id ? "a" : "no"} billing_agreement_id`);
  }
}

/** F9: may a subscription be created with an INLINE plan override that changes the price (the
 *  body the JS SDK's actions.subscription.create also takes)? If so, a subscription on the site's
 *  plan id can bill less than the plan's price, and the sale's amount must be checked. */
async function override(planId) {
  const r = await api("POST", "/v1/billing/subscriptions", {
    plan_id: planId,
    plan: { billing_cycles: [{ sequence: 1, total_cycles: 0, pricing_scheme: { fixed_price: { value: "0.01", currency_code: "USD" } } }] },
  });
  console.log(`create with a $0.01 override: ${r.status}`);
  if (r.status >= 300) { console.log("refused:", JSON.stringify({ name: r.json?.name, issue: r.json?.details?.[0]?.issue })); return; }
  const got = await api("GET", `/v1/billing/subscriptions/${r.json.id}?fields=plan`);
  const price = got.json?.plan?.billing_cycles?.[0]?.pricing_scheme?.fixed_price?.value;
  fact("F9", price === "0.01" ? false : null, `subscription ${r.json.id} plan_id ${got.json?.plan_id === planId ? "is the site's plan" : "differs"}; its price reads ${price ?? "(not shown)"}`);
  await api("POST", `/v1/billing/subscriptions/${r.json.id}/cancel`, { reason: "sandbox facts" });
}

function page(planId, out) {
  const { id } = creds();
  // The client id is public by design (the live site serves it to every browser). The page is
  // written to the path given, for a local browser only.
  const html = `<!doctype html><meta charset="utf-8"><title>PayPal facts F3 F4</title>
<p>F4: both buttons below must render. F3: the subscribe button returns the id the server made.</p>
<p>Server-created subscription id (from <code>subscribe ${planId}</code>): <input id="sid" size="30"></p>
<div id="tip"></div><div id="sub"></div><pre id="log"></pre>
<script src="https://www.paypal.com/sdk/js?client-id=${id}&intent=capture&components=buttons&currency=USD"></script>
<script data-namespace="paypalSubscriptions" src="https://www.paypal.com/sdk/js?client-id=${id}&vault=true&intent=subscription&components=buttons&currency=USD"></script>
<script>
const log = (m) => (document.getElementById("log").textContent += m + "\\n");
paypal.Buttons({ createOrder: (d, a) => a.order.create({ purchase_units: [{ amount: { value: "1.00" } }] }), onApprove: () => log("F4 tip approve OK") }).render("#tip");
paypalSubscriptions.Buttons({ createSubscription: () => document.getElementById("sid").value.trim(),
  onApprove: (d) => log("F3 onApprove subscriptionID " + d.subscriptionID), onError: (e) => log("F3 error " + e) }).render("#sub");
log("both SDKs loaded: window.paypal " + typeof paypal + ", paypalSubscriptions " + typeof paypalSubscriptions);
</script>`;
  writeFileSync(out, html);
  console.log(`wrote ${out} — open it in a browser (it holds only the public client id)`);
}

const [cmd, a, b] = process.argv.slice(2);
const run = { setup, subscribe: () => subscribe(a), check: () => check(a), refund: () => refund(a), cancel: () => cancel(a), simulate: () => simulate(a), override: () => override(a), page: () => page(a, b) }[cmd];
if (!run || (cmd !== "setup" && !a) || (cmd === "page" && !b)) {
  console.error("usage: paypal-sandbox-facts.mjs setup | subscribe <P-…> | check <I-…> | refund <sale id> | cancel <I-…> | simulate <webhook id> | override <P-…> | page <P-…> <out.html>");
  process.exit(2);
}
Promise.resolve(run()).catch((e) => { console.error(`failed: ${e.message}`); process.exit(1); });
