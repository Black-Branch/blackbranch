// PayPalButton renders BESIDE TipForm's other controls, so a live order sits
// next to an editable amount. This file proves the money invariant by real
// mount, not source scan:
//
//   - paypal.Buttons is called ONCE across several prop changes (the
//     re-render bug the file header warns about — a re-render mid-approval
//     would kill the open popup).
//   - createOrder posts the SNAPSHOT taken at click time, never a live
//     re-read of getDraft() — proven by changing what getDraft returns AFTER
//     onClick and confirming the stale value is what gets posted.
//   - onClick rejects (and never locks) when `valid` is false; when valid it
//     snapshots + locks.
//   - every unlock path actually calls onLockChange(false): onCancel,
//     onError, a throwing/failing createOrder, a failing capture. A
//     SUCCESSFUL capture calls onCaptured and does NOT unlock.
//   - fundingSource is passed straight through to paypal.Buttons.
//   - the wrapper is visibly greyed (opacity-50 pointer-events-none,
//     aria-disabled) whenever `valid` is false.
//
// window.paypal is never real in this harness — jsdom cannot run PayPal's
// actual SDK — so each test drives the script's onload/onerror by hand and
// captures the config object PayPalButton hands to `paypal.Buttons(...)`,
// then calls that config's own callbacks directly, the same way the real SDK
// would after a person clicks the rendered button.
//
// Run: node --test app/features/support/PayPalButton.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act, resetStorage } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";

const { PayPalButton, _resetPaypalSdkForTests } = await import("./PayPalButton.tsx");
const { setPaypalSandbox } = await import("../../lib/paypalSdkEnv.ts");
const { createRoot } = await import("react-dom/client");

type TipDraft = { amount: number; message: string; displayName: string; anonymous: boolean; announce: boolean };
type OnClickActions = { resolve?: () => unknown; reject?: () => unknown };
type ButtonsConfig = {
  fundingSource: string;
  style: { color?: string; borderRadius?: number };
  onClick: (data: unknown, actions: OnClickActions | undefined) => unknown;
  createOrder: () => Promise<string>;
  onApprove: (data: { orderID: string }) => Promise<void>;
  onError: (err: unknown) => void;
  onCancel: () => void;
};

/** Installs a fake `window.paypal` capturing every Buttons() config, and a
 *  fake fetch dispatching by URL — everything PayPalButton's effects touch. */
function harness(fetchImpl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const configs: ButtonsConfig[] = [];
  const rendered: HTMLElement[] = [];
  (globalThis as unknown as { fetch: unknown }).fetch = (url: unknown, init?: RequestInit) =>
    Promise.resolve(fetchImpl(String(url), init));
  return {
    configs,
    rendered,
    installPaypalGlobal() {
      (window as unknown as { paypal: unknown }).paypal = {
        FUNDING: { PAYPAL: "paypal", VENMO: "venmo" },
        Buttons: (config: ButtonsConfig) => {
          configs.push(config);
          return {
            render: (el: HTMLElement) => { rendered.push(el); },
            close: () => {},
          };
        },
      };
    },
  };
}

const DRAFT: TipDraft = { amount: 25, message: "go go go", displayName: "Ada", anonymous: false, announce: true };

type Props = {
  clientId: string;
  fundingSource: "paypal" | "venmo";
  valid: boolean;
  getDraft: () => TipDraft;
  onLockChange: (locked: boolean) => void;
  onCaptured: () => void;
};

function mount(overrides: Partial<Props> = {}) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  const props: Props = {
    clientId: "test-client-id",
    fundingSource: "paypal",
    valid: true,
    getDraft: () => DRAFT,
    onLockChange: () => {},
    onCaptured: () => {},
    ...overrides,
  };
  act(() => root.render(React.createElement(PayPalButton, props)));
  return {
    host,
    // Takes the FULL Props, not a partial merged onto the original — merging
    // onto `props` silently keeps whichever callback a call site doesn't
    // mention at the SAME identity as the very first render, so the
    // "rendered once" test below would stay green under a real regression
    // (TipForm passes fresh closures for `onLockChange` and `onCaptured` on
    // every one of ITS OWN re-renders). Every rerender() call spells out
    // every prop.
    rerender: (next: Props) => act(() => root.render(React.createElement(PayPalButton, next))),
    unmount: () => { act(() => root.unmount()); host.remove(); },
  };
}

