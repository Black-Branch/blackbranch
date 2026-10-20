// Accessibility scans: keyboard reveal for auto-hidden bars, live-region
// announcements on money/mod feedback, and the labels/landmarks stragglers.
// Source scans — these invariants are attributes on specific JSX elements.
//
// Run: node --test app/lib/a11yRound3.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("22: an auto-hidden bar reveals on keyboard focus — the Bar primitive carries it for every bar", () => {
  // In theatre/compact the bars are parked off the panel's edge but their
  // buttons stay tabbable (a hidden bar is inert; an OVERLAY bar never is).
  // The reveal on `:has(:focus-visible)` lives once, in chrome.css, so a bar
  // migrated to Bar cannot lose it. The list grows as the bars migrate.
  const css = read("../components/chrome/chrome.css");
  assert.match(css, /\.chrome-bar-top\[data-state="overlay"\]:is\(:hover, :has\(:focus-visible\), \[data-revealed\]\)/);
  assert.match(css, /\.chrome-bar-bottom\[data-state="overlay"\]:is\(:hover, :has\(:focus-visible\), \[data-revealed\]\)/);
  for (const rel of [
    "../components/StreamEmbedBar.tsx",
    "../components/StreamMetaBar.tsx",
    "../features/chat/ChatTabBar.tsx",
    // The chat panel's BOTTOM bar (the composer). It is an overlay Bar in
    // desktop compact exactly like the three above and was missing from this
    // list — the one bar a keyboard user reaches by tabbing INTO the composer.
    "../features/chat/ChatSidebar.tsx",
  ]) {
    const src = read(rel);
    assert.match(src, /<Bar[\s\S]{0,120}overlay=\{/, `${rel}: renders its auto-hide state through Bar`);
    assert.doesNotMatch(src, /translate-y-full|peer-hover/, `${rel}: no hand-rolled overlay`);
  }
});

test("22: the video top bar's icon-only controls say what they DO", () => {
  // The bar became icons: a mode rail plus gear/theatre/fold. An icon with only
  // a `title` is a tooltip, not an accessible name on every AT, and the fold
  // button's glyph (⌃ / ⌄) carries the whole meaning — so it states its action.
  const bar = read("../components/StreamEmbedBar.tsx");
  // The fold arrow is a BarButton, whose `label` prop drives aria-label
  // directly (BarButton.tsx) — so the accessible-name invariant is pinned here
  // on `label`, not a raw aria-label attribute that does not appear in this
  // file's own source.
  assert.match(bar, /label=\{folded \? "Unfold player" : "Fold player"\}/,
    "the fold button announces its action, not its caret direction");

  // The rail's caret opens a menu; the semantics live once in the chrome
  // primitive, so every consumer of IconRail inherits them.
  const rail = read("../components/chrome/IconRail.tsx");
  assert.match(rail, /aria-haspopup="menu"/, "the caret does not announce that it opens a menu");
  assert.match(rail, /aria-expanded=\{menuOpen\}/, "the caret never reports whether the menu is open");
  assert.match(rail, /aria-label=\{on \? undefined : t\.label\}/,
    "an unexpanded mode is icon-only — without a label it announces as an empty tab");

  // The chat bar's twin control — the same icon button, rebound: on desktop it
  // is the full-screen community panel, on a phone StreamView hands it
  // `toggleFold`. Announcing "Community mode" either way would tell a phone
  // user the wrong action. Both spellings come from fullToggleLabel — the
  // ONE place that decides label + icon — so ChatTabBar and FoldedTabControl
  // (its floating twin once the tab bar itself is folded away) can't spell
  // this out separately and drift apart.
  const label = read("../components/fullToggleLabel.ts");
  assert.match(label, /const label = fold\s*\?\s*\(isFull \? "Unfold player" : "Fold player"\)/,
    "the shared label helper does not say what a fold toggle folds");

  const chatBar = read("../features/chat/ChatTabBar.tsx");
  assert.match(chatBar, /fullToggleLabel\(fullKind, isFull\)/,
    "ChatTabBar's full/fold toggle no longer goes through the shared label helper");
  // The toggle is a BarButton, whose `label` prop drives aria-label directly
  // — the same shape as the fold arrow above.
  assert.match(chatBar, /label=\{label\}/,
    "the full/fold toggle has a tooltip and no accessible name");

  const foldedControl = read("../components/FoldedTabControl.tsx");
  assert.match(foldedControl, /fullToggleLabel\(fullKind, isFull\)/,
    "FoldedTabControl's full/fold toggle no longer goes through the shared label helper — it hardcoded \"Community mode\" even on a phone's fold");
  assert.match(foldedControl, /label=\{label\}/,
    "FoldedTabControl's full/fold toggle has a tooltip and no accessible name");

  // …and what it opens is a menu of choices, not a second tab strip.
  const menu = read("../components/StreamModeMenu.tsx");
  assert.match(menu, /role="menu"/);
  assert.match(menu, /role="menuitemradio"/);
  assert.match(menu, /aria-checked=\{o\.checked\}/, "the current source is not exposed as the checked option");
});

