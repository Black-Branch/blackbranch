// The phone tab strip never shows a one-letter tab, a faint tail, or a blank hole (client polish Task 5b, rounds 1–2).
//
// At 390 px the chat top bar's strip holds less than its tabs need. The old strip
// let the last tab run under the edge fade to "S›". Round 0 hid any tab that was
// not whole, which left a ~100 px blank stretch and hid Matrix at rest — worse.
// Round 1 let tabs peek again but missed a label STARTING inside the fade ramp
// (two unread dots put Stream's "S" there) and the start side's "‹e". The rule now:
//   - tabs that do not fit PEEK under the fade (nothing is hidden);
//   - the list SNAPS to item starts, and every chevron press / selection reveal
//     lands on one of those rest positions;
//   - a label touching either fade band that cannot show three characters clear
//     of it — measured on its GLYPHS — is covered completely by a hard mask stop;
//   - the chat bar's "+" is the list's last item, so at 390 px Home, Live and
//     Matrix are whole at rest;
//   - the "‹"/"›" are 40 px touch boxes laid OVER the strip's faded edges.
//
// jsdom has no layout: this checks the real chrome.css, drives a mounted strip
// whose layout (boxes AND glyphs) is stubbed from the pair's measurements
// (look/05b-glyphs.mjs), and scans the wiring. The pixel proof is the Look
// (look/05b-strip.mjs).
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/components/chrome/stripWhole.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dom, React, act } from "../../lib/testDom.ts";
import { stripComments, stripCssComments, cssAtRuleBodies } from "../../lib/testSource.ts";
import { installResizeObserverStub } from "../../lib/testTsx.ts";

const ro = installResizeObserverStub();
const { Sections } = await import("./Sections.tsx");
const { createRoot } = await import("react-dom/client");

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

// jsdom applies no rule inside @layer, so the layer's BODY goes in (one layer — barButtonTouch.render.test.ts pins that).
const css = stripCssComments(read("./chrome.css"));
const style = dom.window.document.createElement("style");
style.textContent = cssAtRuleBodies(css, "@layer components").join("\n");
dom.window.document.head.appendChild(style);

// The pair at 390 px, default tabs: Home · Live · Matrix · Stream and the "+", in a 274 px strip
// (362 bar − 44 lead − 44 trail; the derivation is in stripOverflow.test.ts).
type Key = "home" | "live" | "matrix" | "stream";
const NAMES: Record<Key, string> = { home: "Home", live: "Live", matrix: "Matrix", stream: "Stream" };
const KEYS: Key[] = ["home", "live", "matrix", "stream"];
const TAB_W: Record<Key, number> = { home: 69, live: 57, matrix: 72, stream: 79 };
// Glyph edges from each tab's left (measured: a Range per character, 14 px Geist).
const GLYPHS: Record<Key, number[]> = {
  home: [14, 24, 33, 45, 54], live: [14, 21, 25, 33, 42], matrix: [14, 26, 33, 39, 45, 48, 57], stream: [14, 23, 29, 34, 43, 51, 64],
};
const DOT = 14; // an unread dot: .5rem + the .375rem gap
const CW = 274, PLUS_W = 40;

// The layout of the CURRENT mount: tab starts and widths, given which tabs carry a dot.
const lay = { x: [] as number[], w: [] as number[], plus: 0, sw: 0 };
function layout(dots: Key[]) {
  let at = 0;
  lay.x = []; lay.w = [];
  for (const k of KEYS) { const w = TAB_W[k] + (dots.includes(k) ? DOT : 0); lay.x.push(at); lay.w.push(w); at += w; }
  lay.plus = at; lay.sw = at + PLUS_W;
}
const max = () => lay.sw - CW;

