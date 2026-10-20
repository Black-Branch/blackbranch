// The split header paints a hole per pane, in BAND space, and clears both on
// unmount — the Console language must not go dark when the panel splits.
//
// Six things a source scan cannot see, and one mount can:
//
// 1. BOTH holes at once. Panes hands the Band a two-box list, so --ind-x/--ind-w
//    AND --ind-x2/--ind-w2 are live together and BOTH caps are lit. Panes is
//    the one consumer that fills the second slot, so "the second layer exists"
//    and "a consumer can open it" are two different claims.
// 2. BAND space, not group space. A `Bar band` puts the Band around the whole
//    strip, so the leading slot sits inside it, before the pane headers. A
//    measurement taken against the GROUP would put both holes 8px to the left
//    of their panes and every line of the effect would still read correctly.
//    The fixture stubs the group's own rect for exactly that reason — leave
//    it at jsdom's zero and both spaces answer the same, and the claim is empty.
// 3. --chrome-panes-offset, the distance the first cell subtracts so the
//    header's split line lands on the real divider. It is MEASURED (and only
//    after the band frame's ref is attached, which is the ResizeObserver's
//    first delivery), so only a mount can say whether it is published at all.
// 4. A two-box paint followed by a ONE-box paint closes slot 2. Unsplitting
//    swaps this header back for a single Sections; a Band that only ever WROTE
//    the second slot would leave that hole punched and cap B lit over a strip
//    with one tab. (The swap also runs Panes' unmount cleanup on the way, so
//    what this pins is the END STATE of the whole sequence — which is the
//    user-visible thing — not that one paint in isolation did it.)
// 5. The offset is CONSUMED: cell 1's inline width subtracts it. Publishing
//    the variable and using it are separate claims — the paint assertions
//    stay green with the style prop deleted, because the fixture stubs rects.
// 6. The observer watches the CELLS. A divider drag resizes cell 1 with no
//    re-render, so the holes follow the finger only if the cells themselves
//    are observed — group-only observation passes every paint assertion here.
//
// The .tsx loader, the recording ResizeObserver and the rect stubber live in
// ../testTsx.ts, so this file is only its own fixture and assertions. Importing
// it is what arms the loader, which is why the components below are dynamic
// imports.
//
// Run: node --test app/lib/chrome/panes.render.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../testDom.ts";
import { installResizeObserverStub, fakeLayout } from "../testTsx.ts";
import type { PaneDef } from "@/app/components/chrome/Panes";

const ro = installResizeObserverStub();
const { Bar } = await import("@/app/components/chrome/Bar");
const { Panes } = await import("@/app/components/chrome/Panes");
const { Sections } = await import("@/app/components/chrome/Sections");

type Key = "live" | "matrix";

const PANES: readonly [PaneDef<Key>, PaneDef<Key>] = [
  { key: "live", label: "Live", expandTitle: "Expand live chat" },
  { key: "matrix", label: "Matrix", dot: true, expandTitle: "Expand Matrix" },
];

/**
 * The band frame at 0 (it is the whole bar), the pane GROUP at 8 (the leading
 * slot is that 8px), and the two pane headers at 8 and 308.
 *
 * The group's rect is what makes this fixture discriminate, exactly as the
 * tablist's does in bar.render.test.ts: band space reads 8 / 308, group space
 * reads 0 / 300.
 */
const layout = (container: HTMLElement) =>
  fakeLayout(container, {
    ".chrome-band": { left: 0, width: 600 },
    ".chrome-panes": { left: 8, width: 592 },
    ".chrome-pane > button": (i) => (i === 0 ? { left: 8, width: 40 } : { left: 308, width: 52 }),
  });