test("23: every inline money/mod error in the straggler files is a live region", () => {
  // Round-2 gave role=alert to the main spend surfaces; these three files kept
  // rendering red text silently — a screen-reader user taps Buy and hears
  // nothing while "Not enough Qorm" sits on screen.
  const files = [
    "../components/SupportContent.tsx",
    "../features/store/StoreSpend.tsx",
    "../features/chat/StickerBoostPopover.tsx",
  ];
  for (const rel of files) {
    const src = read(rel);
    let hits = 0;
    // Every element whose className carries an error red must carry role=alert
    // ON THAT ELEMENT (scan the enclosing tag, not the neighborhood).
    const re = /className="[^"]*text-red-[34]00[^"]*"/g;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      hits += 1;
      const tagStart = src.lastIndexOf("<", m.index);
      const tagEnd = src.indexOf(">", m.index);
      const tag = src.slice(tagStart, tagEnd);
      assert.match(tag, /role="alert"/,
        `${rel}: an error renders silently for screen readers: ${tag.slice(0, 80)}…`);
    }
    assert.ok(hits > 0, `vacuity anchor: no red error text found in ${rel} — rewritten? update this scan`);
  }
});

test("23: StoreSpend's armed two-tap confirm is announced, not just repainted", () => {
  // The confirm state only changes a BUTTON's label ("Confirm 250?") — screen
  // readers do not reliably re-announce label changes on an already-focused
  // control. A visually-hidden role=status line carries the same message.
  const src = read("../features/store/StoreSpend.tsx");
  assert.match(src, /role="status"/,
    "the armed confirm has no live announcement — a blind buyer cannot tell their first tap armed anything");
  assert.match(src, /sr-only/, "the announcer should be visually hidden (sr-only), not a second visible line");
});

