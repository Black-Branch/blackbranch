// WindowLayerTarget registers its own element per pane and unregisters on
// unmount — the DOM half of the Task-1 registry contract, whose
// stale-unregister safety exists precisely for this component's StrictMode
// double-mount.
//
// ── Why this file also carries a source scan ──────────────────────────────
// The mount test above proves the COMPONENT works; it says nothing about
// whether any host still RENDERS it. check-orphans only proves
// WindowLayerTarget is referenced from somewhere — a later edit that deletes
// one of the three pane mounts, or the active-pane reporting effect, would
// leave `npm run check:all` green while the window layer quietly stopped
// following the panes. The house idiom (chatPager.test.ts, chromeSkins.test.ts)
// is a source scan for exactly this: pin the WIRING in the actual source text.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dom, React, act } from "../testDom.ts";
import "../testTsx.ts";
import { stripComments } from "../testSource.ts";
import { getActiveTarget, setActivePane, _resetWindowLayerForTests } from "./windowLayer.ts";
const { WindowLayerTarget } = await import("@/app/components/chrome/WindowLayerTarget");
const { createRoot } = await import("react-dom/client");

const read = (...p: string[]) => stripComments(readFileSync(join(process.cwd(), "app", ...p), "utf8"));

beforeEach(() => _resetWindowLayerForTests());

test("mount registers the rendered layer element; unmount clears it", async () => {
  setActivePane("live");
  const host = dom.window.document.createElement("div");
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(WindowLayerTarget, { pane: "live" })); });
  const el = getActiveTarget();
  assert.ok(el, "mounting the target must register it for its pane");
  assert.ok(el!.className.includes("chrome-window-layer"));
  assert.ok(host.contains(el!), "the registered element is the rendered layer div");
  await act(async () => { root.unmount(); });
  assert.equal(getActiveTarget(), null, "unmount unregisters");
});

test("the ceiling is a CALC over chrome tokens — the layer must contain NO measurement", () => {
  // No JS formula works here:
  //   raw K            → caps far below the top of the chat.
  //   K − document top → clamped to the VIEWPORT top, so the band sits under
  //                      the video column, which paints over the tucked-up
  //                      panel by design.
  //   measured d       → a SNAPSHOT taken at the K commit, while the chat's
  //                      top bar hides by animating its own margin over 200ms
  //                      (a bounce at the top of the range, and a gap under
  //                      the video panel when the tab bar is closed).
  // And the bar's height is --chrome-top-h = --tab-size + 22px — a USER
  // SETTING — so no measured constant could survive a chat-size change either.
  const css = readFileSync(join(process.cwd(), "app", "components", "chrome", "chrome.css"), "utf8");
  const layerAt = css.indexOf(".chrome-window-layer {");
  assert.notEqual(layerAt, -1, "vacuity anchor: the layer block exists");
  const block = css.slice(layerAt, css.indexOf("}", layerAt));
  assert.match(block, /--pane-ceiling: max\(0px, calc\(var\(--kb-lift\) - var\(--pane-ceiling-rise\) - var\(--pane-chrome-above\)\)\);/,
    "the ceiling must be the calc() over all three tokens, floored at 0 — declared on the layer as the token the panel subtracts");
  const src = readFileSync(join(process.cwd(), "app", "components", "chrome", "WindowLayerTarget.tsx"), "utf8");
  for (const banned of ["getBoundingClientRect", "offsetTop", "offsetParent", "getComputedStyle", "style.top"]) {
    assert.ok(!stripComments(src).includes(banned),
      `WindowLayerTarget measures again (${banned}) — the ceiling is CSS's job precisely because every term in it animates`);
  }
  assert.ok(!stripComments(src).includes("useKeyboardInset"),
    "the layer must not even read K — publishing it is useKeyboardLift's job, consuming it is the stylesheet's");
  // vacuity anchor — the END of the file, so a truncated read cannot pass
  assert.match(css, /\}\s*\}\s*$/, "vacuity anchor: chrome.css's real tail (reduced-motion block close)");
});

