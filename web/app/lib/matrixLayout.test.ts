// Tests for the Matrix UnifiedLayout's pure layout decisions: the visibility
// resolver, the capacity transition, and the
// three inner-pager derivations that read the resolver's output.
//
// All of them govern a large component with many hooks and no other test
// coverage, so these pin the rules that are easiest to break silently and
// hardest to notice: which panels render at each width class, what has to close
// when the width class changes, and which panes the mode-1 swipe row is built
// from. (The pager's WIRING into that component — the row, the commit, the
// enable term — is pinned by app/features/community/matrixPager.test.ts.)
//
// Run: node --test app/lib/matrixLayout.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveVisibility,
  matrixPaneKeys,
  matrixActivePane,
  matrixPagerEnabled,
  type MatrixPaneKey,
} from "./matrixVisibility.ts";
import { resolveCapacityChange } from "./matrixCapacity.ts";

const vis = (over: Partial<Parameters<typeof resolveVisibility>[0]> = {}) =>
  resolveVisibility({
    mode: 2,
    hasSelected: true,
    directoryOpen: false,
    membersOpen: false,
    threadsListOpen: false,
    hasThreadEvent: false,
    ...over,
  });

// ── visibility ───────────────────────────────────────────────────────────────

test("mode 1 shows exactly ONE panel, whatever the combination", () => {
  // The mobile-Discord rule. Any two panels visible at once is the bug.
  const combos = [0, 1].flatMap((d) =>
    [0, 1].flatMap((m) =>
      [0, 1].flatMap((t) =>
        [0, 1].map((th) => ({
          directoryOpen: !!d, membersOpen: !!m, threadsListOpen: !!t, hasThreadEvent: !!th,
        }))
      )
    )
  );
  for (const c of combos) {
    for (const hasSelected of [true, false]) {
      const v = vis({ mode: 1, hasSelected, ...c });
      const shown = Object.values(v).filter(Boolean).length;
      assert.equal(shown, 1, `mode 1 showed ${shown} panels for ${JSON.stringify({ hasSelected, ...c })}`);
    }
  }
});

test("mode 1 with nothing selected falls back to the directory", () => {
  const v = vis({ mode: 1, hasSelected: false });
  assert.equal(v.showDirectory, true);
  assert.equal(v.showTimeline, false, "a timeline with no room selected would be blank");
});

test("mode 1 precedence: directory > thread > threads-list > members > timeline", () => {
  const all = { directoryOpen: true, membersOpen: true, threadsListOpen: true, hasThreadEvent: true };
  assert.equal(vis({ mode: 1, ...all }).showDirectory, true, "directory wins");
  assert.equal(vis({ mode: 1, ...all, directoryOpen: false }).showThread, true, "then thread");
  assert.equal(
    vis({ mode: 1, ...all, directoryOpen: false, hasThreadEvent: false }).showThreadsList,
    true, "then threads-list"
  );
  assert.equal(
    vis({ mode: 1, ...all, directoryOpen: false, hasThreadEvent: false, threadsListOpen: false }).showMembers,
    true, "then members"
  );
});

test("modes 2/3 always keep the timeline — it is the anchor", () => {
  for (const mode of [2, 3]) {
    for (const over of [{}, { directoryOpen: true }, { membersOpen: true }, { hasThreadEvent: true }]) {
      assert.equal(vis({ mode, ...over }).showTimeline, true, `timeline vanished in mode ${mode}`);
    }
  }
});

test("the right slot holds ONE of thread / threads-list / members", () => {
  // They share one physical slot; two at once would overlap.
  const v = vis({ mode: 2, hasThreadEvent: true, threadsListOpen: true, membersOpen: true });
  const right = [v.showThread, v.showThreadsList, v.showMembers].filter(Boolean).length;
  assert.equal(right, 1, "more than one panel claimed the right slot");
  assert.equal(v.showThread, true, "an open thread outranks the list and members");
});

