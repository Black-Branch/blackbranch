// Source scans over the bar-control adoption: every bar control is a BarButton.
//
// Run: node --test app/lib/barChromeWiring.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments, stripCssComments } from "./testSource.ts";

const here = dirname(fileURLToPath(import.meta.url));
const accountCardPath = join(here, "..", "components", "AccountCard.tsx");
const embedBarPath = join(here, "..", "components", "StreamEmbedBar.tsx");
const chromeCssPath = join(here, "..", "components", "chrome", "chrome.css");
const modWindowPath = join(here, "..", "features", "moderation", "ModWindow.tsx");
const matrixViewPath = join(here, "..", "features", "community", "MatrixView.tsx");

/**
 * Every `<BarButton … />` element in a source, as a WHOLE tag.
 *
 * Not a regex: a prop value can hold JSX of its own (`icon={folded ?
 * <CaretDown … /> : …}`), so the first `/>` in the text is usually the icon's,
 * not the element's. Scan to the `/>` that sits at brace depth 0.
 */
function barButtons(src: string): string[] {
  const out: string[] = [];
  for (let at = src.indexOf("<BarButton"); at !== -1; at = src.indexOf("<BarButton", at + 1)) {
    let depth = 0;
    for (let i = at; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === "/" && src[i + 1] === ">" && depth === 0) { out.push(src.slice(at, i + 2)); break; }
    }
  }
  return out;
}

test("the appearance panel header carries no popout control, hand-rolled or BarButton", () => {
  // The header has no popout button at all, hand-rolled "⧉" glyph or
  // <BarButton> — Alt+Shift+P
  // (StreamView.tsx) is now the only way to open the popout — so the guard
  // now asserts the control is gone, not that it has a particular shape.
  const src = stripComments(readFileSync(accountCardPath, "utf8"));
  assert.doesNotMatch(src, /label="Popout chat"/, "the popout button must not come back");
  assert.equal(src.includes("⧉"), false,
    "the text glyph popout must be gone — it is the spelling this shipment removes");
  assert.equal(/text-muted hover:text-body-dim/.test(src), false,
    "the hand-rolled popout classes must be gone");
});

test("the player bar's fold arrow is a BarButton and stays desktop-only", () => {
  // Matched over the WHOLE element, not with `<BarButton[^>]*display=…`.
  // That form depends on JSX prop ORDER — it would force source to be
  // shuffled to satisfy it, and it would go red on a reformat that changed
  // nothing.
  const src = stripComments(readFileSync(embedBarPath, "utf8"));
  const fold = barButtons(src).filter((t) => /onClick=\{onFold\}/.test(t));
  assert.equal(fold.length, 1, "exactly one BarButton must be the fold arrow");
  assert.match(fold[0]!, /display="hidden md:flex"/,
    "the fold arrow must keep its desktop-only rule THROUGH the display prop");
  assert.match(fold[0]!, /label=\{folded \?/,
    "…and its label must still flip on `folded`, which is what drives both aria-label and title");
  assert.equal(/bg-surface-1 hover:bg-surface-2 transition-colors/.test(src), false,
    "the hand-rolled fold-arrow classes must be gone");
});

test("the community members bar's ✕ is a BarButton too — the FIFTH spelling", () => {
  // A bar control here sits inside a <Bar>, in a file outside
  // app/components/chrome/: a hand-rolled one would have its own button
  // classes and no aria-label or title — announced to a screen reader as the
  // character "✕". So this file is scanned too.
  const src = stripComments(readFileSync(matrixViewPath, "utf8"));
  const close = barButtons(src).filter((t) => /setMembersOpen\(false\)/.test(t));
  assert.equal(close.length, 1, "the members close control must be a BarButton");
  assert.match(close[0]!, /label="[^"]+"/,
    "BarButton's label is what pairs aria-label and title — an unlabelled close is the defect");
  assert.equal(/className="text-muted hover:text-strong text-xs"/.test(src), false,
    "the hand-rolled ✕ classes must be gone");
});

