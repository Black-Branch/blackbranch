// Behavioural tests for useViewportHeightVar — RENDERED, not source-scanned.
//
// Why this file exists: the costliest keyboard bug here is one source scans
// cannot catch. Every line they assert on can be present and correctly ordered
// while the defect is in WHICH DOM API the hook uses to publish the height —
// `documentElement.style.setProperty("--app-vh", …)`, an INHERITED custom
// property, rewritten on every frame of the keyboard's travel, forces a
// whole-document style recalc. Measured at ~40ms/frame against 10ms for writing
// `height` directly (390x844 mobile emulation, 4x CPU throttle). A scan sees a
// `setProperty` call and has no opinion. A render sees what landed on the
// element.
//
// The motion is also DISCRETE, and that half is behavioural to its bones: "how
// many times did the shell move" is not a question source text can answer. The
// scans still earn their place for ordering invariants (one tier live at a
// time, learn-only-while-focused).
//
// `.ts` extensions are REQUIRED on these imports — `node --test` cannot resolve
// extensionless TypeScript specifiers (same rule as windowScoped.ts).

import test from "node:test";
import assert from "node:assert/strict";
import { dom, mountHook, fakePhoneViewport } from "./testDom.ts";
import { useViewportHeightVar, isKeyboardOpen, keyboardInset, subscribeKeyboardOpen } from "./useViewportHeightVar.ts";

const BASE = 800;          // viewport with no keyboard
const KB = 340;            // a realistic keyboard
const WITH_KB = BASE - KB; // 460 — comfortably over MIN_KB (120)
/** What the seed guess produces on a device that has never seen a keyboard. */
const SEEDED = BASE - Math.round(BASE * 0.38);   // 496

async function phone(opts: { learned?: number } = {}) {
  const vp = fakePhoneViewport({ height: BASE });
  vp.reset();
  dom.window.localStorage.clear();
  if (opts.learned) dom.window.localStorage.setItem("kbHeight", String(opts.learned));
  const h = await mountHook(() => useViewportHeightVar());
  await vp.flush();
  return { vp, unmount: h.unmount };
}

/**
 * Record every DISTINCT nonzero K the hook publishes, in order — the K-level
 * analogue of `vp.heightSequence()`, needed because `heightSequence()` cannot
 * carry the "how many times did this cost a move" bound: the pinned shell
 * writes the identical `${baseHeight}px` on every commit, so a second (or
 * third) commit is invisible to a DOM-height observer. K
 * (`baseHeight − committedH`) is the one thing that still changes value per
 * commit and is public (`subscribeKeyboardOpen`/`keyboardInset()`), so it is
 * what carries the bound.
 */
function trackInsets(): { stop: () => void; seen: () => number[] } {
  const values: number[] = [];
  const stop = subscribeKeyboardOpen(() => {
    const k = keyboardInset();
    if (k > 0 && values[values.length - 1] !== k) values.push(k);
  });
  return { stop, seen: () => values.slice() };
}

// ── What gets written, and where ─────────────────────────────────────────────

test("a keyboard-sized inset PINS the shell at baseHeight on BOTH .h-app elements", async () => {
  const { vp, unmount } = await phone({ learned: KB });

  await vp.focusEditable(true);
  await vp.resizeTo(WITH_KB);
  await vp.settle();

  const { html, body } = vp.shellHeights();
  assert.equal(html, `${BASE}px`, "<html> carries .h-app and must be PINNED at baseHeight");
  // layout.tsx puts `h-app` on <html> AND <body>. Writing only one leaves the
  // other at the CSS tier's full 100dvh, so half the shell stays under the
  // keyboard — a failure a custom property read via `var()` by both could not
  // have.
  assert.equal(body, `${BASE}px`, "<body> carries .h-app too — writing only <html> strands it");
  assert.equal(keyboardInset(), KB, "K must carry the keyboard-derived height the pin no longer shows");

  await unmount();
});

