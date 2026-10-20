// Tests for window-scoped state (pure, node --test, no DOM).
//
// These simulate TWO BROWSER WINDOWS: one shared localStorage, two separate
// sessionStorages. That is the whole point of the module, and it is not
// something a single-window test can catch — the original bug shipped because
// nothing ever exercised a second window.
//
// Run: node --test app/lib/windowScoped.test.ts

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ── A two-window browser ─────────────────────────────────────────────────────
// `localStorage` is shared by reference; each window gets its own
// `sessionStorage`. Swapping `sessionStorage` is what "switching window" means.
class Store {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

const shared = new Store();
const windowA = new Store();
const windowB = new Store();

const g = globalThis as unknown as { localStorage: Store; sessionStorage: Store; window: unknown };
g.localStorage = shared;
// A browser has a `window`. safeLocalStorage's helpers answer "nothing stored"
// without one (on the server, merely naming Node's `localStorage` global prints
// a warning), so a fake browser has to say it is a browser.
g.window = globalThis;

/** Run `fn` as if inside that window. */
function inWindow<T>(w: Store, fn: () => T): T {
  g.sessionStorage = w;
  return fn();
}

const { wsGet, wsSet, wsPin, wsClear } = await import("./windowScoped.ts");

beforeEach(() => {
  shared.map.clear();
  windowA.map.clear();
  windowB.map.clear();
});

const KEY = "chatTargetDest";

// ── The regression ───────────────────────────────────────────────────────────

test("a window that CHOSE a destination does not disturb another window", () => {
  inWindow(windowB, () => wsPin(KEY));           // B is open, nothing chosen yet
  inWindow(windowA, () => wsSet(KEY, "twitch")); // A picks Twitch

  assert.equal(inWindow(windowB, () => wsGet(KEY)), null, "B followed A");
  assert.equal(inWindow(windowA, () => wsGet(KEY)), "twitch");
});

test("a window that INHERITED a destination still stops following", () => {
  // The case the explicit pin exists for, and the one most likely to bite:
  // window B never writes, it only ever restores. Without pinning it would keep
  // falling through to localStorage forever.
  shared.setItem(KEY, "kick");                   // left by an earlier session
  assert.equal(inWindow(windowB, () => wsGet(KEY)), "kick", "B should start where you left off");
  inWindow(windowB, () => wsPin(KEY));           // B mounts

  inWindow(windowA, () => wsSet(KEY, "twitch")); // A changes it later

  assert.equal(inWindow(windowB, () => wsGet(KEY)), "kick", "B drifted to A's choice");
});

test("switching in one window never changes where the OTHER window sends", () => {
  // Stated as the user-facing property, because that is the thing that matters:
  // a message typed in B must go where B says, whatever A is doing.
  inWindow(windowA, () => wsSet(KEY, "native"));
  inWindow(windowB, () => wsSet(KEY, "twitch"));

  for (const dest of ["kick", "streamplace", "youtube", "all"]) {
    inWindow(windowA, () => wsSet(KEY, dest));
    assert.equal(inWindow(windowB, () => wsGet(KEY)), "twitch", `B moved when A chose ${dest}`);
  }
});

// ── The properties that must SURVIVE the fix ─────────────────────────────────

test("a brand-new window still starts where you left off", () => {
  // Property (1). This is why plain sessionStorage is not the answer: it would
  // pass every test above and silently reset the destination on every new
  // window, which is a documented behaviour people rely on.
  inWindow(windowA, () => wsSet(KEY, "twitch"));

  const fresh = new Store();
  assert.equal(inWindow(fresh, () => wsGet(KEY)), "twitch");
});

test("a value survives reload of the same window", () => {
  // Property (3) — sessionStorage outlives a reload, unlike component state.
  inWindow(windowA, () => wsSet(KEY, "kick"));
  assert.equal(inWindow(windowA, () => wsGet(KEY)), "kick");
});

test("pinning is idempotent and never overwrites this window's own choice", () => {
  inWindow(windowA, () => wsSet(KEY, "twitch"));
  shared.setItem(KEY, "kick");                   // another window moved on
  inWindow(windowA, () => { wsPin(KEY); wsPin(KEY); wsPin(KEY); });
  assert.equal(inWindow(windowA, () => wsGet(KEY)), "twitch", "pin clobbered a real choice");
});

test("pinning with nothing to pin is a no-op, not a written empty value", () => {
  inWindow(windowA, () => wsPin(KEY));
  assert.equal(windowA.getItem(KEY), null);
  assert.equal(inWindow(windowA, () => wsGet(KEY)), null);
});

test("a write leaves the seed for the next window", () => {
  inWindow(windowA, () => wsSet(KEY, "streamplace"));
  assert.equal(shared.getItem(KEY), "streamplace", "localStorage must still carry the seed");
});

// ── Clearing (retiring a value that should never have been stored) ───────────

test("clearing forgets the value in BOTH tiers, so it cannot re-seed", () => {
  // The half-fix to guard against: clearing only sessionStorage leaves the seed
  // in localStorage, so the very next window restores the thing just retired.
  inWindow(windowA, () => wsSet(KEY, "encrypted"));
  assert.equal(shared.getItem(KEY), "encrypted", "precondition: the seed is there");

  inWindow(windowA, () => wsClear(KEY));

  assert.equal(inWindow(windowA, () => wsGet(KEY)), null, "this window still sees it");
  assert.equal(shared.getItem(KEY), null, "the seed survived and will re-infect a new window");
  assert.equal(inWindow(new Store(), () => wsGet(KEY)), null, "a fresh window inherited it");
});

test("clearing leaves the pin, so the window does not resume following others", () => {
  // The trap. Clearing the pin as well would look tidier and would undo the
  // whole module: this window would fall through to localStorage again and
  // start tracking whatever another window chose next — the mis-send.
  inWindow(windowA, () => { wsSet(KEY, "encrypted"); wsClear(KEY); });
  inWindow(windowB, () => wsSet(KEY, "twitch"));

  assert.equal(inWindow(windowA, () => wsGet(KEY)), null, "A followed B after being cleared");
});

test("clearing is safe on a key that was never set", () => {
  inWindow(windowA, () => wsClear(KEY));
  assert.equal(inWindow(windowA, () => wsGet(KEY)), null);
});

// ── Storage unavailable (Safari private mode / blocked cookies) ──────────────

test("degrades to no-op rather than throwing when storage is unavailable", () => {
  const boom = {
    getItem() { throw new Error("SecurityError"); },
    setItem() { throw new Error("SecurityError"); },
    removeItem() { throw new Error("SecurityError"); },
  } as unknown as Store;
  const prevLocal = g.localStorage;
  g.localStorage = boom;
  try {
    inWindow(boom, () => {
      assert.equal(wsGet(KEY), null);
      wsSet(KEY, "twitch");   // must not throw
      wsPin(KEY);             // must not throw
      wsClear(KEY);           // must not throw
      assert.equal(wsGet(KEY), null);
    });
  } finally {
    g.localStorage = prevLocal;
  }
});
