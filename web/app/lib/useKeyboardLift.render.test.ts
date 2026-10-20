// Behavioural tests for useKeyboardLift, RENDERED not source-scanned — the
// contract is "does anything land on the element", which only a mount can
// answer. A source scan sees `el.style.transform = …` and has no opinion on
// whether a desktop host ever reaches it, or whether K returning to 0 leaves
// the element at `translateY(-0px)` instead of truly cleared.
//
// K is driven through the real mechanism — useViewportHeightVar(), mounted
// alongside useKeyboardLift() in one probe, exactly the two-hook composition
// each lifted host uses — rather than by poking the module's published state
// directly.
//
// `.ts` extensions are REQUIRED on these imports — `node --test` cannot
// resolve extensionless TypeScript specifiers (same rule as
// useViewportHeightVar.render.test.ts).

import test from "node:test";
import assert from "node:assert/strict";
import { dom, mountHook, fakePhoneViewport } from "./testDom.ts";
// Side-effect only: arms testTsx.ts's extensionless-relative-import resolver
// (module.registerHooks runs at EVALUATION time, so it only reaches modules
// resolved AFTER this line evaluates — a dynamic import(), never a static one
// in the same graph, which is why useKeyboardLift is loaded dynamically below).
import "./testTsx.ts";
import { useViewportHeightVar, keyboardInset, KB_LIFT_EVENT, type KbLiftDetail } from "./useViewportHeightVar.ts";
// node --test realm gotcha (useUserMenuEvents.test.ts precedent): the hook
// constructs `new CustomEvent(...)` against NODE's global, and jsdom's
// dispatchEvent rejects an event from another realm. Point the global at
// jsdom's constructor before the hook ever runs.
(globalThis as unknown as { CustomEvent: unknown }).CustomEvent = dom.window.CustomEvent;
// Dynamic: useKeyboardLift.ts imports useKeyboardOpenDetection.ts (which in
// turn imports useViewportHeightVar.ts) without a `.ts` extension — correct
// for webpack/tsc, but node's native ESM resolver cannot follow a STATIC
// import like that without the hook above already armed, and a static import
// is resolved during linking, before this file's own top-level code runs.
const { useKeyboardLift } = await import("./useKeyboardLift.ts");

const BASE = 800;          // viewport with no keyboard
const KB = 340;             // a realistic, already-learned keyboard height
const WITH_KB = BASE - KB;  // 460

/**
 * Mount useKeyboardLift on a real element, alongside the hook that actually
 * commits K. `learned` seeds localStorage so the predicted lift lands exactly
 * on KB with no settle correction (mirrors useViewportHeightVar.render.test.ts's
 * `phone()` helper).
 */
async function mountLift(opts: { enabled?: boolean; learned?: number } = {}) {
  const vp = fakePhoneViewport({ height: BASE });
  vp.reset();
  dom.window.localStorage.clear();
  if (opts.learned) dom.window.localStorage.setItem("kbHeight", String(opts.learned));
  const el = dom.window.document.createElement("div");
  const ref: { current: HTMLElement | null } = { current: el };
  const h = await mountHook(() => {
    useViewportHeightVar();
    useKeyboardLift(ref, opts.enabled ?? true);
  });
  await vp.flush();
  return { vp, el, unmount: h.unmount };
}

test("K > 0 lifts the element with longhand transition properties", async () => {
  const { vp, el, unmount } = await mountLift({ learned: KB });

  await vp.focusEditable(true);
  await vp.resizeTo(WITH_KB);
  await vp.settle();

  assert.equal(el.style.transform, `translateY(-${KB}px)`, "the element rises by exactly the committed K");
  assert.equal(el.style.transitionProperty, "transform", "a longhand, not the `transition` shorthand");
  assert.equal(el.style.transitionDuration, "var(--anim-default)");
  assert.equal(el.style.transitionTimingFunction, "var(--anim-ease)");
  // `transition` itself must never be written — that would be the shorthand
  // this hook is deliberately built to avoid (it would clobber a co-existing
  // Tailwind transition utility's delay/extra properties).
  assert.equal(el.style.transition, "", "the shorthand property must stay empty — only the longhands are written");

  await unmount();
});

test("K back to 0 clears the transform, not translateY(-0px)", async () => {
  const { vp, el, unmount } = await mountLift({ learned: KB });

  await vp.focusEditable(true);
  await vp.resizeTo(WITH_KB);
  await vp.settle();
  assert.notEqual(el.style.transform, "", "setup: the element was lifted");

  await vp.focusEditable(false);
  await vp.resizeTo(BASE);

  assert.equal(el.style.transform, "", "the transform must be cleared to empty, never left at translateY(-0px)");

  await unmount();
});

test("enabled=false never touches the element, at any K", async () => {
  const { vp, el, unmount } = await mountLift({ learned: KB, enabled: false });
  let fired = 0;
  el.addEventListener(KB_LIFT_EVENT, () => { fired++; });

  await vp.focusEditable(true);
  await vp.resizeTo(WITH_KB);
  await vp.settle();
  // Prove the negative assertion below is not vacuous: K genuinely committed
  // non-zero in this window — the same window a K > 0 test lifts the element.
  assert.equal(keyboardInset(), KB, "setup: K really did rise while enabled=false — the guard is being exercised, not skipped");

  assert.equal(el.style.cssText, "", "a disabled host must never see a style write, even while K is committed and non-zero");
  assert.equal(fired, 0, "and no announcement either — no write, no event (a follower hearing a lift that never happened would jump)");

  await unmount();
});