// THE SCROLL-CLAMP FIX. overflow:hidden on html/body only clips visually —
// they stay SCROLL CONTAINERS, and while pinned the document is K px taller
// than the layout viewport, i.e. K px of programmatic scroll slack. Browsers
// scroll scrollable ancestors (hidden included) to reveal a focused editable,
// and with the shell pinned nothing clamps scrollTop back on its own, so a
// misprediction window (first open on an unlearned device, or a keyboard
// height change mid-open) can leave the root scrolled for the whole open.
test("the pin zeroes root scroll — a mispredict-window auto-scroll cannot stick", async () => {
  const { vp, unmount } = await phone({ learned: KB });

  // Simulate the browser revealing a focused editable by scrolling the
  // (still scrollable, merely clipped) root — jsdom allows setting scrollTop
  // directly.
  dom.window.document.documentElement.scrollTop = 400;
  dom.window.document.body.scrollTop = 400;

  await vp.focusEditable(true);

  assert.equal(dom.window.document.documentElement.scrollTop, 0,
    "the browser revealed the focused input by scrolling the pinned root; unclamped, the whole " +
    "page stays displaced for the open");
  assert.equal(dom.window.document.body.scrollTop, 0,
    "the browser revealed the focused input by scrolling the pinned root; unclamped, the whole " +
    "page stays displaced for the open");

  await unmount();
});

// THE CUSTOM-PROPERTY REGRESSION GUARD. Not "is `--app-vh` gone" (a scan can ask
// that) but "did anything land on the root as a custom property at all" — a
// rename, or a registered @property, would pass the scan and reintroduce the
// whole cost.
test("no custom property is ever written on the root element", async () => {
  const { vp, unmount } = await phone({ learned: KB });

  await vp.focusEditable(true);
  await vp.resizeTo(WITH_KB);
  await vp.resizeTo(WITH_KB + 20);   // mid-animation correction
  await vp.resizeTo(WITH_KB);
  await vp.settle();

  assert.deepEqual(
    vp.rootCustomProps(), [],
    "a custom property is being written on :root during the keyboard animation. " +
    "Custom properties INHERIT, so this invalidates computed style for the entire " +
    "document every frame (~40ms vs 10ms measured). @property does not fix it — " +
    "registration makes it interpolable, not cheap."
  );

  await unmount();
});

test("no keyboard in play hands the height back to CSS, on both elements", async () => {
  const { vp, unmount } = await phone({ learned: KB });

  await vp.focusEditable(true);
  await vp.resizeTo(WITH_KB);
  await vp.settle();
  assert.equal(vp.shellHeights().html, `${BASE}px`, "setup: the shell was pinned");

  await vp.focusEditable(false);
  await vp.resizeTo(BASE);

  assert.deepEqual(
    vp.shellHeights(), { html: "", body: "" },
    "both elements must be released so `.h-app`'s dvh/env tier owns the height again — " +
    "a leftover inline height pins the shell forever"
  );

  await unmount();
});

// ── The motion is DISCRETE ───────────────────────────────────────────────────
//
// The whole point. The platform's keyboard signal is jittery, non-monotonic
// and unspecified — Chrome Android reports 691 -> 1026 -> 691 on a show
// (crbug 40924170), the VirtualKeyboard API repeats 343 -> 392 -> 343
// (crbug 493412612), and no spec requires either to track the animation.
// Writing the shell height on every one of those reads as "up-pause-up". We
// commit once and animate on our own curve.

test("intermediate platform values do not move the shell", async () => {
  const { vp, unmount } = await phone({ learned: KB });

  await vp.focusEditable(true);
  assert.equal(vp.shellHeights().html, `${BASE}px`, "setup: predicting must PIN the shell immediately");
  vp.clearSequence();

  // Chrome's documented shape: an overshoot, then partials, then the real value.
  await vp.resizeTo(BASE + 226);     // the 691 -> 1026 overshoot
  await vp.resizeTo(BASE - 200);     // a partial
  await vp.resizeTo(BASE - 260);     // another partial
  await vp.resizeTo(WITH_KB);        // settled

  // Assert the SEQUENCE, not the final height. A shell that chases every
  // intermediate and happens to land on the right value passes an end-state
  // check while being exactly as choppy.
  assert.deepEqual(
    vp.heightSequence(), [],
    "the shell moved during the keyboard's travel. Every one of these values is a hard " +
    "cut, and chasing them IS the choppy two-stage motion — the signal is non-monotonic " +
    "(Chrome 691->1026->691) and no spec requires it to be smooth. Commit once; re-read " +
    "only at settle."
  );

  await unmount();
});

test("a learned keyboard costs exactly ONE movement, all the way up", async () => {
  const { vp, unmount } = await phone({ learned: KB });

  // heightSequence() can't carry this bound any more — every commit pins the
  // SAME `${BASE}px`, so a second commit is invisible to a shell-height
  // observer; K is what still moves per commit (see trackInsets).
  const insets = trackInsets();

  await vp.focusEditable(true);
  await vp.resizeTo(WITH_KB);
  await vp.settle();

  assert.deepEqual(
    vp.heightSequence(), [`${BASE}px`],
    "the shell wrote more than one height for a single keyboard open — the pin itself moved"
  );
  assert.deepEqual(
    insets.seen(), [KB],
    "the panels moved more than once for a single keyboard open. CORRECT_PX exists so a " +
    "pixel or two of drift never costs a second visible move — two moves IS the " +
    "'two motions'"
  );
  insets.stop();

  await unmount();
});

