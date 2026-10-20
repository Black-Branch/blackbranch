import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { stripCssComments } from "../sourceText.mjs";
// IconRail is a REAL .tsx component (it renders JSX, like every other chrome
// skin) — node's native TypeScript support strips types, not JSX
// (useTabList.render.test.ts's header says this for the plain-.ts case).
// ../testTsx.ts is the module's own answer: a synchronous module.registerHooks
// resolver + transpileModule loader for "@/" and .tsx specifiers, armed by
// importing it. It must be a STATIC import so its hooks are registered before
// anything else resolves — sections.render.test.ts hits the same ordering
// constraint and is why its component import is dynamic too.
import "../testTsx.ts";
const { IconRail } = await import("../../components/chrome/IconRail.tsx");

const items = [
  { key: "live", label: "Live", icon: "●", tone: "live" as const, detail: "Twitch", hasMenu: true },
  { key: "community", label: "Community", icon: "⧉", tone: "available" as const },
  { key: "radio", label: "Radio", icon: "♪", tone: "off" as const },
];
const render = (value: "live" | "community" | "radio" | null, menuOpen = false) =>
  renderToStaticMarkup(createElement(IconRail, { items, value, onChange: () => {}, label: "Player mode", onMenu: () => {}, menuOpen }));

test("a tablist of one tab per mode, each carrying its tone", () => {
  const html = render("live");
  assert.match(html, /role="tablist"/);
  assert.equal((html.match(/role="tab"/g) ?? []).length, 3);
  assert.match(html, /data-tone="live"/);
  assert.match(html, /data-tone="available"/);
  assert.match(html, /data-tone="off"/);
});

test("only the active item expands: its word, its detail, and its caret", () => {
  const html = render("live");
  assert.match(html, />Live</);
  assert.match(html, /· Twitch/);
  assert.match(html, /aria-label="Live options"/);
  assert.doesNotMatch(html, />Community</);
  assert.doesNotMatch(html, />Radio</);
  // Inactive items keep their name for assistive tech even without the word on screen.
  assert.match(html, /aria-label="Community"/);
  assert.match(html, /aria-label="Radio"/);
});

