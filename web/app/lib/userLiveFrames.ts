// The popped-out user card's live buffer: one person's lines, kept in step with
// the room's deletions. Pure, so it runs under `node --test`.
//
// It reads the TYPED frame union (wsFrames.ts) — a `delete` names its line by
// `platform` + `messageId`, and a `purge` carries a list of them. The card used
// to cast the frame to `{ id }` and read a field the server never sends, so a
// deleted or purged line stayed on the card.
//
// Same visibility rule as the main chat (useChatMessages): a removed line is gone,
// except for a moderator who opted in to see deleted lines — they keep it struck out.
import type { ChatMsg } from "./chatMsg.ts";
import type { StreamFrame } from "./wsFrames.ts";
import { chatKey, isKeyable } from "./chatSeed.ts";

const MAX = 200;

export type CardView = {
  /** Is this line from the person the card is about? */
  mine: (m: ChatMsg) => boolean;
  /** A moderator who opted in to see deleted lines (struck out) — everyone else loses them. */
  showDeleted: boolean;
};

function remove(prev: ChatMsg[], keys: Set<string>, showDeleted: boolean): ChatMsg[] {
  if (!prev.some((m) => keys.has(chatKey(m)))) return prev;
  return showDeleted
    ? prev.map((m) => (keys.has(chatKey(m)) ? { ...m, deleted: true } : m))
    : prev.filter((m) => !keys.has(chatKey(m)));
}

/** The card's buffer after one frame. Returns `prev` itself when nothing changed. */
export function applyCardFrame(prev: ChatMsg[], frame: StreamFrame, view: CardView): ChatMsg[] {
  switch (frame.type) {
    case "history": {
      // The replay on connect: whatever of theirs is still in the server's ring buffer.
      const theirs = frame.messages.filter((m) => isKeyable(m) && view.mine(m));
      if (!frame.delta) return theirs.filter((m) => view.showDeleted || !m.deleted).slice(-MAX);
      // A resume sends only what changed: folded in by id, a deleted line leaving as on a delete.
      if (theirs.length === 0) return prev;
      const byKey = new Map(theirs.map((m) => [chatKey(m), m]));
      const kept = prev.map((m) => byKey.get(chatKey(m)) ?? m);
      const have = new Set(prev.map(chatKey));
      const merged = [...kept, ...theirs.filter((m) => !have.has(chatKey(m)))];
      const gone = new Set(theirs.filter((m) => m.deleted).map(chatKey));
      return remove(merged, gone, view.showDeleted).slice(-MAX);
    }
    case "message": {
      const m: ChatMsg = frame;
      if (!isKeyable(m) || !view.mine(m)) return prev;
      if (m.deleted && !view.showDeleted) return prev;
      return [...prev, m].slice(-MAX);
    }
    case "delete":
      return remove(prev, new Set([`${frame.platform}:${frame.messageId}`]), view.showDeleted);
    case "purge":
      return remove(prev, new Set(frame.ids.filter(isKeyable).map((it) => `${it.platform}:${it.id}`)), view.showDeleted);
    default:
      return prev;
  }
}
