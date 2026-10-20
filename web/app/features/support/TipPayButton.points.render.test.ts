// TipPayButton, mounted directly with purpose="points". The tip-purpose behaviour is pinned by
// TipPayButton.render.test.ts; this file pins ONLY what purpose="points" changes: the card-half
// label/colour, the caption, and the PayPal order body. Harness copied from
// TipPayButton.render.test.ts verbatim, except the fetch stub also records order bodies.
//
// Run: node --test app/features/support/TipPayButton.points.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act, resetStorage } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";

const { TipPayButton } = await import("./TipPayButton.tsx");
const { _resetPaypalSdkForTests } = await import("./PayPalButton.tsx");
const { createRoot } = await import("react-dom/client");

type ButtonsConfig = {
  fundingSource: string;
  onClick: (data: unknown, actions: { reject?: () => unknown } | undefined) => unknown;
  createOrder: () => Promise<string>;
  onApprove: (data: { orderID: string }) => Promise<void>;
  onError: (err: unknown) => void;
  onCancel: () => void;
};

function harness() {
  const configs: ButtonsConfig[] = [];
  const orderBodies: unknown[] = [];
  (globalThis as unknown as { fetch: unknown }).fetch = (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/billing/paypal/order")) {
      orderBodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(new Response(JSON.stringify({ orderId: "X" }), { status: 200 }));
    }
    if (u.includes("/api/billing/paypal/capture")) return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    return Promise.resolve(new Response("{}", { status: 200 })); // /api/emotes and anything else
  };
  return {
    configs,
    orderBodies,
    installPaypalGlobal(venmoEligible: boolean) {
      (window as unknown as { paypal: unknown }).paypal = {
        FUNDING: { PAYPAL: "paypal", VENMO: "venmo" },
        Buttons: (config: ButtonsConfig) => ({
          // Pushed only on an actual render call — a venmo-eligibility probe
          // (TipPayButton's own venmoEligible() calls) never renders, so it
          // must never be mistaken for the one real button mount.
          render: () => { configs.push(config); },
          close: () => {},
          isEligible: () => venmoEligible,
        }),
      };
    },
  };
}

function scriptTag(): HTMLScriptElement | null {
  return dom.window.document.querySelector('script[src*="paypal.com/sdk/js"]');
}

test.beforeEach(() => {
  resetStorage();
  delete (window as unknown as { paypal?: unknown }).paypal;
  scriptTag()?.remove();
  // The SDK load state is module-shared now (fix round 1, review finding 1)
  // — reset it between tests the same way PayPalButton.render.test.ts does.
  _resetPaypalSdkForTests();
});

function mountPoints(over: Record<string, unknown> = {}) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  const props = {
    purpose: "points" as const, amount: 5, busy: false, disabledCard: false, valid: true,
    getDraft: () => ({ amount: 5, message: "", displayName: "", anonymous: false, announce: false }),
    paypalClientId: "cid", locked: false, onLockChange: () => {}, onCardSubmit: () => {}, onPaypalCaptured: () => {},
    ...over,
  };
  act(() => root.render(React.createElement(TipPayButton, props)));
  return { host, unmount: () => { act(() => root.unmount()); host.remove(); } };
}

test("points: the card half reads 'Buy 500 points' in gold, and the ▾ matches it", () => {
  harness();
  const m = mountPoints();
  const main = [...m.host.querySelectorAll("button")].find((b) => /^Buy /.test(b.textContent ?? ""))!;
  assert.equal(main.textContent, "Buy 500 points");
  assert.ok(main.className.includes("bg-yellow-500"), main.className);
  const toggle = m.host.querySelector('button[aria-label="Choose how to pay"]') as HTMLButtonElement;
  assert.ok(toggle.className.includes("bg-yellow-500"), toggle.className);
  m.unmount();
});

test("points: an invalid amount shows 'Buy  points' with no number, like today's Store", () => {
  harness();
  const m = mountPoints({ valid: false, amount: 0, disabledCard: true });
  assert.ok([...m.host.querySelectorAll("button")].some((b) => b.textContent === "Buy  points"));
  m.unmount();
});

