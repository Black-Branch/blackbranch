import type { MatrixEvent, Room } from "matrix-js-sdk";
import { isIgnoredSender } from "./ignoredBots.ts";

// Ids this page has seen as an EDIT or a THREAD REPLY. A redaction strips the
// relation out of an event's content (and the SDK moves a redacted thread reply
// to the main timeline), so once deleted those two look exactly like a deleted
// message — and Community › Deleted messages › "Show a note" would put a note in
// the main timeline for every deleted edit or thread reply. Remembering them
// while they still say what they are keeps those notes out. An event first seen
// already redacted cannot be told apart; that is the documented limit.
const RELATION_IDS = new Set<string>();

/** Remember thread-reply ids (the timeline passes its thread index's replies). */
export function noteRelationIds(ids: Iterable<string>): void {
  for (const id of ids) RELATION_IDS.add(id);
}

/** True when `e` is a row of the room's main timeline: a message or sticker,
 *  not from an ignored sender, not an edit echo, not a thread reply, and not
 *  deleted — unless `deleted` asks for deleted messages too (they render as a
 *  note). The timeline's list and the pinned panel's jump share this so a jump
 *  never targets something the list would not show. */
export function isTimelineRow(room: Room, e: MatrixEvent, opts: { deleted?: boolean } = {}): boolean {
  const t = e.getType();
  if (t !== "m.room.message" && t !== "m.sticker") return false;
  if (isIgnoredSender(room, e)) return false;
  const id = e.getId() ?? "";
  if (e.isRedacted()) return !!opts.deleted && !RELATION_IDS.has(id);
  const rel = (e.getContent() as Record<string, unknown>)["m.relates_to"] as { rel_type?: string } | undefined;
  if (rel?.rel_type === "m.replace" || rel?.rel_type === "m.thread") {
    if (id) RELATION_IDS.add(id);
    return false;
  }
  return true;
}
