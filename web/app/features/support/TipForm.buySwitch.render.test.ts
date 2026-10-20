// The buy switch (`currency.purchasable`) as a tipper meets it: with buying OFF the
// form has no Announce switch — every submit is a tip, never a quiet purchase. A real mount fed
// the store table the way /api/store/prices answers.
// Run: node --test app/features/support/TipForm.buySwitch.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";

let purchasable = false;
(globalThis as unknown as { fetch: unknown }).fetch = (url: unknown) => {
  const body = String(url).includes("/api/store/prices")
    ? { prices: { sticker: 25 }, e: 45, purchasable, clockMultiplier: 2 }
    : {};
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
};

const { TipForm } = await import("./TipForm.tsx");
const { refreshStorePrices } = await import("../../lib/useStorePrices.ts");
const { createRoot } = await import("react-dom/client");

async function mount() {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(TipForm, { busy: false, signedIn: true, initialName: "", onSubmit: () => {}, initialAnnounce: false }));
    await new Promise((r) => setTimeout(r, 20)); // the store table's read lands
  });
  return { host, unmount: () => { act(() => root.unmount()); host.remove(); } };
}
const sw = (host: HTMLElement) => host.querySelector('button[role="switch"][aria-label="Announce on stream"]');
const buttons = (host: HTMLElement) => [...host.querySelectorAll("button")].map((b) => b.textContent ?? "").join(" | ");

test("buying OFF: no Announce switch, and even the Store's quiet start submits a TIP", async () => {
  const m = await mount();
  try {
    assert.equal(sw(m.host), null, "no switch to turn a tip into a purchase");
    assert.match(buttons(m.host), /Tip \$5/);
    assert.doesNotMatch(buttons(m.host), /Buy /);
  } finally { m.unmount(); }
});

test("buying ON: the switch is back and the Store starts quiet", async () => {
  purchasable = true;
  await act(async () => { refreshStorePrices(); await new Promise((r) => setTimeout(r, 20)); });
  const m = await mount();
  try {
    assert.ok(sw(m.host), "the switch renders when points can be bought");
    assert.match(buttons(m.host), /Buy 500 points/);
  } finally { m.unmount(); }
});