test("the chrome-window-btn alias is deleted, not left behind", () => {
  // A transitional alias left behind is how a
  // second name survives — "leave it for now" is not a disposition.
  const css = stripCssComments(readFileSync(chromeCssPath, "utf8"));
  assert.equal(css.includes("chrome-window-btn"), false,
    "the one-shipment alias must be removed in the same shipment");
  assert.match(css, /\.chrome-bar-btn\s*\{/, "the real class must still be defined");
});

test("every mode-rail icon is declared at the same size — the built-ins and a registered fallback's", () => {
  // The three mode icons share a 1rem box, so a different unit or value on one
  // (an `em` size against an inherited font-size) renders off-centre. Assert
  // the VALUE on all three: "three icons exist" passes with the wrong
  // instances. A fallback's icon is the plugin's component, sized here by the
  // bar (modeIcon) — the third size.
  const src = stripComments(readFileSync(embedBarPath, "utf8"));
  const start = src.indexOf("BUILTIN_ICON");
  const block = src.slice(start, src.indexOf("const modeLabel", start));
  assert.equal(/0\.95em/.test(block), false, "the em-sized community icon must be gone");
  const sizes = [...block.matchAll(/size=\{(\d+)\}/g)].map((m) => m[1]);
  assert.equal(sizes.length, 3, "both built-in icons and the fallback's must declare a numeric size");
  assert.deepEqual(new Set(sizes), new Set(["14"]), "all three must be the SAME size");
});

test("ModWindow passes popoutUrl", () => {
  // Window implements popout in full; assert the prop AND its value — `popout`
  // appearing somewhere in the file proves nothing.
  const src = stripComments(readFileSync(modWindowPath, "utf8"));
  assert.match(src, /popoutUrl=\{popout \? undefined : "\/mod"\}/, "the mod panel must pop out to its own page");
});

test("the profile root names itself rather than falling back to Account", () => {
  // accountPages.ts gives `profile` an empty title on purpose (it also feeds the
  // back-navigation trail), so the substitution belongs here, at the one place
  // `name` is computed.
  const src = stripComments(readFileSync(accountCardPath, "utf8"));
  assert.equal(/name=\{top\.title \|\| "Account"\}/.test(src), false,
    "the generic fallback must be gone");
  assert.match(src, /name=\{top\.title \|\| displayName \|\| "Profile"\}/,
    "the profile root must prefer the viewer's display name");
});

// ── Vacuity anchor ───────────────────────────────────────────────────────────
// Seven of the assertions above are NEGATIVE ("the glyph is gone", "the classes
// are gone", "the fallback is gone", "the alias must be removed", "the icon must be gone"),
// and a negative assertion goes green over a hole — an empty file, a moved file, a bad join().
// FIVE sources are read here, and the anchor must prove each was read to its END: a landmark
// near the top of a file (e.g. `export default function AccountCard`)
// proves only that the file opens as expected, which is not what a truncated read looks like.
//
// Keep this test LAST in the file. The rule is an END-of-file anchor,
// and a new test appended below it would quietly demote it.
test("all five scanned sources were read to their END", () => {
  const tail = (p: string) => readFileSync(p, "utf8").trimEnd().slice(-400);
  assert.match(tail(accountCardPath), /<\/Window>/,
    "AccountCard.tsx is truncated — it closes on its Window");
  assert.match(tail(embedBarPath), /onClick=\{onFold\}/,
    "StreamEmbedBar.tsx is truncated — the fold arrow is its last element");
  assert.match(tail(chromeCssPath), /\.matrix-entrance\[data-entered\]/,
    "chrome.css is truncated — the entrance's reduced-motion override is its last rule");
  assert.match(tail(modWindowPath), /<ModPanel/,
    "ModWindow.tsx is truncated — it closes on its ModPanel");
  assert.match(tail(matrixViewPath), /return <UnifiedLayout pageChrome \/>;/,
    "MatrixView.tsx is truncated — its default export ends on the page-chrome branch");
});

// ── One universal bar button style, shared by every icon button in a bar, so
// a phone sees the same buttons as the player top bar. The one style is
// .chrome-bar-btn, sized and rounded like the mode rail's items; the icon
// buttons beside the rail, in the chat tab bar and in the folded pill
// wear it through BarButton. ──────────────────────────────────────────────────

test(".chrome-bar-btn is the mode rail's geometry with a hover fill, an on-state fill and press motion", () => {
  const css = stripCssComments(readFileSync(chromeCssPath, "utf8"));
  const rule = /\.chrome-bar-btn \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(rule, /height: 1\.625rem/, "the rail item's height");
  assert.match(rule, /min-width: 1\.625rem/, "a square hit area at minimum");
  assert.match(rule, /border-radius: \.4375rem/, "the rail item's radius");
  assert.match(rule, /justify-content: center/);
  assert.match(rule, /transition: color var\(--anim-fast\)[^;]*background-color var\(--anim-fast\)[^;]*transform var\(--anim-fast\)/, "colour, fill and press all move");
  assert.match(css, /\.chrome-bar-btn:hover \{[^}]*background: var\(--color-surface-2\)/, "hover = the shared hover fill");
  assert.match(css, /\.chrome-bar-btn\[data-active\] \{[^}]*background: var\(--color-surface-3\)/, "on = the rail's selected fill");
  assert.match(css, /\.chrome-bar-btn:active \{[^}]*transform: scale\(/, "press dips");
  const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n  \}/.exec(css)?.[1] ?? "";
  assert.match(reduced, /\.chrome-bar-btn/, "reduced motion covers the button");
  assert.match(css.trimEnd(), /\}\s*$/);
});