test("all three ceiling tokens — and the ceiling itself — are REGISTERED lengths, or the calc() fails silently", () => {
  // An unregistered custom property computes to its token TEXT. `max(0px,
  // calc(var(--kb-lift) - …))` with an unregistered, undeclared term is
  // invalid at computed-value time — the declaration is dropped and the
  // ceiling disappears with no error anywhere. Registration is also what gives
  // each an initial 0px, which is what makes a host that declares nothing
  // (the popout document, a fallback shape) simply get no ceiling.
  const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
  // --pane-ceiling is the fourth: the layer declares the max()/calc() INTO it
  // and the panel reads it back; unregistered, the panel would inherit the
  // expression's text and its max-height would be dropped the same silent way.
  for (const name of ["--kb-lift", "--pane-ceiling-rise", "--pane-chrome-above", "--pane-ceiling"]) {
    assert.match(css, new RegExp(`@property ${name} \\{ syntax: "<length>"; inherits: true; initial-value: 0px; \\}`),
      `${name} must be a registered, inheriting <length> with a 0px initial value`);
  }
});

test("the chat's own chrome term is the BAR'S OWN TOKEN, never a number, and drops to 0 when the bar leaves flow", () => {
  // The tab bar size changes with the chat customizations, so measurements
  // cannot be used. --chrome-top-h is `--tab-size + 22px`, so the bar's
  // height IS the user's chat-size setting. Referencing the same token
  // `.chrome-bar-top` sizes itself with — and that `[data-state="hidden"]`
  // pulls itself out by — is what makes the ceiling follow a customization.
  const chrome = readFileSync(join(process.cwd(), "app", "components", "chrome", "chrome.css"), "utf8");
  assert.match(chrome, /\.chrome-bar-top\s+\{ height: var\(--chrome-top-h\);/,
    "the bar's height must still BE the token this term references");
  assert.match(chrome, /\.chrome-bar-top\[data-state="hidden"\]\s+\{ margin-top:\s+calc\(-1 \* var\(--chrome-top-h\)\);/,
    "and hiding must still remove exactly that much — the term goes to 0 on the same state");
  const globals = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
  assert.match(globals, /--chrome-top-h:\s*calc\(var\(--tab-size\) \+ 22px\);/,
    "if the bar's height stops deriving from --tab-size, this whole argument needs re-checking");
  const side = stripComments(readFileSync(join(process.cwd(), "app", "features", "chat", "ChatSidebar.tsx"), "utf8"));
  // (+ `composerReplaced`: the bar is out of flow while the chat TUI has the window.)
  // (Written through useLiftToken — announced like K while the keyboard is up.)
  assert.match(side, /useLiftToken\(asideRef, "--pane-chrome-above", mobileCompactHidden \|\| compactOverlay \|\| composerReplaced \? "0px" : "var\(--chrome-top-h\)"\);/,
    "the chat host must declare its in-flow chrome from the bar's own token and the bar's own hide state");
  // vacuity anchor — the END of the file, so a truncated read cannot pass
  assert.match(side, /<\/Window>\s*\)\}\s*<\/aside>\s*\);\s*\}\s*$/, "vacuity anchor: ChatSidebar's real tail");
});

