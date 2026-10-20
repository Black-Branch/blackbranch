import type { ChatMsg } from "./chatMsg.ts";
import { msgTs } from "./historyCursor.ts";
import { chatKey, isKeyable } from "./chatSeed.ts";
import { CHAT_OVERLAY_CAP } from "./chatCaps.ts";

// The OBS source's buffer rules (ChatOverlay), pure so node --test pins them:
// it is the public stream, so deleted rows are removed for everyone and poll
// cards never enter (the dedicated /overlay/poll source owns on-stream polls,
// and this overlay receives no pollUpdate frames). Oldest first, the newest
// CHAT_OVERLAY_CAP kept.

const shows = (m: ChatMsg) => isKeyable(m) && !m.deleted && m.system !== "poll";
const cap = (rows: ChatMsg[]) => (rows.length > CHAT_OVERLAY_CAP ? rows.slice(-CHAT_OVERLAY_CAP) : rows);

/** The buffer's first state from the server page's rows. */
export function seedOverlayRows(initial: ChatMsg[] | undefined): ChatMsg[] {
  if (!initial || initial.length === 0) return [];
  return cap(initial.filter(shows).sort((a, b) => msgTs(a) - msgTs(b)));
}

/**
 * The socket's `history` frame folded INTO the buffer, never replacing it: after
 * a stream-api restart the frame is empty, and a replace would wipe the seeded
 * rows. Rows the frame reports deleted leave; rows it adds join; same identity
 * is not duplicated. Returns `prev` itself when nothing changes.
 */
export function mergeOverlayHistory(prev: ChatMsg[], history: ChatMsg[]): ChatMsg[] {
  const incoming = history.filter(isKeyable);
  if (incoming.length === 0) return prev;
  const incomingKeys = new Set(incoming.map(chatKey));
  const kept = prev.filter((m) => !incomingKeys.has(chatKey(m)));
  const add = incoming.filter(shows);
  return cap([...kept, ...add].sort((a, b) => msgTs(a) - msgTs(b)));
}
