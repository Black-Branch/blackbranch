// The setup pages' Tests: runProviderCheck from the generated schema, against RECORDED provider
// answers — success, and the three or four likeliest failures, each read back in the plain words
// the page shows. Nothing here touches a network.
// Every Test is read-only: GETs, plus the client-credentials token fetches. None sends a
// webhook, creates a payment or calls a money endpoint of this site.
// Run: node --test app/lib/setup/providerChecks.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MODULES, runProviderCheck, normalizeCheckResult, describeCheck } from "../instanceSchema.generated.mjs";
import { HANDLED_EVENTS } from "../stripeWebhookEvents.ts";

type Resp = { status: number; body?: unknown };
type Call = { url: string; method: string; body?: unknown };
const res = (r: Resp) => ({ ok: r.status < 400, status: r.status, json: async () => { if (r.body === undefined) throw new Error("no body"); return r.body; } });
function stub(routes: [RegExp, Resp | (() => never)][]) {
  const calls: Call[] = [];
  const f = async (url: string, init: { method?: string; body?: unknown } = {}) => {
    calls.push({ url, method: (init.method ?? "GET").toUpperCase(), body: init.body });
    const hit = routes.find(([re]) => re.test(url));
    if (!hit) throw new TypeError(`fetch failed: ${url}`);
    const r = hit[1];
    return typeof r === "function" ? r() : res(r);
  };
  return Object.assign(f, { calls });
}
// The stub stands in for fetch: only the fields runProviderCheck reads.
const check = (t: string, get: (k: string) => unknown, f: unknown) => runProviderCheck(t, get, f as typeof fetch);
const words = (r: unknown) => describeCheck(normalizeCheckResult(r));
const BB = "https://bb.test";
const harmless = (calls: Call[]) => {
  for (const c of calls) assert.ok(c.method === "GET" || /oauth2?\/token/.test(c.url), `${c.method} ${c.url} is not a harmless read`);
  assert.ok(!calls.some((c) => c.url.startsWith(BB) && /billing|webhook/.test(c.url)), "a Test called this site's money or webhook address");
};
const timeoutErr = () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; };

test("Twitch: app token, then the channel; its numeric id is shown so it can be pasted", async () => {
  const vals: Record<string, string> = { "twitch.clientId": "cid", "twitch.clientSecret": "SECRET", "platform.twitch.channel": "SomeChannel" };
  const get = (k: string) => vals[k] ?? null;
  const ok = stub([[/oauth2\/token/, { status: 200, body: { access_token: "AT" } }], [/oauth2\/validate/, { status: 200, body: {} }],
    [/helix\/users\?login=somechannel$/, { status: 200, body: { data: [{ id: "123456789", login: "somechannel" }] } }]]);
  const r = await check("twitch", get, ok);
  assert.deepEqual(r, { ok: true, code: "accepted", id: "123456789" });
  assert.equal(words(r), "accepted — channel found, id 123456789");
  harmless(ok.calls);
  const none = stub([[/oauth2\/token/, { status: 200, body: { access_token: "AT" } }], [/oauth2\/validate/, { status: 200, body: {} }], [/helix\/users/, { status: 200, body: { data: [] } }]]);
  assert.equal(words(await check("twitch", get, none)), "not found at the provider — check the name, id or address");
  vals["platform.twitch.broadcasterId"] = "42";
  assert.equal(words(await check("twitch", get, ok)), "found, but its id is 123456789 — not the id saved here");
  // Measured on VM 120: an unknown client id answers 400 "invalid client" — refused, not a provider error.
  assert.equal(words(await check("twitch", get, stub([[/oauth2\/token/, { status: 400, body: { status: 400, message: "invalid client" } }]]))), "rejected (HTTP 400)");
  assert.equal(words(await check("twitch", get, stub([[/oauth2\/token/, { status: 400, body: { status: 400, message: "missing client id" } }]]))), "provider answered HTTP 400");
  const bad = stub([[/oauth2\/token/, { status: 403, body: { status: 403, message: "invalid client secret" } }]]);
  assert.equal(words(await check("twitch", get, bad)), "rejected (HTTP 403)");
  assert.equal(words(await check("twitch", get, timeoutErr)), "timed out after 8 s");
  assert.equal(words(await check("twitch", () => null, ok)), "not set: twitch.clientId, twitch.clientSecret");
});

test("Kick: app token, then the channel", async () => {
  const vals: Record<string, string> = { "kick.clientId": "cid", "kick.clientSecret": "SECRET", "platform.kick.slug": "somechannel" };
  const get = (k: string) => vals[k] ?? null;
  const tok: [RegExp, Resp] = [/id\.kick\.com\/oauth\/token/, { status: 200, body: { access_token: "AT" } }];
  assert.equal(words(await check("kick", get, stub([tok, [/channels\?slug=somechannel/, { status: 200, body: { data: [{ broadcaster_user_id: 987 }] } }]]))),
    "accepted — channel found, id 987");
  assert.equal(words(await check("kick", get, stub([tok, [/channels/, { status: 200, body: { data: [] } }]]))), "not found at the provider — check the name, id or address");
  assert.equal(words(await check("kick", get, stub([[/oauth\/token/, { status: 401, body: { error: "invalid_client" } }]]))), "rejected (HTTP 401)");
  assert.equal(words(await check("kick", get, stub([]))), "request failed (network)");
});

