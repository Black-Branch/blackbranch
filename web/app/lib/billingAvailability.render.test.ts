// The three payment surfaces — /donate (DonateClient), the Support panel (SupportContent) and the
// Store (StoreContent) — open with EITHER provider. Gating the whole page on Stripe,
// with the PayPal button inside that gate, would leave an install with PayPal/Venmo only unable to
// take a tip or sell points at all. A real mount of each surface for every combination
// (Stripe only, PayPal only, both, neither), plus a restart and a retry.
//
// The availability answer is ONE server response, /api/billing/stripe/config
// ({ publishableKey, paypalClientId }), read by useBillingAvailability (useStripe.ts) on mount and
// again on window focus. Served here by a fake fetch whose answer a test can change mid-mount.
//
// Run: systemd-run --user --scope -p MemoryMax=8G --quiet node --test app/lib/billingAvailability.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act, resetStorage } from "./testDom.ts";
import "./testTsx.ts";

// Browser globals the surfaces' other parts touch and jsdom/testDom do not install: next/link reads
// `self`; the Store's tab chrome measures itself (getComputedStyle, ResizeObserver).
const g = globalThis as unknown as Record<string, unknown>;
g.self ??= dom.window;
g.getComputedStyle ??= dom.window.getComputedStyle.bind(dom.window);
g.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY; // the first answer is the server's, not a build's

type Answer = { publishableKey: string | null; paypalClientId: string | null; supporter?: { amount: number; currency: string } | null; subscribe?: { amount: number; currency: string } | null };
const MONTH = { amount: 500, currency: "usd" };
const COMBOS: Record<"stripe" | "paypal" | "both" | "neither", Answer> = {
  stripe: { publishableKey: "pk_test_casey", paypalClientId: null, supporter: MONTH },
  paypal: { publishableKey: null, paypalClientId: "AeGadget123", supporter: null },
  both: { publishableKey: "pk_test_casey", paypalClientId: "AeGadget123", supporter: MONTH },
  neither: { publishableKey: null, paypalClientId: null, supporter: null },
};
let served: Answer = COMBOS.neither;
let configReads = 0;
(globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown) => {
  const u = String(url);
  const body: unknown =
    u.startsWith("/api/billing/stripe/config") ? (configReads++, served)
    : u.startsWith("/api/billing/gifts") ? { given: [], received: [] }
    : u.startsWith("/api/store/prices") ? { prices: [], e: 1, purchasable: true, clockMultiplier: 1 }
    : u.startsWith("/api/points/balance") ? { balance: 0, earned: 0 }
    : u.startsWith("/api/me/style") ? { style: null, unlocked: [] }
    : u.startsWith("/api/styles/prices") ? { prices: {} }
    : {};
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};

const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const router = { push() {}, replace() {}, back() {}, forward() {}, refresh() {}, prefetch() {} };
const { DonateClient } = await import("../donate/DonateClient.tsx");
const { default: SupportContent } = await import("../components/SupportContent.tsx");
const { default: StoreContent } = await import("../features/store/StoreContent.tsx");
const { _resetPaypalSdkForTests } = await import("../features/support/PayPalButton.tsx");
const { createRoot } = await import("react-dom/client");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => act(async () => { await sleep(15); });

type Surface = "donate" | "support" | "store";
// Every mount is unmounted after its test even when an assertion threw first: a surface left
// mounted keeps its timers (the Store's balance poll) alive and the file never exits.
const live: (() => void)[] = [];
test.afterEach(() => { while (live.length) live.pop()!(); });
async function mount(surface: Surface, opts: { paypalFromServer?: string | null; settle?: boolean } = {}) {
  resetStorage();
  _resetPaypalSdkForTests();
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  const el =
    surface === "donate" ? React.createElement(DonateClient, { initialName: "", paypalClientId: opts.paypalFromServer ?? null, signedIn: false })
    : surface === "support" ? React.createElement(SupportContent, { signedIn: true })
    : React.createElement(StoreContent, {});
  act(() => root.render(React.createElement(AppRouterContext.Provider, { value: router as never }, el)));
  const unmount = () => { if (!host.isConnected) return; act(() => root.unmount()); host.remove(); };
  live.push(unmount);
  if (opts.settle !== false) await settle();
  return { host, unmount };
}
const focus = async () => { await act(async () => { dom.window.dispatchEvent(new dom.window.Event("focus")); await sleep(15); }); };