test("desktop: with K never rising, style.cssText stays empty", async () => {
  // A real desktop matchMedia — every query, including Q_TOUCH_PRIMARY, comes
  // back false — so useViewportHeightVar's effect bails before registering a
  // single listener. K can never become anything but 0.
  (dom.window as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: false });

  const el = dom.window.document.createElement("div");
  let fired = 0;
  el.addEventListener(KB_LIFT_EVENT, () => { fired++; });
  const ref: { current: HTMLElement | null } = { current: el };
  const h = await mountHook(() => {
    useViewportHeightVar();
    useKeyboardLift(ref, true);
  });

  assert.equal(el.style.cssText, "", "nothing must be written on mount");

  // Fire the same focusin a phone would get, to prove the bail-out really
  // suppresses everything downstream rather than this simply not having run yet.
  const input = dom.window.document.createElement("input");
  dom.window.document.body.appendChild(input);
  const ev = new dom.window.Event("focusin", { bubbles: true });
  Object.defineProperty(ev, "target", { value: input });
  await h.act(async () => { dom.window.document.dispatchEvent(ev); });

  assert.equal(keyboardInset(), 0, "setup: the touch-primary gate genuinely suppressed K, not merely a no-op focusin");
  assert.equal(el.style.cssText, "", "the write-only-while-lifting contract: on desktop this hook must never write a style");
  assert.equal(fired, 0, "nor announce a write that never happened");

  await h.unmount();
});

test("K is PUBLISHED as --kb-lift, not just applied — and cleared with the transform", async () => {
  // The window layer's ceiling is a calc() in CSS over this token (chrome.css
  // .chrome-window-layer). Two JS versions of that arithmetic shipped and both
  // were wrong the same way: a distance measured at the K commit is a snapshot,
  // while every term in it moves on its own 200ms curve. Publishing K is what
  // lets CSS re-solve it whenever any of them moves.
  const { vp, el, unmount } = await mountLift({ learned: KB });

  assert.equal(el.style.getPropertyValue("--kb-lift"), "", "nothing published while the keyboard is down");

  await vp.focusEditable(true);
  await vp.resizeTo(WITH_KB);
  await vp.settle();
  assert.equal(el.style.getPropertyValue("--kb-lift"), `${KB}px`,
    "the committed K must be published as a LENGTH — a bare number makes the calc() invalid at computed-value time and the ceiling silently vanishes");
  assert.equal(el.style.transform, `translateY(-${KB}px)`, "and it must agree with the transform it accompanies");

  await vp.focusEditable(false);
  await vp.resizeTo(BASE);
  assert.equal(el.style.getPropertyValue("--kb-lift"), "",
    "cleared with the transform — a stale K would hold every layer's ceiling down after the keyboard left");

  await unmount();
});

test("enabled=false publishes nothing — an embedded tree must not lift OR claim a lift", async () => {
  // MatrixView embedded in the stream chat panel passes enabled=false so it
  // does not double-lift. Publishing --kb-lift there would push the ceiling of
  // every layer inside it down by a K that never moved it.
  const { vp, el, unmount } = await mountLift({ learned: KB, enabled: false });
  await vp.focusEditable(true);
  await vp.resizeTo(WITH_KB);
  await vp.settle();
  assert.equal(keyboardInset(), KB, "setup: K really rose while enabled=false — the guard is exercised, not skipped");
  assert.equal(el.style.getPropertyValue("--kb-lift"), "", "a disabled host must publish nothing");
  await unmount();
});

test("every K write is ANNOUNCED on the lifted element — before/after, bubbling, with the DOM on each side", async () => {
  // PanelWindow's lift-follow (Window.tsx) reads its own layout top on both
  // sides of the write to turn the ceiling's one-frame jump into a compositor
  // translate. It can only do that if the WRITER says when the write happens:
  // a module subscription fires before React re-renders, with the DOM still on
  // the old K, so "between these two calls" is a fact only this hook can state.
  const { vp, el, unmount } = await mountLift({ learned: KB });
  dom.window.document.body.appendChild(el); // bubbling needs a connected element
  const seen: string[] = [];
  const onLift = (e: Event) => {
    const d = (e as CustomEvent<KbLiftDetail>).detail;
    seen.push(`${d.phase}:${d.k}:${el.style.getPropertyValue("--kb-lift") || "-"}`);
  };
  // Listening on DOCUMENT — the follower is a DESCENDANT that must hear an
  // ancestor's event, so `bubbles` is load-bearing, not decoration.
  dom.window.document.addEventListener(KB_LIFT_EVENT, onLift);
  try {
    await vp.focusEditable(true);
    await vp.resizeTo(WITH_KB);
    await vp.settle();
    assert.deepEqual(seen, [`before:${KB}:-`, `after:${KB}:${KB}px`],
      "one write, one before/after pair: `before` still sees the old K in the DOM and `after` the new — that pair is what makes the jump measurable");
    seen.length = 0;
    await vp.focusEditable(false);
    await vp.resizeTo(BASE);
    assert.deepEqual(seen, [`before:0:${KB}px`, `after:0:-`],
      "the clear is announced the same way — the keyboard leaving is a lift-follow too (the grow direction)");
  } finally {
    dom.window.document.removeEventListener(KB_LIFT_EVENT, onLift);
    el.remove();
  }
  await unmount();
});