test("YouTube: the key and the channel in one call; a bad key is 'rejected', not a provider error", async () => {
  const vals: Record<string, string> = { "youtube.apiKey": "AIzaSECRET", "platform.youtube.channelId": "UCabcdefghijklmnopqrstuv" };
  const get = (k: string) => vals[k] ?? null;
  const ok = stub([[/youtube\/v3\/channels\?part=id&id=UCabc/, { status: 200, body: { items: [{ id: "UCabcdefghijklmnopqrstuv" }] } }]]);
  assert.equal(words(await check("youtube", get, ok)), "accepted");
  assert.equal(ok.calls.length, 1, "one quota unit");
  assert.equal(words(await check("youtube", get, stub([[/channels/, { status: 200, body: { items: [] } }]]))), "not found at the provider — check the name, id or address");
  assert.equal(words(await check("youtube", get, stub([[/channels/, { status: 400, body: { error: { message: "API key not valid. Please pass a valid API key." } } }]]))), "rejected (HTTP 400)");
  assert.equal(words(await check("youtube", get, stub([[/channels/, { status: 403, body: { error: { message: "quota" } } }]]))), "rejected (HTTP 403)");
  assert.equal(words(await check("youtube", () => null, ok)), "not set: youtube.apiKey");
});

test("Streamplace: the account resolves and this site's own sign-in description answers at its own address", async () => {
  const did = "did:plc:abcdefghijklmnopqrstuvwx";
  const vals: Record<string, string> = { "platform.streamplace.did": did, "site.origin": BB };
  const get = (k: string) => vals[k] ?? null;
  const meta = `${BB}/oauth/client-metadata.json`;
  const plc: [RegExp, Resp] = [/plc\.directory\/did:plc:/, { status: 200, body: { id: did } }];
  assert.equal(words(await check("streamplace", get, stub([plc, [/client-metadata\.json$/, { status: 200, body: { client_id: meta } }]]))), "accepted");
  assert.equal(words(await check("streamplace", get, stub([[/plc\.directory/, { status: 404, body: {} }]]))), "not found at the provider — check the name, id or address");
  assert.match(words(await check("streamplace", get, stub([plc, [/client-metadata/, { status: 502, body: {} }]]))), /sign-in description did not answer/);
  assert.match(words(await check("streamplace", get, stub([plc, [/client-metadata/, { status: 200, body: { client_id: "https://elsewhere.test/oauth/client-metadata.json" } }]]))), /sign-in description/);
  vals["platform.streamplace.did"] = "someone.bsky.social";
  assert.equal(words(await check("streamplace", get, stub([]))), "not in the provider's format");
});