const text = (h: HTMLElement) => h.textContent ?? "";
const buttons = (h: HTMLElement) => [...h.querySelectorAll("button")];
/** The card half of the split button: "Tip $5" on a tip, "Buy N points" on a quiet Store purchase. */
const cardButtons = (h: HTMLElement) => buttons(h).filter((b) => /^(Tip \$|Buy \d)/.test(b.textContent ?? ""));
/** The PayPal side: the ▾ that chooses PayPal/Venmo (card on), or PayPal's own button standing alone. */
const methodMenus = (h: HTMLElement) => h.querySelectorAll('[aria-label="Choose how to pay"]');
const paypalLines = (h: HTMLElement) => [...h.querySelectorAll("p")].filter((p) => / via (PayPal|Venmo)$/.test(p.textContent ?? ""));
const NOT_CONFIGURED = "Billing isn’t configured on the server yet.";

/** What each combination must show — the same on all three surfaces for the pay button. */
function assertPayButtons(h: HTMLElement, combo: keyof typeof COMBOS, where: string) {
  if (combo === "neither") {
    assert.ok(text(h).includes(NOT_CONFIGURED), `${where}: neither provider → the "isn't configured" line`);
    assert.equal(cardButtons(h).length, 0, `${where}: no card button`);
    assert.equal(paypalLines(h).length + methodMenus(h).length, 0, `${where}: no PayPal`);
    return;
  }
  assert.ok(!text(h).includes(NOT_CONFIGURED), `${where}: the page opens with ${combo}`);
  const stripeOn = combo !== "paypal";
  const paypalOn = combo !== "stripe";
  assert.equal(cardButtons(h).length, stripeOn ? 1 : 0, `${where}: card button ${stripeOn ? "once" : "absent"}`);
  if (stripeOn) assert.equal(methodMenus(h).length, paypalOn ? 1 : 0, `${where}: the ▾ only with PayPal on`);
  else assert.equal(paypalLines(h).length, 1, `${where}: PayPal stands alone as the pay button`);
}

for (const combo of Object.keys(COMBOS) as (keyof typeof COMBOS)[]) {
  test(`/donate, ${combo}: the right pay buttons, and the US-dollars line only with Stripe`, async () => {
    served = COMBOS[combo];
    const m = await mount("donate");
    assertPayButtons(m.host, combo, "/donate");
    const usdLine = text(m.host).includes("switch the payment box to US dollars");
    assert.equal(usdLine, combo === "stripe" || combo === "both", "the US-dollars line is about Stripe's payment box");
    if (combo === "paypal") {
      assert.ok(m.host.querySelector("textarea"), "the message box still feeds the PayPal order");
      assert.ok(text(m.host).includes("Tip anonymously"), "so does the anonymous box");
    }
    m.unmount();
  });

  test(`Support panel, ${combo}: pay buttons, and subscriptions/gifts only with Stripe`, async () => {
    served = COMBOS[combo];
    const m = await mount("support");
    assertPayButtons(m.host, combo, "Support");
    if (combo !== "neither") {
      const stripeOn = combo !== "paypal";
      assert.equal(text(m.host).includes("Become a Supporter"), stripeOn, "subscribing is a Stripe checkout");
      assert.equal(text(m.host).includes("Gift Supporter"), stripeOn, "gifting is a Stripe checkout");
      assert.equal(text(m.host).includes("Subscriptions and gifts aren’t available on this site."), !stripeOn,
        "with Stripe off, one plain line says so instead of empty sections");
      assert.equal(/processed by Stripe/.test(text(m.host)), stripeOn, "the footer names only the providers in use");
      assert.equal(/PayPal/.test(text(m.host).slice(text(m.host).indexOf("Payments are processed"))), combo !== "stripe");
    }
    m.unmount();
  });

  test(`Store, ${combo}: points can be bought with whichever provider is on — and with neither, only the top-up box goes`, async () => {
    served = COMBOS[combo];
    const m = await mount("store");
    if (combo === "neither") {
      // The wallet, spending and history stay; no "isn't configured" wall over them.
      assert.ok(!text(m.host).includes(NOT_CONFIGURED), "no Billing-isn't-configured wall over the Store");
      assert.ok(text(m.host).includes("Your wallet"), "the wallet stays");
      assert.ok(m.host.querySelector('[aria-label="Store sections"]'), "the Store's sections stay");
      assert.equal(cardButtons(m.host).length + paypalLines(m.host).length + methodMenus(m.host).length, 0, "no way to pay");
      assert.ok(!m.host.querySelector('input[placeholder="Other"]'), "no top-up amount box");
    } else assertPayButtons(m.host, combo, "Store");
    if (combo === "paypal") {
      assert.match(paypalLines(m.host)[0]!.textContent ?? "", /^Buying [\d,]+ \S+ via PayPal$/, "a quiet points purchase through PayPal");
    }
    m.unmount();
  });
}