test("the player top bar's gear and theatre buttons are BarButtons beside the fold arrow — no hand-rolled w-6 h-6 rounded", () => {
  const src = stripComments(readFileSync(embedBarPath, "utf8"));
  const tags = barButtons(src);
  assert.ok(tags.some((t) => /label="Manage community embeds"/.test(t)), "the gear is a BarButton");
  const theatre = tags.filter((t) => /Theatre mode \(Alt\+R\)/.test(t));
  assert.equal(theatre.length, 1, "the theatre toggle is a BarButton");
  assert.match(theatre[0]!, /active=\{panelMode === "theatre"\}/, "…and its on-state is the shared one");
  assert.doesNotMatch(src, /w-6 h-6 rounded/, "the hand-rolled square is gone");
  assert.match(src, /\}\s*$/);
});

test("the chat tab bar's compact, split and full/fold toggles are BarButtons with the shared on-state", () => {
  const src = stripComments(readFileSync(join(here, "..", "features", "chat", "ChatTabBar.tsx"), "utf8"));
  const tags = barButtons(src);
  const compact = tags.filter((t) => /onClick=\{onToggleCompact\}/.test(t));
  assert.equal(compact.length, 1, "the compact toggle is a BarButton");
  assert.match(compact[0]!, /active=\{compact\}/);
  assert.ok(tags.some((t) => /label="Split view — live chat \+ Matrix"/.test(t)), "the split button is a BarButton");
  const full = tags.filter((t) => /onClick=\{onToggleFull\}/.test(t));
  assert.equal(full.length, 1, "the full/fold toggle is a BarButton");
  assert.match(full[0]!, /active=\{isFull\}/);
  assert.match(full[0]!, /label=\{label\}/, "its name still comes from fullToggleLabel");
  assert.doesNotMatch(src, /px-2\.5 h-full flex items-center justify-center/, "the hand-rolled bar button is gone");
  assert.match(src, /\}\s*$/);
});

test("the folded pill is the rail's tray — same radius, padding and gap — and its three buttons are BarButtons", () => {
  const src = stripComments(readFileSync(join(here, "..", "components", "FoldedTabControl.tsx"), "utf8"));
  assert.match(src, /data-folded-ctl className="[^"]*rounded-\[\.5625rem\][^"]*"/, "the pill's radius is the rail tray's");
  assert.match(src, /data-folded-ctl className="[^"]*\bp-\[2px\][^"]*"/, "the pill's padding is the rail tray's");
  assert.match(src, /data-folded-ctl className="[^"]*\bgap-\[2px\][^"]*"/, "the pill's gap is the rail tray's");
  assert.doesNotMatch(src, /rounded-full bg-scrim-heavy/, "the round pill skin is gone");
  const tags = barButtons(src);
  // This split button stays rendered while split is ON, so — unlike the tab
  // bar's, which only exists while unsplit — its name must say the state that
  // `active` only paints (BarButton sets no aria-pressed).
  const split = tags.filter((t) => /label=\{split \? "Split view — on" : "Split view — live chat \+ Matrix"\}/.test(t));
  assert.equal(split.length, 1); assert.match(split[0]!, /active=\{split\}/);
  const compact = tags.filter((t) => /onClick=\{onToggleCompact\}/.test(t));
  assert.equal(compact.length, 1); assert.match(compact[0]!, /active=\{compact\}/);
  const full = tags.filter((t) => /onClick=\{onToggleFull\}/.test(t));
  assert.equal(full.length, 1); assert.match(full[0]!, /active=\{isFull\}/);
  assert.doesNotMatch(src, /w-6 h-6 rounded-full/, "the hand-rolled circles are gone");
  assert.match(src, /\}\s*$/);
});

