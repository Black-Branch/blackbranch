// @test-only test infrastructure — a render harness for `node --test`, not product code.
// A minimal React render harness for `node --test`, so hooks can be tested by
// RUNNING them instead of by scanning their source.
//
// Why it exists: the settings/destination guards in this repo assert on source
// TEXT, because "the persist effect isn't unit-testable without a React
// renderer" (sendDestination.test.ts). That is true as far as it goes, and it is
// also how real bugs survive dozens of tests — every line those scans assert on
// can be present and correctly ordered, so they measure the code's SHAPE while
// its BEHAVIOUR is wrong. This closes that gap. Source scans are still the right
// tool for cross-file invariants (registry ⇄ menu census, import direction);
// they are the wrong tool for "what does this hook actually do".
//
// No new dependencies: jsdom, react and react-dom are all already here.
//
// Test-only. Nothing under app/ that ships may import this — it is a sibling
// of testSource.ts and follows the same rule.
//
// `.ts` extensions are REQUIRED on imports of this module and its callees:
// `node --test` cannot resolve extensionless TypeScript specifiers.

import { JSDOM } from "jsdom";

export const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://example.org/",
});

// Globals must be installed BEFORE react-dom/client is imported, which is why
// the React imports below are dynamic and this module is async.
(globalThis as unknown as { window: unknown }).window = dom.window;
(globalThis as unknown as { document: unknown }).document = dom.window.document;
// defineProperty, not assignment: on Node 26 `globalThis.navigator` is a
// getter-only accessor and a plain `=` throws TypeError at import time.
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
// Bare `location` is a real browser global and hooks use it unqualified (the
// `?kbdebug` gate in useViewportHeightVar). Without this it is a ReferenceError
// inside the effect, which React reports as a mount failure rather than as the
// missing global it is.
Object.defineProperty(globalThis, "location", { value: dom.window.location, configurable: true });
(globalThis as unknown as { localStorage: unknown }).localStorage = dom.window.localStorage;
(globalThis as unknown as { sessionStorage: unknown }).sessionStorage = dom.window.sessionStorage;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no AnimationEvent/TransitionEvent constructor. react-dom's own
// vendor-prefix feature detection runs ONCE at import time and checks
// `"AnimationEvent" in window` / `"TransitionEvent" in window` to decide
// whether onAnimationEnd/onTransitionEnd should listen for the unprefixed
// native event or a `webkit`-prefixed one — and jsdom's cssstyle DOES expose
// `WebkitAnimation`/`WebkitTransition` on a style object, so a missing
// constructor here doesn't fail open, it fails to the WRONG prefix: React
// silently listens for "webkitAnimationEnd" while every real browser (and
// every test dispatching a plain "animationend" Event) uses the unprefixed
// name. Presence is all react-dom's detection reads — a real constructor is
// not required for that, only for code that constructs one directly.
if (!("AnimationEvent" in dom.window)) {
  (dom.window as unknown as { AnimationEvent: unknown }).AnimationEvent = dom.window.Event;
}
if (!("TransitionEvent" in dom.window)) {
  (dom.window as unknown as { TransitionEvent: unknown }).TransitionEvent = dom.window.Event;
}

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

export { React, act };

/** A mounted hook: `.current` is its latest return value. */
export type MountedHook<T> = {
  readonly current: T;
  /** Run something that updates state, flushing effects like the browser would. */
  act: (fn: () => void | Promise<void>) => Promise<void>;
  unmount: () => Promise<void>;
};

/** Mount `useHook` in a throwaway React root and return a live handle to it. */
export async function mountHook<T>(useHook: () => T): Promise<MountedHook<T>> {
  const ref: { current: T | null } = { current: null };
  function Probe() {
    ref.current = useHook();
    return null;
  }
  const root = createRoot(dom.window.document.createElement("div"));
  await act(async () => {
    root.render(React.createElement(Probe));
  });
  return {
    get current() {
      return ref.current!;
    },
    act: (fn) => act(async () => { await fn(); }),
    unmount: () => act(async () => { root.unmount(); }),
  };
}

/** Wipe both storage tiers between tests (they share one jsdom window). */
export function resetStorage(): void {
  dom.window.localStorage.clear();
  dom.window.sessionStorage.clear();
}

/**
 * Serve `fetch` a fixed JSON body. Returns a mutable box so a test can change
 * the response and trigger a refetch.
 *
 * Node's global `Response`, NOT `dom.window.Response` — jsdom implements no
 * fetch/Response, so the window one is `undefined` and `new undefined(…)` throws
 * INSIDE the promise chain, where a hook's `.catch(() => {})` swallows it. The
 * suite then silently runs as "the fetch failed", which is indistinguishable
 * from a legitimately empty response.
 */
export function serveJson<T>(body: T): { current: T } {
  const box = { current: body };
  (globalThis as unknown as { fetch: unknown }).fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify(box.current), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
  return box;
}

