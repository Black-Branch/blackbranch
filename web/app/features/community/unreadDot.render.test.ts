// Community › Channel list › Unread channels › "Number on mentions" (client polish Task 8, F8):
// Discord's red number on the channel and on the server icon, offered as a third value beside
// Dots and Counts. It is the default since 2026-11-06 (k's word, the ADR 0116 exception); a stored
// choice still wins. The real UnreadDot, and the real SpacesRail
// with the setting stored the way the settings panel stores it.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G npx tsx --test app/features/community/unreadDot.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { dom, React, act, resetStorage } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";
const { UnreadDot } = await import("./parts.tsx");
const { SpacesRail } = await import("./SpacesRail.tsx");
const { readValues, ENTRIES } = await import("../../lib/settingsRegistry.ts");
const { createRoot } = await import("react-dom/client");

async function mount(el: React.ReactElement) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(el); });
  return {
    host,
    rerender: (next: React.ReactElement) => act(async () => { root.render(next); }),
    unmount: () => act(async () => { root.unmount(); host.remove(); }),
  };
}

const dot = (p: Record<string, unknown>) => React.createElement(UnreadDot as never, p);
const noop = () => {};
const rail = (homeUnreads: { total: number; highlight: number }) => React.createElement(SpacesRail as never, {
  servers: [], activeId: "space", homeUnreads, canAddSpace: false,
  onSelectHome: noop, onSelectServer: noop, onAddSpace: noop, rooms: [], myUserId: "@me:site.test",
  onOpenRoomThreads: noop, onOpenSettings: noop, hideUserButton: true,
});
const store = (v: string | null) => {
  if (v === null) dom.window.localStorage.removeItem("chatStyle_mxUnread");
  else dom.window.localStorage.setItem("chatStyle_mxUnread", v);
  dom.window.dispatchEvent(new dom.window.CustomEvent("bb:setting", { detail: "chatStyle_mxUnread" }));
};

test("mentions mode + highlight 3 → rose '3'", async () => {
  const m = await mount(dot({ total: 5, highlight: 3, mode: "mentions" }));
  const el = m.host.firstElementChild as HTMLElement;
  assert.equal(el.textContent, "3");
  assert.match(el.className, /bg-rose-500/);
  assert.equal(el.hasAttribute("data-unread-dot"), false, "a mention is about you: Unread dots off never hides it");
  await m.unmount();
});

test("mentions mode + total 5, highlight 0 → dot", async () => {
  const m = await mount(dot({ total: 5, highlight: 0, mode: "mentions", className: "w-1.5 h-1.5" }));
  const el = m.host.firstElementChild as HTMLElement;
  assert.equal(el.textContent, "", "a plain unread draws no number");
  assert.match(el.className, /bg-accent/);
  assert.match(el.className, /w-1\.5 h-1\.5/, "the dot keeps the caller's size");
  assert.equal(el.hasAttribute("data-unread-dot"), true, "the blue dot still obeys Behavior › Unread dots");
  await m.unmount();
});

test("dots mode + highlight 3 → dot (UnreadDot's own prop default)", async () => {
  for (const mode of ["dots", undefined]) {
    const m = await mount(dot({ total: 5, highlight: 3, mode, className: "w-1.5 h-1.5" }));
    const el = m.host.firstElementChild as HTMLElement;
    assert.equal(el.textContent, "", `mode ${mode}: no number`);
    assert.match(el.className, /bg-rose-500/, `mode ${mode}: the mention dot is rose, as today`);
    assert.match(el.className, /w-1\.5 h-1\.5/);
    await m.unmount();
  }
});

test("counts mode is as before: the mention count in rose, else the unread count", async () => {
  const m = await mount(dot({ total: 7, highlight: 0, mode: "counts" }));
  assert.equal(m.host.textContent, "7");
  await m.rerender(dot({ total: 7, highlight: 2, mode: "counts" }));
  assert.equal(m.host.textContent, "2");
  assert.match((m.host.firstElementChild as HTMLElement).className, /bg-rose-500/);
  await m.rerender(dot({ total: 0, highlight: 0, mode: "mentions" }));
  assert.equal(m.host.firstElementChild, null, "nothing unread draws nothing");
  await m.unmount();
});

test("rail pill carries pillClassName", async () => {
  const m = await mount(dot({ total: 4, highlight: 1, mode: "mentions", className: "w-2.5 h-2.5", pillClassName: "absolute -bottom-1 -right-1" }));
  const el = m.host.firstElementChild as HTMLElement;
  assert.equal(el.textContent, "1");
  assert.match(el.className, /absolute -bottom-1 -right-1/);
  assert.doesNotMatch(el.className, /w-2\.5/, "a dot's size never reaches the pill");
  await m.unmount();
});