function scriptTag(): HTMLScriptElement | null {
  return dom.window.document.querySelector('script[src*="paypal.com/sdk/js"]');
}

async function ready(h: ReturnType<typeof harness>) {
  const script = scriptTag();
  assert.ok(script, "vacuity anchor: no script tag to fire onload on");
  await act(async () => {
    h.installPaypalGlobal();
    // usePaypalSdk listens via addEventListener("load", …), not a `.onload`
    // property assignment — dispatch a real event, the way the browser does.
    script!.dispatchEvent(new dom.window.Event("load"));
  });
  return h.configs[0]!;
}

test.beforeEach(() => {
  resetStorage();
  delete (window as unknown as { paypal?: unknown }).paypal;
  scriptTag()?.remove();
  // The SDK load state is module-shared — with no per-instance state to fall back to, a leftover "ready"/
  // "failed" from a previous test would make ensureSdkLoad's idle-only guard
  // silently skip creating a script tag for this one.
  _resetPaypalSdkForTests();
});

// buyer-country=US: PayPal's sandbox-only way to present as a US buyer (Venmo is
// US-only). PayPal rejects it on live, so it rides only on a sandbox answer.
for (const sandbox of [true, false]) {
  test(`buyer-country=US is on the SDK URL ${sandbox ? "in the sandbox" : "NEVER on live"}`, () => {
    setPaypalSandbox(sandbox);
    harness(() => new Response("{}", { status: 200 }));
    const m = mount();
    const url = new URL(scriptTag()!.src);
    assert.equal(url.searchParams.get("client-id"), "test-client-id", "vacuity anchor: the SDK URL was built");
    assert.equal(url.searchParams.get("buyer-country"), sandbox ? "US" : null);
    m.unmount();
    setPaypalSandbox(false);
  });
}

test("injects the SDK script with the client id, currency, capture intent, venmo funding enabled, and pay-later/card funding DISABLED", () => {
  harness(() => new Response("{}", { status: 200 }));
  const m = mount();
  const script = scriptTag();
  assert.ok(script, "no PayPal SDK <script> tag was injected on mount");
  const url = new URL(script!.src);
  assert.equal(url.origin + url.pathname, "https://www.paypal.com/sdk/js");
  assert.equal(url.searchParams.get("client-id"), "test-client-id");
  assert.equal(url.searchParams.get("currency"), "USD");
  assert.equal(url.searchParams.get("intent"), "capture");
  assert.equal(url.searchParams.get("components"), "buttons");
  assert.equal(url.searchParams.get("enable-funding"), "venmo");
  assert.equal(url.searchParams.get("disable-funding"), "paylater,card");
  m.unmount();
});

test("once the script loads, paypal.Buttons is called with the right fundingSource and rendered into the DOM", async () => {
  const h = harness(() => new Response("{}", { status: 200 }));
  const m = mount({ fundingSource: "venmo" });
  const config = await ready(h);
  assert.equal(h.configs.length, 1, "paypal.Buttons must be called exactly once");
  assert.equal(h.rendered.length, 1, "the buttons config must be rendered into the container");
  assert.equal(config.fundingSource, "venmo", "fundingSource must be passed straight through");
  assert.equal(config.style.color, undefined, "venmo must not force a color — its SDK default is Venmo blue");
  m.unmount();
});

test("the paypal funding source gets PayPal's gold color", async () => {
  const h = harness(() => new Response("{}", { status: 200 }));
  const m = mount({ fundingSource: "paypal" });
  const config = await ready(h);
  assert.equal(config.fundingSource, "paypal");
  assert.equal(config.style.color, "gold");
  m.unmount();
});

// White corners on the buttons: the site is color-scheme dark, PayPal's iframe document is not, and a browser paints such
// an iframe an OPAQUE white canvas that shows through rounded corners. The
// wrapper must pin the light scheme, and the SDK button must be square (the
// wrapper rounds the left; the right meets the ▾ flush).
test("the button sits in a light-scheme wrapper and renders square — no white iframe canvas at the corners", async () => {
  const h = harness(() => new Response("{}", { status: 200 }));
  const m = mount({ fundingSource: "venmo" });
  const config = await ready(h);
  assert.equal(config.style.borderRadius, 0, "PayPal's own rounding exposes the iframe canvas at the corners");
  const wrapper = m.host.querySelector(".scheme-light");
  assert.ok(wrapper, "the iframe's wrapper must pin color-scheme: light");
  assert.ok(wrapper!.className.includes("rounded-l-lg") && wrapper!.className.includes("overflow-hidden"), "the wrapper rounds the left edge itself");
  m.unmount();
});

