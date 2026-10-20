// TipPayButton, exercised through the real TipForm it renders inside. A real
// mount, not a source scan: the point is the whole split button's OBSERVABLE
// behaviour — what shows with no PayPal configured, what the ▾ menu offers and
// when, which method a returning tipper sees first, and that a live PayPal
// order actually locks every other control on the form, not just the ones
// TipPayButton itself owns.
//
// window.paypal is never real in this harness — each test drives the SDK
// script's load event by hand and installs a fake global whose `Buttons()`
// answers `isEligible()` for the venmo-eligibility probe (TipPayButton calls
// this on every render while the SDK is ready) and captures the config ONLY
// when something actually calls `.render(el)` on it — the real render call
// PayPalButton makes, as opposed to the (never-rendered) eligibility probe.
//
// Run: node --test app/features/support/TipPayButton.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act, resetStorage } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";

const { TipForm } = await import("./TipForm.tsx");
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
  (globalThis as unknown as { fetch: unknown }).fetch = (url: unknown) => {
    const u = String(url);
    if (u.includes("/api/billing/paypal/order")) return Promise.resolve(new Response(JSON.stringify({ orderId: "X" }), { status: 200 }));
    if (u.includes("/api/billing/paypal/capture")) return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    return Promise.resolve(new Response("{}", { status: 200 })); // /api/emotes and anything else
  };
  return {
    configs,
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

function mount(props: Partial<Parameters<typeof TipForm>[0]> = {}) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  const defaults: Parameters<typeof TipForm>[0] = { busy: false, signedIn: true, initialName: "", onSubmit: () => {} };
  act(() => root.render(React.createElement(TipForm, { ...defaults, ...props })));
  return {
    host,
    rerender: (next: Partial<Parameters<typeof TipForm>[0]>) =>
      act(() => root.render(React.createElement(TipForm, { ...defaults, ...next }))),
    unmount: () => { act(() => root.unmount()); host.remove(); },
  };
}

function submitButton(host: HTMLElement) {
  return [...host.querySelectorAll("button")].find((b) => /^(Tip \$|Starting)/.test(b.textContent ?? "")) as HTMLButtonElement;
}

function toggleButton(host: HTMLElement) {
  return host.querySelector('button[aria-label="Choose how to pay"]') as HTMLButtonElement | null;
}