/**
 * Put the harness on a touch phone with a controllable `visualViewport`, and make
 * `requestAnimationFrame` manual so a test can step the keyboard frame by frame.
 *
 * jsdom implements none of this: no `matchMedia`, no `visualViewport`. The
 * viewport-height hook stands down without both (`(pointer: coarse)` +
 * `(hover: none)`, then `window.visualViewport`), so without this it would return
 * immediately and every assertion would pass against a hook that never ran.
 *
 * `standalone: true` puts it in the installed-PWA display mode; the Chromium env()
 * branch additionally needs `navigator.virtualKeyboard`, which jsdom has not, so
 * the measuring path is what these tests exercise.
 */
export function fakePhoneViewport(opts: { height?: number; standalone?: boolean } = {}) {
  const listeners: Record<string, Set<() => void>> = { resize: new Set(), scroll: new Set() };
  const vv = {
    height: opts.height ?? 800,
    offsetTop: 0,
    scale: 1,
    addEventListener: (t: string, cb: () => void) => { listeners[t]?.add(cb); },
    removeEventListener: (t: string, cb: () => void) => { listeners[t]?.delete(cb); },
  };
  (dom.window as unknown as { visualViewport: unknown }).visualViewport = vv;
  (dom.window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
    matches: q.includes("display-mode: standalone")
      ? !!opts.standalone
      : q.includes("pointer: coarse") || q.includes("hover: none"),
  });

  // Record every distinct shell height, in order. A MutationObserver rather than
  // anything the hook cooperates with, so the assertion surface stays "what the
  // DOM did" and production carries no test-only state.
  const root = dom.window.document.documentElement;
  const moves: string[] = [];
  let lastH = root.style.height;
  new dom.window.MutationObserver(() => {
    const h = root.style.height;
    if (h !== lastH) { lastH = h; moves.push(h); }
  }).observe(root, { attributes: true, attributeFilter: ["style"] });

  // Manual rAF. The hook coalesces every viewport event into one frame, so a test
  // that never flushes is testing nothing.
  let queue: Array<() => void> = [];
  let id = 0;
  const g = globalThis as unknown as { requestAnimationFrame: unknown; cancelAnimationFrame: unknown };
  g.requestAnimationFrame = (cb: () => void) => { queue.push(cb); return ++id; };
  g.cancelAnimationFrame = () => { queue = []; };

  const flush = async () => {
    await act(async () => {
      const due = queue;
      queue = [];
      for (const cb of due) cb();
    });
  };

  return {
    /** Resize the visible viewport and let the hook's frame run. */
    resizeTo: async (height: number) => {
      vv.height = height;
      for (const cb of listeners.resize!) cb();
      await flush();
    },
    /** Focus/blur an editable, as `focusin`/`focusout` would. */
    focusEditable: async (focused: boolean) => {
      const el = dom.window.document.createElement("input");
      dom.window.document.body.appendChild(el);
      const ev = new dom.window.Event(focused ? "focusin" : "focusout", { bubbles: true });
      Object.defineProperty(ev, "target", { value: el });
      await act(async () => { dom.window.document.dispatchEvent(ev); });
      await flush();
    },
    flush,
    /**
     * Let real timers fire, then run any frame they queued.
     *
     * Needed because the hook deliberately does NOT follow the viewport: it
     * commits once and re-reads only after the viewport has held still for
     * SETTLE_MS. A test that asserts the settled geometry without waiting is
     * asserting on the prediction instead.
     */
    settle: async (ms = 220) => {
      await act(async () => { await new Promise(r => setTimeout(r, ms)); });
      await flush();
    },
    /** The two `.h-app` elements' inline heights — what the hook actually wrote. */
    shellHeights: () => ({
      html: dom.window.document.documentElement.style.height,
      body: dom.window.document.body.style.height,
    }),
    /**
     * Every distinct height the shell has taken, in order — "" meaning released
     * to CSS. This is the phase-2 assertion surface: the discrete design's whole
     * claim is that ONE keyboard open costs ONE entry, so counting entries
     * measures the user-visible thing ("how many times did it move") without the
     * hook having to expose any test-only state.
     */
    heightSequence: () => moves.slice(),
    clearSequence: () => { moves.length = 0; },
    /** Every custom property currently set on the root, to catch a per-frame one. */
    rootCustomProps: () => {
      const s = dom.window.document.documentElement.style;
      return Array.from({ length: s.length }, (_, i) => s.item(i)).filter(n => n.startsWith("--"));
    },
    reset: () => {
      dom.window.document.documentElement.style.height = "";
      dom.window.document.body.style.height = "";
      dom.window.document.body.replaceChildren();
    },
  };
}

/** A React-shaped touch event carrying one touch point. */
export function touchEvent(x: number, y: number) {
  let defaultPrevented = false;
  return {
    touches: [{ clientX: x, clientY: y }],
    preventDefault() { defaultPrevented = true; },
    get defaultPrevented() { return defaultPrevented; },
  } as unknown as React.TouchEvent & { defaultPrevented: boolean };
}