test("an active item without a menu shows no caret; the caret reports open state", () => {
  assert.doesNotMatch(render("community"), /options"/);
  assert.match(render("live", true), /aria-expanded="true"/);
  assert.match(render("live", false), /aria-expanded="false"/);
});

test("value null: nothing selected, every item is an icon", () => {
  const html = render(null);
  assert.doesNotMatch(html, /aria-selected="true"/);
  assert.doesNotMatch(html, /options"/);
});

test("an `off` mode is inert: aria-disabled on that tab alone", () => {
  // Grey means there is nothing behind the item, so selecting it would
  // mount an empty player. It stays focusable and in the arrow order —
  // aria-disabled, never `disabled` — and IconRail filters the selection itself.
  const offLive = [{ ...items[0]!, tone: "off" as const }, items[1]!, items[2]!];
  const html = renderToStaticMarkup(createElement(IconRail, {
    items: offLive, value: "community", onChange: () => {}, label: "Player mode", onMenu: () => {}, menuOpen: false,
  }));
  // One segment per item, so "on that tab alone" is checked per tab rather than
  // by a count that two wrong tabs could also satisfy.
  const segs = html.split('<div class="chrome-iconrail-item"').slice(1);
  assert.equal(segs.length, 3, "setup: one segment per rail item");
  assert.match(segs[0]!, /aria-disabled="true"/, "the off Live tab does not announce as disabled");
  assert.doesNotMatch(segs[1]!, /aria-disabled/, "the available (and active) Community tab must not be disabled");
  assert.match(segs[2]!, /aria-disabled="true"/, "the off Radio tab does not announce as disabled");
});

test("the selected item is never aria-disabled, even with an off tone", () => {
  // Live can BE the current selection while Casey is offline (tone "off") —
  // that's a selected tab, not an inert one, so aria-selected="true" and
  // aria-disabled must never co-occur on the same tab.
  const offLive = [{ ...items[0]!, tone: "off" as const }, items[1]!, items[2]!];
  const html = renderToStaticMarkup(createElement(IconRail, {
    items: offLive, value: "live", onChange: () => {}, label: "Player mode", onMenu: () => {}, menuOpen: false,
  }));
  const segs = html.split('<div class="chrome-iconrail-item"').slice(1);
  assert.equal(segs.length, 3, "setup: one segment per rail item");
  assert.match(segs[0]!, /aria-selected="true"/, "the active Live tab must announce as selected");
  assert.doesNotMatch(segs[0]!, /aria-disabled/, "the active Live tab must not also announce as disabled");
});

test("arrowing the rail moves focus only: selection here mounts a cross-origin embed", () => {
  // The hook's own header rule — "manual" is for a tab list whose selection is
  // expensive. With the default "auto", one Arrow press per mode mounted one
  // player per mode on the way past.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, "..", "..", "components", "chrome", "IconRail.tsx"), "utf8");
  assert.match(src, /activation: "manual"/, "IconRail is back on automatic activation");
  // Vacuity anchor on the END of the file.
  assert.match(src.trimEnd(), /\}\s*$/);
});

test("the rail can shrink, and the detail is what gives: min-width chain + ellipsis", () => {
  // The rail shares a Bar row with a wordmark and a utility cluster. Without
  // min-width:0 down rail → active item → active tab, a flex item's automatic
  // minimum size is its content, so a long detail ("Live · stream.place") pushed
  // the cluster out of the bar instead of ellipsising.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const css = stripCssComments(readFileSync(path.join(here, "..", "..", "components", "chrome", "chrome.css"), "utf8"));
  assert.match(css, /\.chrome-iconrail \{[^}]*min-width: 0/);
  assert.match(css, /\.chrome-iconrail-item\[data-active\] \{[^}]*min-width: 0/);
  assert.match(css, /\.chrome-iconrail \.chrome-tab\[aria-selected="true"\] \{[^}]*min-width: 0/);
  assert.match(css, /\.chrome-iconrail-detail \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*max-width: 10rem;/,
    "the active item's detail no longer truncates — it can only overflow the bar");
  // The icons must NOT be the thing that gives.
  assert.match(css, /\.chrome-iconrail-item \{[^}]*flex: none/);
  assert.match(css.trimEnd(), /\}\s*$/); // vacuity anchor: whole file
});

test("no pulse on a tone change: the iconrail tab resets the shared .chrome-tab transition", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(path.join(here, "..", "..", "components", "chrome", "chrome.css"), "utf8");
  const css = stripCssComments(raw);
  // The base .chrome-tab rule puts an unconditional `transition: color …` on
  // every tab (for the selection-driven colour changes the other skins want).
  // A tone here is a STATE, not a selection — without its own reset, a
  // data-tone flip on a mounted item (Live turning red while the rail sits on
  // Radio) would inherit that transition and animate into a pulse, which is
  // ruled out. Cascade is per-property, so setting `color` on the tone rules can't
  // narrow it; only a rule that touches `transition` itself can.
  assert.match(css, /\.chrome-iconrail \.chrome-tab \{[^}]*transition: none/);
  // Vacuity anchor: a truncated read of chrome.css (or a stripper that ate the
  // closing brace) must not pass this test by accident.
  assert.match(css.trimEnd(), /\}\s*$/);
});

// ── The rail's word is smaller, its caret is a real control, it moves on
// hover/select, and under width pressure it falls back to icons — keeping
// the caret where a mode has options. ───────────────────────────────────────

const chromeCss = () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return stripCssComments(readFileSync(path.join(here, "..", "..", "components", "chrome", "chrome.css"), "utf8"));
};

test("the caret is an icon button, not a 10px text glyph (one is hard to see and hard to hit)", () => {
  const html = render("live");
  const caret = /<button[^>]*class="chrome-iconrail-caret"[^>]*>([\s\S]*?)<\/button>/.exec(html);
  assert.ok(caret, "the caret button renders");
  assert.match(caret![1]!, /<svg/, "the caret is an SVG icon");
  assert.doesNotMatch(caret![1]!, /▾/, "the text glyph is gone");
  const css = chromeCss();
  assert.match(css, /\.chrome-iconrail-caret \{[^}]*min-width: 1\.5rem/, "the caret has a real hit area");
  assert.doesNotMatch(css, /\.chrome-iconrail-caret \{[^}]*font-size: \.625rem/, "the 10px glyph size is gone");
  assert.match(css.trimEnd(), /\}\s*$/);
});