test("side panels need a selected room (nothing to show them about)", () => {
  const v = vis({ mode: 2, hasSelected: false, membersOpen: true, threadsListOpen: true });
  assert.equal(v.showMembers, false);
  assert.equal(v.showThreadsList, false);
});

// ── capacity transitions ─────────────────────────────────────────────────────

test("entering mode 3 opens the directory ONCE — the close button must win", () => {
  // The regression this guards: applying the rule on every render reopens the
  // directory immediately after the user closes it.
  assert.deepEqual(
    resolveCapacityChange({ mode: 3, prevMode: 2, directoryOpen: false, membersOpen: false, lastSide: null }),
    { directoryOpen: true },
    "entering mode 3 should open the directory"
  );
  assert.deepEqual(
    resolveCapacityChange({ mode: 3, prevMode: 3, directoryOpen: false, membersOpen: false, lastSide: null }),
    {},
    "ALREADY in mode 3 with the directory closed: the user closed it, leave it closed"
  );
});

test("any non-3 previous mode counts as 'not previously wide' (incl. the 0 seed)", () => {
  for (const prevMode of [0, 1, 2, null]) {
    assert.deepEqual(
      resolveCapacityChange({ mode: 3, prevMode, directoryOpen: false, membersOpen: false, lastSide: null }),
      { directoryOpen: true },
      `prevMode ${prevMode} should be treated as entering mode 3`
    );
  }
});

test("narrowing to mode 2 with both panels open drops the LEAST recently used", () => {
  const both = { mode: 2, prevMode: 3, directoryOpen: true, membersOpen: true };
  assert.deepEqual(
    resolveCapacityChange({ ...both, lastSide: "mem" }),
    { directoryOpen: false },
    "user last touched members → members stays"
  );
  assert.deepEqual(
    resolveCapacityChange({ ...both, lastSide: "dir" }),
    { membersOpen: false },
    "user last touched the directory → directory stays"
  );
  assert.deepEqual(
    resolveCapacityChange({ ...both, lastSide: null }),
    { membersOpen: false },
    "no interaction recorded → keep the directory (the default panel)"
  );
});

test("mode 2 with only one side panel open changes nothing", () => {
  const base = { mode: 2, prevMode: 2, lastSide: null } as const;
  assert.deepEqual(resolveCapacityChange({ ...base, directoryOpen: true, membersOpen: false }), {});
  assert.deepEqual(resolveCapacityChange({ ...base, directoryOpen: false, membersOpen: true }), {});
});

test("mode 1 closes nothing — the flags survive so widening restores them", () => {
  assert.deepEqual(
    resolveCapacityChange({ mode: 1, prevMode: 2, directoryOpen: true, membersOpen: true, lastSide: "dir" }),
    {},
    "mode 1 shows one panel via resolveVisibility; the open flags must be preserved"
  );
});

test("the patch is SPARSE — an absent key never means 'close it'", () => {
  // A caller applying `patch.directoryOpen ?? false` would close panels the rule
  // had no opinion about. Absent must stay absent.
  const patch = resolveCapacityChange({
    mode: 2, prevMode: 2, directoryOpen: true, membersOpen: true, lastSide: "mem",
  });
  assert.equal("membersOpen" in patch, false, "membersOpen should be untouched, not set to true/false");
  assert.equal(patch.directoryOpen, false);
});

// ── Inner-pager derivations ──────────────────────────────────────────────────

/** Every input the resolver takes, exhaustively: 3 modes × selected × the four
 *  flags = 96 states. The pager derivations are total functions over all of
 *  them, so nothing below is allowed to sample. */
const ALL_STATES = [1, 2, 3].flatMap((mode) =>
  [true, false].flatMap((hasSelected) =>
    [false, true].flatMap((directoryOpen) =>
      [false, true].flatMap((membersOpen) =>
        [false, true].flatMap((threadsListOpen) =>
          [false, true].map((hasThreadEvent) => ({
            mode, hasSelected, directoryOpen, membersOpen, threadsListOpen, hasThreadEvent,
          }))
        )
      )
    )
  )
);