// A layout that MOVES with scrollLeft, installed before mount so the first commit already measures it.
const geo = { scrollLeft: 0 };
const scrolls: number[] = [];
const proto = dom.window.HTMLElement.prototype;
const rect = (left: number, width: number) => ({ left, width, right: left + width, top: 0, bottom: 36, height: 36, x: left, y: 0, toJSON() {} });
const isScroller = (el: HTMLElement) => el.classList.contains("chrome-sections");
const tabIndex = (el: Element) => { const tab = el.closest('[role="tab"]')!; return Array.from(tab.parentElement!.children).indexOf(tab); };
Object.defineProperty(proto, "getBoundingClientRect", { configurable: true, value(this: HTMLElement) {
  if (this.getAttribute("role") === "tab") { const i = tabIndex(this); return rect(lay.x[i]! - geo.scrollLeft, lay.w[i]!); }
  if (this.classList.contains("chrome-sections-trail")) return rect(lay.plus - geo.scrollLeft, PLUS_W);
  if (isScroller(this)) return rect(0, CW);
  return rect(0, 0);
} });
// The glyphs: a Range over a label's text measures its letters, not its box.
Object.defineProperty(dom.window.Range.prototype, "getBoundingClientRect", { configurable: true, value(this: Range) {
  const i = tabIndex(this.startContainer.parentElement!);
  const g = GLYPHS[KEYS[i]!]!;
  return rect(lay.x[i]! + g[this.startOffset]! - geo.scrollLeft, g[this.endOffset]! - g[this.startOffset]!);
} });
Object.defineProperty(proto, "clientWidth", { configurable: true, get(this: HTMLElement) { return isScroller(this) ? CW : 0; } });
Object.defineProperty(proto, "scrollWidth", { configurable: true, get(this: HTMLElement) { return isScroller(this) ? lay.sw : 0; } });
Object.defineProperty(proto, "scrollLeft", { configurable: true,
  get(this: HTMLElement) { return isScroller(this) ? geo.scrollLeft : 0; },
  set(this: HTMLElement, v: number) { if (isScroller(this)) geo.scrollLeft = Math.min(Math.max(v, 0), max()); } });
Object.defineProperty(proto, "scrollTo", { configurable: true, value(o: { left: number }) { scrolls.push(o.left); } });
// The stubs shadow the prototypes' own; removing them restores jsdom's.
test.after(() => {
  for (const k of ["getBoundingClientRect", "clientWidth", "scrollWidth", "scrollLeft", "scrollTo"]) delete (proto as unknown as Record<string, unknown>)[k];
  delete (dom.window.Range.prototype as unknown as Record<string, unknown>).getBoundingClientRect;
});

async function mount(value: Key, dots: Key[] = []) {
  layout(dots);
  geo.scrollLeft = 0;
  scrolls.length = 0;
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  const trail = React.createElement("button", { type: "button", "aria-label": "Add a tab" }, "+");
  // The real markup: an unread tab renders Sections' own dot after its label.
  const items = KEYS.map((key) => ({ key, label: NAMES[key], dot: dots.includes(key) }));
  const render = (v: Key) => act(async () => {
    root.render(React.createElement(Sections, { items, value: v, onChange: () => {}, label: "Chat sections", trail }));
  });
  await render(value);
  await act(async () => { ro.fire(); });
  const scroller = host.querySelector<HTMLElement>(".chrome-sections")!;
  const wrap = host.querySelector<HTMLElement>(".chrome-sections-wrap")!;
  const tabs = Array.from(scroller.querySelectorAll<HTMLElement>('[role="tab"]'));
  const scroll = (left: number) => act(async () => { geo.scrollLeft = left; scroller.dispatchEvent(new dom.window.Event("scroll")); });
  const stops = () => Object.fromEntries(["start-t", "start-o", "end-t", "end-o"].map((k) => [k, wrap.style.getPropertyValue(`--strip-${k}`)]));
  return { host, wrap, scroller, tabs, scroll, render, stops, unmount: () => act(async () => { root.unmount(); host.remove(); }) };
}

const shown = (el: HTMLElement) => dom.window.getComputedStyle(el).opacity !== "0" && dom.window.getComputedStyle(el).visibility !== "hidden";

test("the real chrome.css: the strip snaps to item starts 40 px in, nothing in it is ever hidden, the chevrons are 40 px boxes over its edges", async () => {
  const m = await mount("home");
  const list = dom.window.getComputedStyle(m.scroller);
  assert.equal(list.scrollSnapType, "x mandatory");
  assert.equal(list.getPropertyValue("scroll-padding-inline"), "40px", "a rest position puts an item's start just clear of the ‹ box");
  for (const t of m.tabs) assert.equal(dom.window.getComputedStyle(t).getPropertyValue("scroll-snap-align"), "start", `${t.textContent} snaps at its start`);
  const trail = m.scroller.querySelector<HTMLElement>(".chrome-sections-trail")!;
  assert.equal(dom.window.getComputedStyle(trail).getPropertyValue("scroll-snap-align"), "start", "the + is a rest position too, so the end is reachable");
  // The hole: no rule may hide a tab — a hidden tab left a blank stretch in the strip.
  assert.doesNotMatch(css, /\.chrome-tab\[data-cut\]/, "no data-cut rule");
  assert.doesNotMatch(css.match(/\.chrome-sections \.chrome-tab \{[^}]*\}/)?.[0] ?? "", /opacity/, "the strip's tab rule never touches opacity");
  for (const side of ["start", "end"]) {
    const c = m.host.querySelector<HTMLElement>(`.chrome-more-${side}`)!;
    const cs = dom.window.getComputedStyle(c);
    assert.equal(cs.position, "absolute", `the ${side} chevron is laid over the strip, not beside it — it takes no strip width`);
    assert.equal(cs.width, "40px", `the ${side} chevron is a 40 px touch box`);
    assert.equal(cs.top, "0px");
    assert.equal(cs.bottom, "0px", "and the strip's full height (36 px in a bar)");
  }
  await m.unmount();
});