test("ONE ramp formula, ONE arming boolean — the column's transform and the layer's ceiling cannot disagree", () => {
  // Two hand-copied calc()s drift the moment a token changes, and two
  // separately-written booleans drift the moment one condition is edited. If
  // the column ramps while the host publishes nothing, a keyboard-up panel
  // caps ~50px below the video's edge; if the host publishes while the column
  // does not ramp, it caps ~50px above it — back under the video.
  const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
  assert.match(css, /html\.kb-open \.bb-video-col\[data-kb-ramp\] \{\s*transform: translateY\(calc\(-1 \* var\(--pane-ceiling-rise\)\)\);/,
    "the column's ramp must READ the shared token, not respell the calc");
  assert.match(css, /\[data-kb-ramp-host\] \{\s*--pane-ceiling-rise: calc\(var\(--chrome-top-h\) \+ var\(--panel-gap, 12px\) \+ var\(--frame-width, 2px\)\);/,
    "the one formula must live on the ramp host, which is an ancestor of BOTH the column and the chat panel");
  assert.match(css, /@property --pane-ceiling-rise \{ syntax: "<length>"; inherits: true; initial-value: 0px; \}/,
    "unregistered, getComputedStyle hands the layer the calc() TEXT and parseFloat returns NaN → a silent 0 rise");
  const sv = stripComments(readFileSync(join(process.cwd(), "app", "components", "StreamView.tsx"), "utf8"));
  assert.match(sv, /const rampArmed = narrow && !barsHidden;/, "the arming condition must be named once");
  assert.match(sv, /data-kb-ramp-host=\{rampArmed \? "" : undefined\}/, "the host attribute must come from that one boolean");
  assert.match(sv, /data-kb-ramp=\{rampArmed \? \(snapping \? "on" : "anim"\) : undefined\}/, "so must the column's");
  // vacuity anchor — the END of the file, so a truncated read cannot pass
  assert.match(sv, /const GuestSupportContent = dynamic\(\(\) => import\("\.\/SupportContent"\), \{ ssr: false \}\);\s*$/,
    "vacuity anchor: StreamView's real tail");
});

test("ChatSidebar mounts the live-pane and content-pane slot targets", () => {
  const src = read("features", "chat", "ChatSidebar.tsx");
  assert.match(src, /<WindowLayerTarget pane="live" \/>/,
    "the live pane's window-layer target is gone");
  assert.match(src, /<WindowLayerTarget pane=\{k\} \/>/,
    "the content-pane slots' window-layer target is gone");
  // vacuity anchor — the END of the file, so a truncated read cannot pass
  assert.match(src, /<\/Window>\s*\)\}\s*<\/aside>\s*\);\s*\}\s*$/, "vacuity anchor: ChatSidebar's real tail");
});

test("ChatSidebar reports the active pane to the window layer, and clears it on unmount", () => {
  const src = read("features", "chat", "ChatSidebar.tsx");
  assert.match(src, /setWindowLayerPane\(activePane\);/, "the active-pane report is gone");
  assert.match(src, /return \(\) => setWindowLayerPane\(null\);/,
    "the unmount cleanup is gone — a stale pane would leave a panel window with nowhere correct to fall back");
  // vacuity anchor — the END of the file, so a truncated read cannot pass
  assert.match(src, /<\/Window>\s*\)\}\s*<\/aside>\s*\);\s*\}\s*$/, "vacuity anchor: ChatSidebar's real tail");
});

test("Timeline mounts the matrix-pane target ONLY in the compact (sidebar-panel) mode, and ONLY while MatrixView's inner pager shows the timeline itself", () => {
  const src = read("features", "community", "Timeline.tsx");
  assert.match(src, /\{compact && windowLayerActive && <WindowLayerTarget pane="matrix" \/>\}/,
    "the gate is gone — `compact` alone would register the target from an off-screen inner mx-pane too (MatrixView's own directory/timeline/members pager), capturing a panel window opened from another pane onto an invisible layer");
  // vacuity anchor — the END of the file, so a truncated read cannot pass
  assert.match(src, /<\/div>\s*\);\s*\}\s*$/, "vacuity anchor: Timeline's real tail");
});

test("MatrixView's directory and members inner panes register the matrix target while VISIBLE (open-flow fix: no more body-portal fade for home-page opens)", () => {
  // Each inner mx-pane registers "matrix" only while it is the visible one —
  // the same one-visible-pane law as Timeline's gate above, so the registry
  // never holds two live "matrix" targets. Without these, an account card
  // opened from the rail avatar (directory showing) or a user card from a
  // member tap would fall back to the body portal and open with no animation.
  const src = read("features", "community", "MatrixView.tsx");
  assert.match(src, /\{mxActivePane === "directory" && <WindowLayerTarget pane="matrix" \/>\}/,
    "the directory-pane registration is gone");
  assert.match(src, /\{mxActivePane === "members" && <WindowLayerTarget pane="matrix" \/>\}/,
    "the members-pane registration is gone");
  // Both slots must be positioned boxes, or the absolute layer sizes itself
  // against some ancestor instead of the pane slot.
  const relSlots = src.match(/\$\{MX_PANE_SLOT\} relative/g) ?? [];
  assert.equal(relSlots.length, 2, "both registering slots carry `relative` — the layer's box");
  // vacuity anchor — the END of the file, so a truncated read cannot pass
  assert.match(src, /return <UnifiedLayout pageChrome \/>;\s*\}\s*$/, "vacuity anchor: MatrixView's real tail");
});