test("the pane keys are the panes that have something to be ABOUT", () => {
  assert.deepEqual(matrixPaneKeys(true), ["directory", "timeline", "members"]);
  // With no room selected a timeline pane would be blank and a member list has
  // no room to list — the resolver says the same thing (showTimeline and
  // showMembers both require hasSelected), so the row is one pane wide and
  // every swipe belongs to the OUTER pager.
  assert.deepEqual(matrixPaneKeys(false), ["directory"]);
});

test("the key order IS the journey order — directory left, members right", () => {
  // A fresh swipe off members' right edge continues to news, off
  // directory's left edge back to live. Reversing this row would send the
  // continuation the wrong way at both ends.
  assert.deepEqual(matrixPaneKeys(true).indexOf("directory" as MatrixPaneKey), 0);
  assert.deepEqual(matrixPaneKeys(true).indexOf("timeline" as MatrixPaneKey), 1);
  assert.deepEqual(matrixPaneKeys(true).indexOf("members" as MatrixPaneKey), 2);
});

test("the active pane is whichever panel the FLAGS are showing — never a fourth answer", () => {
  // In mode 1 the resolver shows exactly one panel, so in every enabled state
  // the active pane must be the pane whose flag is the true one. This is the
  // pin that keeps `activeKey` (and so the at-rest `inert` reference) tied to
  // the committed flags rather than drifting into its own state.
  for (const s of ALL_STATES) {
    const v = resolveVisibility(s);
    if (!matrixPagerEnabled(s.mode, true, v)) continue;
    const expected = v.showDirectory ? "directory" : v.showMembers ? "members" : "timeline";
    assert.equal(matrixActivePane(v), expected, `wrong active pane for ${JSON.stringify(s)}`);
  }
});

test("the active pane is ALWAYS one of the keys — an activeKey off the list snaps nowhere", () => {
  // usePanePager resolves activeKey through `keys.indexOf(...)` and bails on
  // -1: an active pane outside the key set means the external re-sync silently
  // stops working (a tap on "Members" would leave the row parked on timeline).
  // The one state that can produce it is nothing-selected, which is exactly
  // why matrixPaneKeys narrows to ["directory"] there.
  for (const s of ALL_STATES) {
    const v = resolveVisibility(s);
    if (!matrixPagerEnabled(s.mode, true, v)) continue;
    const keys = matrixPaneKeys(s.hasSelected);
    assert.ok(
      keys.includes(matrixActivePane(v)),
      `active pane ${matrixActivePane(v)} is not in [${keys.join(", ")}] for ${JSON.stringify(s)}`,
    );
  }
});

test("the pager is mode 1 only — modes 2/3 show the panels side by side (both pointer types)", () => {
  for (const coarse of [true, false]) {
    for (const s of ALL_STATES) {
      const v = resolveVisibility(s);
      if (s.mode === 1) continue;
      assert.equal(matrixPagerEnabled(s.mode, coarse, v), false, `pager enabled in mode ${s.mode}, coarse=${coarse}`);
    }
  }
});

test("the pager YIELDS to the thread region — an open thread or list disables it, on a coarse pointer", () => {
  // Threads stay OUT of the pager: they take the whole panel in
  // an overlay swap. Enabled must therefore be false for every state the
  // resolver resolves to a thread pane, or the row would render underneath one.
  // Fixed at coarse=true here — coarse=false is already false for every state,
  // covered by the fine-pointer gate test below.
  for (const s of ALL_STATES) {
    const v = resolveVisibility(s);
    if (v.showThread || v.showThreadsList) {
      assert.equal(matrixPagerEnabled(s.mode, true, v), false, `pager stayed on under a thread: ${JSON.stringify(s)}`);
    }
  }
  // The two concrete yields, spelled out (a thread open, and the list open).
  const threadOpen = resolveVisibility({
    mode: 1, hasSelected: true, directoryOpen: false, membersOpen: false,
    threadsListOpen: false, hasThreadEvent: true,
  });
  assert.equal(matrixPagerEnabled(1, true, threadOpen), false, "a single open thread must yield");
  const listOpen = resolveVisibility({
    mode: 1, hasSelected: true, directoryOpen: false, membersOpen: false,
    threadsListOpen: true, hasThreadEvent: false,
  });
  assert.equal(matrixPagerEnabled(1, true, listOpen), false, "the threads list must yield");
});

