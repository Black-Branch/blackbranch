"use client";

// The cancelable-CustomEvent handshake: an OPTIONAL host claims an event via
// preventDefault(), which flips dispatchEvent's return to false — so the
// dispatcher knows a live listener took it and can skip its own fallback.
// Used by the mod-panel opener (ProfileCard → ChatSidebar) and the profile-
// card opener (MatrixView's rail → the useUserMenuEvents hub): exactly one
// host either way — never a dead click, never a double mount.

/** Dispatch `name` as a cancelable CustomEvent. Returns true iff a listener
 *  claimed it (claimEvent/preventDefault) — when false, no host is mounted and
 *  the dispatcher should raise its own fallback.
 *
 *  `orOpener`: when nothing in THIS window claims it, offer it to the window
 *  that opened this one, and focus that window if it takes it. For pop-outs:
 *  a popped-out user card is its own document with no UserMenu, so its Gift
 *  button's `bb:open-support` has no host there — the panel it wants lives in
 *  the opener. */
export function dispatchClaimable(
  name: string,
  detail?: unknown,
  opts?: { orOpener?: boolean },
): boolean {
  if (dispatchOn(window, name, detail)) return true;
  if (!opts?.orOpener) return false;
  try {
    const opener = window.opener as Window | null;
    if (!opener || opener === window || opener.closed) return false;
    if (!dispatchOn(opener, name, detail)) return false;
    opener.focus();
    return true;
  } catch {
    // A cross-origin opener throws SecurityError on touch — it is not ours to
    // drive, so this reads as unclaimed and the caller keeps its own window.
    return false;
  }
}

/** Built with the TARGET window's own CustomEvent: an opener is a different
 *  realm, and dispatchEvent rejects an Event constructed in another one. */
function dispatchOn(target: Window, name: string, detail: unknown): boolean {
  const Ctor = (target as Window & typeof globalThis).CustomEvent;
  return !target.dispatchEvent(new Ctor(name, { detail, cancelable: true }));
}

/** Claim a cancelable event dispatched via dispatchClaimable — tells the
 *  dispatcher this listener is hosting, so its fallback stays closed. */
export function claimEvent(e: Event): void {
  e.preventDefault();
}