test("the button is rendered ONCE across several parent re-renders, EVEN WHEN EVERY CALLBACK PROP IS A FRESH CLOSURE each time — matches production: TipForm passes getDraft={() => draft} and onCaptured={() => props.onPaypalCaptured?.()}, both new every render", async () => {
  const h = harness(() => new Response("{}", { status: 200 }));
  const baseProps = (amount: number, valid: boolean): Props => ({
    clientId: "test-client-id",
    fundingSource: "paypal",
    valid,
    getDraft: () => ({ ...DRAFT, amount }),
    onLockChange: () => {},
    onCaptured: () => {},
  });
  const m = mount(baseProps(25, true));
  await ready(h);
  assert.equal(h.configs.length, 1);

  // Every one of these re-renders hands PayPalButton a BRAND NEW object for
  // every prop — getDraft, onLockChange and onCaptured all get fresh
  // closures, not just the two the old version of this test varied. A
  // regression that adds any of them to the button-creation effect's
  // dependency array would re-render on every one of these, not only on a
  // genuine draft/valid change.
  for (let i = 0; i < 4; i++) {
    m.rerender(baseProps(99 + i, i % 2 === 0));
  }
  assert.equal(h.configs.length, 1, "paypal.Buttons must still have been called exactly once after several re-renders with entirely fresh prop identities");

  // And once more AFTER a lock-triggering click — a regression scoped only
  // to the deps array (not e.g. a key change) could plausibly survive
  // re-renders that happen BEFORE any interaction but still break the one
  // that matters: a re-render while a popup is actually open.
  const config = h.configs[0]!;
  act(() => { config.onClick(undefined, {}); });
  m.rerender(baseProps(25, true));
  assert.equal(h.configs.length, 1, "still exactly one render after a lock-triggering click followed by a fresh-identity re-render");
  m.unmount();
});

test("onClick rejects and does NOT lock when the draft is invalid — including when the button rendered VALID and only went invalid afterwards", async () => {
  const h = harness(() => new Response("{}", { status: 200 }));
  const locks: boolean[] = [];

  // Mounted-invalid case (unchanged).
  const mInvalid = mount({ valid: false, onLockChange: (l) => locks.push(l) });
  const configInvalid = await ready(h);
  let rejectedInvalid = false;
  act(() => { configInvalid.onClick(undefined, { reject: () => { rejectedInvalid = true; } }); });
  assert.ok(rejectedInvalid, "onClick must reject when mounted invalid");
  assert.deepEqual(locks, [], "an invalid click must never lock the form");
  mInvalid.unmount();

  // The real-world case the mounted-invalid version can't catch (review
  // finding 4): the button renders VALID (paypal.Buttons is created once,
  // per the test above), and only afterwards does the draft go invalid —
  // e.g. a message typed past the reading-tier cap while the button already
  // sits on screen. A regression that read `valid` from the render-once
  // effect's closure instead of `validRef.current` would still see the
  // STALE `true` here and let the click through.
  delete (window as unknown as { paypal?: unknown }).paypal;
  scriptTag()?.remove();
  _resetPaypalSdkForTests();
  const h2 = harness(() => new Response("{}", { status: 200 }));
  const locks2: boolean[] = [];
  const m = mount({ valid: true, onLockChange: (l) => locks2.push(l) });
  const config = await ready(h2);
  assert.equal(h2.configs.length, 1, "vacuity anchor: the button never rendered while valid");

  m.rerender({
    clientId: "test-client-id",
    fundingSource: "paypal",
    valid: false,
    getDraft: () => DRAFT,
    onLockChange: (l) => locks2.push(l),
    onCaptured: () => {},
  });

  let rejected = false;
  act(() => { config.onClick(undefined, { reject: () => { rejected = true; } }); });
  assert.ok(rejected, "onClick must reject once valid has gone false, even though the button rendered while valid was still true");
  assert.deepEqual(locks2, [], "a click after going invalid must never lock the form");
  m.unmount();
});

