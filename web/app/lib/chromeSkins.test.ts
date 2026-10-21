// web/app/lib/chromeSkins.test.ts
// Source-scan guards for the chrome tab family. The skins are .tsx the test
// runner cannot execute, so the invariants that matter are pinned by reading
// the source with comments stripped: every skin uses the ONE hook (no skin may
// grow its own keyboard model), the CSS is layered, the index is the only door,
// and the pager contract (`progress`) exists.
// Run: node --test app/lib/chromeSkins.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stripComments, stripCssComments } from "./testSource.ts";
import { CHROME_TOP_H, CHROME_BOTTOM_H, CHROME_INITIAL_PX } from "./chrome/chromeTokens.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => stripComments(readFileSync(path.join(here, "..", rel), "utf8"));

test("useTabList is built on the pure keyboard model, not a second one", () => {
  const src = read("lib/chrome/useTabList.ts");
  assert.match(src, /import \{ activeIndex, moveIndex, type Orientation \} from "\.\/tabListKeys\.ts"/);
  assert.match(src, /moveIndex\(from, e\.key, items\.length, orientation\)/);
  assert.match(src, /activeIndex\(keys, value\)/);
  // roving tabindex: exactly the FOCUSED tab is in the Tab order (auto mode:
  // focus === selection, so this is still "the active tab" as before)
  assert.match(src, /tabIndex: i === focused \? 0 : -1/);
  // ids are built from the INDEX, never the key — a label with a space
  // ("Mode & tools") must not leak into an HTML id
  assert.match(src, /id: `\$\{id\}-tab-\$\{i\}`/);
  assert.match(src, /id: `\$\{id\}-panel-\$\{i\}`/);
  // aria-controls is opt-in via `panels`, not emitted by default
  assert.match(src, /\.\.\.\(panels \? \{ "aria-controls": `\$\{id\}-panel-\$\{i\}` \} : \{\}\)/);
  // manual activation: Enter/Space select the focused tab
  assert.match(src, /activation === "manual" && \(e\.key === "Enter" \|\| e\.key === " "\)/);
  // vacuity anchor — the END of the file, so a truncated read cannot pass
  assert.match(src, /return \{ active, listProps, tabProps, panelProps \};\s*\}\s*$/);
});

test("chrome.css is ONE layered block — unlayered chrome would beat every utility beside it", () => {
  const css = stripCssComments(readFileSync(path.join(here, "..", "components/chrome/chrome.css"), "utf8")).trim();
  assert.ok(css.startsWith("@layer components {"), "first rule must open @layer components");
  assert.ok(css.endsWith("}"), "vacuity anchor: the file closes its layer");
  // nothing after the layer's closing brace: count braces so the layer wraps everything
  let depth = 0, closedAt = -1;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") { depth--; if (depth === 0) { closedAt = i; break; } }
  }
  assert.equal(closedAt, css.length - 1, "a rule sits OUTSIDE @layer components");
  assert.match(css, /\.chrome-shade\s*\{[^}]*mask-composite:\s*exclude/, "the shade layer is a mask hole");
  assert.match(css, /\.chrome-band\s*\{[^}]*--ind-x:\s*0px/, "the band frame carries the hole geometry");
  assert.match(css, /\.chrome-band\s*\{[^}]*--ind-x2:\s*0px;[^}]*--ind-w2:\s*0px/, "the second hole's geometry rests at zero");
  assert.match(css, /mask-size:\s*100% 100%,\s*var\(--ind-w\) 100%,\s*var\(--ind-w2\) 100%/, "the shade carries a third, zero-width-by-default mask layer for the second hole");
});

test("globals.css imports chrome.css immediately after tailwind, before @source", () => {
  const css = readFileSync(path.join(here, "..", "globals.css"), "utf8");
  const tw = css.indexOf('@import "tailwindcss";');
  const ch = css.indexOf('@import "./components/chrome/chrome.css";');
  const src = css.indexOf("@source");
  assert.ok(tw >= 0 && ch > tw && ch < src, "import order: tailwindcss → chrome.css → @source");
});

