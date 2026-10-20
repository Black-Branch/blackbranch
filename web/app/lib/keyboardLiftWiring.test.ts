// Wiring guards for the keyboard model: the shell PINS at
// baseHeight and four keyboard-hosting surfaces compensate — three translate
// up by K (useKeyboardLift: the stream chat panel, /popout, /community
// mode-1), one shrinks by height (/mod's scroll box, which can't translate).
//
// These are static source checks, not behavioural ones — what has to be
// proven here is WIRING (is every consumer actually calling the hook / using
// the right prop), not what the hook itself does when it runs (that is
// useKeyboardLift.render.test.ts's job) or what the shell's pin does when the
// keyboard actually moves (useViewportHeightVar.render.test.ts's job).
//
// Run: node --test app/lib/keyboardLiftWiring.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments, stripCssComments } from "./testSource.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const raw = (p: string) => readFileSync(join(webRoot, p), "utf8");
const readCode = (p: string) => stripComments(raw(p));

// ── Lift site 1: the stream chat panel ───────────────────────────────────────

test("StreamView lifts the chat panel by K", () => {
  const src = readCode("app/components/StreamView.tsx");
  assert.match(src, /useKeyboardLift\(chatPanelRef\)/,
    "StreamView no longer lifts the chat panel — its composer would sit under the keyboard " +
    "for the whole open");
  // Both must land on the SAME opening tag (order-agnostic lookaheads bounded by the tag's
  // own closing `>`) — a ref on a wrapper with the class one level down would still match
  // two separate `ref=`/`bb-chat-panel` greps while silently lifting the wrong box.
  assert.match(src, /<div(?=[^>]*\bref=\{chatPanelRef\})(?=[^>]*\bbb-chat-panel\b)[^>]*>/,
    "chatPanelRef and the bb-chat-panel class are no longer on the SAME element — a future " +
    "refactor could split them across a wrapper and its child, and useKeyboardLift would then " +
    "move an element that isn't the panel the CSS (and z+backing) actually occludes against");
});

// ── Lift site 2: /popout ─────────────────────────────────────────────────────

test("PopoutView lifts its root by K", () => {
  const src = readCode("app/components/PopoutView.tsx");
  assert.match(src, /useKeyboardLift\(rootRef\)/,
    "PopoutView no longer lifts its root — the popout composer would sit under the keyboard");
  assert.match(src, /ref=\{rootRef\}/,
    "rootRef is never attached to an element — useKeyboardLift has nothing to move");
});

// ── Lift site 3: /community (embedded vs. standalone page) ──────────────────

test("MatrixView lifts UnifiedLayout's container, gated on pageChrome", () => {
  const src = readCode("app/features/community/MatrixView.tsx");
  const at = src.indexOf("useKeyboardLift(containerRef, pageChrome)");
  assert.notEqual(at, -1,
    "UnifiedLayout no longer lifts its container gated on pageChrome — embedded " +
    '(layout="sidebar") this tree lives INSIDE the stream chat panel, which already lifts; ' +
    "without the gate it would DOUBLE-LIFT there (the blast-radius audit's one sharp edge)");
});

// ── Lift site 4: /mod — height, not translation ──────────────────────────────

