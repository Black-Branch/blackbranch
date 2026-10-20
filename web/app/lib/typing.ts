// Discord's typing-indicator copy, and the id list the room's members yield
// for the reader. An `m.typing` ephemeral event carries no room_id (it is
// folded into each member's `.typing` flag before the SDK re-emits it as
// RoomMemberEvent.Typing), so both the seed and the update read the flag off
// the room itself — one expression, so they cannot drift.

export function typingLabel(names: string[]): string | null {
  const n = names.length;
  if (n === 0) return null;
  if (n === 1) return `${names[0]} is typing…`;
  if (n === 2) return `${names[0]} and ${names[1]} are typing…`;
  if (n === 3) return `${names[0]}, ${names[1]}, and ${names[2]} are typing…`;
  return "Several people are typing…";
}

/** The slice of Room this reads; an SDK Room satisfies it. */
export type TypingRoom = { getMembers(): Array<{ userId: string; typing: boolean }> };

/** Everyone the SDK currently flags as typing in `room`, minus the reader. */
export function typingUserIds(room: TypingRoom, myUserId: string): string[] {
  const out: string[] = [];
  for (const m of room.getMembers()) {
    if (m.typing && m.userId !== myUserId && !out.includes(m.userId)) out.push(m.userId);
  }
  return out;
}