test("points: busy reads 'Starting checkout…'", () => {
  harness();
  const m = mountPoints({ busy: true });
  assert.ok([...m.host.querySelectorAll("button")].some((b) => b.textContent === "Starting checkout…"));
  m.unmount();
});

test("points: a PayPal order posts purpose 'points' and the amount — no message, name or anonymous flag", async () => {
  const h = harness();
  dom.window.localStorage.setItem("bb_tipMethod", "paypal"); // before mounting: PayPal preselected
  const m = mountPoints();
  await act(async () => {}); // flush the mount effect that reads the stored method
  const script = scriptTag();
  await act(async () => {
    h.installPaypalGlobal(true);
    script!.dispatchEvent(new dom.window.Event("load"));
  });
  assert.equal(h.configs.length, 1, "vacuity anchor: the real PayPal button was never rendered");
  act(() => { h.configs[0]!.onClick(undefined, {}); });
  await act(async () => { await h.configs[0]!.createOrder(); });
  // fundingSource names the pressed button: the order's payment_source (NO_SHIPPING lives there).
  assert.deepEqual(h.orderBodies[0], { purpose: "points", amount: 5, fundingSource: "paypal" });
  assert.ok(m.host.textContent!.includes("Buying 500 points via PayPal"));
  m.unmount();
});

// While the capture POST is in flight, PayPalButton's busy line must read from
// the `purpose` PROP (not the ref used inside the SDK callbacks) — "Confirming
// your purchase…" for points, never the tip copy.
test("points: while capture is pending, the busy line reads 'Confirming your purchase…', never 'tip'", async () => {
  const h = harness();
  dom.window.localStorage.setItem("bb_tipMethod", "paypal");
  const m = mountPoints();
  await act(async () => {});
  const script = scriptTag();
  await act(async () => {
    h.installPaypalGlobal(true);
    script!.dispatchEvent(new dom.window.Event("load"));
  });
  assert.equal(h.configs.length, 1, "vacuity anchor: the real PayPal button was never rendered");
  act(() => { h.configs[0]!.onClick(undefined, {}); });
  await act(async () => { await h.configs[0]!.createOrder(); });
  // Replace fetch so the capture call never resolves — the busy state must
  // stay up long enough to read it.
  (globalThis as unknown as { fetch: unknown }).fetch = (url: unknown) => {
    const u = String(url);
    if (u.includes("/api/billing/paypal/capture")) return new Promise(() => {}); // never resolves
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  act(() => { void h.configs[0]!.onApprove({ orderID: "X" }); });
  const busyLine = [...m.host.querySelectorAll("p")].find((p) => p.textContent?.includes("Confirming"));
  assert.equal(busyLine?.textContent, "Confirming your purchase…");
  assert.ok(!busyLine?.textContent?.toLowerCase().includes("tip"));
  m.unmount();
});

// A 401 from the order route must show the server's own response text, same
// shape as the existing 400 branch — falling into the generic "Something went
// wrong" message drops a sign-in prompt the server wrote on purpose.
test("points: a 401 from the order route shows the server's own message, not the generic one", async () => {
  const h = harness();
  (globalThis as unknown as { fetch: unknown }).fetch = (url: unknown) => {
    const u = String(url);
    if (u.includes("/api/billing/paypal/order")) {
      return Promise.resolve(new Response("Sign in to buy points", { status: 401 }));
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  dom.window.localStorage.setItem("bb_tipMethod", "paypal");
  const m = mountPoints();
  await act(async () => {});
  const script = scriptTag();
  await act(async () => {
    h.installPaypalGlobal(true);
    script!.dispatchEvent(new dom.window.Event("load"));
  });
  assert.equal(h.configs.length, 1, "vacuity anchor: the real PayPal button was never rendered");
  act(() => { h.configs[0]!.onClick(undefined, {}); });
  await act(async () => {
    await assert.rejects(() => h.configs[0]!.createOrder());
  });
  assert.ok(m.host.textContent!.includes("Sign in to buy points"));
  m.unmount();
});