test("the + scrolls with the tabs as the list's last item, outside the tablist", async () => {
  const m = await mount("home");
  const tablist = m.scroller.querySelector<HTMLElement>('[role="tablist"]')!;
  assert.ok(tablist && tablist.parentElement === m.scroller, "the tablist sits inside the scroller");
  assert.ok(Array.from(tablist.children).every((c) => c.getAttribute("role") === "tab"), "a tablist owns only tabs");
  const trail = m.scroller.lastElementChild as HTMLElement;
  assert.ok(trail.classList.contains("chrome-sections-trail") && trail.querySelector('[aria-label="Add a tab"]'), "the + is the scroller's last item");
  await m.unmount();
});

test("at rest on the default phone: Home, Live and Matrix whole and clear of the ›; Stream peeks with three clear letters; nothing hidden", async () => {
  const m = await mount("home");
  assert.equal(m.wrap.dataset.more, "end");
  const list = m.scroller.getBoundingClientRect();
  for (const t of m.tabs.slice(0, 3)) {
    const r = t.getBoundingClientRect();
    assert.ok(r.left >= list.left && r.right <= list.right - 40, `${t.textContent} is whole, clear of the › box`);
  }
  for (const t of m.tabs) assert.ok(shown(t), `${t.textContent} is shown`);
  // "Str" ends at 232, before the band at 234: the standard ramp ("Strea›").
  assert.deepEqual(m.stops(), { "start-t": "20px", "start-o": "40px", "end-t": "20px", "end-o": "40px" });
  await m.unmount();
});

test("two unread dots (Live and Matrix, both lit during a stream): Stream's label starts inside the ramp and is covered from its first letter", async () => {
  const m = await mount("home", ["live", "matrix"]);
  assert.equal(m.tabs[1]!.querySelector(".chrome-tab-dot") !== null && m.tabs[2]!.querySelector(".chrome-tab-dot") !== null, true, "the real dot markup");
  // Stream's label: 226 + 14 = 240 — inside 234…254. The old rule left "S›"; now 274 − 240 = 34 px is transparent.
  assert.equal(m.stops()["end-t"], "34px");
  assert.equal(m.stops()["end-o"], "34px", "one hard stop: the whole sliver, not a ramp over it");
  // Matrix (140…226) and its dot stay clear: the stop is at 240, past them.
  await m.unmount();
});

test("one unread dot: Stream's first three letters would cross the band, so it is covered from 226", async () => {
  const m = await mount("home", ["live"]);
  assert.equal(m.stops()["end-o"], `${CW - 226}px`);
  await m.unmount();
});

test("the start side mirrored: at Live's rest Home's tail beside the ‹ is covered through its last letter", async () => {
  const m = await mount("home");
  await m.scroll(29);
  assert.equal(m.wrap.dataset.more, "both");
  // Home's glyphs end at 54: 25 px in, under the 20→40 ramp ("‹e"). Covered: 0…25 transparent.
  assert.equal(m.stops()["start-t"], "25px");
  assert.equal(m.stops()["start-o"], "25px");
  await m.scroll(max());
  // At the end (43): Home's glyphs end 11 px in (already transparent) and Live's last three start 47 px in,
  // clear of the band — the standard fade. (The five-tab end, where Live's tail WOULD show, is in stripOverflow.test.ts.)
  assert.equal(m.stops()["start-o"], "40px");
  assert.equal(m.stops()["end-o"], "40px", "and no end fade to move at the end");
  await m.unmount();
});

