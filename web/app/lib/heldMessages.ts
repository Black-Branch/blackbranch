// A message the sender wrote that is held for a moderator (word filter, link
// gate). Without this, a held send answers 202 and the sender sees nothing at
// all.
//
// Pure: shared by the sender-only status route (server) and the pending line
// (client). The wire between the send hook and the chat list is the same shape
// as chatNotice.ts, because the hook lives in the composer and the list does not.

export type HeldState = "pending" | "approved" | "rejected" | "expired";

export const HELD_PENDING_TEXT = "Held for review — only you can see this";
export const HELD_REJECTED_TEXT = "Not approved by a moderator";
export const HELD_EXPIRED_TEXT = "Not posted — no moderator reviewed it in time";
/** How often a visible pending line asks whether a moderator decided. */
export const HELD_POLL_MS = 10_000;

/** site.automod_held.status → what the sender is told. A row that is neither
 *  waiting nor allowed was not posted. */
export function heldStateOf(status: string): HeldState {
  if (status === "pending") return "pending";
  if (status === "allowed") return "approved";
  if (status === "expired") return "expired";
  return "rejected";
}

export type HeldAnnouncement = { rowId: number; text: string };
type Listener = (h: HeldAnnouncement) => void;
const listeners = new Set<Listener>();

/** Subscribe; returns the unsubscribe (shaped for a useEffect cleanup). */
export function onHeldMessage(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Tell the chat list a message was held. False when no list is listening (the
 *  caller then says it some other way). */
export function announceHeld(h: HeldAnnouncement): boolean {
  for (const fn of listeners) fn(h);
  return listeners.size > 0;
}
