// Admin Panel → Utility → OBS's overlay cards, mounted: every overlay stream-api serves is listed
// with its address on THIS install's API host and a copy button that copies exactly that address,
// beside the OBS steps (Browser source, 1920 × 1080). The support bar and the alerts are listed on
// their own settings pages instead; the owner's meter is never listed.
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/features/instance/overlaysPanel.render.test.ts
import "../../lib/testInstallValues.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";
const { default: OverlaysPanel, OverlayAddresses } = await import("./OverlaysPanel.tsx");
const { OVERLAY_SOURCES } = await import("../../lib/overlayDirectory.ts");
const { createRoot } = await import("react-dom/client");

const ELSEWHERE = ["support-bar", "alert"];
const API = OVERLAY_SOURCES.filter((s) => s.served === "stream-api" && s.id !== "meter" && !ELSEWHERE.includes(s.id));

async function mount(go: (id: string) => void = () => {}) {
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(React.createElement(OverlaysPanel as never, { go })); });
  return { el, done: async () => { await act(async () => { root.unmount(); el.remove(); }); } };
}

test("every stream-api overlay of the directory is listed with its address on the install's API host", async () => {
  assert.ok(API.length >= 2, "vacuity: the directory's stream-api overlays were read (poll and sticker at least)");
  const { el, done } = await mount();
  const rows = [...el.querySelectorAll("[data-overlay]")];
  assert.deepEqual(rows.map((r) => r.getAttribute("data-overlay")), API.map((s) => s.id), "one row per overlay, in the directory's order");
  for (const s of API) {
    const row = el.querySelector(`[data-overlay="${s.id}"]`)!;
    assert.equal(row.querySelector("[data-overlay-url]")?.textContent, `https://api.example.tv${s.path}`, s.id);
    assert.ok(row.textContent?.includes(s.name) && row.textContent.includes(s.shows), `${s.id}: its name and what it shows`);
  }
  await done();
});

test("the copy button copies that row's exact address and says so; a refused clipboard says not copied", async () => {
  const copied: string[] = [];
  let refuse = false;
  Object.defineProperty(dom.window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: (t: string) => (refuse ? Promise.reject(new Error("denied")) : (copied.push(t), Promise.resolve())) },
  });
  const { el, done } = await mount();
  const first = API[0]!;
  const btn = el.querySelector(`[data-overlay="${first.id}"] button`) as HTMLButtonElement;
  assert.equal(btn.getAttribute("aria-label"), `Copy the ${first.name} address`);
  await act(async () => { btn.click(); await Promise.resolve(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert.deepEqual(copied, [`https://api.example.tv${first.path}`]);
  assert.equal(btn.textContent, "Copied");
  refuse = true;
  const second = el.querySelector(`[data-overlay="${API[1]!.id}"] button`) as HTMLButtonElement;
  await act(async () => { second.click(); await Promise.resolve(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert.equal(second.textContent, "Not copied");
  await done();
});

test("the OBS steps are on the page: a Browser source, 1920 × 1080, and the way to the support bar's and the alerts' addresses", async () => {
  const opened: string[] = [];
  const { el, done } = await mount((id) => opened.push(id));
  const howto = el.querySelector("[data-overlays-howto]")!;
  assert.match(howto.textContent ?? "", /Sources → \+ → Browser/);
  assert.match(howto.textContent ?? "", /Width 1920, height 1080/);
  for (const [word, place] of [["Support bar", "utility/bar"], ["Effects", "utility/effects"]] as const) {
    const b = [...howto.querySelectorAll("button")].find((x) => x.textContent === word) as HTMLButtonElement;
    await act(async () => { b.click(); });
    assert.equal(opened.at(-1), place);
  }
  await done();
});

test("the support bar's and the alerts' addresses sit beside their own settings; the meter is never listed", async () => {
  const { el, done } = await mount();
  for (const id of [...ELSEWHERE, "meter"]) assert.equal(el.querySelector(`[data-overlay="${id}"]`), null, `${id} is not on the OBS page`);
  await done();
  for (const id of ELSEWHERE) {
    const host = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => { root.render(React.createElement(OverlayAddresses as never, { ids: [id] })); });
    const s = OVERLAY_SOURCES.find((x) => x.id === id)!;
    assert.equal(host.querySelector(`[data-overlay="${id}"] [data-overlay-url]`)?.textContent, `https://api.example.tv${s.path}`);
    await act(async () => { root.unmount(); host.remove(); });
  }
});
