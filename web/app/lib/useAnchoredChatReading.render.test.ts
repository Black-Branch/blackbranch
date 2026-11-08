// useAnchoredChat — the READING position (#240, #241). While the reader is scrolled up, the
// row under their eye (the one crossing the middle of the list) keeps its place through
// a width change (the dual panel's dividers, a window resize: every row above re-wraps),
// a row above it growing (a reaction, a picture loading), and new lines arriving. At the
// bottom the view stays at the bottom.
//
// Measured before the fix on the throwaway pair (look/240-position.mjs): dragging the
// Live | Matrix divider moved the row under the eye by up to 393 px in Chromium and 606 px
// in Firefox — the browser's own scroll anchoring holds the TOP row, so everything the
// re-wrap adds between the top and the eye pushes the eye's row down.
//
// jsdom lays nothing out, so this file carries a tiny layout model: each row's height is
// its text's line count at the list's width, rows stack in DOM order, and the scroller
// clamps scrollTop to its range the way a browser does.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G node --test app/lib/useAnchoredChatReading.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "./testDom.ts";
import { installResizeObserverStub } from "./testTsx.ts";
import { useAnchoredChat } from "./useAnchoredChat.ts";

const ro = installResizeObserverStub();
const { createRoot } = await import("react-dom/client");

const LINE = 20;
const CHAR = 8;
const ROWS = "[data-event-id]";

type Layout = { width: number; clientH: number; scrollTop: number; extra: Map<string, number> };

/** Text length of row i: a mix of one-liners and long lines that re-wrap. */
const lenOf = (key: string) => [12, 90, 30, 160, 8, 60, 220][Number(key.slice(1)) % 7]!;

function rowHeight(L: Layout, key: string) {
  return LINE * Math.max(1, Math.ceil((lenOf(key) * CHAR) / L.width)) + (L.extra.get(key) ?? 0);
}

async function mountList(opts: { count?: number; width?: number; clientH?: number; selector?: string | null } = {}) {
  const L: Layout = { width: opts.width ?? 600, clientH: opts.clientH ?? 600, scrollTop: 0, extra: new Map() };
  const items = { current: Array.from({ length: opts.count ?? 80 }, (_, i) => `r${i}`) };
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  let content: HTMLElement | null = null;
  let scroller: HTMLElement | null = null;
  const rowsTop = () => {
    // Offsets in DOM order — the browser's stacking.
    const tops = new Map<Element, number>();
    let y = 0;
    for (const r of content ? Array.from(content.children) : []) {
      tops.set(r, y);
      y += rowHeight(L, r.getAttribute("data-event-id") ?? "");
    }
    return { tops, total: y };
  };
  const maxTop = () => Math.max(0, rowsTop().total - L.clientH);
  const latest: { current: ReturnType<typeof useAnchoredChat<string>> | null } = { current: null };
  function Host() {
    const t = useAnchoredChat<string>({
      items: items.current,
      getKey: (s) => s,
      ...(opts.selector === null ? {} : { anchorRows: opts.selector ?? ROWS }),
    });
    latest.current = t;
    return React.createElement("div", {
      ref: (el: HTMLDivElement | null) => {
        if (el && el !== scroller) {
          scroller = el;
          Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => rowsTop().total });
          Object.defineProperty(el, "clientHeight", { configurable: true, get: () => L.clientH });
          Object.defineProperty(el, "clientWidth", { configurable: true, get: () => L.width });
          Object.defineProperty(el, "scrollTop", {
            configurable: true,
            get: () => L.scrollTop,
            set: (v: number) => { L.scrollTop = Math.max(0, Math.min(maxTop(), v)); },
          });
          el.getBoundingClientRect = () => ({ top: 0, bottom: L.clientH, left: 0, right: L.width, width: L.width, height: L.clientH, x: 0, y: 0, toJSON() {} }) as DOMRect;
        }
        (t.scrollRef as { current: HTMLDivElement | null }).current = el;
      },
      onScroll: t.onScroll,
    }, React.createElement("div", {
      ref: (el: HTMLDivElement | null) => {
        content = el;
        (t.contentRef as { current: HTMLDivElement | null }).current = el;
      },
    }, t.rendered.map((k) => React.createElement("div", {
      key: k,
      "data-event-id": k,
      ref: (el: HTMLDivElement | null) => {
        if (!el) return;
        el.getBoundingClientRect = () => {
          const top = (rowsTop().tops.get(el) ?? 0) - L.scrollTop;
          const h = rowHeight(L, k);
          return { top, bottom: top + h, left: 0, right: L.width, width: L.width, height: h, x: 0, y: top, toJSON() {} } as DOMRect;
        };
      },
    }, k))));
  }
  await act(async () => { root.render(React.createElement(Host)); });
  await act(async () => { await Promise.resolve(); });
  const t = () => latest.current!;
  const el = () => scroller!;
  /** The row crossing the middle of the list, and its offset from the list's top. */
  const eye = () => {
    const mid = L.clientH / 2;
    for (const r of Array.from(content!.children)) {
      const b = r.getBoundingClientRect();
      if (b.top <= mid && b.bottom >= mid) return { key: r.getAttribute("data-event-id")!, off: b.top };
    }
    return null;
  };
  const offOf = (key: string) => content!.querySelector(`[data-event-id="${key}"]`)!.getBoundingClientRect().top;
  /** The reader wheels up `px` (a gesture: wheel event, then the scroll it causes). */
  const wheelUp = (px: number) => act(async () => {
    el().dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -px }));
    el().scrollTop = L.scrollTop - px;
    el().dispatchEvent(new dom.window.Event("scroll"));
  });
  /** A layout change the browser makes: new geometry, then its resize observers and scroll event. */
  const relayout = (change: () => void) => act(async () => {
    const before = L.scrollTop;
    change();
    L.scrollTop = Math.max(0, Math.min(maxTop(), L.scrollTop)); // the browser's clamp
    ro.fire();
    if (L.scrollTop !== before) el().dispatchEvent(new dom.window.Event("scroll"));
  });
  /**
   * The browser's own scroll anchoring acts first: it keeps the TOP row in place by moving
   * scrollTop during layout, and that scroll event reaches the engine before any resize
   * observer does.
   */
  const relayoutNativeFirst = (change: () => void) => act(async () => {
    const topRow = Array.from(content!.children).find((r) => r.getBoundingClientRect().bottom > 0)!;
    const was = topRow.getBoundingClientRect().top;
    change();
    L.scrollTop = Math.max(0, Math.min(maxTop(), L.scrollTop + topRow.getBoundingClientRect().top - was));
    el().dispatchEvent(new dom.window.Event("scroll"));
    ro.fire();
  });
  /** An app-driven scroll (no gesture window): the write, then the browser's scroll event. */
  const jump = (dy: number) => act(async () => {
    el().scrollTop = L.scrollTop + dy;
    el().dispatchEvent(new dom.window.Event("scroll"));
  });
  const rerender = (next: string[]) => act(async () => {
    items.current = next;
    root.render(React.createElement(Host));
  });
  const unmount = async () => { await act(async () => { root.unmount(); }); host.remove(); };
  return { L, t, el, eye, offOf, wheelUp, jump, relayout, relayoutNativeFirst, rerender, items, maxTop, unmount };
}