function menuItems(host: HTMLElement) {
  return [...host.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent?.trim() ?? "");
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

test("no paypalClientId → no ▾ at all, and the button reads exactly \"Tip $5\"", () => {
  harness();
  const m = mount({ paypalClientId: null });
  assert.ok(!toggleButton(m.host), "the ▾ must not render when PayPal isn't configured");
  assert.equal(submitButton(m.host).textContent, "Tip $5");
  m.unmount();
});

test("undefined paypalClientId (prop simply omitted) behaves the same as null", () => {
  harness();
  const m = mount({});
  assert.ok(!toggleButton(m.host));
  assert.equal(submitButton(m.host).textContent, "Tip $5");
  m.unmount();
});

test("with a paypalClientId, the ▾ lists Card and PayPal; Venmo only once the SDK is loaded AND eligible", async () => {
  const h = harness();
  const m = mount({ paypalClientId: "cid" });
  // No "via Card": Stripe's box also offers Apple Pay, Google Pay, Link,
  // Cash App and Amazon Pay — the menu row names the range instead.
  assert.equal(submitButton(m.host).textContent, "Tip $5", "the card-path label must not claim it is card-only");
  const toggle = toggleButton(m.host);
  assert.ok(toggle, "the ▾ must render when paypalClientId is set");
  assert.ok(toggle!.className.includes("bg-emerald-500"), "with Card chosen the ▾ must match the emerald button");
  act(() => { toggle!.click(); });

  let items = menuItems(m.host);
  assert.ok(items.some((t) => t.startsWith("Card, Apple Pay & more")), `expected a "Card, Apple Pay & more" row, got: ${items.join(", ")}`);
  assert.ok(items.some((t) => t.startsWith("PayPal")), `expected a PayPal row, got: ${items.join(", ")}`);
  assert.ok(!items.some((t) => t.startsWith("Venmo")), "Venmo must not show before the SDK is ready");

  const script = scriptTag();
  assert.ok(script, "opening the ▾ menu must start loading the PayPal SDK");
  await act(async () => {
    h.installPaypalGlobal(true);
    script!.dispatchEvent(new dom.window.Event("load"));
  });
  items = menuItems(m.host);
  assert.ok(items.some((t) => t.startsWith("Venmo")), `Venmo should show once the SDK is ready and eligible, got: ${items.join(", ")}`);
  m.unmount();
});

test("Venmo stays off the menu once the SDK is ready but reports ineligible", async () => {
  const h = harness();
  const m = mount({ paypalClientId: "cid" });
  act(() => { toggleButton(m.host)!.click(); });
  const script = scriptTag();
  await act(async () => {
    h.installPaypalGlobal(false);
    script!.dispatchEvent(new dom.window.Event("load"));
  });
  const items = menuItems(m.host);
  assert.ok(!items.some((t) => t.startsWith("Venmo")), `Venmo must not show when ineligible, got: ${items.join(", ")}`);
  m.unmount();
});

test("a remembered \"paypal\" preference preselects PayPal, not Card, on mount", async () => {
  harness();
  dom.window.localStorage.setItem("bb_tipMethod", "paypal");
  const m = mount({ paypalClientId: "cid" });
  await act(async () => {}); // flush the mount effect that reads the stored method
  assert.ok(m.host.textContent?.includes("Tipping $5 via PayPal"), `expected the PayPal half to show, got: ${m.host.textContent}`);
  assert.ok(!submitButton(m.host), "the Card submit button must not render while paypal is selected");
  // The ▾ wears the colour of the button beside it.
  const cls = toggleButton(m.host)!.className;
  assert.ok(cls.includes("bg-paypal") && !cls.includes("bg-emerald-500"), `the ▾ must be PayPal gold beside the PayPal button, got: ${cls}`);
  m.unmount();
});

test("the remembered method is applied when paypalClientId arrives AFTER mount — the Support panel's own shape (starts null, fills in once its config fetch resolves)", async () => {
  harness();
  dom.window.localStorage.setItem("bb_tipMethod", "paypal");
  const m = mount({ paypalClientId: null });
  assert.equal(submitButton(m.host)?.textContent, "Tip $5", "sanity: no client id yet — plain card label, no ▾");

  m.rerender({ paypalClientId: "cid" });
  await act(async () => {}); // flush the effect's microtask defer

  assert.ok(
    m.host.textContent?.includes("Tipping $5 via PayPal"),
    `expected the remembered PayPal preference to apply once the id arrived, got: ${m.host.textContent}`,
  );
  m.unmount();
});

test("...unless the person already picked something from the menu themselves before the stored preference lands", async () => {
  harness();
  dom.window.localStorage.setItem("bb_tipMethod", "paypal");
  const m = mount({ paypalClientId: null });

  // The id arrives, and — in the same tick, before the stored-preference
  // microtask has a chance to run — the person picks Card from the ▾.
  m.rerender({ paypalClientId: "cid" });
  const toggle = toggleButton(m.host);
  assert.ok(toggle, "vacuity anchor: no ▾ after the id arrived");
  act(() => { toggle!.click(); });
  const cardRow = [...m.host.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent?.trim().startsWith("Card"));
  assert.ok(cardRow, "vacuity anchor: no Card row in the menu");
  act(() => { (cardRow as HTMLButtonElement).click(); });

  await act(async () => {}); // let the stored-preference microtask try to run

  assert.equal(
    submitButton(m.host)?.textContent,
    "Tip $5",
    "a choice made before the stored preference lands must win — the late arrival must not stomp it",
  );
  m.unmount();
});

test("a remembered \"venmo\" preference that turns out ineligible falls back to paypal", async () => {
  const h = harness();
  dom.window.localStorage.setItem("bb_tipMethod", "venmo");
  const m = mount({ paypalClientId: "cid" });
  await act(async () => {}); // the mount effect must start loading the SDK for a stored non-card method
  const script = scriptTag();
  assert.ok(script, "a stored non-card method must start loading the SDK at mount, not wait for the ▾ to open");
  await act(async () => {
    h.installPaypalGlobal(false); // venmo NOT eligible
    script!.dispatchEvent(new dom.window.Event("load"));
  });
  assert.ok(m.host.textContent?.includes("Tipping $5 via PayPal"), `an ineligible remembered venmo must fall back to paypal, got: ${m.host.textContent}`);
  assert.ok(!m.host.textContent?.includes("via Venmo"));
  m.unmount();
});

test("a remembered \"venmo\" preference that IS eligible stays on Venmo", async () => {
  const h = harness();
  dom.window.localStorage.setItem("bb_tipMethod", "venmo");
  const m = mount({ paypalClientId: "cid" });
  await act(async () => {});
  const script = scriptTag();
  await act(async () => {
    h.installPaypalGlobal(true);
    script!.dispatchEvent(new dom.window.Event("load"));
  });
  assert.ok(m.host.textContent?.includes("Tipping $5 via Venmo"), `expected Venmo to stay selected, got: ${m.host.textContent}`);
  const cls = toggleButton(m.host)!.className;
  assert.ok(cls.includes("bg-venmo") && !cls.includes("bg-paypal"), `the ▾ must be Venmo blue beside the Venmo button, got: ${cls}`);
  m.unmount();
});

test("while a PayPal order is locked, every TipForm control — presets, custom amount, name, message, anonymous box, and the ▾ — is disabled, and the lock line shows", async () => {
  const h = harness();
  dom.window.localStorage.setItem("bb_tipMethod", "paypal");
  const m = mount({ paypalClientId: "cid", initialName: "Ada" });
  await act(async () => {});
  const script = scriptTag();
  await act(async () => {
    h.installPaypalGlobal(true);
    script!.dispatchEvent(new dom.window.Event("load"));
  });
  assert.equal(h.configs.length, 1, "vacuity anchor: the real PayPal button was never rendered — nothing below would prove anything");

  assert.ok(!m.host.textContent?.includes("Finish in the PayPal window"), "sanity: not locked yet");
  act(() => { h.configs[0]!.onClick(undefined, {}); });
  assert.ok(m.host.textContent?.includes("Finish in the PayPal window — the amount is locked until you do."), "the lock line must show once locked");

  const presets = [...m.host.querySelectorAll("button")].filter((b) => /^\$\d+$/.test(b.textContent ?? ""));
  assert.ok(presets.length === 4, `vacuity anchor: expected 4 preset buttons, found ${presets.length}`);
  for (const p of presets) assert.equal((p as HTMLButtonElement).disabled, true, `preset ${p.textContent} should be disabled while locked`);

  const custom = m.host.querySelector('input[placeholder="Other"]') as HTMLInputElement;
  assert.equal(custom.disabled, true, "the custom amount box should be disabled while locked");

  const name = m.host.querySelector('input[aria-label="Your name"]') as HTMLInputElement;
  assert.equal(name.disabled, true, "the name box should be disabled while locked");

  const textarea = m.host.querySelector("textarea") as HTMLTextAreaElement;
  assert.equal(textarea.disabled, true, "the message box should be disabled while locked");

  const checkbox = m.host.querySelector('input[type="checkbox"]') as HTMLInputElement;
  assert.equal(checkbox.disabled, true, "the anonymous checkbox should be disabled while locked");

  const toggle = toggleButton(m.host);
  assert.ok(toggle, "vacuity anchor: the ▾ disappeared entirely instead of being disabled");
  assert.equal(toggle!.disabled, true, "the ▾ should be disabled while locked");

  m.unmount();
});

test("the ▾ is opened, the SDK script fails to load, THEN PayPal is chosen — must show the failed-load message and a retry button, never spin on \"Loading PayPal…\" forever", async () => {
  harness();
  const m = mount({ paypalClientId: "cid" });
  const toggle = toggleButton(m.host);
  assert.ok(toggle, "vacuity anchor: the ▾ never rendered");
  act(() => { toggle!.click(); }); // opens the ▾ menu — starts loading the SDK per Ruling 3/TipPayButton's openMenu()
  const script = scriptTag();
  assert.ok(script, "vacuity anchor: opening the ▾ must start loading the SDK");

  // The SDK is ad-blocked — and it fails BEFORE PayPal is ever chosen, the
  // exact ordering the reviewer's probe reproduced: a <script> fires `error`
  // exactly once, so whoever attaches listeners AFTER this point must still
  // be able to learn the outcome.
  await act(async () => { script!.dispatchEvent(new dom.window.Event("error")); });

  // NOW choose PayPal from the still-open menu — this is the moment
  // PayPalButton actually mounts, strictly after the script had already
  // failed.
  const paypalRow = [...m.host.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent?.trim().startsWith("PayPal"));
  assert.ok(paypalRow, "vacuity anchor: no PayPal row in the menu");
  act(() => { (paypalRow as HTMLButtonElement).click(); });

  assert.ok(
    m.host.textContent?.includes("We couldn’t load PayPal."),
    `expected the failed-load message even though PayPalButton mounted after the failure, got: ${m.host.textContent}`,
  );
  assert.ok(
    !m.host.textContent?.includes("Loading PayPal…"),
    "must not be stuck showing the loading spinner forever — the SDK already failed before PayPalButton even mounted",
  );
  const retryButton = [...m.host.querySelectorAll("button")].find((b) => /try again/i.test(b.textContent ?? ""));
  assert.ok(retryButton, "a failed load must offer a retry button, even when PayPalButton mounted AFTER the failure");
  m.unmount();
});

test("a cancelled PayPal popup unlocks the form again", async () => {
  const h = harness();
  dom.window.localStorage.setItem("bb_tipMethod", "paypal");
  const m = mount({ paypalClientId: "cid" });
  await act(async () => {});
  const script = scriptTag();
  await act(async () => {
    h.installPaypalGlobal(true);
    script!.dispatchEvent(new dom.window.Event("load"));
  });
  act(() => { h.configs[0]!.onClick(undefined, {}); });
  assert.ok(m.host.textContent?.includes("Finish in the PayPal window"));

  act(() => { h.configs[0]!.onCancel(); });
  assert.ok(!m.host.textContent?.includes("Finish in the PayPal window"), "a cancelled popup must unlock the form");
  const presets = [...m.host.querySelectorAll("button")].filter((b) => /^\$\d+$/.test(b.textContent ?? ""));
  for (const p of presets) assert.equal((p as HTMLButtonElement).disabled, false, "controls must re-enable once unlocked");
  m.unmount();
});