test("Sections renders through useTabList, adopts an enclosing Band, and owns no shade or cap of its own", () => {
  const src = read("components/chrome/Sections.tsx");
  assert.match(src, /import \{ useTabList, type TabItem \} from "@\/app\/lib\/chrome\/useTabList"/);
  assert.match(src, /import \{ interpolateBox, type Box \} from "@\/app\/lib\/chrome\/indicatorBox"/, "the indicator math is the extracted pure function (F3)");
  assert.match(src, /import \{ BandContext \} from "@\/app\/lib\/chrome\/bandContext"/, "the band is adopted through context");
  assert.match(src, /const \{ active, listProps, tabProps \} = useTabList\(/);
  assert.match(src, /\{\.\.\.listProps\}/);
  assert.match(src, /\{\.\.\.tabProps\(i\)\}/);
  assert.match(src, /progress\?: number/, "the pager binding is part of the API");
  assert.match(src, /value: K \| null/, "null = nothing selected (the collapsed dock)");
  assert.doesNotMatch(src, /className="chrome-shade"|className="chrome-cap"/, "shade and cap belong to Band");
  assert.match(src, /band \? strip : <Band>\{strip\}<\/Band>/, "standalone Sections wraps itself in its own Band");
  assert.match(src, /const band = density === "floating" \? null : ctx;/, "floating adopts no Band");
  assert.doesNotMatch(src, /min-h-|minHeight/, "heights, not floors");
  // geometry is measured in BAND space via rect deltas, so a leading slot before the strip cannot shift the hole
  assert.match(src, /getBoundingClientRect\(\)/);
  assert.match(src, /band\.paint\(next \? \[next\] : \[\], /, "Sections hands the Band a box LIST — the split view's Panes hands two");
  // read RAW, not through `read`: stripComments would delete the very comment
  // this looks for, and a vacuous assertion is worse than none
  assert.doesNotMatch(readFileSync(path.join(here, "..", "components/chrome/Sections.tsx"), "utf8"), /eslint-disable/, "no rule is disabled");
  assert.match(src, /useLayoutEffect\(\(\) => \{[\s\S]*?\}, \[keySig\]\);/, "effect A depends only on keySig");
  assert.match(src, /useLayoutEffect\(\(\) => \{[\s\S]*?\}, \[active, progress, keySig, band\]\);/, "effect B depends on active/progress/keySig/band");
  assert.match(src, /applyRef\.current/, "effect A calls the latest apply via a ref, not by re-wiring");
  assert.match(src, /programmatic\.current = true/, "the scroll-into-view write is flagged as self-caused (F6b)");
  // the ✕ is a span role=button INSIDE the tab (a nested <button> is invalid HTML), keyboard-operable
  assert.match(src, /role="button"[\s\S]{0,200}tabIndex=\{0\}[\s\S]{0,300}onKeyDown/);
  // …and it is a real target: 11px of icon, with a 24×24 borrowed hit area on a coarse pointer
  assert.match(src, /<X size=\{11\}/);
  const chromeCss = stripCssComments(readFileSync(path.join(here, "..", "components/chrome/chrome.css"), "utf8"));
  assert.match(chromeCss, /@media \(pointer: coarse\)\s*\{[^}]*\.chrome-tab-close::after\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;/, "the ✕ has a 24×24 coarse-pointer hit area");
  // Overflow: the tab loop closes the tablist, then the two pointer-only chevrons and
  // the wrapper that carries data-more close the file.
  assert.match(src, /<\/button>\s*\)\)\}\s*<\/div>\s*<button[^>]*chrome-more-start[\s\S]*?<\/button>\s*<button[^>]*chrome-more-end[\s\S]*?<\/button>\s*<\/div>\s*\);\s*\}\s*$/, "vacuity anchor: the strip's real tail at the END of the file");
});

test("Band owns exactly one shade and both caps, paints them itself, and provides the context", () => {
  const src = read("components/chrome/Band.tsx");
  assert.match(src, /import \{ BandContext, type BandHandle \} from "@\/app\/lib\/chrome\/bandContext"/);
  assert.equal((src.match(/className="chrome-shade"/g) ?? []).length, 1, "exactly one shade layer");
  assert.equal((src.match(/className="chrome-cap"/g) ?? []).length, 2, "two caps — the split view paints a hole per pane; cap B rests at opacity 0");
  // the shade/cap refs never leave this file: the Band is the only writer, so
  // nothing has to mutate a value it reached through useContext
  assert.match(src, /const paint = useCallback\(/, "paint is stable for the life of the Band");
  assert.match(src, /<BandContext value=\{handle\}>/, "React 19 context-as-provider");
  assert.match(src, /<\/BandContext>\s*\);\s*\}\s*$/, "vacuity anchor");
  const ctx = read("lib/chrome/bandContext.ts");
  assert.match(ctx, /paint: \(boxes: readonly Box\[\], animate: boolean\) => void;/, "the handle takes a box LIST; [] closes every hole");
  assert.match(ctx, /export const BandContext = createContext<BandHandle \| null>\(null\);\s*$/, "context default is null (standalone Sections)");
});

