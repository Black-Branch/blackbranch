"use client";

// The way back to an older room with the same person (client polish Task 20; dm-crypto-research B.4):
// at the start of a conversation, "Earlier conversation · 13 messages · Aug 5 – Oct 23". A tap opens
// that room's timeline, read-only — sending always goes to the conversation's active room. The
// message count is said only when the room's start is loaded (otherwise it would be a guess).

import type { Room } from "matrix-js-sdk";
import { isTimelineRow } from "@/app/lib/timelineRows";

const day = (ts: number, now: Date) => {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
};

/** "Earlier conversation · N messages · <first> – <last>" for `room`. */
function earlierLabel(room: Room, now = new Date()): string {
  const evs = room.getLiveTimeline().getEvents();
  const lines = evs.filter((e) => isTimelineRow(room, e));
  const started = evs.some((e) => e.getType() === "m.room.create");
  const first = room.currentState.getStateEvents("m.room.create", "")?.getTs() ?? lines[0]?.getTs() ?? 0;
  const last = lines[lines.length - 1]?.getTs() ?? first;
  const parts = ["Earlier conversation"];
  if (started) parts.push(lines.length === 1 ? "1 message" : `${lines.length} messages`);
  if (first) parts.push(day(first, now) === day(last, now) ? day(first, now) : `${day(first, now)} – ${day(last, now)}`);
  return parts.join(" · ");
}

/** The newest of `rooms` (the ones before this one, newest first) as a tap target. */
export function EarlierConversation({ rooms, onOpen }: { rooms: Room[]; onOpen: (room: Room) => void }) {
  const room = rooms[0];
  if (!room) return null;
  return (
    <button type="button" data-earlier-conversation="" onClick={() => onOpen(room)}
      className="h-6 max-w-full truncate rounded-full px-3 text-3xs font-semibold text-secondary hover:bg-surface-1 hover:text-body focus-visible:outline focus-visible:outline-edge-bright">
      {earlierLabel(room)}
    </button>
  );
}