const near = (a: number, b: number, msg: string) => assert.ok(Math.abs(a - b) <= 1, `${msg}: ${a} vs ${b}`);

test("#240: a resize with the list scrolled up keeps the row under the eye in place", async () => {
  const m = await mountList();
  assert.equal(m.L.scrollTop, m.maxTop(), "opens at the bottom");
  await m.wheelUp(1500);
  assert.equal(m.t().anchored, false, "precondition: reading, not following");
  const eye = m.eye()!;
  for (const w of [560, 480, 400, 330, 420, 600, 720]) {
    await m.relayout(() => { m.L.width = w; });
    near(m.offOf(eye.key), eye.off, `width ${w}: the row under the eye stays where it was`);
  }
  await m.unmount();
});

test("#241: a row above the eye growing (a reaction, a picture) keeps the row in place", async () => {
  const m = await mountList();
  await m.wheelUp(1500);
  const eye = m.eye()!;
  const idx = Number(eye.key.slice(1));
  // One far above the view, one in view above the eye.
  for (const k of [`r${idx - 20}`, `r${idx - 1}`]) {
    await m.relayout(() => { m.L.extra.set(k, 28); });
    near(m.offOf(eye.key), eye.off, `${k} grew 28 px: the row under the eye stays`);
  }
  await m.unmount();
});

test("#241: new lines arriving while scrolled up do not move the row under the eye", async () => {
  const m = await mountList();
  await m.wheelUp(1500);
  const eye = m.eye()!;
  for (let i = 0; i < 3; i++) {
    await m.rerender([...m.items.current, `n${i}`]);
    near(m.offOf(eye.key), eye.off, `new line ${i + 1}`);
  }
  assert.equal(m.t().queued, 3, "the new lines wait behind the pill");
  await m.unmount();
});