test("Segmented, Chips and Rail each render through useTabList and own no keyboard model", () => {
  for (const [name, extra] of [
    ["Segmented", /className="chrome-thumb"/],
    ["Chips", /onMouseDown=\{onItemMouseDown\}/],
    // Rail uses manual activation — its panels (Gadget's nine) fetch on
    // mount, so arrowing through them must move focus without selecting
    ["Rail", /orientation: "vertical", activation: "manual"/],
  ] as const) {
    const src = read(`components/chrome/${name}.tsx`);
    assert.match(src, /import \{ useTabList, type TabItem \} from "@\/app\/lib\/chrome\/useTabList"/, `${name}: hook import`);
    assert.match(src, /\{\.\.\.listProps\}/, `${name}: spreads listProps`);
    // Rail hands each tab its props through RailTab (the folded rail renders by group).
    if (name === "Rail") {
      assert.match(src, /props=\{tabProps\(i\)\}/, "Rail: hands RailTab its tabProps");
      assert.match(src, /<button \{\.\.\.props\} className="chrome-tab"/, "Rail: RailTab spreads them");
    } else assert.match(src, /\{\.\.\.tabProps\(i\)\}/, `${name}: spreads tabProps`);
    assert.doesNotMatch(src, /onKeyDown|ArrowLeft|ArrowRight/, `${name}: keys live in useTabList only`);
    assert.doesNotMatch(src, /min-h-|minHeight/, `${name}: heights, not floors`);
    assert.match(src, extra, `${name}: skin-specific contract`);
    assert.match(src, /<\/div>\s*\);\s*\}\s*$/, `${name}: vacuity anchor at the END`);
  }
});

test("Segmented drives its thumb with custom properties, so the move is transform-only", () => {
  const src = read("components/chrome/Segmented.tsx");
  // Math.max(1, …) — zero items must not divide the track width by zero
  assert.match(src, /"--chrome-n": Math\.max\(1, items\.length\)/);
  assert.match(src, /"--chrome-i": active/);
});

test("index.ts is the only door and exports every skin", () => {
  const src = read("components/chrome/index.ts");
  for (const name of ["Sections", "Segmented", "Chips", "Rail"]) {
    assert.match(src, new RegExp(`export \\{ ${name}(, type \\w+)? \\} from "\\./${name}"`), `${name} missing from the index`);
  }
  assert.match(src, /export \{ RailLayout \} from "\.\/RailLayout"/, "RailLayout missing from the index (F5)");
  assert.match(src, /export type \{ TabItem \} from "@\/app\/lib\/chrome\/useTabList"/);
});

test("StoreContent renders Sections from the index and carries no tab skin of its own", () => {
  const rel = "features/store/StoreContent.tsx";
  const src = read(rel);
  assert.match(src, /import \{ Sections \} from "@\/app\/components\/chrome"/, `${rel}: imports the index`);
  assert.match(src, /<Sections[^>]*label="Store sections"/, `${rel}: renders Sections`);
  assert.doesNotMatch(src, /role="tab/, `${rel}: no hand-rolled tab`);
  assert.doesNotMatch(src, /bg-surface-3 text-strong/, `${rel}: the pill skin is gone`);
  // vacuity anchor — the END of the file
  assert.match(read("features/store/StoreContent.tsx"), /\{tab === "history" && \([\s\S]*\}\s*$/);
});

test("the Mod and Admin panels are a Rail with a search above it, like the account windows", () => {
  for (const [rel, label] of [
    ["features/moderation/ModPanel.tsx", "Mod panel sections"],
    ["features/instance/AdminPanel.tsx", "Admin panel sections"],
  ] as const) {
    const src = read(rel);
    assert.match(src, /import \{ Rail, RailLayout \} from "@\/app\/components\/chrome"/, `${rel}: imports the index`);
    assert.match(src, new RegExp(`<Rail [\\s\\S]{0,200}?label="${label}"`), `${rel}: renders the Rail`);
    assert.match(src, /type="search"/, `${rel}: has the search`);
    assert.doesNotMatch(src, /<Sections\b/, `${rel}: no band strip`);
    assert.doesNotMatch(src, /role="tab/, `${rel}: no hand-rolled tab`);
  }
  assert.match(read("features/moderation/ModPanel.tsx"), /\{shown === "identity" && <IdentitySection note=\{note\} \/>\}\s*<\/div>\s*<\/RailLayout>[\s\S]*?<ModUndoToast \/>\s*<\/div>\s*\);\s*\}\s*$/, "ModPanel read to its end");
});

test("EmotePicker filters with Chips (keepFocus preserved); ReactionPicker switches with Segmented", () => {
  const emote = read("components/EmotePicker.tsx");
  assert.match(emote, /import \{ Chips \} from "@\/app\/components\/chrome"/);
  assert.match(emote, /<Chips[^>]*label="Emote providers"[^>]*onItemMouseDown=\{keepFocus\}/);
  assert.doesNotMatch(emote, /border-b-2/, "the underline-tab idiom is gone");
  assert.match(emote, /<\/ComposerPopover>\s*\);\s*\}\s*$/, "vacuity anchor");

  const react = read("components/ReactionPicker.tsx");
  assert.match(react, /import \{ Segmented \} from "@\/app\/components\/chrome"/);
  assert.match(react, /<Segmented[^>]*label="Reaction kind"/);
  assert.doesNotMatch(react, /flex-1 py-1\.5 text-xs font-semibold/, "the filled-halves skin is gone");
  assert.match(react, /document\.body,?\s*\);\s*\}\s*$/, "vacuity anchor: the portal call closes the file");
});

