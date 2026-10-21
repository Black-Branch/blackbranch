// The Support panel's PayPal subscription, by real mount (subscription sources S3, spec §10.1,
// §10.2): offered only when the server offers it; a viewer already a Supporter elsewhere is warned
// BEFORE any payment and can still choose to subscribe; the PayPal button asks OUR server for the
// subscription (sending the choice); approval only shows "Confirming with PayPal…" until /api/me
// shows the webhook's record; a PayPal subscriber sees their line and an on-site Cancel.
//
// PayPal's SDK cannot run in jsdom: the test answers the namespaced script's load by hand and
// captures the config the button hands to Buttons(), then calls its callbacks as PayPal would.
import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act, resetStorage } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";

const g = globalThis as unknown as Record<string, unknown>;
g.self ??= dom.window;
g.getComputedStyle ??= dom.window.getComputedStyle.bind(dom.window);
g.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

type Rec = { provider: string; tier: string | null; status: string; renews: boolean; periodEnd: string | null; accessUntil: string | null };
const FUTURE = new Date(Date.now() + 20 * 86_400_000).toISOString();
const state = {
  stripe: false,
  offered: true,
  subscriptions: [] as Rec[],
  posts: [] as Array<{ url: string; body: unknown }>,
  subscribeAnswer: { status: 200, body: { subscriptionId: "I-GADGET0001" } as unknown },
  checkoutAnswer: { status: 503, body: {} as unknown },
};
(globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown, init?: RequestInit) => {
  const u = String(url);
  if (init?.method === "POST") {
    state.posts.push({ url: u, body: init.body ? JSON.parse(String(init.body)) : null });
    if (u === "/api/billing/paypal/subscription") return new Response(JSON.stringify(state.subscribeAnswer.body), { status: state.subscribeAnswer.status });
    if (u === "/api/billing/checkout") return new Response(JSON.stringify(state.checkoutAnswer.body), { status: state.checkoutAnswer.status });
    return new Response(JSON.stringify({ cancelled: 1 }), { status: 200 });
  }
  const body: unknown =
    u.startsWith("/api/billing/stripe/config") ? { publishableKey: state.stripe ? "pk_test_casey" : null, paypalClientId: "AeGadget123", supporter: state.stripe ? { amount: 500, currency: "usd" } : null }
    : u.startsWith("/api/billing/paypal/subscription") ? { offered: state.offered, price: state.offered ? { amount: 600, currency: "usd" } : null, elsewhere: null }
    : u.startsWith("/api/me") ? { signedIn: true, tier: null, subStatus: null, subscriptions: state.subscriptions }
    : u.startsWith("/api/billing/gifts") ? { given: [], received: [] }
    : {};
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};

const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { default: SupportContent } = await import("../../components/SupportContent.tsx");
const { _resetPaypalSdkForTests } = await import("./PayPalButton.tsx");
const { _resetPaypalSubscribeSdkForTests } = await import("./PayPalSubscribeButton.tsx");
const { createRoot } = await import("react-dom/client");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = (ms = 20) => act(async () => { await sleep(ms); });
const text = (h: HTMLElement) => h.textContent ?? "";
const button = (h: HTMLElement, label: string) => [...h.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label);

type Config = { createSubscription: () => Promise<string>; onApprove: () => Promise<void>; style: { label: string } };
let configs: Config[] = [];
/** Answer the namespaced subscription SDK's <script> as loaded, with a fake namespace. */
async function loadSdk() {
  const s = dom.window.document.getElementById("paypal-sdk-subscriptions");
  assert.ok(s, "the subscription SDK script was requested");
  assert.equal(s!.getAttribute("data-namespace"), "paypalSubscriptions", "its own namespace: the tip SDK's window.paypal is left alone");
  const src = new URL(s!.getAttribute("src")!);
  assert.deepEqual([src.searchParams.get("vault"), src.searchParams.get("intent")], ["true", "subscription"]);
  (dom.window as unknown as Record<string, unknown>).paypalSubscriptions = {
    FUNDING: { PAYPAL: "paypal" },
    Buttons: (c: Config) => { configs.push(c); return { render: () => {}, close: () => {} }; },
  };
  await act(async () => { s!.dispatchEvent(new dom.window.Event("load")); await sleep(10); });
}