test("ModPageShell shrinks by height, never translates", () => {
  const src = readCode("app/(main)/mod/ModPageShell.tsx");
  assert.match(src, /useKeyboardInset/,
    "ModPageShell no longer reads the keyboard inset — the scroll box can't compensate");
  assert.match(src, /calc\(100% - /,
    "ModPageShell no longer shrinks by height — a scroll container must compensate by HEIGHT, " +
    "not translateY, or content past the keyboard is just clipped");
  assert.doesNotMatch(src, /translateY/,
    "ModPageShell is translating — a scroll box compensates by height; translating one just " +
    "clips its bottom instead of revealing it");
});

// ── kb-moving is EXTINCT as a mechanism ──────────────────────────────────────

test("the kb-moving height transition is gone from globals.css", () => {
  const code = stripCssComments(raw("app/globals.css"));
  // Vacuity anchor: prove this is really globals.css's live ruleset, not an
  // empty read — the tombstone's own PROSE is stripped along with every other
  // comment, so anchor on real code that must survive any edit here.
  assert.match(code, /\.h-app\s*\{\s*height:\s*100dvh;\s*\}/,
    "vacuity anchor: the .h-app dvh tier is gone from globals.css — is this scanning the right file?");
  assert.doesNotMatch(code, /html\.kb-moving/,
    "the kb-moving selector is back in globals.css — the shell must stay PINNED; a height " +
    "transition here re-animates the dvh tier's toolbar changes (a border shimmer)");
});

test("kb-moving/MOVING_CLASS/arm( are gone from useViewportHeightVar.ts", () => {
  const hook = readCode("app/lib/useViewportHeightVar.ts");
  // Vacuity anchor: prove the hook itself is still here before trusting the
  // absence checks below.
  assert.match(hook, /export function useViewportHeightVar/,
    "vacuity anchor: useViewportHeightVar itself is gone — is this scanning the right file?");
  assert.doesNotMatch(hook, /kb-moving/, "the kb-moving class name is back in the hook");
  assert.doesNotMatch(hook, /MOVING_CLASS/, "MOVING_CLASS is back — the arm/disarm mechanism must stay deleted");
  assert.doesNotMatch(hook, /\barm\(/, "arm( is back — the shell must PIN, not animate its own commit");
});

// ── ChatTabBar: occlusion replaces the fold ──────────────────────────────────

test("ChatTabBar occludes instead of folding for the keyboard", () => {
  const src = readCode("app/features/chat/ChatTabBar.tsx");
  assert.match(src, /occluded=\{foldForKeyboard\}/,
    "the tab bar no longer occludes for the keyboard — it must stay inert but keep its " +
    "geometry while the panel lifts, or the fold shifts the list mid-lift (two motions)");
  assert.doesNotMatch(src, /hidden=\{foldForKeyboard\}/,
    "the tab bar folds again on the Bar's `hidden` prop — that changes geometry mid-lift, " +
    "which is exactly the two-motions problem occlusion replaced");
});

// ── The phone block: video column paints above chat, opaque-backed ──────────

// Brace-matched, not a comment-window slurp: `.bb-video-col` also appears
// in the DESKTOP `@media (min-width: 768px)` block a few rules down (a
// container-type declaration, no z-index), so a scan not scoped to THIS
// media block risks reading the wrong rule entirely — same trap
// streamSeamMobile.test.ts's `seamBlock` already guards against.
function phoneBlock(css: string): string {
  const open = css.indexOf("@media (max-width: 767px)");
  assert.notEqual(open, -1, "the mobile seam @media block is gone from globals.css");
  let depth = 0;
  for (let i = css.indexOf("{", open); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open, i + 1);
  }
  assert.fail("unbalanced braces in the mobile seam @media block");
}

test("the video column gets z + an opaque backing in the keyboard flip's phone block", () => {
  const rawCss = raw("app/globals.css");
  // The marker comment stays a PRESENCE check only — prose can quote a
  // declaration verbatim (that's the whole reason the rest of this test reads
  // comment-stripped CSS instead), so it proves nothing about the live rule.
  assert.notEqual(rawCss.indexOf("The video column paints ABOVE the chat panel on phones"), -1,
    "the phone-block marker comment is gone from globals.css's mobile seam block");

  // `stripCssComments`, not `stripComments` — the latter deletes any line
  // starting with `--`, which is every custom-property declaration in this
  // file (testSource.ts's own warning).
  const block = phoneBlock(stripCssComments(rawCss));
  // Anchored on the SELECTOR itself, not a line-count window after a comment
  // — `[^}]*` is safe here because `.bb-video-col {` (unlike `::before`/
  // `::after`, which this pattern deliberately excludes by requiring `{`
  // immediately after the class) opens no nested braces of its own.
  const rule = block.match(/\.bb-video-col\s*\{([^}]*)\}/)?.[1];
  assert.ok(rule, "the plain `.bb-video-col` rule (not ::before/::after) is gone from the " +
    "mobile seam block");
  assert.match(rule, /z-index:\s*12;/,
    "the video column's z-index regressed from 12 — at REST the untransformed chat panel's top " +
    "Bar (z:10, root level) needs a column z ABOVE 10 to lose to it (z 1 breaks exactly this" +
    "); while the keyboard is up the panel's own lift (translateY(−K), a stacking " +
    "context of its own) still has to sit below this column's z for the tuck to hold either way");
  // Opaque = the page gradient (always opaque) with a solid colour under it,
  // so the backing matches the page instead of flat canvas.
  assert.match(rule, /background:\s*var\(--bg-page\);[^}]*background-color:\s*var\(--bg-body-end\);/,
    "the video column lost its opaque backing — the tucked chat top would show through it, " +
    "which defeats the whole point of occluding it");
});

// ── useKeyboardLift no longer @parked ────────────────────────────────────────

test("useKeyboardLift is landed, not parked", () => {
  const src = raw("app/lib/useKeyboardLift.ts");
  assert.match(src, /export function useKeyboardLift/,
    "vacuity anchor: useKeyboardLift itself is gone — is this scanning the right file?");
  assert.doesNotMatch(src, /@parked/,
    "useKeyboardLift still carries @parked — it has landed consumers " +
    "(StreamView, PopoutView, MatrixView, ModPageShell)");
});