test("the pager IS on for every ordinary mode-1 state on a coarse pointer (directory · timeline · members)", () => {
  // The other half of the yield: it must not be so eager to stand down that
  // the feature never runs. These are the three panes the row is made of.
  const base = { mode: 1, hasSelected: true, threadsListOpen: false, hasThreadEvent: false };
  const dir = resolveVisibility({ ...base, directoryOpen: true, membersOpen: false });
  const tl = resolveVisibility({ ...base, directoryOpen: false, membersOpen: false });
  const mem = resolveVisibility({ ...base, directoryOpen: false, membersOpen: true });
  assert.equal(matrixPagerEnabled(1, true, dir), true);
  assert.equal(matrixPagerEnabled(1, true, tl), true);
  assert.equal(matrixPagerEnabled(1, true, mem), true);
  assert.deepEqual([matrixActivePane(dir), matrixActivePane(tl), matrixActivePane(mem)],
    ["directory", "timeline", "members"]);
  // …and with nothing selected (the signed-out / pre-sync state), where the
  // row is one pane but the pager still owns the panel.
  const empty = resolveVisibility({ ...base, hasSelected: false, directoryOpen: false, membersOpen: false });
  assert.equal(matrixPagerEnabled(1, true, empty), true);
  assert.equal(matrixActivePane(empty), "directory");
});

test("the pager is touch-only — a FINE pointer disables it for every state, mode 1 included", () => {
  // The bug this closes: a desktop unsplit chat panel is mode 1 too (mode is
  // width-driven, not device-driven), and before this gate it got a live,
  // invisible snap row — a trackpad two-finger pan or shift+wheel could page
  // the Matrix panes and commit directoryOpen/membersOpen with no visible
  // pager UI. `coarse: false` must win over every other term, including the
  // ordinary mode-1 states the previous test proves are enabled on touch.
  for (const s of ALL_STATES) {
    const v = resolveVisibility(s);
    assert.equal(matrixPagerEnabled(s.mode, false, v), false,
      `pager enabled on a fine pointer for ${JSON.stringify(s)}`);
  }
  // The concrete regression case: mode 1, a room selected, nothing else open —
  // exactly the state the previous test proves is enabled at coarse=true.
  const tl = resolveVisibility({
    mode: 1, hasSelected: true, directoryOpen: false, membersOpen: false,
    threadsListOpen: false, hasThreadEvent: false,
  });
  assert.equal(matrixPagerEnabled(1, true, tl), true, "sanity: this exact state IS enabled on touch");
  assert.equal(matrixPagerEnabled(1, false, tl), false,
    "a desktop (fine-pointer) unsplit panel must never get the pager — trackpad pans would silently page it");
});

test("the derivations never re-decide visibility — they only READ the resolver", () => {
  // The invariant this whole trio rests on: `resolveVisibility` stays the
  // authority and the flags stay the source of truth. If a derivation ever
  // disagreed with the resolver about which panel is showing, the row and the
  // panel it renders would part company.
  for (const s of ALL_STATES) {
    const v = resolveVisibility(s);
    if (!matrixPagerEnabled(s.mode, true, v)) continue;
    const active = matrixActivePane(v);
    const shownByResolver =
      (v.showDirectory ? 1 : 0) + (v.showTimeline ? 1 : 0) + (v.showMembers ? 1 : 0);
    assert.equal(shownByResolver, s.hasSelected || v.showDirectory ? 1 : 0,
      `resolver showed ${shownByResolver} pager panels for ${JSON.stringify(s)}`);
    const flagForActive =
      active === "directory" ? v.showDirectory : active === "members" ? v.showMembers : v.showTimeline;
    assert.equal(flagForActive, true, `active pane ${active} is not the one the resolver shows`);
  }
});