const live: (() => void)[] = [];
test.afterEach(() => { while (live.length) live.pop()!(); });
async function mount(sections: ("subscription" | "donation" | "gift")[] | null = null) {
  resetStorage();
  _resetPaypalSdkForTests();
  _resetPaypalSubscribeSdkForTests();
  delete (dom.window as unknown as Record<string, unknown>).paypalSubscriptions;
  dom.window.document.getElementById("paypal-sdk-subscriptions")?.remove();
  configs = [];
  state.posts = [];
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  const router = { push() {}, replace() {}, back() {}, forward() {}, refresh() {}, prefetch() {} };
  act(() => root.render(React.createElement(AppRouterContext.Provider, { value: router as never },
    React.createElement(SupportContent, { signedIn: true, sections }))));
  live.push(() => { if (!host.isConnected) return; act(() => root.unmount()); host.remove(); });
  await settle();
  return host;
}

test("PayPal only: the Supporter section offers PayPal's subscribe button at the plan's price; gifts say they are not offered", async () => {
  state.stripe = false; state.offered = true; state.subscriptions = [];
  const h = await mount();
  assert.ok(text(h).includes("Supporter"));
  assert.ok(text(h).includes("$6/month"), "the PayPal plan's own price");
  assert.equal(button(h, "Become a Supporter"), undefined, "no card checkout without Stripe");
  assert.ok(text(h).includes("Gifts aren’t available on this site."));
  await loadSdk();
  assert.equal(configs.length, 1);
  assert.equal(configs[0]!.style.label, "subscribe");
});

test("not offered by the server → no PayPal subscribe, and the plain line stays", async () => {
  state.stripe = false; state.offered = false; state.subscriptions = [];
  const h = await mount();
  assert.equal(dom.window.document.getElementById("paypal-sdk-subscriptions"), null, "the subscription SDK is never loaded");
  assert.ok(text(h).includes("Subscriptions and gifts aren’t available on this site."));
});

test("the PayPal button asks OUR server for the subscription; approval shows Confirming… until /api/me has the record", async () => {
  state.stripe = true; state.offered = true; state.subscriptions = [];
  const h = await mount(["subscription"]);
  assert.ok(button(h, "Become a Supporter"), "card and PayPal side by side");
  await loadSdk();
  const id = await configs[0]!.createSubscription();
  assert.equal(id, "I-GADGET0001");
  assert.deepEqual(state.posts.at(-1), { url: "/api/billing/paypal/subscription", body: { tier: "supporter", alsoElsewhere: false } });
  await act(async () => { await configs[0]!.onApprove(); });
  assert.ok(text(h).includes("Confirming with PayPal…"), "display only — the webhook decides");
  state.subscriptions = [{ provider: "paypal", tier: "supporter", status: "active", renews: true, periodEnd: FUTURE, accessUntil: FUTURE }];
  await settle(2_300);
  assert.ok(text(h).includes("You’re a Supporter now"), "the record showed up");
});

test("a Supporter elsewhere is warned before paying; 'Subscribe anyway' reveals the buttons and is sent to the server", async () => {
  state.stripe = true; state.offered = true;
  state.subscriptions = [{ provider: "patreon", tier: "supporter", status: "active", renews: true, periodEnd: FUTURE, accessUntil: FUTURE }];
  const h = await mount(["subscription"]);
  assert.match(text(h), /You’re already a Supporter through Patreon \(renews [^)]+\)\. Subscribing here is a second, separate subscription — you’d be paying twice\./);
  assert.equal(button(h, "Become a Supporter"), undefined, "no payment button behind the warning");
  assert.equal(dom.window.document.getElementById("paypal-sdk-subscriptions"), null);
  assert.ok(button(h, "Keep what I have"));
  await act(async () => { button(h, "Subscribe anyway")!.click(); await sleep(10); });
  assert.ok(button(h, "Become a Supporter"));
  await loadSdk();
  await configs[0]!.createSubscription();
  assert.deepEqual(state.posts.at(-1)!.body, { tier: "supporter", alsoElsewhere: true });
});

