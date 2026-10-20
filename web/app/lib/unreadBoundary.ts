// The "New messages" line. Batch 1 made the client WRITE m.fully_read (with
// the public and private receipts) whenever the newest message is on screen;
// this is the first thing that reads a marker back. The client starts with
// initialSyncLimit: 30 and no persistent store, so a marker from before that
// window is not loaded yet on a fresh page load. Ruling: capture the
// marker's EVENT ID once when the room opens (never re-read — the receipt
// hook moves it 800 ms later, and Discord keeps the line where the reader
// found it), then derive its timestamp at render from the live room, so the
// line appears as soon as history pulls the marked event in (auto-fill or a
// scrollback) instead of never appearing at all.

/** The slice of Room this reads; an SDK Room satisfies it. */
export type MarkerRoom = {
  getAccountData(type: string): { getContent(): Record<string, unknown> } | undefined;
  getEventReadUpTo(userId: string): string | null;
};

/** The event id of the reader's read marker — m.fully_read first, then the
 *  latest receipt — or null. Captured once when a room opens. */
export function unreadMarkerId(room: MarkerRoom, myUserId: string): string | null {
  const marked = room.getAccountData("m.fully_read")?.getContent().event_id;
  if (typeof marked === "string" && marked) return marked;
  return room.getEventReadUpTo(myUserId);
}

/** The marker's timestamp once the marked event is loaded, else null (an old
 *  marker beyond the loaded window shows no line rather than a guessed one). */
export function markerTs(room: { findEventById(id: string): { getTs(): number } | undefined }, markerId: string | null): number | null {
  if (!markerId) return null;
  return room.findEventById(markerId)?.getTs() ?? null;
}

/** Index of the first event newer than the marker that the reader did not
 *  send (own messages never sit under a "New" line), or -1. */
export function firstUnreadIndex(
  events: ReadonlyArray<{ getTs(): number; getSender(): string | undefined }>,
  markerTs: number | null,
  myUserId: string
): number {
  if (markerTs === null) return -1;
  return events.findIndex((e) => e.getTs() > markerTs && e.getSender() !== myUserId);
}
