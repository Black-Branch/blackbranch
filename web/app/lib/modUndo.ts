// Act at once, with an Undo: a timeout or ban from the ⋯
// menu is applied the moment it is chosen, and an Undo is offered for a few seconds. One store
// for every host (live chat, the Chat history); `ModUndoToast` renders it.
//
// What the Undo window holds back: the message's removal. A ban removes the sender's message too,
// and a removal cannot be taken back (on a platform it is final) — so the removal runs only when
// the window closes (`commit`), and an Undo cancels it. `pagehide` runs every pending commit at
// once (with keepalive) so leaving the page never leaves a banned person's message standing.

export type Undoable = {
  id: number;
  label: string;
  /** Epoch ms the Undo stops being offered. */
  until: number;
};

type Entry = Undoable & { undo: () => Promise<{ ok: true } | { ok: false; error: string }>; commit: (leaving: boolean) => void; timer: ReturnType<typeof setTimeout> | null };

const UNDO_MS = 6000;

let entries: Entry[] = [];
let snapshot: readonly Undoable[] = [];
let nextId = 1;
const subs = new Set<() => void>();
let wired = false;

function changed() {
  snapshot = entries.map(({ id, label, until }) => ({ id, label, until }));
  for (const fn of Array.from(subs)) fn();
}

function finish(id: number, leaving = false) {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  if (e.timer) clearTimeout(e.timer);
  entries = entries.filter((x) => x.id !== id);
  changed();
  e.commit(leaving);
}

/** Every pending commit, now — the page is going away.
 *  @test-only the pagehide listener in this file runs it; the tests run it to settle state. */
export function flushUndos(): void {
  for (const e of [...entries]) finish(e.id, true);
}

/** Offer an Undo for an action already applied. `commit` runs when the offer ends without an Undo. */
export function offerUndo(label: string, undo: Entry["undo"], commit: Entry["commit"], ms = UNDO_MS): number {
  if (!wired && typeof window !== "undefined") {
    window.addEventListener("pagehide", flushUndos);
    wired = true;
  }
  const id = nextId++;
  const e: Entry = { id, label, until: Date.now() + ms, undo, commit, timer: null };
  e.timer = setTimeout(() => finish(id), ms);
  entries = [...entries, e];
  changed();
  return id;
}

/** Take the action back. The commit never runs. Resolves with how the undo went. */
export async function runUndo(id: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const e = entries.find((x) => x.id === id);
  if (!e) return { ok: false, error: "Too late to undo" };
  if (e.timer) clearTimeout(e.timer);
  entries = entries.filter((x) => x.id !== id);
  changed();
  return e.undo();
}

export function pendingUndos(): readonly Undoable[] {
  return snapshot;
}

export function subscribeUndos(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}