test("Stripe key: the account and every object type the site reads; a missing Read permission is named", async () => {
  const get = (k: string) => ({ "stripe.secretKey": "rk_test_SECRET" } as Record<string, string>)[k] ?? null;
  const all = stub([[/api\.stripe\.com\/v1\//, { status: 200, body: { data: [] } }]]);
  assert.equal(words(await check("stripe", get, all)), "accepted (test)");
  assert.deepEqual(all.calls.map((c) => new URL(c.url).pathname), ["/v1/account", "/v1/customers", "/v1/subscriptions", "/v1/invoices", "/v1/payment_intents", "/v1/checkout/sessions"]);
  harmless(all.calls);
  const perm = { status: 403, body: { error: { message: "The provided key 'rk_test_***' does not have the required permissions for this endpoint." } } };
  const denied = stub([[/v1\/(subscriptions|payment_intents)/, perm], [/api\.stripe\.com/, { status: 200, body: { data: [] } }]]);
  assert.equal(words(await check("stripe", get, denied)), "the key cannot read subscriptions, payment intents — give it those Read permissions");
  assert.equal(words(await check("stripe", get, stub([[/stripe/, { status: 401, body: { error: { message: "Invalid API Key provided: rk_test_SECRET" } } }]]))), "rejected (HTTP 401)");
  assert.equal(words(await check("stripe", get, timeoutErr)), "timed out after 8 s");
  for (const c of [denied.calls, all.calls]) assert.ok(!JSON.stringify(c).includes("SECRET") || c.every((x) => !x.url.includes("SECRET")), "the key never travels in a URL");
});

test("Stripe webhook: a destination for THIS address, enabled, sending every handled event — the three lists are one", async () => {
  // The Stripe setup page's paste line, web's HANDLED_EVENTS and what the Test requires.
  const stripe = (MODULES as { id: string; setup?: { id: string; paste: { label: string; value: string }[] }[] }[]).find((m) => m.id === "stripe")!;
  const pasted = stripe.setup!.find((s) => s.id === "webhook")!.paste.find((p) => p.label === "Events")!.value.split(" · ");
  assert.deepEqual([...pasted].sort(), [...HANDLED_EVENTS].sort(), "the setup page lists exactly the events the route handles");
  const vals: Record<string, string> = { "stripe.secretKey": "rk_live_SECRET", "stripe.webhookSecret": "whsec_abc123", "site.origin": BB };
  const get = (k: string) => vals[k] ?? null;
  const ep = (over: Record<string, unknown> = {}) => stub([[/v1\/webhook_endpoints/, { status: 200, body: { data: [
    { url: "https://other.test/api/billing/webhook", status: "enabled", enabled_events: ["*"] },
    { url: `${BB}/api/billing/webhook`, status: "enabled", enabled_events: [...HANDLED_EVENTS], ...over },
  ] } }]]);
  const ok = ep();
  assert.equal(words(await check("stripe-webhook", get, ok)), "accepted");
  harmless(ok.calls);
  assert.equal(words(await check("stripe-webhook", get, ep({ enabled_events: ["*"] }))), "accepted");
  assert.equal(words(await check("stripe-webhook", get, ep({ enabled_events: HANDLED_EVENTS.filter((e) => e !== "invoice.paid") }))),
    "the webhook does not send 1 of the events this site handles");
  assert.equal(words(await check("stripe-webhook", get, ep({ status: "disabled" }))), "the webhook exists but is disabled");
  assert.equal(words(await check("stripe-webhook", get, ep({ url: "https://bb.test.evil/api/billing/webhook" }))), "not found at the provider — check the name, id or address");
  const limited = stub([[/webhook_endpoints/, { status: 403, body: { error: { message: "The provided key 'rk_live_***' does not have the required permissions for this endpoint." } } }]]);
  assert.deepEqual(normalizeCheckResult(await check("stripe-webhook", get, limited)), { ok: true, code: "limited", status: 403 }, "a key that may not read webhooks: check by hand (grey in the doctor)");
  vals["stripe.webhookSecret"] = "sk_live_pasted_the_wrong_one";
  assert.equal(words(await check("stripe-webhook", get, ok)), "not in the provider's format");
});

test("PayPal: a token, then the webhook id — it exists, points at this site and sends every handled event", async () => {
  const route = readFileSync(new URL("../../api/billing/paypal/webhook/route.ts", import.meta.url), "utf8");
  const handled = [...route.matchAll(/case "([A-Z.]+)":/g)].map((m) => m[1]).sort();
  assert.ok(handled.length >= 4, `vacuity: ${handled.length} PayPal cases read`);
  const paypal = (MODULES as { id: string; setup?: { id: string; paste: { label: string; value: string }[] }[] }[]).find((m) => m.id === "paypal")!;
  assert.deepEqual(paypal.setup!.find((s) => s.id === "webhook")!.paste.find((p) => p.label === "Events")!.value.split(" · ").sort(), handled);
  const vals: Record<string, string> = { "paypal.clientId": "cid", "paypal.clientSecret": "SECRET", "paypal.env": "sandbox", "paypal.webhookId": "WH-1", "site.origin": BB };
  const get = (k: string) => vals[k] ?? null;
  const tok: [RegExp, Resp] = [/sandbox\.paypal\.com\/v1\/oauth2\/token/, { status: 200, body: { access_token: "AT" } }];
  const hook = (body: Record<string, unknown>) => stub([tok, [/notifications\/webhooks\/WH-1$/, { status: 200, body }]]);
  const full = { url: `${BB}/api/billing/paypal/webhook`, event_types: handled.map((name) => ({ name })) };
  const ok = hook(full);
  assert.equal(words(await check("paypal-webhook", get, ok)), "accepted (sandbox)");
  harmless(ok.calls);
  assert.equal(words(await check("paypal-webhook", get, hook({ ...full, url: "https://old.test/api/billing/paypal/webhook" }))), "the webhook points at another address, not this site");
  assert.equal(words(await check("paypal-webhook", get, hook({ ...full, event_types: full.event_types.slice(1) }))), "the webhook does not send 1 of the events this site handles");
  assert.equal(words(await check("paypal-webhook", get, stub([tok, [/notifications\/webhooks/, { status: 404, body: { name: "INVALID_RESOURCE_ID" } }]]))), "not found at the provider — check the name, id or address");
  assert.equal(words(await check("paypal", get, stub([[/oauth2\/token/, { status: 401, body: { error: "invalid_client" } }]]))), "rejected (HTTP 401)");
  assert.equal(words(await check("paypal", get, stub([tok]))), "accepted (sandbox)");
});
