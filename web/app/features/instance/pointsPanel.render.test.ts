// Admin Panel → Site → Points, mounted: Store prices is a table of PRICES, edited as prices; the
// earn rates stay on their own card; what a typical viewer earns per stream is a line of
// information, with nothing to type and no button that moves every price.
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/features/instance/pointsPanel.render.test.ts
import "../../lib/testInstallValues.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";
const { default: PointsPanel, streamsForPrice } = await import("./PointsPanel.tsx");
const { buildInstanceView } = await import("../../lib/instanceAdminView.ts");
const { createRoot } = await import("react-dom/client");

const table = { rows: [{ itemKey: "sticker", baseStreams: 0.5, price: 100 }, { itemKey: "tts", baseStreams: 2, price: 400 }], e: 200 };
let sent: { url: string; method: string; body: unknown }[] = [];
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  sent.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
  const body = String(url) === "/api/admin/points" ? table : { ok: true, from: 100, to: 150 };
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

async function mount() {
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(React.createElement(PointsPanel as never, { inst: buildInstanceView(null), reloadInst: () => {}, note: () => {} })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return { el, done: async () => { await act(async () => { root.unmount(); el.remove(); }); } };
}

test("a typed price is stored as streams of earning at today's rate", () => {
  assert.equal(streamsForPrice(150, 200), 0.75);
  assert.equal(streamsForPrice(100, 300), 0.333);
});

test("Store prices: each row is its price, saved as that price; the typical earning is information only", async () => {
  const { el, done } = await mount();
  const card = el.querySelector('section[aria-label="Store prices"]')!;
  assert.ok(card.querySelector("[data-typical]")?.textContent?.includes("per stream"));
  assert.equal(card.querySelectorAll("[data-typical] input, [data-typical] button").length, 0);
  assert.equal([...card.querySelectorAll("button")].filter((b) => /Preview|Apply/.test(b.textContent ?? "")).length, 0, "nothing moves every price at once");
  const sticker = card.querySelector('[data-item="sticker"] input') as HTMLInputElement;
  assert.equal(sticker.value, "100", "the row starts from its price, not its streams");
  sent = [];
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(sticker, "150");
    sticker.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await act(async () => { card.querySelector('[data-item="sticker"] form')!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
  assert.deepEqual(sent[0], { url: "/api/admin/points/prices/sticker", method: "PUT", body: { baseStreams: 0.75 } });
  await done();
});