test("registry parses 'mentions'; the default is 'mentions' (k, 2026-11-06); a stored choice still wins", () => {
  resetStorage();
  assert.equal(readValues().mxUnread, "mentions", "nothing stored = Number on mentions");
  store("dots");
  assert.equal(readValues().mxUnread, "dots", "a viewer who chose Dots keeps Dots");
  store("counts");
  assert.equal(readValues().mxUnread, "counts");
  resetStorage();
  assert.equal(ENTRIES.mxUnread.parse("mentions"), "mentions");
  assert.equal(ENTRIES.mxUnread.parse("counts"), "counts");
  assert.equal(ENTRIES.mxUnread.parse("bogus"), null);
  const control = ENTRIES.mxUnread.control;
  assert.ok(control && control.kind === "choice", "Unread channels is a choice");
  assert.deepEqual(control.options.map((o) => [o.value, o.label]), [["dots", "Dots"], ["mentions", "Number on mentions"], ["counts", "Counts"]]);
  assert.equal(ENTRIES.mxUnread.prePaint, false);
});

// The tile button clips (overflow-hidden) and the mark sits on its corner: inside the button the dot
// showed only a sliver on the phone (look/08-mentions.mjs, 2026-11-06). Every mark sits on the wrapper.
const tileMark = (host: HTMLElement) => {
  const tile = host.querySelector('button[title="Home — Direct Messages"]') as HTMLElement;
  const mark = [...host.querySelectorAll(".bg-rose-500, .bg-accent")].find((e) => e.classList.contains("absolute")) as HTMLElement | undefined;
  return { tile, mark };
};

test("the space tile, nothing stored + a mention → the rose number (the default since 2026-11-06)", async () => {
  resetStorage();
  const m = await mount(rail({ total: 4, highlight: 2 }));
  assert.ok([...m.host.querySelectorAll(".bg-rose-500")].some((e) => e.textContent === "2"), "a fresh viewer sees the mention count");
  await m.unmount();
  resetStorage();
});

test("the space tile: Dots chosen + a mention → a rose dot, no number, outside the clipping button", async () => {
  resetStorage();
  store("dots");
  const m = await mount(rail({ total: 1, highlight: 1 }));
  const { tile, mark } = tileMark(m.host);
  assert.ok(mark, "the rose dot is drawn");
  assert.match(mark.className, /bg-rose-500/);
  assert.equal(mark.textContent, "");
  assert.match(mark.className, /w-2\.5 h-2\.5/, "the dot's size, as before");
  assert.equal(tile.contains(mark), false, "not clipped by the tile button");
  assert.ok(mark.parentElement?.contains(tile), "on the tile's own wrapper");
  await m.unmount();
});

test("the space tile: 'Number on mentions' → a rose '1' outside the clipped tile", async () => {
  resetStorage();
  store("mentions");
  const m = await mount(rail({ total: 3, highlight: 1 }));
  const tile = m.host.querySelector('button[title="Home — Direct Messages"]') as HTMLElement;
  const pill = [...m.host.querySelectorAll(".bg-rose-500")].find((e) => e.textContent === "1") as HTMLElement | undefined;
  assert.ok(pill, "the rose number is drawn");
  assert.equal(tile.contains(pill), false, "the tile button clips (overflow-hidden); the pill sits on its wrapper");
  assert.ok(pill.parentElement?.contains(tile), "the pill sits beside the tile, in the tile's own wrapper");
  assert.match(pill.className, /absolute/);
  await m.unmount();
  resetStorage();
});

test("restart: a stored 'Number on mentions' is read back on a fresh mount; a plain unread stays a dot", async () => {
  resetStorage();
  dom.window.localStorage.setItem("chatStyle_mxUnread", "mentions");
  const m = await mount(rail({ total: 6, highlight: 0 }));
  const { tile, mark } = tileMark(m.host);
  assert.equal(m.host.textContent?.includes("6"), false, "no number for a plain unread");
  assert.ok(mark && /bg-accent/.test(mark.className), "the blue dot");
  assert.equal(tile.contains(mark), false);
  await m.unmount();
  resetStorage();
});

test("retry: switching back to Dots draws the dot again, live", async () => {
  resetStorage();
  store("mentions");
  const m = await mount(rail({ total: 2, highlight: 2 }));
  assert.ok([...m.host.querySelectorAll(".bg-rose-500")].some((e) => e.textContent === "2"), "the number first");
  await act(async () => { store("dots"); });
  assert.equal([...m.host.querySelectorAll(".bg-rose-500")].some((e) => e.textContent !== ""), false, "no number after the switch");
  const { mark } = tileMark(m.host);
  assert.ok(mark && /bg-rose-500/.test(mark.className) && mark.textContent === "", "the rose dot is back");
  await m.unmount();
  resetStorage();
});
