import type { Room, MatrixEvent } from "matrix-js-sdk";
import { isIgnoredSender } from "./ignoredBots.ts";

// Thread support is client-side and timeline-driven: a thread reply is any
// message whose `m.relates_to.rel_type === "m.thread"` points at the root event.
// We read straight from the live timeline (same approach as matrixReactions /
// matrixEdits) so threads work without depending on the SDK's Thread aggregation
// being populated, and survive late decrypts in E2EE rooms.

// The canonical thread root for an event: if the event is itself a thread reply,
// the root is what it relates to; otherwise the event is its own (potential) root.
export function threadRootId(ev: MatrixEvent): string {
  const rel = (ev.getContent() as Record<string, unknown>)["m.relates_to"] as
    | { rel_type?: string; event_id?: string }
    | undefined;
  if (rel?.rel_type === "m.thread" && rel.event_id) return rel.event_id;
  return ev.getId() ?? "";
}

// rootId → its replies, in timeline order. One pass over the live timeline
// answers every thread question for that pass.
//
// Without this, each caller would re-scan the whole timeline per root: listPosts
// two full scans for EVERY top-level post, and a MatrixMessageRow's reply chip
// one per rendered row. The scans are O(events) and the callers are O(roots), so
// the cost would be quadratic in room size — a 60-post forum over a 250-event
// timeline spends ~30k event visits per refresh, and ForumView's scrollback(80)
// drives one refresh per paginated event.
export type ThreadIndex = Map<string, MatrixEvent[]>;

/** Predicate shared with threadReplies so the index can't drift from the scan. */
function isThreadReplyTo(room: Room, e: MatrixEvent): { root: string } | null {
  const t = e.getType();
  if (t !== "m.room.message" && t !== "m.sticker") return null;
  if (e.isRedacted()) return null; // deleted replies vanish from view
  if (isIgnoredSender(room, e)) return null;
  const rel = (e.getContent() as Record<string, unknown>)["m.relates_to"] as
    | { rel_type?: string; event_id?: string }
    | undefined;
  if (rel?.rel_type === "m.replace") return null;
  if (rel?.rel_type !== "m.thread" || !rel.event_id) return null;
  return { root: rel.event_id };
}

export function buildThreadIndex(room: Room): ThreadIndex {
  const out: ThreadIndex = new Map();
  for (const e of room.getLiveTimeline().getEvents()) {
    const hit = isThreadReplyTo(room, e);
    if (!hit) continue;
    const arr = out.get(hit.root);
    if (arr) arr.push(e);
    else out.set(hit.root, [e]);
  }
  return out;
}

// Message/sticker replies in a thread, in timeline order. Edit echoes (m.replace)
// are excluded — they render through the original event, not as their own rows.
// Pass `index` when answering for more than one root to avoid the rescan.
export function threadReplies(room: Room, rootId: string, index?: ThreadIndex): MatrixEvent[] {
  if (!rootId) return [];
  if (index) return index.get(rootId) ?? [];
  return room
    .getLiveTimeline()
    .getEvents()
    .filter((e) => isThreadReplyTo(room, e)?.root === rootId);
}

// Reply count for the indicator chip. Prefers the SDK Thread length (it can know
// of replies not yet paginated into the live timeline) and falls back to the
// timeline scan so the chip still shows from loaded replies alone.
export function countThreadReplies(room: Room, rootId: string, index?: ThreadIndex): number {
  if (!rootId) return 0;
  try {
    const th = (room as unknown as { getThread?: (id?: string) => { length?: number } | null }).getThread?.(rootId);
    const n = th?.length ?? 0;
    if (n > 0) return n;
  } catch {
    /* getThread can throw if thread support is off — fall through to the scan */
  }
  // The common case (a post with no thread) never satisfies getThread, so this
  // fallback is the hot path, not the exception — hence the index.
  return threadReplies(room, rootId, index).length;
}

// The most recent reply in a thread, for the root's summary chip preview.
// Null if none are loaded into the live timeline.
export function lastThreadReply(room: Room, rootId: string, index?: ThreadIndex): MatrixEvent | null {
  const r = threadReplies(room, rootId, index);
  return r.length ? (r[r.length - 1] ?? null) : null;
}

// All threads in a room (for the Threads activity list), newest-active first.
// A thread = any root event that has at least one m.thread reply loaded.
export type ThreadSummary = { root: MatrixEvent; count: number; last: MatrixEvent | null };
export function listThreads(room: Room): ThreadSummary[] {
  // One pass builds every root's replies; previously this scanned once to collect
  // root ids and then twice MORE per root (threadReplies, then countThreadReplies
  // falling through to another threadReplies).
  const index = buildThreadIndex(room);
  const out: ThreadSummary[] = [];
  for (const [id, replies] of index) {
    if (replies.length === 0) continue;
    const root = room.findEventById(id);
    if (!root || root.isRedacted() || isIgnoredSender(room, root)) continue;
    out.push({
      root,
      count: Math.max(countThreadReplies(room, id, index), replies.length),
      last: replies[replies.length - 1] ?? null,
    });
  }
  out.sort((a, b) => (b.last?.getTs() ?? b.root.getTs()) - (a.last?.getTs() ?? a.root.getTs()));
  return out;
}

// The relation block for a new thread reply. `latestId` is the last event in the
// thread (or the root) so non-threaded clients render it as a normal reply
// (is_falling_back), while thread-aware clients slot it into the thread.
export function threadRelation(rootId: string, latestId: string): Record<string, unknown> {
  return {
    rel_type: "m.thread",
    event_id: rootId,
    is_falling_back: true,
    "m.in_reply_to": { event_id: latestId },
  };
}