test("at the bottom a resize stays at the bottom (the bottom lock is untouched)", async () => {
  const m = await mountList();
  for (const w of [420, 300, 700]) {
    await m.relayout(() => { m.L.width = w; });
    assert.equal(m.t().anchored, true);
    assert.equal(m.L.scrollTop, m.maxTop(), `width ${w}: still at the newest line`);
  }
  await m.rerender([...m.items.current, "n0"]);
  assert.equal(m.L.scrollTop, m.maxTop(), "a new line at the bottom is followed");
  await m.unmount();
});

test("restart: a fresh mount opens at the bottom, and its first read holds its own row — nothing carried over", async () => {
  const first = await mountList();
  await first.wheelUp(1500);
  await first.unmount();
  const m = await mountList();
  assert.equal(m.t().anchored, true, "a new mount follows the newest line");
  await m.relayout(() => { m.L.width = 350; });
  assert.equal(m.L.scrollTop, m.maxTop(), "and holds the bottom through a resize");
  await m.wheelUp(900);
  const eye = m.eye()!;
  await m.relayout(() => { m.L.width = 600; });
  near(m.offOf(eye.key), eye.off, "the new mount's own reading row holds");
  await m.unmount();
});

test("retry: dragging back and forth twice ends exactly where it started, and a new scroll moves what is held", async () => {
  const m = await mountList();
  await m.wheelUp(1500);
  const start = { top: m.L.scrollTop, eye: m.eye()! };
  for (let round = 0; round < 2; round++) {
    for (const w of [500, 400, 320, 400, 500, 600]) await m.relayout(() => { m.L.width = w; });
    near(m.offOf(start.eye.key), start.eye.off, `round ${round + 1}: the row is where it was`);
    near(m.L.scrollTop, start.top, `round ${round + 1}: no drift accumulates`);
  }
  // The reader scrolls on: the next resize holds the NEW row, never yanks back to the old one.
  await m.wheelUp(700);
  const next = m.eye()!;
  assert.notEqual(next.key, start.eye.key, "precondition: a different row is under the eye now");
  await m.relayout(() => { m.L.width = 380; });
  near(m.offOf(next.key), next.off, "the row the reader moved to is the one held");
  await m.unmount();
});

test("a programmatic scroll (a jump, a page key) moves what is held too", async () => {
  const m = await mountList();
  await m.wheelUp(1500);
  // No gesture window: the app (or PgUp) writes scrollTop, the browser fires a scroll event.
  await new Promise((r) => setTimeout(r, 160));
  await m.jump(-500);
  const eye = m.eye()!;
  await m.relayout(() => { m.L.width = 360; });
  near(m.offOf(eye.key), eye.off, "the row the jump brought under the eye is held");
  await m.unmount();
});

test("the browser's own anchoring moving first (its scroll event before the resize observer) is undone, not adopted", async () => {
  const m = await mountList();
  await m.wheelUp(1500);
  const eye = m.eye()!;
  for (const w of [480, 360, 600]) {
    await m.relayoutNativeFirst(() => { m.L.width = w; });
    near(m.offOf(eye.key), eye.off, `width ${w}: the eye's row, not the top row, is the one held`);
  }
  await m.unmount();
});

test("retry: a held row that stops crossing the middle after a restore is still the one held on the way back", async () => {
  const m = await mountList();
  await m.wheelUp(1500);
  const mid = m.L.clientH / 2;
  // A tall row under the eye (a picture), its top 200 px above the middle.
  const r1 = m.eye()!.key;
  await m.relayout(() => { m.L.extra.set(r1, 400); });
  await m.jump(m.offOf(r1) - (mid - 200));
  assert.equal(m.eye()!.key, r1, "precondition: the tall row is under the eye");
  near(m.offOf(r1), mid - 200, "precondition: its top 200 px above the middle");
  // Narrower (rows above re-wrap: the restore writes scrollTop) and the picture gone: the row
  // is now short and ends above the middle.
  await m.relayout(() => { m.L.width = 400; m.L.extra.delete(r1); });
  near(m.offOf(r1), mid - 200, "held through the change");
  assert.notEqual(m.eye()!.key, r1, "precondition: it no longer crosses the middle");
  await m.relayout(() => { m.L.width = 600; m.L.extra.set(r1, 400); });
  near(m.offOf(r1), mid - 200, "the same row is held on the way back — no drift to its neighbour");
  await m.unmount();
});

test("a list without row anchors keeps the old behaviour (live chat opts in separately)", async () => {
  const m = await mountList({ selector: null });
  await m.wheelUp(1500);
  const top = m.L.scrollTop;
  await m.relayout(() => { m.L.width = 360; });
  assert.equal(m.L.scrollTop, top, "no anchor rows: the engine does not move a paused list");
  await m.unmount();
});
