// The sender's own lines that reached the site but missed a platform for a
// TRANSIENT reason (not live, unreachable…). The send hook marks them (it knows
// the line's id from the route's answer); the chat row reads the mark and shows a
// zero-height inline marker labelled "not delivered to Kick" — never a row under
// the line (U1 rework). A persistent refusal is not marked at all: the composer's
// one note explains it (platformRefusals.ts).
//
// In-memory and per tab on purpose: it describes what THIS sender just saw happen,
// and nobody else's view of the line changes.
import { useSyncExternalStore } from "react";

const marks = new Map<number, readonly string[]>();
const listeners = new Set<() => void>();
const MAX_MARKS = 200;

/** Record that site line `id` did not reach `platforms`. */
export function markUndelivered(id: number, platforms: readonly string[]): void {
  if (!Number.isInteger(id) || platforms.length === 0) return;
  marks.set(id, [...platforms]);
  // Bounded like the chat buffer: an old mark's line has long scrolled away.
  while (marks.size > MAX_MARKS) marks.delete(marks.keys().next().value!);
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The platforms line `id` did not reach, or null. Pass a SITE line's id only — a
 *  platform line's id comes from another sequence and could collide. */
export function useUndelivered(id: string | number | null | undefined): readonly string[] | null {
  const n = typeof id === "string" && /^\d+$/.test(id) ? Number(id) : id;
  const key = typeof n === "number" && Number.isInteger(n) ? n : null;
  return useSyncExternalStore(
    subscribe,
    () => (key == null ? null : marks.get(key) ?? null),
    () => null,
  );
}