test("the chrome grid is two HEIGHT tokens, defined once and registered as <length>", () => {
  const raw = readFileSync(path.join(here, "..", "globals.css"), "utf8");
  const css = stripCssComments(raw);
  assert.match(css, /--chrome-top-h:\s*calc\(var\(--tab-size\) \+ 22px\);/, "top token: tab size + 22px (36px at the default)");
  assert.match(css, /--chrome-bottom-h:\s*max\(48px, calc\(var\(--title-size\) \* 1\.25 \+ 30px\), calc\(var\(--composer-ctl\) \+ 6px\)\);/,
    "bottom token: 48px at the defaults, then the viewer's Title-size slider AND the chat Text-size slider — " +
    "both bottom bars read this one token, so it must clear the taller content. Term 2 is the meta bar's " +
    "two-line title block (--title-size x 1.25 + the 16px meta line + 2px + 12px breathing + the hairline): " +
    "47.5 at 0.875rem so the max holds 48, 65px at the 2x ceiling, where a fixed 48 clipped it by 6px over the " +
    "hairline onto the player. Term 3 is the composer's row, PINNED to --composer-ctl (--chat-font-size x 1.25 " +
    "+ 0.5rem + 2px) so it cannot shift when the first letter arrives, + 6px of breathing and the hairline: " +
    "47.04 at the 1.352rem default so 48 still holds, 60 at the 2rem ceiling — where two terms left 54px of row " +
    "in a 47px box, 7px of overflow");
  // --composer-ctl must be on :root for a registered <length> on :root to read it.
  assert.match(css, /:root \{[^}]*--composer-ctl:\s*calc\(var\(--composer-line\) \+ 0\.5rem \+ 2px\);/,
    "the third term's input is declared on :root, not on some other selector");
  assert.equal((css.match(/--chrome-top-h:/g) ?? []).length, 1, "the top token is defined ONCE");
  assert.equal((css.match(/--chrome-bottom-h:/g) ?? []).length, 1, "the bottom token is defined ONCE");
  // Registered, so getComputedStyle() hands JS the RESOLVED px (readChromePx)
  assert.match(css, /@property --chrome-top-h \{\s*syntax:\s*"<length>";\s*inherits:\s*true;\s*initial-value:\s*36px;\s*\}/);
  assert.match(css, /@property --chrome-bottom-h \{\s*syntax:\s*"<length>";\s*inherits:\s*true;\s*initial-value:\s*48px;\s*\}/);
  // CHROME_INITIAL_PX (readChromePx's fallback) must mirror these two
  // initial-value lines exactly — it is what a browser with no @property
  // support falls back to, and a drift here is a silent wrong dock height.
  assert.equal(CHROME_INITIAL_PX[CHROME_TOP_H], 36);
  assert.equal(CHROME_INITIAL_PX[CHROME_BOTTOM_H], 48);
  // vacuity anchor — the END of globals.css
  assert.match(raw.slice(-400), /timer-delta-fade[\s\S]*\}\s*$/);
});

