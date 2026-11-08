import type { MatrixEvent, Room } from "matrix-js-sdk";
import { isIgnoredSender } from "./ignoredBots.ts";
import { isPollStartType } from "./pollStart.ts";

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

const ENCRYPTED = "m.room.encrypted";
const VERIFICATION = "m.key.verification.";
// Relations an encrypted event carries in the clear: a reaction, an edit, a thread reply or a
// verification step is never a row, read or not (it would flash a lock and vanish).
const NOT_A_ROW_REL = new Set(["m.annotation", "m.replace", "m.thread", "m.reference"]);

/** An in-room verification event: any `m.key.verification.*` type, or the request another client
 *  sends as a message (`msgtype: m.key.verification.request`, whose body is fallback text for
 *  clients without in-chat verification). Never a message to show; the request shows in Settings. */
export function isVerificationEvent(e: MatrixEvent): boolean {
  if (e.getType().startsWith(VERIFICATION)) return true;
  const msgtype = (e.getContent() as { msgtype?: unknown }).msgtype;
  return typeof msgtype === "string" && msgtype.startsWith(VERIFICATION);
}

/** Whether a row's event is deleted, as a list hands it to MatrixMessageRow (its `redacted` prop).
 *  The SDK redacts the same event object in place, so the memoised row repaints only on a changed
 *  prop; the lists read it here, beside the rule that decides whether a deleted row shows at all. */
export function rowRedacted(e: Pick<MatrixEvent, "isRedacted">): boolean {
  return e.isRedacted();
}

/** True when `e` is a row of the room's main timeline: a message, sticker or poll,
 *  not from an ignored sender, not an edit echo, not a thread reply, not a
 *  verification event, and not deleted — unless `deleted` asks for deleted
 *  messages too (they render as a note). An encrypted event not yet decrypted
 *  is a row (the lock row) from the start, so the list does not jump when it
 *  resolves. The timeline's list and the pinned panel's jump share this so a
 *  jump never targets something the list would not show. */
export function isTimelineRow(room: Room, e: MatrixEvent, opts: { deleted?: boolean } = {}): boolean {
  const t = e.getType();
  // A poll started in another Matrix app is a row too (both spellings; PollStartCard draws it).
  if (t !== "m.room.message" && t !== "m.sticker" && t !== ENCRYPTED && !isPollStartType(t)) return false;
  if (isIgnoredSender(room, e)) return false;
  const id = e.getId() ?? "";
  if (e.isRedacted()) return t !== ENCRYPTED && !!opts.deleted && !RELATION_IDS.has(id);
  if (isVerificationEvent(e)) return false;
  // Not decrypted (still pending, or failed): only the wire content says what it relates to.
  const wire = (e.getWireContent() as Record<string, unknown>)["m.relates_to"] as { rel_type?: string } | undefined;
  if (wire?.rel_type && NOT_A_ROW_REL.has(wire.rel_type)) {
    if (id && (wire.rel_type === "m.replace" || wire.rel_type === "m.thread")) RELATION_IDS.add(id);
    return false;
  }
  const rel = (e.getContent() as Record<string, unknown>)["m.relates_to"] as { rel_type?: string } | undefined;
  if (rel?.rel_type === "m.replace" || rel?.rel_type === "m.thread") {
    if (id) RELATION_IDS.add(id);
    return false;
  }
  return true;
}