// The keyboard must not overlap the bottom of the input bar. The composer sits
// at the shell's bottom edge, so a shell TALLER than the visible viewport puts
// that edge below the fold — under the keyboard. CORRECT_PX must never
// suppress that direction, however small: a 1-7px overlap would otherwise be
// permanent.
test("a shell left even slightly too tall is always corrected, never tolerated", async () => {
  // Learned height 4px short of the truth — well inside CORRECT_PX (8).
  const { vp, unmount } = await phone({ learned: KB - 4 });

  await vp.focusEditable(true);
  assert.equal(vp.shellHeights().html, `${BASE}px`, "setup: the shell PINS immediately on prediction");
  assert.equal(
    keyboardInset(), KB - 4,
    "setup: the prediction under-lifts by 4px — the composer is still under the keyboard"
  );

  await vp.resizeTo(WITH_KB);
  await vp.settle();

  assert.equal(
    keyboardInset(), KB,
    "a sub-CORRECT_PX under-lift was tolerated, so the composer stays tucked under the keyboard " +
    "for the whole session — the correction must be asymmetric"
  );
  assert.equal(vp.shellHeights().html, `${BASE}px`, "the shell must remain pinned through the correction");

  await unmount();
});

test("a sub-threshold GAP is still tolerated — the asymmetry is deliberate", async () => {
  // Learned height 4px LONG: K ends up 4px more than the true keyboard, which
  // is a cosmetic over-lift, not an overlap. That one is not worth a second movement.
  const { vp, unmount } = await phone({ learned: KB + 4 });

  await vp.focusEditable(true);
  await vp.resizeTo(WITH_KB);
  await vp.settle();

  assert.equal(
    keyboardInset(), KB + 4,
    "a 4px gap cost a second visible movement. CORRECT_PX exists for exactly this direction"
  );
  assert.equal(vp.shellHeights().html, `${BASE}px`, "the shell must remain pinned — the correction never fired");

  await unmount();
});

test("an unknown device lands on the seed, then corrects ONCE at settle", async () => {
  const { vp, unmount } = await phone();   // nothing learned

  // heightSequence() can't carry the "two moves and no more" bound any more
  // — the seed and the settled correction both pin the SAME `${BASE}px`;
  // track K's own distinct values instead (see trackInsets).
  const insets = trackInsets();

  await vp.focusEditable(true);
  assert.equal(
    vp.shellHeights().html, `${BASE}px`,
    "the first open on a device must still PIN immediately — a fully reactive first " +
    "open is the lag this prediction exists to remove"
  );
  assert.equal(
    keyboardInset(), BASE - SEEDED,
    "the seed must lift the panels immediately, before the browser's own resize arrives"
  );

  await vp.resizeTo(WITH_KB);
  await vp.settle();

  assert.equal(
    keyboardInset(), KB,
    "an unknown device's K must correct to the true keyboard height at settle"
  );
  assert.equal(vp.shellHeights().html, `${BASE}px`, "the shell must remain pinned through the correction");
  assert.deepEqual(
    insets.seen(), [BASE - SEEDED, KB],
    "an unknown device costs exactly two moves — the seed, then one correction at settle. " +
    "More than two means the intermediate values are being chased again"
  );
  insets.stop();
  assert.equal(
    dom.window.localStorage.getItem("kbHeight"), String(KB),
    "the settled keyboard height must be learned, so the NEXT open is a single move"
  );

  await unmount();
});

// A second keyboard open in a Firefox PWA must not have the input bar rising
// up half a second late.
//
// The mechanism is NOT the `keyboardUp()` early-out in onFocusIn — both
// conditions behave identically here. It is a PER-FRAME CHASE: if on focusout
// the shell followed the keyboard DOWN, a re-tap would find it halfway to the
// floor with the prediction suppressed, and it would have to climb back
// reactively. The discrete commit is what prevents it: the shell holds its
// height until the keyboard is actually gone.
test("the shell does not descend with a dismissing keyboard", async () => {
  const { vp, unmount } = await phone({ learned: KB });

  await vp.focusEditable(true);
  await vp.resizeTo(WITH_KB);
  await vp.settle();
  vp.clearSequence();

  // Dismiss. The keyboard starts travelling down; these are its intermediate
  // heights, still keyboard-sized.
  await vp.focusEditable(false);
  await vp.resizeTo(BASE - 260);
  await vp.resizeTo(BASE - 180);

  assert.deepEqual(
    vp.heightSequence(), [],
    "the shell is riding the keyboard down again. That is what left a re-tap finding it " +
    "halfway to the floor, having to climb back reactively — a delayed second open"
  );

  await unmount();
});