test("Bar is ONE in-flow strip of token height: hides by its own margin, overlays ABSOLUTE at the edge, never a floor", () => {
  const src = read("components/chrome/Bar.tsx");
  assert.match(src, /import \{ Band \} from "\.\/Band"/);
  assert.match(src, /slot: "top" \| "bottom"/);
  assert.match(src, /const state = hidden \? "hidden" : overlay \? "overlay" : undefined;/, "hidden wins over overlay");
  assert.match(src, /inert=\{hidden \|\| occluded\}/, "a hidden OR occluded bar's controls leave the tab order (occluded is the covered-not-pulled case)");
  assert.match(src, /aria-hidden=\{hidden \|\| occluded \|\| undefined\}/);
  assert.doesNotMatch(src, /chrome-bar-zone/, "there is no proximity-zone ELEMENT — one sat over the host's own content and oscillated; proximity is now a pointermove listener with hysteresis inside Bar itself, pinned by bar.render.test.ts (a real mount, not a source scan)");
  assert.match(src, /\{band \? <Band>\{slots\}<\/Band> : slots\}/, "band = the Band spans the whole bar");
  assert.match(src, /\{leading != null && leading !== false &&/, "a withheld slot (`leading={cond && <X/>}`) renders no lane, so it cannot leave the bar's gap behind");
  assert.match(src, /\{trailing != null && trailing !== false &&/);
  assert.doesNotMatch(src, /className\?:/, "no className PROP — consumers cannot put a floor on it");
  assert.doesNotMatch(src, /min-h-|minHeight/, "heights, not floors");
  assert.match(src, /<\/div>\s*\);\s*\}\s*$/, "vacuity anchor");

  const css = stripCssComments(readFileSync(path.join(here, "..", "components/chrome/chrome.css"), "utf8"));
  assert.match(css, /\.chrome-bar-top\s*\{[^}]*height:\s*var\(--chrome-top-h\)/, "top bars are the top token tall");
  assert.match(css, /\.chrome-bar-bottom\s*\{[^}]*height:\s*var\(--chrome-bottom-h\)/, "bottom bars are the bottom token tall");
  // A BORDER hairline sits inside the token height (border-box), so a bar's
  // slots — `height: 100%` of the content box — would centre half a pixel off
  // the bar's visual centre (every band's title and ✕ at cy 17.5 in a 36px
  // bar). The hairline is an inset shadow — it paints over the content box
  // without shrinking it. (A mirroring padding centres the slots too, but
  // pushes a band bar's shade 1px off the edge.)
  assert.match(css, /\.chrome-bar-top\s*\{[^}]*box-shadow:\s*inset 0 -1px 0 var\(--color-edge-strong\)/, "the top bar's hairline is an inset shadow, so its slots centre on the bar");
  assert.doesNotMatch(css, /\.chrome-bar-top\s*\{[^}]*(?:border-bottom|padding-top)/, "no border and no padding on the top bar — either one shifts the slots");
  assert.match(css, /\.chrome-bar-bottom\s*\{[^}]*box-shadow:\s*inset 0 1px 0 var\(--color-edge-strong\)/, "the bottom bar's hairline is an inset shadow");
  assert.doesNotMatch(css, /\.chrome-bar-bottom\s*\{[^}]*(?:border-top|padding-bottom)/);
  // The seam shade composes WITH the hairline rather than replacing it, and a
  // band bar (whose shade carries its own hairline) drops the bar's but keeps
  // the seam.
  assert.match(css, /\.chrome-bar-top\[data-seam\]\s*\{[^}]*box-shadow:\s*var\(--seam-shade-box\), inset 0 -1px 0 var\(--color-edge-strong\)/);
  assert.match(css, /\.chrome-bar-top:has\(> \.chrome-band\)\s*\{[^}]*box-shadow:\s*none/);
  assert.match(css, /\.chrome-bar-top\[data-seam\]:has\(> \.chrome-band\)\s*\{[^}]*box-shadow:\s*var\(--seam-shade-box\);/);
  // A band bar contributes no inline padding, so its edge controls carry a
  // small inset of their own (the compact toggle sat ~5px from the panel edge).
  assert.match(css, /\.chrome-bar:has\(> \.chrome-band\) \.chrome-bar-lead\s*\{[^}]*padding-left:\s*\.25rem/);
  assert.match(css, /\.chrome-bar:has\(> \.chrome-band\) \.chrome-bar-trail\s*\{[^}]*padding-right:\s*\.25rem/);
  assert.doesNotMatch(css, /min-height/, "no floor anywhere in chrome");
  assert.match(css, /\.chrome-bar-top\[data-state="hidden"\]\s*\{[^}]*margin-top:\s*calc\(-1 \* var\(--chrome-top-h\)\)/, "hidden = the whole height, pulled out of the flow");
  assert.match(css, /\.chrome-bar-bottom\[data-state="hidden"\]\s*\{[^}]*margin-bottom:\s*calc\(-1 \* var\(--chrome-bottom-h\)\)/);
  // Overlay is a DIFFERENT mechanism from hidden, not the same pull parked.
  // The margin pull is written as one token, so it equals the height only while
  // the bar IS one token — a grown bar parks short, and clamping it back to the
  // token instead gives a compact composer a 35px content
  // box for ~76px of reply banner + row. Absolute at the edge has nothing to
  // measure: the park is 100% of the bar's OWN height, so a grown bar reveals
  // taller.
  assert.match(css, /\.chrome-bar\[data-state="overlay"\]\s*\{[^}]*position:\s*absolute;[^}]*inset-inline:\s*0/, "an overlay bar is out of flow at its panel's edge, not margin-pulled");
  assert.match(css, /\.chrome-bar-top\[data-state="overlay"\]\s*\{[^}]*top:\s*0;\s*margin-top:\s*0;\s*translate:\s*0 -100%/, "parked = its own height above the host's top edge");
  assert.match(css, /\.chrome-bar-bottom\[data-state="overlay"\]\s*\{[^}]*bottom:\s*0;\s*margin-bottom:\s*0;\s*translate:\s*0 100%/, "parked = its own height below the host's bottom edge");
  assert.match(css, /\.chrome-bar-top\[data-state="overlay"\]:is\(:hover, :has\(:focus-visible\), \[data-revealed\]\)\s*\{[^}]*translate:\s*0 0;[^}]*transition-delay:\s*150ms/, "reveal on hover / keyboard focus / revealed, delayed 150ms; hiding immediate");
  assert.match(css, /\.chrome-bar-bottom\[data-state="overlay"\]:is\(:hover, :has\(:focus-visible\), \[data-revealed\]\)\s*\{[^}]*translate:\s*0 0;[^}]*transition-delay:\s*150ms/);
  assert.match(css, /\.chrome-bar-bottom:has\(\[data-chrome-grow\]\)\s*\{[^}]*height:\s*auto/, "growth is opt-in and named");
  // There is no zone ELEMENT: one would sit over the host's own content
  // (elementFromPoint returning the zone instead of, say, the radio card's
  // controls in theatre) and oscillate (revealing moves the zone, which
  // un-hovers the pointer, which parks the bar, which re-arms the zone).
  // Proximity is coordinate-driven inside Bar itself (a pointermove listener
  // with hysteresis) — pinned by bar.render.test.ts, a real mount, since a
  // source scan cannot see a listener's behaviour.
  assert.doesNotMatch(css, /chrome-bar-zone/, "the zone's rules are gone with the element");
  // Vacuity anchor for the negative assertion above: with no positive
  // `.chrome-bar-zone` assertion late in the
  // file, nothing else here proves `css` reaches anywhere near the actual
  // end of chrome.css rather than a read truncated partway through (where
  // "contains no chrome-bar-zone" would be true for the empty reason). Match
  // all the way to the file's own last rule.
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\}\s*\}\s*$/, "reaches chrome.css's own closing rule and brace — the css variable used above is genuinely the whole file");
  // ONLY hidden is reset to the token — that state's distance IS one token of
  // negative margin, so the pull must equal the height, and a hidden bar shows
  // nothing anyway. An OVERLAY bar must NOT be reset: it is absolute, so a grown
  // one simply reveals taller, which is what makes the composer's reply banner
  // and expanded field work in desktop compact. Same specificity as the grow
  // rule (class + attribute either way), so this only wins by coming LATER.
  assert.match(css, /\.chrome-bar-bottom\[data-state="hidden"\]\s*\{[^}]*height:\s*var\(--chrome-bottom-h\);\s*padding-block:\s*0/, "a HIDDEN bottom bar is exactly the token, however grown it was — padding-block too, or the grow rule's .375rem squeezes the reset box");
  assert.doesNotMatch(css, /\.chrome-bar-bottom\[data-state\]\s*\{/, "the reset must not reach [data-state=\"overlay\"] — that is the 35px-content-box clip");
  assert.ok(
    // the selector also appears earlier (the margin pull), so pin the rule text
    css.indexOf('.chrome-bar-bottom[data-state="hidden"] { height:') > css.indexOf(".chrome-bar-bottom:has([data-chrome-grow])"),
    "equal specificity — the token reset must come AFTER the grow rule or growth wins and the pull is short",
  );
  assert.match(css, /\.chrome-bar-top\[data-seam\]\s*\{[^}]*box-shadow:\s*var\(--seam-shade-box\)/, "the one seam shade, applied by Bar");
  assert.match(css, /\.chrome-bar\s*\{[^}]*transform:\s*translateZ\(0\)/, "the hairline-shimmer promotion — the bars' half of what .chat-tabbar carried; .chat-scroll-layer keeps its own");
  assert.match(css, /\.chrome-bar\s*\{[^}]*z-index:\s*10;/, "the seam ::after (z 11) must still outrank a bar");
  assert.match(css, /\.chrome-bar\[data-state="overlay"\]\s*\{[^}]*z-index:\s*30/, "a parked bar slides OVER the panel's own positioned children (z 10)");
  assert.match(css, /\.chrome-bar \.chrome-sections\s*\{[^}]*height:\s*100%/, "inside a bar the strip fills the bar's content box");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.chrome-bar/, "reduced motion reaches the bar");
});

