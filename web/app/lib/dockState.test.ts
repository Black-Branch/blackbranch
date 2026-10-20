// Tests for the bottom dock's state rules (pure, node --test, no DOM), plus
// source-scan guards on BottomDock itself for the invariants a pure function
// can't carry: collapsed-means-unmounted, token-not-measured, and the
// viewForHeight input derivation.
//
// Run: node --test app/lib/dockState.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  DOCK_DEFAULT_TAB, readDockTab, writeDockTab, dockVisible, dockShown, contentAvail,
} from "./dockState.ts";
import { viewForHeight } from "./feedMode.ts";
import { SITE_TABS } from "./tabRegistry.ts";
import { stripComments } from "./testSource.ts";

// Derived, not duplicated — the dock's keys ARE the registry's keys.
const KNOWN = SITE_TABS.map((t) => t.key);

// ── readDockTab / writeDockTab ───────────────────────────────────────────────

test("nothing stored opens the default tab", () => {
  assert.equal(readDockTab(null, KNOWN), DOCK_DEFAULT_TAB);
  assert.equal(DOCK_DEFAULT_TAB, "home");
});

test('collapsed ("") is a valid stored choice and round-trips', () => {
  assert.equal(writeDockTab(null), "");
  assert.equal(readDockTab("", KNOWN), null);
  assert.equal(readDockTab(writeDockTab(null), KNOWN), null);
});

test("a known tab round-trips", () => {
  for (const k of KNOWN) {
    assert.equal(readDockTab(writeDockTab(k), KNOWN), k);
  }
});

test("an unknown stored key falls back to the DEFAULT, not to collapsed", () => {
  // Removing a tab in a future release must not silently collapse the dock
  // for everyone who had that tab open — their stored key stops being known,
  // and the honest fallback is the default tab, still open.
  assert.equal(readDockTab("schedule", KNOWN), DOCK_DEFAULT_TAB);
  // The same rule covers a tab that is conditionally offered (VODs with an
  // empty vods list): the stored key degrades to the default, open.
  assert.equal(readDockTab("vods", ["news"]), DOCK_DEFAULT_TAB);
});

// ── space rules ──────────────────────────────────────────────────────────────

test("dockVisible boundary sits exactly at the tab row's height", () => {
  assert.equal(dockVisible(28, 28), true, "exactly the row's height fits the row");
  assert.equal(dockVisible(27, 28), false);
  assert.equal(dockVisible(0, 0), true, "pre-measurement (0,0) renders, so the row can be measured");
});

test("contentAvail is the leftover minus the row, never negative", () => {
  assert.equal(contentAvail(100, 28), 72);
  assert.equal(contentAvail(10, 28), 0);
  assert.equal(contentAvail(0, 0), 0);
});

test("open: the tabs fade WITH the content; collapsed: the row alone decides", () => {
  // A tab row you can't open anything under is noise. When the
  // dock is OPEN and the space rule hides the content, the whole dock fades —
  // the row does not linger on its own. Collapsed is different: the row IS
  // the dock (it's the reopen affordance), so only the row has to fit.
  const row = 28;
  // open + content hidden → whole dock hidden, even though the row would fit
  assert.equal(dockShown("news", row + 29, row, true), false);
  // open + content visible → shown
  assert.equal(dockShown("news", row + 30, row, false), true);
  // collapsed → the row's own fit decides; content-hidden is irrelevant
  assert.equal(dockShown(null, row, row, true), true);
  assert.equal(dockShown(null, row - 1, row, true), false);
});

test("viewForHeight over contentAvail keeps the exact 30/108 boundaries", () => {
  // The constants are untouched — only their input is contentAvail rather
  // than the raw leftover. Pin the composition at both boundaries so a
  // "helpful" retuning of either side shows up here.
  const row = 28;
  assert.equal(viewForHeight(contentAvail(row + 29, row)), "hidden");
  assert.equal(viewForHeight(contentAvail(row + 30, row)), "ticker");
  assert.equal(viewForHeight(contentAvail(row + 107, row)), "ticker");
  assert.equal(viewForHeight(contentAvail(row + 108, row)), "list");
});

// ── source-scan guards on BottomDock ─────────────────────────────────────────
// These invariants live in a component the test runner cannot execute, so they
// are pinned by scanning the source (comments stripped — testSource.ts says
// why). Derive, don't snapshot: the content-component set comes from the
// file's own imports.

const dockDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "components", "BottomDock",
);
const dockSrc = stripComments(readFileSync(path.join(dockDir, "index.tsx"), "utf8"));