test("a re-tap after a completed dismissal predicts immediately", async () => {
  const { vp, unmount } = await phone({ learned: KB });

  await vp.focusEditable(true);
  await vp.resizeTo(WITH_KB);
  await vp.settle();

  await vp.focusEditable(false);
  await vp.resizeTo(BASE);
  assert.deepEqual(vp.shellHeights(), { html: "", body: "" }, "setup: the shell released on close");

  await vp.focusEditable(true);

  // Guards the coupling between release() and the prediction gate: if release()
  // stopped nulling `committedH`, the gate would suppress every later prediction
  // and every open would be fully reactive.
  assert.equal(
    vp.shellHeights().html, `${BASE}px`,
    "the re-tap did not predict, so the shell would sit unpinned until the browser's own " +
    "resize arrives — on Firefox, whose visualViewport is stale until you scroll, that " +
    "is a visible half-second lag"
  );
  assert.equal(
    keyboardInset(), KB,
    "the re-tap did not carry the learned keyboard height into K"
  );

  await unmount();
});

// ── The baseline guard ───────────────────────────────────────────────────────
//
// Chrome Android is documented to report a spuriously LARGER viewport mid-
// animation (crbug 40924170: 691 -> 1026 -> 691 on a keyboard show). An
// unguarded `if (h > baseHeight) baseHeight = h` lets one overshoot inflate
// the reference permanently — after which the inset reads as keyboard-sized
// with no keyboard, and learning drifts. The downward recovery cannot clear
// it: it is itself gated on `!focusedEditable`.
test("a mid-animation overshoot while focused does not poison the reference", async () => {
  const { vp, unmount } = await phone({ learned: KB });

  await vp.focusEditable(true);
  await vp.resizeTo(WITH_KB);
  await vp.resizeTo(BASE + 220);   // the overshoot, reported while focused
  await vp.resizeTo(WITH_KB);      // then the real resting height
  await vp.settle();

  assert.equal(
    vp.shellHeights().html, `${BASE}px`,
    "the overshoot inflated baseHeight, so the PIN itself would be the wrong (too-tall) height"
  );
  assert.equal(
    keyboardInset(), KB,
    "the overshoot was absorbed into baseHeight, so K is now measured against an inflated reference"
  );

  // And with the keyboard gone the shell must fully release — it cannot, if the
  // reference is inflated, because the inset still reads as keyboard-sized.
  await vp.focusEditable(false);
  await vp.resizeTo(BASE);
  assert.deepEqual(
    vp.shellHeights(), { html: "", body: "" },
    "an inflated reference makes a keyboard-free viewport look keyboard-sized forever"
  );

  await unmount();
});

test("the reference still grows when the viewport genuinely gets taller unfocused", async () => {
  const { vp, unmount } = await phone({ learned: KB });

  // A URL bar collapsing with nothing focused is a real, larger viewport — the
  // guard must not freeze the reference at its mount-time value.
  const taller = BASE + 120;
  await vp.resizeTo(taller);
  await vp.focusEditable(true);
  await vp.resizeTo(taller - KB);
  await vp.settle();

  assert.equal(
    vp.shellHeights().html, `${taller}px`,
    "the reference never adopted the taller keyboard-free viewport, so the PIN is stuck at the old baseline"
  );
  assert.equal(
    keyboardInset(), KB,
    "the reference never adopted the taller keyboard-free viewport, so the keyboard " +
    "inset is measured against a stale baseline"
  );

  await unmount();
});

// ── Blast radius ─────────────────────────────────────────────────────────────

test("a sub-keyboard toolbar delta is left to CSS, not chased from JS", async () => {
  const { vp, unmount } = await phone({ learned: KB });

  // Firefox Android's collapsing URL bar fires resize continuously. Anything
  // under MIN_KB (120) is the dvh tier's job — chasing it from JS makes the
  // composer's top border shimmer.
  await vp.resizeTo(BASE - 60);

  assert.deepEqual(
    vp.shellHeights(), { html: "", body: "" },
    "the shell is following the browser toolbar from JS again — the border shimmer is back"
  );

  await unmount();
});

