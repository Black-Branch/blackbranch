// Window-scoped state: remembered across sessions, but INDEPENDENT per window.
//
// The bug this prevents: open the site in two windows, switch to the Matrix
// tab in one, and the other switches too. Same for the composer's `send to:`
// destination — and that one decides *who receives your message*, so
// inheriting another window's choice is a mis-send, not a cosmetic annoyance.
//
// ── Why it happens ───────────────────────────────────────────────────────────
// `useLocalStorageString` deliberately syncs every key across tabs via the
// `storage` event, which is correct for PREFERENCES (your chat colour should
// follow you) and wrong for VIEW STATE (which tab you're looking at, who you're
// talking to). One mechanism, two kinds of state — a mechanism whose scope
// quietly includes something it shouldn't.
//
// ── The semantics ────────────────────────────────────────────────────────────
// Three properties, and all three matter:
//   1. A NEW window starts where you left off      → seed from localStorage
//   2. Windows never follow each other afterwards  → live in sessionStorage
//   3. It survives a reload of THIS window          → sessionStorage, not memory
//
// So: sessionStorage is the window's own copy; localStorage is only ever the
// seed for the *next* window. Writes go to both.
//
// Do NOT "simplify" this to plain sessionStorage. That satisfies (2) and (3)
// but loses (1) — every new window would reset to defaults, and for the send
// destination that is a documented, relied-on behaviour ("Target platform
// persists across sessions").
//
// Equally, do NOT add a `storage` listener here. Its absence IS the feature.

// `.ts` extension is REQUIRED: this module is exercised under `node --test`,
// which cannot resolve extensionless TypeScript specifiers. `tsconfig` sets
// `allowImportingTsExtensions`, and the tested libs here all do the same.
// Dropping it doesn't fail the build — it kills the test suite.
import { lsGet, lsSet, lsRemove } from "./safeLocalStorage.ts";

/** Read from this window's sessionStorage, or `null` if absent/unavailable. */
export function ssGet(key: string): string | null {
  try { return sessionStorage.getItem(key); } catch { return null; }
}

/** Write to this window's sessionStorage; no-ops if storage is unavailable. */
export function ssSet(key: string, value: string): void {
  try { sessionStorage.setItem(key, value); } catch { /* unavailable — ignore */ }
}

/**
 * Remove ONLY this window's own copy, leaving localStorage (the next-window
 * seed) and the pin untouched. For surgically retiring a stale session-tier
 * value without disturbing what other windows chose — `wsClear` is the
 * both-tiers version.
 */
export function ssRemove(key: string): void {
  try { sessionStorage.removeItem(key); } catch { /* unavailable — ignore */ }
}

/**
 * Marker recording that this window has committed to its own view of `key`.
 *
 * A separate marker is necessary, not tidiness. "This window has no value"
 * and "this window hasn't looked yet" are DIFFERENT states that a single slot
 * cannot tell apart, and conflating them breaks the most ordinary case there
 * is: two windows open, neither has ever chosen, one of them chooses. With no
 * marker the other window has nothing pinned, falls through to localStorage,
 * and follows along. (windowScoped.test.ts simulates two windows for exactly
 * this.)
 */
const pinKey = (key: string) => `ws.pinned.${key}`;

/**
 * This window's value: its own copy if it has one, the last-used value another
 * window left behind if this window hasn't committed yet, otherwise `null`.
 *
 * Pure — it never writes. The seed is only *committed* by `wsPin`, which runs
 * at effect time. Reading and pinning are split precisely so this can be called
 * from a `useSyncExternalStore` snapshot without writing during render.
 */
export function wsGet(key: string): string | null {
  const own = ssGet(key);
  if (own !== null) return own;
  // Committed with no value means absent — NOT "go ask localStorage".
  if (ssGet(pinKey(key)) !== null) return null;
  return lsGet(key);
}

/**
 * Commit this window to its own view, making it independent from here on.
 *
 * Load-bearing. Without it a window that has never *written* the key keeps
 * falling through to localStorage on every read — so it would still follow
 * whatever another window last chose, and the whole module would be a no-op
 * for exactly the passive window most likely to be caught out by it.
 *
 * Idempotent, and never clobbers a value this window already holds.
 */
export function wsPin(key: string): void {
  if (ssGet(pinKey(key)) !== null) return;
  const seed = lsGet(key);
  if (seed !== null) ssSet(key, seed);
  ssSet(pinKey(key), "1");
}

/**
 * Set this window's value, and leave it as the seed for the next new window.
 *
 * The localStorage write is what preserves "a new window starts where you left
 * off". It cannot disturb a window that has already pinned. Writing implies
 * committing, so this pins too.
 */
export function wsSet(key: string, value: string): void {
  ssSet(key, value);
  ssSet(pinKey(key), "1");
  lsSet(key, value);
}

/**
 * Forget `key` in BOTH tiers, so it can neither be read by this window nor seed
 * the next one. For retiring a value that should never have been stored — not
 * for "set it back to the default", which is what `wsSet` is for.
 *
 * Deliberately leaves the pin alone. The pin records "this window has looked",
 * which stays true, and clearing it would make this window fall through to
 * localStorage again and start following other windows — the very bug this
 * module exists to prevent. Cleared-and-pinned reads back as `null`, which is
 * the "no stored choice" state callers want.
 */
export function wsClear(key: string): void {
  try { sessionStorage.removeItem(key); } catch { /* unavailable — ignore */ }
  lsRemove(key);
}