test("index.ts exports Bar", () => {
  assert.match(read("components/chrome/index.ts"), /export \{ Bar, type BarProps \} from "\.\/Bar"/);
});

test("the video top bar is a Bar (no seam, overlay + hidden from barVisibility) and --video-chrome is a sum, not a measurement", () => {
  const embed = read("components/StreamEmbedBar.tsx");
  // Both skins come through the ONE door (check-chrome forbids reaching inside),
  // and so does BarButton.
  assert.match(embed, /import \{ Bar, BarButton, IconRail \} from "@\/app\/components\/chrome"/);
  assert.match(embed, /<Bar\s+slot="top"\s+name="video-top"\s+overlay=\{overlay\}\s+hidden=\{hidden\}\s+occluded=\{occluded\}\s+seam=\{false\}/);
  // The bar's shape: the center is the
  // mode rail, and the trailing cluster is gear · theatre · fold and nothing
  // else — no LIVE pill, no timer, no featured-streamer name or dots.
  assert.match(embed, /center=\{[\s\S]{0,400}?<IconRail/, "the center slot is the mode rail");
  assert.match(embed, /trailing=\{[\s\S]*?\}\s*\/>/, "there is still a trailing cluster");
  const trailing = embed.slice(embed.indexOf("trailing={"));
  assert.deepEqual(
    (trailing.match(/<(GearSix|CornersOut|CaretUp|CaretDown|StreamTimerIndicator|IconRail)\b/g) ?? []),
    ["<GearSix", "<CornersOut", "<CaretDown", "<CaretUp"],
    "trailing = mod gear, theatre, fold (the caret flips with `folded`) — nothing else"
  );
  assert.doesNotMatch(embed, /collapse-row|is-collapsed|min-h-9|peer-hover|inert=/, "the old wrapper is gone");
  assert.match(embed, /\/>\s*\);\s*\}\s*$/, "vacuity anchor");

  const sv = read("components/StreamView.tsx");
  assert.doesNotMatch(sv, /ResizeObserver|--video-chrome|children\[0\]|children\[2\]/, "the measurement is gone");
  assert.match(sv, /<StreamEmbedBar\s+overlay=\{bars\.overlay\}\s+hidden=\{bars\.topHidden\}/);
  assert.match(sv, /<StreamMetaBar\s+overlay=\{bars\.overlay\}\s+hidden=\{bars\.bottomHidden\}/);
  assert.match(sv, /const GuestSupportContent = dynamic\([\s\S]*\);\s*$/, "vacuity anchor");

  const css = stripCssComments(readFileSync(path.join(here, "..", "globals.css"), "utf8"));
  assert.match(css, /\.bb-video-col\s*\{[^}]*--video-chrome:\s*calc\(var\(--chrome-top-h\) \+ var\(--chrome-bottom-h\) \+ 2 \* var\(--frame-width, 2px\)\)/);
  assert.doesNotMatch(css, /var\(--video-chrome, 88px\)/, "a fallback would hide a missing definition");
  assert.equal((css.match(/var\(--video-chrome\)/g) ?? []).length, 3, "the three attached/radio consumers read the sum");
});