test("unmounting releases the shell", async () => {
  const { vp, unmount } = await phone({ learned: KB });

  await vp.focusEditable(true);
  await vp.resizeTo(WITH_KB);
  await vp.settle();
  assert.equal(vp.shellHeights().html, `${BASE}px`, "setup: the shell was pinned");

  await unmount();

  assert.deepEqual(
    vp.shellHeights(), { html: "", body: "" },
    "the hook left an inline height behind on teardown — it would outlive the component"
  );
});

// ── The published scalar — the one driver the mobile layer model positions on ─
//
// K (the keyboard inset) is not a second measurement of anything: it is defined
// as `baseHeight − committedH`, so it is the SAME decision that moves the shell,
// expressed as a distance instead of a height. These tests exist because the
// layer architecture makes every mobile layer's position a function of K, and a
// K that could disagree with the shell — by a pixel or by a frame — is the
// two-detector bug wearing a different hat.

test("K is exactly the distance the shell gave up, never an independent reading", async () => {
  const { vp, unmount } = await phone({ learned: KB });

  // Asserted at the PREDICTION, before the platform has reported anything at
  // all: if K were read straight off `visualViewport` it would still be 0 here,
  // because the live viewport has not moved yet. Checking only after settle
  // passes even if K is an independent reading.
  await vp.focusEditable(true);
  assert.equal(
    keyboardInset(), KB,
    "K disagrees with the committed decision at the moment of prediction — it is being read " +
    "from the platform rather than from the decision. Layers would sit at rest for the ~250ms " +
    "until the browser's resize arrives, then jump, while the shell already pinned on the tap"
  );
  assert.equal(vp.shellHeights().html, `${BASE}px`, "and the shell itself must already be pinned");

  await vp.resizeTo(WITH_KB);
  await vp.settle();
  assert.equal(
    keyboardInset(), KB,
    "K drifted from the committed decision across the settle correction. They are two views " +
    "of ONE decision; if they can drift, a layer positioned on K lands somewhere the pin's " +
    "decision is not"
  );

  await unmount();
});

test("K does not move while the platform jitters — it inherits the discrete commit", async () => {
  const { vp, unmount } = await phone({ learned: KB });

  await vp.focusEditable(true);
  const predicted = keyboardInset();
  assert.equal(predicted, KB, "setup: the prediction committed the learned keyboard");

  // Chrome Android's documented show sequence: overshoot, correct, overshoot
  // (crbug 40924170). Every one of these is a resize a chasing design follows.
  await vp.resizeTo(WITH_KB - 40);
  await vp.resizeTo(WITH_KB + 60);
  await vp.resizeTo(WITH_KB);

  assert.equal(
    keyboardInset(), predicted,
    "K followed the platform's mid-animation values. Layers positioned on it would be " +
    "animated through the jitter — which is the choppiness the discrete commit exists " +
    "to prevent, reintroduced one level up"
  );

  await unmount();
});

test("K returns to zero when the keyboard is gone", async () => {
  const { vp, unmount } = await phone({ learned: KB });

  await vp.focusEditable(true);
  await vp.resizeTo(WITH_KB);
  await vp.settle();
  assert.ok(keyboardInset() > 0, "setup: the keyboard was up");

  await vp.focusEditable(false);
  await vp.resizeTo(BASE);

  assert.equal(
    keyboardInset(), 0,
    "K is still non-zero with no keyboard — every layer would stay translated, and the " +
    "shell (released to CSS) would be at full height underneath them"
  );

  await unmount();
});

// The reason publishing lives at the ENTRY POINTS and not inside
// commit()/release(). A subscriber re-reads BOTH facts on every notification, so
// a notification that carries only half of a change is a frame in which the app
// is told "the keyboard is up, and it is 0px tall" — every layer would render at
// rest and then jump.
test("open and inset are never published half-updated", async () => {
  const { vp, unmount } = await phone({ learned: KB });

  const seen: Array<{ open: boolean; inset: number }> = [];
  const stop = subscribeKeyboardOpen(() => {
    seen.push({ open: isKeyboardOpen(), inset: keyboardInset() });
  });

  await vp.focusEditable(true);
  await vp.resizeTo(WITH_KB);
  await vp.settle();
  await vp.focusEditable(false);
  await vp.resizeTo(BASE);
  stop();

  const bad = seen.filter((s) => (s.open ? s.inset === 0 : s.inset !== 0));
  assert.deepEqual(
    bad, [],
    "a subscriber observed openness and inset out of step. Publishing from inside " +
    "commit()/release() does exactly this — the caller has changed one fact and not " +
    "yet the other"
  );
  assert.ok(seen.length > 0, "setup: the subscriber saw nothing at all");

  await unmount();
});
