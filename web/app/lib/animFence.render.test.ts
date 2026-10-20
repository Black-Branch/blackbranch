// The fence by RUNNING it: a fake IntersectionObserver delivers the entries the browser would.
// The case that matters is the EDGE TOUCH — IO reports a zero-area touch as
// `isIntersecting: true` with ratio 0, which is exactly the Home tab's hidden chat pane (x =
// its scroll container's clip edge), so every row there would keep animating.
//
// A census scan below pins that every component rendering a styled (animated) name outside the
// chat row also fences it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { dom, mountHook } from "./testDom.ts";
import { stripComments } from "./testSource.ts";

type Entry = { target: Element; isIntersecting: boolean; intersectionRatio: number };
let lastIO: { cb: (e: Entry[]) => void; opts: { threshold?: number[] } | undefined; observed: Set<Element> } | null = null;
class FakeIO {
  observed = new Set<Element>();
  constructor(cb: (e: Entry[]) => void, opts?: { threshold?: number[] }) { lastIO = { cb, opts, observed: this.observed }; }
  observe(el: Element) { this.observed.add(el); }
  unobserve(el: Element) { this.observed.delete(el); }
  disconnect() { this.observed.clear(); }
}
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIO;
const { useAnimFence, useAnimFenceRef } = await import("./animFence.ts");

test("an edge touch (intersecting, ratio 0) is OFF screen; a real sliver is on; unmount clears the mark", async () => {
  const el = dom.window.document.createElement("div");
  const h = await mountHook(() => useAnimFence({ current: el }, true));
  assert.ok(lastIO, "no observer was made");
  assert.deepEqual(lastIO!.opts?.threshold, [0, 0.001], "a 0-only threshold never re-fires on 0 → >0");
  const fire = (isIntersecting: boolean, intersectionRatio: number) => lastIO!.cb([{ target: el, isIntersecting, intersectionRatio }]);
  fire(true, 0);
  assert.equal(el.hasAttribute("data-anim-off"), true, "the hidden pane's edge touch must pause");
  fire(true, 0.002);
  assert.equal(el.hasAttribute("data-anim-off"), false);
  fire(false, 0);
  assert.equal(el.hasAttribute("data-anim-off"), true);
  await h.unmount();
  assert.equal(el.hasAttribute("data-anim-off"), false, "an unmounted fence leaves no pause behind");
});

test("the ref form marks the element itself, runs the element's other ref, and only while active", async () => {
  const doc = dom.window.document;
  const box = doc.createElement("div");
  const el = doc.createElement("span");
  box.appendChild(el);
  const seen: Array<Element | null> = [];
  const also = (x: HTMLElement | null) => { seen.push(x); };
  const on = await mountHook(() => useAnimFenceRef(true, also));
  const cleanup = on.current(el as HTMLElement);
  assert.deepEqual(seen, [el], "the composed ref (useNameInk) still runs");
  assert.equal(lastIO!.observed.has(box), true, "the name's box (its parent) is what is observed");
  lastIO!.cb([{ target: box, isIntersecting: false, intersectionRatio: 0 }]);
  assert.equal(el.hasAttribute("data-anim-off"), true, "the NAME carries the mark");
  assert.equal(box.hasAttribute("data-anim-off"), false, "the parent is only the measuring stick");
  lastIO!.cb([{ target: box, isIntersecting: true, intersectionRatio: 1 }]);
  assert.equal(el.hasAttribute("data-anim-off"), false);
  (cleanup as () => void)();
  assert.equal(lastIO!.observed.has(box), false);
  assert.equal(el.hasAttribute("data-anim-off"), false);
  const off = await mountHook(() => useAnimFenceRef(false, also));
  const el2 = doc.createElement("span");
  assert.equal(off.current(el2 as HTMLElement), undefined, "a static name is not observed");
  assert.equal(lastIO!.observed.has(el2), false);
});

// Type in starts at clip-path inset(... 100% ...): the name's own clip is zero-area, and the browser
// reports a target clipped by its OWN clip-path exactly like an edge touch (intersecting, ratio 0 —
// measured in Chromium). Observing the name itself therefore paused the entrance on its first
// frame, which then kept the area at zero: the name stayed invisible for good (the Home tab's own
// card, the leaderboard, the pinned banner). The fence measures the name's parent box instead.
test("an entrance's own zero-area first frame cannot pause it: the observed box is not the clipped name", async () => {
  const doc = dom.window.document;
  const box = doc.createElement("div");
  const name = doc.createElement("span");
  name.style.setProperty("clip-path", "inset(-0.5em 100% -0.5em -0.5em)");
  box.appendChild(name);
  const on = await mountHook(() => useAnimFenceRef(true));
  const cleanup = on.current(name as HTMLElement);
  assert.equal(lastIO!.observed.has(name), false, "the clipped name itself is observed — its own clip reads as off-screen");
  lastIO!.cb([{ target: box, isIntersecting: true, intersectionRatio: 1 }]);
  assert.equal(name.hasAttribute("data-anim-off"), false);
  (cleanup as () => void)();
});

test("two names in one box share the observation; removing one keeps the other fenced", async () => {
  const doc = dom.window.document;
  const box = doc.createElement("div");
  const a = doc.createElement("span"), b = doc.createElement("span");
  box.append(a, b);
  const on = await mountHook(() => useAnimFenceRef(true));
  const ca = on.current(a as HTMLElement) as () => void;
  const cb = on.current(b as HTMLElement) as () => void;
  lastIO!.cb([{ target: box, isIntersecting: false, intersectionRatio: 0 }]);
  assert.equal(a.hasAttribute("data-anim-off") && b.hasAttribute("data-anim-off"), true);
  ca();
  assert.equal(lastIO!.observed.has(box), true, "the box was unobserved while another name still needs it");
  lastIO!.cb([{ target: box, isIntersecting: true, intersectionRatio: 1 }]);
  assert.equal(b.hasAttribute("data-anim-off"), false);
  cb();
  assert.equal(lastIO!.observed.has(box), false);
});

test("CSS pauses the fenced element ITSELF as well as its descendants", () => {
  const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
  assert.match(css, /\[data-anim-off\]\.un-anim[\s\S]{0,40}\{ animation-play-state: paused !important; \}/);
});

test("census: every component that renders a styled name outside chat rows also fences it", () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".tsx") && !p.includes(".test.")) files.push(p); } };
  walk(join(process.cwd(), "app"));
  assert.ok(files.length > 100, `read only ${files.length} .tsx files — the walk is broken and this would pass vacuously`);
  const users = files.filter((f) => stripComments(readFileSync(f, "utf8")).includes("usernameStyleAnimClass("));
  assert.ok(users.length >= 6, `found ${users.length} styled-name renderers — expected the 6 known ones`);
  for (const f of users) {
    const src = stripComments(readFileSync(f, "utf8"));
    assert.match(src, /useAnimFence(Ref)?\(/, `${f} renders an animated name style with no off-screen fence`);
  }
});