test("collapsing UNMOUNTS: every content component is behind a shownTab guard", () => {
  // The `shownTab === "…" && <Component…` conditionals are what stop the RSS
  // poll when collapsed — a `hidden` class would keep useRssFeed mounted and
  // polling, and would pass any markup-only assertion. Content components are
  // derived from the imports: everything DEFAULT-imported from
  // "@/app/components/<name>" (the dock's own chrome — Bar and Sections — is a
  // NAMED import from the chrome index, and is rightly unconditional).
  const contentComponents = [...dockSrc.matchAll(
    /import\s+(\w+)\s+from\s+"@\/app\/components\/(\w+)"/g,
  )].map((m) => m[1]!);
  assert.ok(contentComponents.length >= 2, "expected at least FeedPanel and VodList imports");
  for (const name of contentComponents) {
    const uses = [...dockSrc.matchAll(new RegExp(`<${name}[\\s/>]`, "g"))];
    assert.ok(uses.length > 0, `${name} is imported but never rendered`);
    for (const use of uses) {
      // The nearest shownTab guard must open BEFORE this use, with no
      // intervening guard-closing `)}` between them.
      const before = dockSrc.slice(0, use.index);
      const guard = before.lastIndexOf('shownTab === "');
      assert.ok(guard !== -1, `<${name}> is rendered with no shownTab guard before it`);
      const between = dockSrc.slice(guard, use.index);
      assert.ok(
        !between.includes(")}"),
        `<${name}> is rendered outside the shownTab guard's expression`,
      );
    }
  }
});

test("the pull-up exit ENDS in an unmount, and the poll is inert while it runs", () => {
  // Collapse defers the unmount for the exit animation (dock-tab-out), which
  // opens two regressions the markup can't show:
  // 1. Nothing clears closingTab → the content stays mounted forever and
  //    "collapsed means unmounted" quietly becomes "collapsed means hidden".
  //    The clear must hang off the animation's END event.
  assert.match(dockSrc, /onAnimationEnd=\{[^}]*setClosingTab\(null\)/,
    "closingTab must be cleared by animationend — that IS the unmount");
  // 2. The closing content keeps polling — active must derive from the OPEN
  //    state (false the moment collapse starts), not from shownTab.
  assert.match(dockSrc, /const contentActive = visible && openTab !== null/,
    "contentActive must go false at collapse start, not at unmount");
  // And reduced-motion must keep dock-tab-out as a real (motionless)
  // animation — `animation: none` would never fire the end event.
  const css = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "globals.css"), "utf8",
  );
  const reduced = css.slice(css.indexOf("prefers-reduced-motion"));
  assert.ok(reduced.includes("@keyframes dock-tab-out"),
    "reduced-motion needs a dock-tab-out override that still fires animationend");
});

test("the news view derives from contentAvail, not the raw leftover", () => {
  // Feeding viewForHeight the raw leftover would double-count the tab row's
  // height — the exact drift this cycle exists to avoid.
  const m = dockSrc.match(/const\s+(\w+)\s*=\s*contentAvail\(/);
  assert.ok(m, "BottomDock never calls contentAvail");
  const availVar = m![1]!;
  assert.match(
    dockSrc, new RegExp(`viewForHeight\\(${availVar}\\)`),
    "viewForHeight must be fed the contentAvail result",
  );
  const fed = [...dockSrc.matchAll(/viewForHeight\(\s*(\w+)/g)].map((x) => x[1]);
  assert.deepEqual(fed, [availVar], "viewForHeight is called with something other than contentAvail's result");
});

test("the tab row's height is the TOKEN, read back resolved — never measured, never a literal", () => {
  // The dock's row is a Bar, exactly --chrome-top-h tall. Browser zoom and the
  // Tab-size slider change the token, so the dock reads the token (registered
  // <length>, so getComputedStyle returns px), not the row's box and not a number.
  assert.match(dockSrc, /setTabRowPx\(readChromePx\(\w+, CHROME_TOP_H\)\)/, "tabRowPx must be the token");
  assert.doesNotMatch(dockSrc, /offsetHeight/, "no bar is measured");
  assert.doesNotMatch(dockSrc, /setTabRowPx\(\s*\d/, "tabRowPx must not be set from a numeric literal");
  assert.match(dockSrc, /new ResizeObserver/, "the SPACE (leftover) is still measured");
  assert.match(dockSrc, /ro\.observe\(body\)/, "the body resizes when the token changes — that is the re-read trigger");
});

test("the tab row scrolls horizontally instead of growing the dock wide", () => {
  // The row is Sections now; the strip's overflow rule lives in chrome.css.
  const css = readFileSync(path.join(dockDir, "..", "chrome", "chrome.css"), "utf8");
  assert.match(css, /\.chrome-sections\s*\{[^}]*overflow-x:\s*auto/);
});

test("clicking the open tab collapses; clicking an inactive tab opens it", () => {
  assert.match(dockSrc, /onChange=\{\(k\) => \(k === openTab \? collapse\(\) : setOpenTab\(k\)\)\}/,
    "the Sections onChange must fork collapse-vs-open on the open tab");
  assert.match(dockSrc, /value=\{openTab\}/, "collapsed (null) = nothing selected, no hole, no cap");
});