test("the video bottom bar is a one-row Bar", () => {
  const src = read("components/StreamMetaBar.tsx");
  assert.match(src, /import \{ Bar \} from "@\/app\/components\/chrome"/);
  assert.doesNotMatch(src, /useState|CaretDown|meta-bar|min-h-|minHeight/);
  assert.match(src, /\/>\s*\);\s*\}\s*$/, "vacuity anchor");
});

test("ChatTabBar's Live/Matrix and FoldedTabControl's pill render Sections from the index", () => {
  assert.match(read("features/chat/ChatTabBar.tsx"), /<Sections\s+items=\{items\}\s+value=\{value\}\s+onChange=\{select\}/);
  assert.match(read("components/FoldedTabControl.tsx"), /<Sections\s+density="floating"/);
});

test("the live composer's Bar keeps the compact-overlay reveal state-driven and measured for the messages' slide", () => {
  const src = read("features/chat/ChatSidebar.tsx");
  // `hidden={composerReplaced}` since the 4a follow-up: the chat TUI's slide-in window replaces the box (chatTakeover.test.ts).
  assert.match(src, /<Bar\s+slot="bottom"\s+name="chat-bottom"\s+hidden=\{composerReplaced\}\s+overlay=\{!!compactOverlay\}\s+revealed=\{composerOpen\}\s+ref=\{composerRef\}/);
  assert.doesNotMatch(src, /composer-shell|absolute bottom-0 inset-x-0 h-6 z-20/, "the old wrapper and its private zone are gone");
  assert.match(src, /<\/aside>\s*\);\s*\}\s*$/, "vacuity anchor");
});

test("the seven Matrix panel headers (six files) are top Bars named mx-header; .mx-panel-header is gone", () => {
  const files = ["ChannelColumn", "ForumView", "MatrixView", "ThreadPanel", "ThreadsListPanel", "Timeline"];
  let bars = 0;
  for (const f of files) {
    const src = read(`features/community/${f}.tsx`);
    assert.match(src, /import \{ Bar(?:, BarButton)?(?:, WindowLayerTarget)?(?:, BootSequence)? \} from "@\/app\/components\/chrome"/, `${f}: imports the index`);
    assert.doesNotMatch(src, /mx-panel-header/, `${f}: the header class is gone`);
    bars += (src.match(/<Bar\s+slot="top"\s+name="mx-header"/g) ?? []).length;
  }
  assert.equal(bars, 7, "six files, seven headers (MatrixView has two member-list headers)");
  const css = stripCssComments(readFileSync(path.join(here, "..", "globals.css"), "utf8"));
  assert.doesNotMatch(css, /\.mx-panel-header/);
  assert.match(css, /\.chat-tabbar-hidden \[data-bar="mx-header"\],\s*\.chat-tabbar-hidden \.pin-row\s*\{\s*padding-right:\s*calc\(var\(--folded-ctl-w, 0px\) \+ 0\.5rem\);/);
});

test("the dock row is a band Bar with Sections; TabRow.tsx is gone", () => {
  const src = read("components/BottomDock/index.tsx");
  assert.match(src, /import \{ Bar, Sections \} from "@\/app\/components\/chrome"/);
  assert.match(src, /import \{ CHROME_TOP_H, readChromePx \} from "@\/app\/lib\/chrome\/chromeTokens"/);
  assert.match(src, /<Bar\s+slot="top"\s+name="dock"\s+band/);
  // \b on TabRow: the COMPONENT is gone, but the space rule's `tabRowPx` /
  // `setTabRowPx` stay — they are the token now (dockState.test.ts pins that),
  // and a bare /TabRow/ would read them as the deleted component.
  assert.doesNotMatch(src, /\bTabRow\b|caretTab|lastTab|uppercase tracking-wide/);
  assert.match(src, /<\/div>\s*\);\s*\}\s*$/, "vacuity anchor");
  assert.throws(() => readFileSync(path.join(here, "..", "components/BottomDock/TabRow.tsx")), "TabRow.tsx must be deleted");
});