test("restart: a provider switched on after the page opened shows on the next read (window focus), no reload", async () => {
  served = COMBOS.stripe;
  const m = await mount("donate");
  assertPayButtons(m.host, "stripe", "before");
  served = COMBOS.paypal;
  await focus();
  assertPayButtons(m.host, "paypal", "after the switch");
  served = COMBOS.neither;
  await focus();
  assertPayButtons(m.host, "neither", "after both off");
  m.unmount();
});

test("restart: a reopened Support panel reads the answer afresh", async () => {
  served = COMBOS.both;
  const a = await mount("support");
  assertPayButtons(a.host, "both", "first open");
  a.unmount();
  served = COMBOS.paypal;
  const b = await mount("support");
  assertPayButtons(b.host, "paypal", "reopened after Stripe went off");
  b.unmount();
});

test("restart: /donate's server-read PayPal id paints at once, before the first read answers", async () => {
  served = COMBOS.paypal;
  const m = await mount("donate", { paypalFromServer: "AeGadget123", settle: false });
  assert.ok(!text(m.host).includes(NOT_CONFIGURED), "no 'isn't configured' flash on a PayPal-only page");
  await settle();
  assertPayButtons(m.host, "paypal", "after the read");
  m.unmount();
});

test("restart: the Store's top-up box comes back when a provider is switched on after the Store opened", async () => {
  served = COMBOS.neither;
  const m = await mount("store");
  assert.ok(!m.host.querySelector('input[placeholder="Other"]'));
  served = COMBOS.paypal;
  await focus();
  assertPayButtons(m.host, "paypal", "after PayPal went on");
  m.unmount();
  served = COMBOS.neither;
});

test("retry: PayPal off and on again, and Stripe off and on again, leaves exactly one button set", async () => {
  served = COMBOS.both;
  const m = await mount("store");
  for (const next of ["stripe", "both", "paypal", "both", "paypal", "both"] as const) {
    served = COMBOS[next];
    await focus();
    assertPayButtons(m.host, next, `after switching to ${next}`);
  }
  assert.equal(methodMenus(m.host).length, 1, "one ▾");
  assert.equal(cardButtons(m.host).length, 1, "one card button");
  m.unmount();
});

