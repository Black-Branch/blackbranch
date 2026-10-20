import { RoomEvent, RoomStateEvent, MatrixEventEvent } from "matrix-js-sdk";
import type { Room, MatrixClient, MatrixEvent } from "matrix-js-sdk";

// The timeline-refresh subscription shared by every room-scoped panel (Timeline,
// ThreadPanel, ThreadsListPanel, ForumView). MatrixEventEvent.Decrypted is a
// CLIENT-wide event, so an unfiltered subscription would let a late decrypt in
// ANY joined room re-run the panel's full refresh. With the Community Hub
// auto-joining the whole space tree, a member sits in dozens of rooms at once —
// so an idle #general panel would rebuild its reaction and edit maps (and, for
// ForumView, re-scan the timeline per post) every time an unrelated room
// decrypted a backfilled event. Filtering by room here fixes all four call
// sites at once and keeps them from drifting apart.
//
// Room-level events (Timeline/Redaction/Members) are already scoped by virtue of
// being registered on the Room, so they pass through unguarded.
export function subscribeRoomRefresh(
  room: Room,
  client: MatrixClient | null | undefined,
  refresh: () => void,
  opts: { members?: boolean } = {}
): () => void {
  // Only re-render for decrypts belonging to THIS room.
  const onDecrypted = (ev: MatrixEvent) => {
    if (ev.getRoomId() === room.roomId) refresh();
  };

  room.on(RoomEvent.Timeline, refresh);
  room.on(RoomEvent.Redaction, refresh);
  if (opts.members) room.on(RoomStateEvent.Members, refresh);
  client?.on(MatrixEventEvent.Decrypted, onDecrypted);

  return () => {
    room.off(RoomEvent.Timeline, refresh);
    room.off(RoomEvent.Redaction, refresh);
    if (opts.members) room.off(RoomStateEvent.Members, refresh);
    client?.off(MatrixEventEvent.Decrypted, onDecrypted);
  };
}