test("the split header cuts a hole per pane, in band space, and hands both back on the way out", async () => {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);

  // `string`, not `Key`: `createElement` instantiates a generic component at
  // its CONSTRAINT, so the prop's parameter type here is the constraint —
  // narrowing it in the fixture would only be a cast dressed as a type.
  const expanded: string[] = [];
  const render = (center: ReturnType<typeof React.createElement>) =>
    act(async () => {
      root.render(
        React.createElement(Bar, {
          slot: "top",
          name: "t",
          band: true,
          leading: React.createElement("button", null, "L"),
          center,
        }),
      );
    });

  await render(
    React.createElement(Panes, {
      panes: PANES,
      firstWidth: "50%",
      label: "Split panes",
      onExpand: (k: string) => { expanded.push(k); },
    }),
  );

  // ── Both panes are OPEN: a group of two buttons, never a tab list ────────
  const group = container.querySelector<HTMLElement>('[role="group"]')!;
  assert.ok(group, "the split header is a group");
  assert.equal(group.getAttribute("aria-label"), "Split panes");
  assert.equal(group.className, "chrome-panes");
  assert.equal(container.querySelectorAll('[role="tablist"]').length, 0, "a tablist has exactly one selected tab; both panes are open");
  assert.equal(container.querySelectorAll("[aria-selected]").length, 0, "…and nothing here may claim a selection");

  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>(".chrome-pane > button"));
  assert.equal(buttons.length, 2, "one header per open pane");
  for (const b of buttons) assert.equal(b.hasAttribute("data-open"), true, "open ink without aria-selected");
  assert.equal(buttons[0]!.getAttribute("title"), "Expand live chat", "clicking a pane header EXPANDS that pane");
  assert.equal(buttons[1]!.getAttribute("title"), "Expand Matrix");

  // ── The holes: measured only once the band frame's ref is attached ───────
  const frame = container.querySelector<HTMLElement>(".chrome-band")!;
  const caps = Array.from(container.querySelectorAll<HTMLElement>(".chrome-cap"));
  assert.equal(caps.length, 2, "two caps, one per pane");

  layout(container);
  await act(async () => { ro.fire(); });

  assert.equal(frame.style.getPropertyValue("--ind-x"), "8px", "the first hole is measured in BAND space: the pane at 8, not 0 — the leading slot is inside the band, before the group");
  assert.equal(frame.style.getPropertyValue("--ind-w"), "40px");
  assert.equal(frame.style.getPropertyValue("--ind-x2"), "308px", "…and the SECOND hole is open at the same time, which no consumer before this one did");
  assert.equal(frame.style.getPropertyValue("--ind-w2"), "52px");
  assert.equal(caps[0]!.style.opacity, "0.85", "cap A is lit by the first observation");
  assert.equal(caps[1]!.style.opacity, "0.85", "…and so is cap B");
  assert.equal(
    group.style.getPropertyValue("--chrome-panes-offset"),
    "8px",
    "the first cell subtracts the band-to-group distance, or the header's split line sits a leading slot to the right of the real divider",
  );

  // ── The offset is CONSUMED, not just published (header item 5) ──────────
  const cells = Array.from(container.querySelectorAll<HTMLElement>(".chrome-pane"));
  assert.equal(cells.length, 2);
  assert.equal(
    cells[0]!.style.width,
    "calc(50% - var(--chrome-panes-offset, 0px))",
    "the first cell SUBTRACTS the published offset — publishing alone is a different claim",
  );
  assert.equal(cells[1]!.style.width, "", "the second cell takes the rest");

  // ── Drag-follow: the observer watches the CELLS (header item 6) ─────────
  for (const c of cells) assert.ok(ro.observed.includes(c), "each pane cell is observed, or a divider drag would strand the holes");

  // ── Clicking a pane header expands that pane ────────────────────────────
  await act(async () => {
    buttons[1]!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  assert.deepEqual(expanded, ["matrix"], "the second header expands Matrix");

  // ── Unsplitting: two boxes, then ONE. Slot 2 must close ─────────────────
  await render(
    React.createElement(Sections, {
      items: [{ key: "live", label: "Live" }],
      value: "live",
      onChange: () => {},
      label: "Chat sections",
    }),
  );

  assert.equal(container.querySelector(".chrome-panes"), null, "the split header really did unmount");
  assert.equal(container.querySelector(".chrome-band"), frame, "…and the Band it was painting is the same element, still mounted");

  fakeLayout(container, {
    '[role="tablist"]': { left: 8, width: 592 },
    '[role="tab"]': { left: 8, width: 44 },
  });
  await act(async () => { ro.fire(); });

  assert.equal(frame.style.getPropertyValue("--ind-w"), "44px", "the surviving Sections owns slot 1 now");
  assert.equal(frame.style.getPropertyValue("--ind-w2"), "0px", "and slot 2 is CLOSED — a two-box state followed by a one-box state must not leave the second hole punched");
  assert.equal(caps[0]!.style.opacity, "0.85");
  assert.equal(caps[1]!.style.opacity, "0", "…with cap B put out");

  // ── And nothing at all closes both ──────────────────────────────────────
  await render(React.createElement("div", null, "solo"));

  assert.equal(frame.style.getPropertyValue("--ind-w"), "0px");
  assert.equal(frame.style.getPropertyValue("--ind-w2"), "0px");
  assert.equal(caps[0]!.style.opacity, "0");
  assert.equal(caps[1]!.style.opacity, "0");

  await act(async () => { root.unmount(); });
  container.remove();
});
