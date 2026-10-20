// Composer binding.
//
// A window that needs the composer BINDS it with a declaration:
//   • sendTo — a submitted line goes to the binding's own `send` (the DM window's
//     Matrix room), NEVER the chat wire, and the send-to control wears the
//     binding's face (the other user's pfp). It is a function, not a
//     destination string: /api/chat/send drops an unknown destination to the
//     public room, so a string could leak a DM there.
// (No window takes every line: the terminal and the chat box are used side by
// side, and the terminal sends with `say` through lib/chatSender.)
//
// ONE-BOUND-WINDOW LAW = last-bind-wins. The composer has one destination, so
// there is one slot: binding while another window holds it dismisses the
// previous holder (its onRelease runs — its requestClose) BEFORE the new
// binding is installed. The law enforces itself structurally. The one thing
// the law cannot police is a holder whose onRelease itself calls
// bindComposer: that is outside the tenant contract — onRelease dismisses,
// it never binds.
//
// LIFECYCLES ARE LINKED BOTH WAYS. releaseComposer() runs the holder's
// onRelease, so the window dismisses. A window that dismisses on its own
// (swipe-down, ✕, Escape) calls releaseComposer(its id) from its close path,
// so the binding clears. Both are idempotent: a release by a window that no
// longer holds the slot is a no-op, and a holder's onRelease that re-enters
// releaseComposer finds the slot already empty.
//
// Pure: no React, no DOM. useComposerBinding.ts is the subscription. ChatInput
// is the only production READER (the live seam); tenants are the
// WRITERS. The DM window (app/features/dm) is the one tenant.
// The Matrix composer (MatrixInput.tsx) has its own send path and is NOT
// seam-aware — a bound window receives lines from the chat composer only.

export type BindingFace = {
  label: string;
  avatarUrl?: string | null;
  /** The composer's destination colour while bound (composerAccent). */
  accent?: string | null;
};

export type ComposerBinding =
  | { kind: "sendTo"; windowId: string; send: (text: string) => Promise<void>; face: BindingFace; onRelease: () => void };

let current: ComposerBinding | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

/** Bind the composer to a window. Returns a release for THIS binding (a no-op
 *  once the window has lost the slot). Re-binding the same windowId replaces
 *  the declaration without releasing — a window updating its own face.
 *
 *  ChatInput is the reader, tenants are the writers. Exercised by
 *  composerBinding.test.ts and the fit-check (chrome/fitCheck.test.ts). */
export function bindComposer(b: ComposerBinding): () => void {
  const prev = current;
  if (prev && prev.windowId !== b.windowId) {
    current = null;      // cleared FIRST: the previous holder's own release call is a no-op
    emit();
    prev.onRelease();    // last-bind-wins: the previous window dismisses
  }
  current = b;
  emit();
  return () => { releaseComposer(b.windowId); };
}

/** Release the composer if `windowId` holds it. Runs the holder's onRelease
 *  (the window dismisses). A window that no longer holds the slot gets `false`
 *  and nothing happens — the store never dismisses the wrong window. */
export function releaseComposer(windowId: string): boolean {
  if (!current || current.windowId !== windowId) return false;
  const held = current;
  current = null;
  emit();
  held.onRelease();
  return true;
}

/** The slot, read synchronously — the submit path reads THIS, not a render's
 *  value, so a bind between render and submit wins. */
export function currentBinding(): ComposerBinding | null {
  return current;
}

export function subscribeComposerBinding(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** @test-only clears the slot and the listeners between tests. */
export function _resetComposerBindingForTests(): void {
  current = null;
  listeners.clear();
}