test("no hole: every position the strip moves itself to (› ‹ presses, selection reveals) is filled edge to edge with what it measured", async () => {
  for (const dots of [[], ["live"], ["live", "matrix"]] as Key[][]) {
    const m = await mount("home", dots);
    const targets = new Set<number>([0]);
    // › and ‹ from wherever the strip is, to the end and back.
    for (const dir of [1, -1]) {
      for (let press = 0; press < 6; press++) {
        const btn = m.host.querySelector<HTMLButtonElement>(dir === 1 ? ".chrome-more-end" : ".chrome-more-start")!;
        await act(async () => { btn.click(); });
        const t = scrolls.at(-1)!;
        targets.add(t);
        await m.scroll(t);
      }
    }
    // Every selection's reveal, from the start.
    for (const k of KEYS) { await m.scroll(0); await m.render(k); targets.add(geo.scrollLeft); }
    for (const t of targets) {
      await m.scroll(t);
      assert.ok(t >= 0 && t <= max(), `dots ${dots}: ${t} is inside the scroll range`);
      const boxes = [...m.tabs, m.scroller.querySelector<HTMLElement>(".chrome-sections-trail")!].map((e) => e.getBoundingClientRect()).sort((a, b) => a.left - b.left);
      // The items the strip measured cover its box with no gap: no unused width at this position.
      let reach = boxes[0]!.left;
      assert.ok(reach <= 0, `dots ${dots}, at ${t}: nothing blank at the start`);
      for (const b of boxes) { assert.ok(b.left <= reach + 0.5, `dots ${dots}, at ${t}: no gap before ${b.left}`); reach = Math.max(reach, b.right); }
      assert.ok(reach >= CW, `dots ${dots}, at ${t}: the items reach the strip's end (${reach})`);
      for (const tab of m.tabs) assert.ok(shown(tab), `dots ${dots}, at ${t}: ${tab.textContent} shown`);
    }
    await m.unmount();
  }
});

test("the selected tab is scrolled into full view when it changes", async () => {
  const m = await mount("home");
  await m.render("stream");
  assert.equal(geo.scrollLeft, max(), "selecting Stream moves the strip to show it whole");
  await m.render("home");
  assert.equal(geo.scrollLeft, 0, "back to Home: the start");
  await m.render("matrix");
  assert.equal(geo.scrollLeft, 0, "Matrix is already whole at the start: no move");
  await m.unmount();
});

test("restart: a fresh strip with the last tab selected opens showing it", async () => {
  const m = await mount("stream");
  assert.equal(geo.scrollLeft, max(), "the first commit already revealed the selected tab");
  await m.unmount();
});

test("retry: a second › from the same place asks for the same rest position, and a press at the end asks for nothing new", async () => {
  const m = await mount("home");
  const fwd = m.host.querySelector<HTMLButtonElement>(".chrome-more-end")!;
  await act(async () => { fwd.click(); fwd.click(); });
  assert.deepEqual(scrolls, [max(), max()], "the target depends on where the strip is, not on how often it was pressed");
  await m.scroll(max());
  await act(async () => { fwd.click(); });
  assert.equal(scrolls.at(-1), max(), "at the end › stays at the end");
  await m.unmount();
});

test("wiring: the selection effect reveals through revealTarget, the chevrons page through pageTarget, the fades come from fadeCovers on glyphs", () => {
  const src = stripComments(read("./Sections.tsx"));
  const effectB = src.match(/useLayoutEffect\(\(\) => \{[\s\S]*?\}, \[active, progress, keySig, band\]\);/)?.[0] ?? "";
  assert.ok(effectB.length > 200, "found effect B (the selection effect)");
  assert.match(effectB, /revealTarget\(spansOf\(list, items\(list\)\), active, /, "the active tab's change calls the into-view helper");
  assert.match(effectB, /list\.scrollLeft = target;/, "and moves the list to its answer");
  const effectA = src.match(/useLayoutEffect\(\(\) => \{[\s\S]*?\}, \[keySig\]\);/)?.[0] ?? "";
  assert.match(effectA, /fadeCovers\(labelsOf\(list\), /, "every scroll / resize re-places both fades");
  assert.match(effectA, /setProperty\(`--strip-\$\{side\}-t`, /);
  assert.match(effectA, /setProperty\(`--strip-\$\{side\}-o`, /);
  assert.match(src, /function labelsOf[\s\S]*?document\.createRange\(\)[\s\S]*?range\.getBoundingClientRect\(\)/, "labels are measured on their glyphs (a Range), not their box");
  assert.doesNotMatch(src, /dataset\.cut|wholeTabs|endFade/, "nothing hides a tab; no one-sided fade rule left");
  assert.match(src, /const page = \(dir: 1 \| -1\) => \{[\s\S]*?pageTarget\(spansOf\(list, items\(list\)\), [\s\S]*?list\.scrollTo\(\{ left: /, "a chevron press pages to a rest position");
  assert.doesNotMatch(src, /scrollBy\(/, "no fixed-width page step left behind");
  // Vacuity anchor at the END of the scanned file: the strip's real tail.
  assert.match(src, /\{trail && <div className="chrome-sections-trail">\{trail\}<\/div>\}\s*<\/div>\s*<button[^>]*chrome-more-start[\s\S]*?<\/button>\s*<button[^>]*chrome-more-end[\s\S]*?<\/button>\s*<\/div>\s*\);\s*\}\s*$/, "the scan read Sections.tsx to its end");
});