test("onClick on a valid draft snapshots the draft and locks the form", async () => {
  const h = harness(() => new Response("{}", { status: 200 }));
  const locks: boolean[] = [];
  const m = mount({ valid: true, onLockChange: (l) => locks.push(l) });
  const config = await ready(h);

  act(() => { config.onClick(undefined, {}); });
  assert.deepEqual(locks, [true], "a valid click must lock the form");
  m.unmount();
});

test("createOrder POSTs the SNAPSHOT taken at click time, never a live re-read of getDraft", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const h = harness((url, init) => {
    if (url.includes("/api/billing/paypal/order")) {
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
      return new Response(JSON.stringify({ orderId: "8U481631H66031715" }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });
  let current: TipDraft = DRAFT;
  const m = mount({ getDraft: () => current });
  const config = await ready(h);

  act(() => { config.onClick(undefined, {}); }); // snapshots { amount: 25, ... }
  current = { ...DRAFT, amount: 999, message: "changed after the click" }; // live draft moves on

  let orderId = "";
  await act(async () => { orderId = await config.createOrder(); });
  assert.equal(orderId, "8U481631H66031715");
  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls[0]!.body,
    { amount: 25, message: "go go go", displayName: "Ada", anonymous: false, fundingSource: "paypal" },
    "createOrder must post the value getDraft() returned AT CLICK TIME, not the live value at createOrder time",
  );
  m.unmount();
});

// The order route builds payment_source.<paypal|venmo> (NO_SHIPPING lives in it),
// so the button that was pressed must reach it — a Venmo press minting a
// payment_source.paypal order would be a source mismatch at PayPal.
for (const [purpose, fundingSource] of [["tip", "venmo"], ["points", "venmo"], ["points", "paypal"]] as const) {
  test(`createOrder names the pressed button: a ${purpose} via ${fundingSource} posts fundingSource "${fundingSource}"`, async () => {
    const bodies: Record<string, unknown>[] = [];
    const h = harness((url, init) => {
      if (url.includes("/api/billing/paypal/order")) {
        bodies.push(JSON.parse(init!.body as string));
        return new Response(JSON.stringify({ orderId: "ORDER-F" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    const host = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(React.createElement(PayPalButton, {
      clientId: "test-client-id", fundingSource, valid: true, getDraft: () => DRAFT,
      onLockChange: () => {}, onCaptured: () => {}, purpose,
    })));
    const config = await ready(h);
    act(() => { config.onClick(undefined, {}); });
    await act(async () => { await config.createOrder(); });
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0]!.fundingSource, fundingSource);
    assert.equal(bodies[0]!.purpose, purpose === "points" ? "points" : undefined);
    act(() => root.unmount()); host.remove();
  });
}

test("a 400 from the order route surfaces the server's body verbatim, throws, and unlocks", async () => {
  const h = harness((url) =>
    url.includes("/api/billing/paypal/order")
      ? new Response("A $25.00 tip carries a message of up to 500 characters.", { status: 400 })
      : new Response("{}", { status: 200 }),
  );
  const locks: boolean[] = [];
  const m = mount({ onLockChange: (l) => locks.push(l) });
  const config = await ready(h);
  act(() => { config.onClick(undefined, {}); });
  await act(async () => {
    await assert.rejects(() => config.createOrder());
  });
  assert.ok(
    m.host.textContent?.includes("A $25.00 tip carries a message of up to 500 characters."),
    "the 400 body must be shown verbatim, the same way DonateClient.startCheckout surfaces it",
  );
  assert.deepEqual(locks, [true, false], "a failed createOrder must unlock the form");
  m.unmount();
});

test("a 503 and a 429 from the order route show the same copy, and both unlock", async () => {
  for (const [status, expected] of [[503, "Billing isn’t set up yet."], [429, "Too many attempts — try again in a few minutes."]] as const) {
    const h = harness((url) =>
      url.includes("/api/billing/paypal/order") ? new Response("", { status }) : new Response("{}", { status: 200 }),
    );
    delete (window as unknown as { paypal?: unknown }).paypal;
    scriptTag()?.remove();
    _resetPaypalSdkForTests();
    const locks: boolean[] = [];
    const m = mount({ onLockChange: (l) => locks.push(l) });
    const config = await ready(h);
    act(() => { config.onClick(undefined, {}); });
    await act(async () => {
      await assert.rejects(() => config.createOrder());
    });
    assert.ok(m.host.textContent?.includes(expected), `status ${status} should show "${expected}", got: ${m.host.textContent}`);
    assert.deepEqual(locks, [true, false]);
    m.unmount();
  }
});

test("onApprove POSTs { orderId } to the capture route and calls onCaptured on success — never claiming the tip is on stream, and does NOT unlock", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const h = harness((url, init) => {
    if (url.includes("/api/billing/paypal/order")) return new Response(JSON.stringify({ orderId: "8U481631H66031715" }), { status: 200 });
    if (url.includes("/api/billing/paypal/capture")) {
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });
  let captured = 0;
  const locks: boolean[] = [];
  const m = mount({ onCaptured: () => { captured += 1; }, onLockChange: (l) => locks.push(l) });
  const config = await ready(h);
  act(() => { config.onClick(undefined, {}); });
  await act(async () => { await config.onApprove({ orderID: "8U481631H66031715" }); });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "/api/billing/paypal/capture");
  assert.deepEqual(calls[0]!.body, { orderId: "8U481631H66031715" });
  assert.equal(captured, 1, "onCaptured must fire exactly once on a successful capture");
  assert.deepEqual(locks, [true], "a SUCCESSFUL capture must not unlock — the caller is expected to move on");
  m.unmount();
});

test("a failed capture shows a readable error, does NOT call onCaptured, and unlocks", async () => {
  const h = harness((url) =>
    url.includes("/api/billing/paypal/capture") ? new Response("", { status: 502 }) : new Response(JSON.stringify({ orderId: "X" }), { status: 200 }),
  );
  let captured = 0;
  const locks: boolean[] = [];
  const m = mount({ onCaptured: () => { captured += 1; }, onLockChange: (l) => locks.push(l) });
  const config = await ready(h);
  act(() => { config.onClick(undefined, {}); });
  await act(async () => { await config.onApprove({ orderID: "8U481631H66031715" }); });
  assert.equal(captured, 0, "a failed capture must never call onCaptured");
  assert.ok(m.host.querySelector('[role="alert"]'), "a failed capture must show a visible error, never fail silently");
  assert.deepEqual(locks, [true, false], "a failed capture must unlock");
  m.unmount();
});

test("onCancel is NOT an error — it clears any error and unlocks", async () => {
  const h = harness(() => new Response(JSON.stringify({ orderId: "X" }), { status: 200 }));
  const locks: boolean[] = [];
  const m = mount({ onLockChange: (l) => locks.push(l) });
  const config = await ready(h);
  act(() => { config.onClick(undefined, {}); });
  act(() => { config.onCancel(); });
  assert.ok(!m.host.querySelector('[role="alert"]'), "a cancel must not show an error — the tipper simply closed the popup");
  assert.deepEqual(locks, [true, false], "a cancel must unlock");
  m.unmount();
});

test("onError shows a readable error, never a blank panel, and unlocks", async () => {
  const h = harness(() => new Response(JSON.stringify({ orderId: "X" }), { status: 200 }));
  const locks: boolean[] = [];
  const m = mount({ onLockChange: (l) => locks.push(l) });
  const config = await ready(h);
  act(() => { config.onClick(undefined, {}); });
  act(() => { config.onError(new Error("boom")); });
  assert.ok(m.host.querySelector('[role="alert"]'), "onError must render a visible error");
  assert.deepEqual(locks, [true, false], "onError must unlock");
  m.unmount();
});

test("a popup CLOSED before approval arrives as onError(\"Detected popup close\") — treated exactly like onCancel, unlocks with no visible error", async () => {
  const h = harness(() => new Response(JSON.stringify({ orderId: "X" }), { status: 200 }));
  const locks: boolean[] = [];
  const m = mount({ onLockChange: (l) => locks.push(l) });
  const config = await ready(h);
  act(() => { config.onClick(undefined, {}); });
  act(() => { config.onError(new Error("Detected popup close")); });
  assert.ok(!m.host.querySelector('[role="alert"]'), "a closed popup must not show an error — the tipper simply closed the window");
  assert.deepEqual(locks, [true, false], "a closed popup must unlock");
  m.unmount();
});

test("a popup-close match is case-insensitive and substring, but every OTHER onError still shows the generic error", async () => {
  const closeVariants = ["DETECTED POPUP CLOSE", "popup close detected mid-flow"];
  for (const msg of closeVariants) {
    delete (window as unknown as { paypal?: unknown }).paypal;
    scriptTag()?.remove();
    _resetPaypalSdkForTests();
    // A fresh harness per mount — `h.configs` grows by one on every mount, so
    // reusing one `h` across several mounts and reading `configs[0]` would
    // silently keep testing the FIRST (already-unmounted) button.
    const h = harness(() => new Response(JSON.stringify({ orderId: "X" }), { status: 200 }));
    const m = mount();
    const config = await ready(h);
    act(() => { config.onClick(undefined, {}); });
    act(() => { config.onError(new Error(msg)); });
    assert.ok(!m.host.querySelector('[role="alert"]'), `"${msg}" must read as a popup close, not a generic error`);
    m.unmount();
  }

  delete (window as unknown as { paypal?: unknown }).paypal;
  scriptTag()?.remove();
  _resetPaypalSdkForTests();
  const h2 = harness(() => new Response(JSON.stringify({ orderId: "X" }), { status: 200 }));
  const m2 = mount();
  const config2 = await ready(h2);
  act(() => { config2.onClick(undefined, {}); });
  act(() => { config2.onError(new Error("Network Error")); });
  assert.ok(m2.host.querySelector('[role="alert"]'), "a genuinely different onError must still show the generic error");
  m2.unmount();
});

test("a network failure in createOrder (postJson's fetch rejects) is caught locally — shows an error, unlocks, and rethrows so the SDK also learns it failed", async () => {
  const h = harness(() => Promise.reject(new TypeError("Failed to fetch")));
  const locks: boolean[] = [];
  const m = mount({ onLockChange: (l) => locks.push(l) });
  const config = await ready(h);
  act(() => { config.onClick(undefined, {}); });
  await act(async () => {
    await assert.rejects(() => config.createOrder(), "createOrder must still reject — the SDK needs to know the order failed to open");
  });
  assert.ok(m.host.querySelector('[role="alert"]'), "a network failure must show a visible error, never leave the form silently stuck");
  assert.deepEqual(locks, [true, false], "a network failure in createOrder must unlock the form locally, not depend on the SDK routing it to onError");
  m.unmount();
});

test("a blocked/failed script load shows a visible message and a retry — never a silent empty box", async () => {
  harness(() => new Response("{}", { status: 200 }));
  const m = mount();
  const script = scriptTag();
  assert.ok(script, "vacuity anchor: no script tag to fail");
  await act(async () => { script!.dispatchEvent(new dom.window.Event("error")); });
  assert.ok(m.host.textContent && m.host.textContent.length > 0, "a failed load must render SOMETHING, not an empty box");
  const retryButton = [...m.host.querySelectorAll("button")].find((b) => /try again/i.test(b.textContent ?? ""));
  assert.ok(retryButton, "a failed load must offer a retry button");

  await act(async () => { retryButton!.click(); });
  const newScript = scriptTag();
  assert.ok(newScript, "retry must inject a new script tag");
  m.unmount();
});

test("the wrapper is visibly greyed (opacity-50 pointer-events-none, aria-disabled) whenever valid is false", () => {
  harness(() => new Response("{}", { status: 200 }));
  const invalid = mount({ valid: false });
  const wrapper = invalid.host.firstElementChild as HTMLElement;
  assert.ok(wrapper, "vacuity anchor: nothing rendered");
  assert.ok(wrapper.className.includes("opacity-50"), "an invalid PayPalButton must be visually greyed (actions.disable() alone does not change the SDK button's color)");
  assert.ok(wrapper.className.includes("pointer-events-none"), "an invalid PayPalButton must not be clickable through the grey overlay");
  assert.equal(wrapper.getAttribute("aria-disabled"), "true");
  invalid.unmount();

  const valid = mount({ valid: true });
  const validWrapper = valid.host.firstElementChild as HTMLElement;
  assert.ok(!validWrapper.className.includes("opacity-50"), "a valid PayPalButton must not be greyed");
  assert.equal(validWrapper.getAttribute("aria-disabled"), null);
  valid.unmount();
});