test("no retired chrome selector survives in globals.css, and .collapse-row is gone with its rules", () => {
  const css = stripCssComments(readFileSync(path.join(here, "..", "globals.css"), "utf8"));
  for (const sel of [".chat-tabbar ", ".chat-tabbar:", ".chat-tabbar{", ".chat-tab-btn", ".composer-shell", ".meta-bar", ".mx-panel-header", ".collapse-row", ".chat-folded-ctl", ".modal-overlay"]) {
    assert.ok(!css.includes(sel), `${sel} is still in globals.css`);
  }
  assert.doesNotMatch(css, /is-collapsed/);
});

test("Panes is a group of two pane headers — never a tab list — and the split branch renders it", () => {
  const src = read("components/chrome/Panes.tsx");
  assert.match(src, /import \{ BandContext \} from "@\/app\/lib\/chrome\/bandContext"/);
  assert.doesNotMatch(src, /role="tab|aria-selected|useTabList/, "two open panes cannot be a tablist (exactly-one-selected)");
  assert.match(src, /role="group"/);
  // NOT `band.paint([`. That shape appears ONLY in the unmount cleanup —
  // and not even there, because it is written `band?.paint([`, which the
  // literal `band\.paint\(\[` cannot match. Pin the two-box paint itself: one
  // map over every pane header, handed to the Band in ONE call.
  assert.match(src, /const boxes: Box\[\] = buttons\.map\(/, "every pane header is measured, not a selected one");
  assert.match(src, /band\.paint\(boxes, animate\)/, "Panes hands the Band BOTH boxes at once");
  assert.match(src, /useLayoutEffect\(\(\) => \(\) => \{ band\?\.paint\(\[\], false\); \}, \[band\]\);/, "unsplitting must not leave the pane holes punched");
  assert.doesNotMatch(src, /min-h-|minHeight|className\?:/, "heights, not floors; no className door");
  assert.match(src, /<\/div>\s*\);\s*\}\s*$/, "vacuity anchor");
  assert.match(read("components/chrome/index.ts"), /export \{ Panes, type PanesProps, type PaneDef \} from "\.\/Panes"/);

  const bar = read("features/chat/ChatTabBar.tsx");
  assert.match(bar, /<Panes[\s\S]{0,400}firstWidth="var\(--live-col-w, 50%\)"/, "the header mirrors the real live-column width");
  assert.doesNotMatch(bar, /ArrowsOutSimple/, "the expand glyph lives in Panes now");

  const hook = read("lib/useChatSplitView.ts");
  assert.match(hook, /setProperty\("--live-col-w", w \+ "px"\)/, "the divider drag feeds the header live, without a re-render");
  assert.match(read("features/chat/ChatSidebar.tsx"), /"--live-col-w":/, "the committed width seeds the variable on the aside");

  const css = stripCssComments(readFileSync(path.join(here, "..", "components/chrome/chrome.css"), "utf8"));
  assert.match(css, /\.chrome-pane \+ \.chrome-pane\s*\{[^}]*flex:\s*1 1 auto;\s*border-left:\s*1px solid var\(--color-edge\)/, "the second pane takes the rest, and the split line is that border");
  assert.match(css, /\.chrome-pane > \.chrome-tab\[data-open\]\s*\{[^}]*color:\s*var\(--color-strong\);\s*font-weight:\s*600/, "the heavier ink of an OPEN pane, without aria-selected");
  assert.match(css, /\.chrome-pane:is\(:hover, :focus-within\) \.chrome-pane-expand\s*\{[^}]*opacity:\s*1/, "the ⤢ is revealed by that pane's own hover or keyboard focus");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.chrome-pane-expand/, "reduced motion reaches the reveal");
});
