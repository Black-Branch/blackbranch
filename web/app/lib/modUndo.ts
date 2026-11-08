// Act at once, with an Undo: a timeout or ban from the ⋯
// menu is applied the moment it is chosen, and an Undo is offered for a few seconds. One store
// for every host (live chat, the Chat history); `ModUndoToast` renders it.
//
// The Undo takes back the ban only. A ban removes the sender's message at once too, and a removal
// cannot be taken back (a Matrix redaction and a platform deletion are final), so the toast says
// that removed messages stay removed.

export type Undoable = {
  id: number;
  label: string;
  /** Epoch ms the Undo stops being offered. */
  until: number;
};

type Entry = Undoable & { undo: () => Promise<{ ok: true } | { ok: false; error: string }>; timer: ReturnType<typeof setTimeout> | null };

const UNDO_MS = 6000;

let entries: Entry[] = [];
let snapshot: readonly Undoable[] = [];
let nextId = 1;
const subs = new Set<() => void>();

function changed() {
  snapshot = entries.map(({ id, label, until }) => ({ id, label, until }));
  for (const fn of Array.from(subs)) fn();
}

function finish(id: number) {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  if (e.timer) clearTimeout(e.timer);
  entries = entries.filter((x) => x.id !== id);
  changed();
}

/** End every offer now.
 *  @test-only the tests run it to settle state between cases. */
export function flushUndos(): void {
  for (const e of [...entries]) finish(e.id);
}

/** Offer an Undo for an action already applied, for `ms`. */
export function offerUndo(label: string, undo: Entry["undo"], ms = UNDO_MS): number {
  const id = nextId++;
  const e: Entry = { id, label, until: Date.now() + ms, undo, timer: null };
  e.timer = setTimeout(() => finish(id), ms);
  entries = [...entries, e];
  changed();
  return id;
}

/** Take the action back. Resolves with how the undo went. */
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