test("the rail's word is smaller than a tab's, on the viewer's tab-size setting", () => {
  const css = chromeCss();
  assert.match(css, /\.chrome-iconrail \.chrome-tab \{[^}]*font-size: calc\(var\(--tab-size, \.875rem\) \* \.86\)/,
    "the rail item's font is derived from --tab-size, smaller than the tab it inherits from");
  assert.match(css.trimEnd(), /\}\s*$/);
});

test("hover and select move: the item's fill fades, the icon lifts — and colour still never transitions (the no-pulse rule)", () => {
  const css = chromeCss();
  assert.match(css, /\.chrome-iconrail-item \{[^}]*transition: background-color var\(--anim-fast\)/, "the select fill fades between items");
  assert.match(css, /\.chrome-iconrail-item:not\(\[data-active\]\):hover \{[^}]*background: var\(--color-surface-2\)/, "hover shows a fill on an inactive item");
  assert.match(css, /\.chrome-iconrail-icon \{[^}]*transition: transform var\(--anim-fast\)/, "the icon's lift is a transform transition");
  assert.match(css, /\.chrome-iconrail \.chrome-tab:hover \.chrome-iconrail-icon \{[^}]*transform: scale\(/);
  assert.match(css, /\.chrome-iconrail \.chrome-tab \{[^}]*transition: none/, "the tab itself still transitions nothing — a tone flip must not pulse");
  // Reduced motion switches the new motion off too.
  const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n  \}/.exec(css)?.[1] ?? "";
  assert.match(reduced, /\.chrome-iconrail-item/, "reduced motion covers the item fill");
  // The transform reset must carry the SAME selectors as the lift/dip rules
  // ((0,4,0)): a bare `.chrome-iconrail-icon { transform: none }` loses on
  // specificity and the icon still jumps, just without easing (review).
  assert.match(reduced, /\.chrome-iconrail \.chrome-tab:hover \.chrome-iconrail-icon, \.chrome-iconrail \.chrome-tab:active \.chrome-iconrail-icon[^{]*\{[^}]*transform: none/,
    "reduced motion neutralises the icon lift at the lift rule's own specificity");
  assert.match(css.trimEnd(), /\}\s*$/);
});

test("under width pressure the detail goes first, then the word — the caret stays (icons only, keeping the arrow)", () => {
  const css = chromeCss();
  // Two container tiers on the rail's host (StreamEmbedBar's wrapper is the
  // container — embedBarRail.test.ts pins that side).
  const tier1 = /@container \(max-width: 300px\) \{([\s\S]*?)\n  \}/.exec(css)?.[1];
  const tier2 = /@container \(max-width: 200px\) \{([\s\S]*?)\n  \}/.exec(css)?.[1];
  assert.ok(tier1, "tier 1 (≤300px) exists");
  assert.ok(tier2, "tier 2 (≤200px) exists");
  assert.match(tier1!, /\.chrome-iconrail-detail \{[^}]*display: none/, "tier 1 drops the detail");
  assert.doesNotMatch(tier1!, /chrome-tab-label/, "tier 1 keeps the word");
  // The word is hidden VISUALLY, never removed from the accessibility tree: the
  // active tab's accessible name IS this word (IconRail sets aria-label only
  // on inactive tabs — a11yRound3.test.ts pins that), so display:none would
  // leave the selected mode announcing as an empty tab.
  assert.match(tier2!, /\.chrome-iconrail \.chrome-tab-label \{[^}]*position: absolute[^}]*clip-path: inset\(50%\)/, "tier 2 hides the word visually only");
  assert.doesNotMatch(tier2!, /display: none/, "tier 2 removes nothing from the accessibility tree");
  assert.doesNotMatch(tier1! + tier2!, /chrome-iconrail-caret/, "no tier touches the caret");
  assert.match(css.trimEnd(), /\}\s*$/);
});