test("a failed read keeps the last answer — a hiccup must not hide a working checkout", async () => {
  served = COMBOS.both;
  const m = await mount("donate");
  const realFetch = globalThis.fetch;
  (globalThis as unknown as { fetch: unknown }).fetch = async () => new Response("down", { status: 502 });
  await focus();
  (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
  assertPayButtons(m.host, "both", "after a failed read");
  m.unmount();
});

test("the answer's paypalSandbox reaches the SDK URL (buyer-country=US), and a live answer leaves it off", async () => {
  for (const sandbox of [true, false]) {
    dom.window.document.querySelectorAll('script[src*="paypal.com/sdk/js"]').forEach((s) => s.remove());
    served = { ...COMBOS.paypal, paypalSandbox: sandbox } as Answer;
    const m = await mount("support");
    const script = dom.window.document.querySelector('script[src*="paypal.com/sdk/js"]') as HTMLScriptElement | null;
    assert.ok(script, "vacuity anchor: PayPal-only mounts the SDK");
    assert.equal(new URL(script!.src).searchParams.get("buyer-country"), sandbox ? "US" : null);
    m.unmount();
  }
  served = COMBOS.neither;
});

test("Stripe on with NO Supporter price: subscriptions and gifts are not offered — one plain line, no button that answers 503 (R1.10)", async () => {
  served = { ...COMBOS.stripe, supporter: null };
  const m = await mount("support");
  assertPayButtons(m.host, "stripe", "Support, no price");
  assert.ok(!text(m.host).includes("Become a Supporter"), "no Subscribe button");
  assert.ok(!text(m.host).includes("Gift Supporter"), "no Gift section");
  assert.ok(text(m.host).includes("Subscriptions and gifts aren’t available on this site."));
  m.unmount();
  served = COMBOS.neither;
});

test("the price shown and the gift total are the Stripe Price's amount and currency, not a number in the code (R1.10)", async () => {
  served = { ...COMBOS.stripe, supporter: { amount: 700, currency: "eur" } };
  const m = await mount("support");
  assert.match(text(m.host), /€7\/month/, "the monthly price, formatted in its currency");
  assert.ok(!text(m.host).includes("$5/month"), "no hard-coded $5/month");
  const gift = buttons(m.host).find((b) => /^Gift /.test(b.textContent ?? ""));
  assert.equal(gift?.textContent, "Gift €7", "one month for one person = one month's price");
  m.unmount();
  served = COMBOS.neither;
});

test("restart: a Supporter price set after the page opened shows on the next read (window focus)", async () => {
  served = { ...COMBOS.stripe, supporter: null };
  const m = await mount("support");
  assert.ok(!text(m.host).includes("Become a Supporter"));
  served = COMBOS.stripe;
  await focus();
  assert.ok(text(m.host).includes("Become a Supporter"), "the price arrived: subscriptions are offered");
  assert.match(text(m.host), /\$5\/month/);
  m.unmount();
  served = COMBOS.neither;
});

// -- `subscribe`: a subscription is for sale through EITHER provider (k, 2026-10-21) --
// What the player's Subscribe button reads (subscribeButton, features/support). Read by mounting the
// hook itself: a PayPal-only answer carries no publishable key, and `subscribe` must not hide behind it.
const { useBillingAvailability } = await import("./useStripe.ts");
async function mountProbe() {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  function Probe() {
    const b = useBillingAvailability();
    return React.createElement("output", null, JSON.stringify({ subscribe: b.subscribe, supporter: b.supporter }));
  }
  act(() => root.render(React.createElement(Probe)));
  const unmount = () => { if (!host.isConnected) return; act(() => root.unmount()); host.remove(); };
  live.push(unmount);
  await settle();
  return { read: () => JSON.parse(text(host)) as { subscribe: unknown; supporter: unknown }, unmount };
}
const PAYPAL_PLAN_SITE: Answer = { ...COMBOS.paypal, subscribe: MONTH };

test("a site that sells subscriptions through PayPal only: the hook's `subscribe` carries the plan's price with no card key; `supporter` (gifts) stays null", async () => {
  served = PAYPAL_PLAN_SITE;
  const m = await mountProbe();
  assert.deepEqual(m.read(), { subscribe: MONTH, supporter: null });
  m.unmount();
  served = COMBOS.neither;
});

test("Stripe only and both: `subscribe` is the server's answer, as before (Stripe's price)", async () => {
  for (const combo of ["stripe", "both"] as const) {
    served = { ...COMBOS[combo], subscribe: MONTH };
    const m = await mountProbe();
    assert.deepEqual(m.read(), { subscribe: MONTH, supporter: MONTH }, combo);
    m.unmount();
  }
  served = COMBOS.neither;
});

test("restart: a PayPal plan set after the page opened shows on the next read (window focus); cleared, it goes", async () => {
  served = COMBOS.paypal;
  const m = await mountProbe();
  assert.equal(m.read().subscribe, null);
  served = PAYPAL_PLAN_SITE;
  await focus();
  assert.deepEqual(m.read().subscribe, MONTH);
  served = COMBOS.paypal;
  await focus();
  assert.equal(m.read().subscribe, null);
  m.unmount();
  served = COMBOS.neither;
});

test("retry: a failed read keeps the last `subscribe` answer, and the next good read replaces it", async () => {
  served = PAYPAL_PLAN_SITE;
  const m = await mountProbe();
  const realFetch = globalThis.fetch;
  (globalThis as unknown as { fetch: unknown }).fetch = async () => new Response("down", { status: 502 });
  await focus();
  (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
  assert.deepEqual(m.read().subscribe, MONTH, "a failed read does not hide the Subscribe button");
  served = { ...PAYPAL_PLAN_SITE, subscribe: { amount: 600, currency: "usd" } };
  await focus();
  assert.deepEqual(m.read().subscribe, { amount: 600, currency: "usd" });
  m.unmount();
  served = COMBOS.neither;
});

// Vacuity anchor: the answer was really read through the fake server, not defaulted.
test("every mount above read the one availability route", () => {
  assert.ok(configReads >= 20, `expected the surfaces to read /api/billing/stripe/config, saw ${configReads} reads`);
});