test("a stale page: the server's 409 subscribed_elsewhere brings the warning back", async () => {
  state.stripe = false; state.offered = true; state.subscriptions = [];
  state.subscribeAnswer = { status: 409, body: { error: "subscribed_elsewhere", provider: "stripe", periodEnd: FUTURE } };
  try {
    const h = await mount(["subscription"]);
    await loadSdk();
    await act(async () => { await configs[0]!.createSubscription().catch(() => {}); await sleep(10); });
    assert.match(text(h), /You’re already a Supporter through a card subscription/);
  } finally {
    state.subscribeAnswer = { status: 200, body: { subscriptionId: "I-GADGET0001" } };
  }
});

test("the card checkout sends the viewer's choice too: false before the warning, true after 'Subscribe anyway'", async () => {
  state.stripe = true; state.offered = false;
  state.subscriptions = [{ provider: "paypal", tier: "supporter", status: "ended", renews: false, periodEnd: null, accessUntil: null }];
  const h = await mount(["subscription"]);
  await act(async () => { button(h, "Become a Supporter")!.click(); await sleep(10); });
  assert.deepEqual(state.posts.at(-1), { url: "/api/billing/checkout", body: { tier: "supporter", alsoElsewhere: false } });
  state.subscriptions = [{ provider: "patreon", tier: "supporter", status: "active", renews: true, periodEnd: FUTURE, accessUntil: FUTURE }];
  const h2 = await mount(["subscription"]);
  await act(async () => { button(h2, "Subscribe anyway")!.click(); await sleep(10); });
  await act(async () => { button(h2, "Become a Supporter")!.click(); await sleep(10); });
  assert.deepEqual(state.posts.at(-1)!.body, { tier: "supporter", alsoElsewhere: true });
});

test("a stale page: the card checkout's 409 subscribed_elsewhere brings the warning back, not an error", async () => {
  state.stripe = true; state.offered = false; state.subscriptions = [];
  state.checkoutAnswer = { status: 409, body: { error: "subscribed_elsewhere", provider: "paypal", periodEnd: FUTURE } };
  try {
    const h = await mount(["subscription"]);
    await act(async () => { button(h, "Become a Supporter")!.click(); await sleep(10); });
    assert.match(text(h), /You’re already a Supporter through PayPal \(renews /);
    assert.equal(button(h, "Become a Supporter"), undefined);
    assert.equal(h.querySelector('[role="alert"]'), null, "a warning, not an error");
  } finally {
    state.checkoutAnswer = { status: 503, body: {} };
  }
});

test("a PayPal subscriber sees their line and an on-site Cancel, which writes nothing but asks PayPal", async () => {
  state.stripe = true; state.offered = true;
  state.subscriptions = [{ provider: "paypal", tier: "supporter", status: "active", renews: true, periodEnd: FUTURE, accessUntil: FUTURE }];
  const h = await mount(["subscription"]);
  assert.match(text(h), /PayPal · Active · renews /);
  assert.ok(text(h).includes("Active"));
  assert.equal(button(h, "Become a Supporter"), undefined, "already subscribed here");
  assert.equal(button(h, "Manage subscription"), undefined, "the Stripe portal is for a card subscription only");
  await act(async () => { button(h, "Cancel")!.click(); await sleep(10); });
  assert.deepEqual(state.posts.map((p) => p.url), ["/api/billing/paypal/subscription/cancel"]);
  assert.match(text(h), /Cancelled\. PayPal confirms it in a moment/);
});