test("24: the tab strip's selected tab and close control are exposed — pinned in chrome (useTabList / Sections), wired in ChatTabBar", () => {
  // The bar renders Sections, so all three facts live once in the chrome
  // module and every strip gets them. Hand-rolled spellings (`aria-current`
  // on the bar's own buttons, its own close <span>) are forbidden by
  // chatTabBar.test.ts, so this checks where they live.
  const src = read("../features/chat/ChatTabBar.tsx");
  assert.match(src, /<Sections\b/, "vacuity anchor: the bar no longer renders the shared strip");
  // Home is pinned, so `closable` is computed: every other content tab keeps its ✕.
  assert.match(src, /closable: !isPinnedTab\(t\.key\)/, "a content tab that cannot be closed has no ✕ to keyboard-operate");
  assert.match(src, /onClose=\{/, "the ✕ would be inert without a handler");

  const hook = read("../lib/chrome/useTabList.ts");
  assert.match(hook, /"aria-selected": i === active/,
    "no aria-selected — a screen reader cannot tell which tab is active");

  const sections = read("../components/chrome/Sections.tsx");
  assert.match(sections, /sr-only">unread/,
    "the unread dots are purely visual — 'you have unread messages' is invisible to a screen reader");
  const closeAt = sections.indexOf("aria-label={`Close ${t.label}`}");
  assert.notEqual(closeAt, -1, "vacuity anchor: the closable-tab X is gone");
  const closeTag = sections.slice(sections.lastIndexOf("<span", closeAt), sections.indexOf(">", closeAt + 60));
  assert.match(closeTag, /tabIndex=\{0\}/,
    "the close X is not focusable — a keyboard user cannot close a content tab at all");
  assert.match(sections, /onKeyDown/, "a focusable close X still needs Enter/Space to activate");
});

test("24: the Matrix timeline is a log region, like live chat", () => {
  const src = read("../features/community/Timeline.tsx");
  assert.match(src, /role="log"/,
    "appended Matrix messages are never announced — live chat has role=log, its sibling didn't");
});

test("24: the home page has an h1", () => {
  const src = read("../(main)/page.tsx");
  assert.match(src, /<h1/,
    "no h1 anywhere on the home page — the document outline starts at nothing");
});

test("25: the floating Window moves focus in on open and restores it on close", () => {
  const src = read("../components/chrome/Window.tsx");
  const effectAt = src.indexOf("if (!panel.contains(document.activeElement)) panel.focus()");
  assert.notEqual(effectAt, -1,
    "no focus-in — a panel opened from a button leaves the screen reader announcing nothing");
  assert.match(src.slice(effectAt, effectAt + 200), /prev\?\.focus\?\.\(\)/,
    "focus is taken but never restored — closing the panel strands focus on <body>");
  assert.match(src, /tabIndex=\{-1\}/, "the shell itself must be focusable to receive the initial focus");
});

test("25: the OAuth link banner is a live region", () => {
  const src = read("../components/AccountLinkPanel.tsx");
  assert.match(src, /role=\{banner\.type === "ok" \? "status" : "alert"\}/,
    "the OAuth outcome banner renders silently — the one thing the redirect came back to say");
});

test("26: muted text clears AA on the darkest common surface", () => {
  // Measured: oklch 55.2% gray is 3.68:1 over --color-panel
  // and 4.13:1 over canvas — under the 4.5:1 AA floor exactly where muted is
  // used at 2xs/3xs sizes. 60% is the minimal lightness that clears 4.5:1
  // over panel (achromatic oklab: lum = L³, contrast = (l1+.05)/(l2+.05)).
  const css = read("../globals.css");
  const m = css.match(/--color-muted:\s*oklch\((\d+(?:\.\d+)?)%/);
  assert.ok(m, "vacuity anchor: the --color-muted token is gone");
  const L = Number(m![1]) / 100;
  const lum = (l: number) => l ** 3;
  const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const panelM = css.match(/--color-panel:\s*oklch\((\d+(?:\.\d+)?)%/);
  assert.ok(panelM, "vacuity anchor: the --color-panel token is gone");
  const ratio = contrast(lum(L), lum(Number(panelM![1]) / 100));
  assert.ok(ratio >= 4.5,
    `--color-muted is ${ratio.toFixed(2)}:1 over panel — small muted text is under the AA floor again`);
});

test("26: keyboard focus is visible even where outline-none removed it", () => {
  // Many outline-none utilities and no global :focus-visible would let a keyboard
  // user hold focus on an invisible position. globals.css is unlayered,
  // so this rule beats the utility for the same property — here that
  // layering foot-gun is the mechanism, deliberately.
  // The selector excludes .chat-input-field: editable elements match
  // :focus-visible on ANY focus, so on the composer this would be a pointer
  // ring stacked on the border that already carries its focus. Keyboard focus
  // there stays visible via that border — polishFollowups.test.ts owns the
  // exclusion; this test owns the rule existing for everything else.
  const css = read("../globals.css");
  const at = css.indexOf(":focus-visible:not(.chat-input-field) {");
  assert.notEqual(at, -1, "no global :focus-visible rule");
  const rule = css.slice(at, css.indexOf("}", at));
  assert.match(rule, /outline:\s*2px solid/, "the global focus indicator has no visible outline");
});
