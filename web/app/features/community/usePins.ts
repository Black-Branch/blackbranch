"use client";

import { useEffect, useState } from "react";
import { EventType, RoomStateEvent } from "matrix-js-sdk";
import type { MatrixEvent, Room } from "matrix-js-sdk";
import { pinnedEventIds } from "@/app/lib/matrixPins";

/** The room's pinned event ids, live. Its own subscription rather than an
 *  option on subscribeRoomRefresh: a pin change should not rebuild the whole
 *  timeline, and RoomStateEvent.Events fires for every state event, so it is
 *  filtered to the one type here. */
export function usePinnedEventIds(room: Room): string[] {
  const [key, setKey] = useState<string | null>(null);
  const [ids, setIds] = useState<string[]>([]);
  if (key !== room.roomId) {
    setKey(room.roomId);
    setIds(pinnedEventIds(room));
  }

  useEffect(() => {
    const onState = (ev: MatrixEvent) => {
      if (ev.getType() === EventType.RoomPinnedEvents) setIds(pinnedEventIds(room));
    };
    room.on(RoomStateEvent.Events, onState);
    return () => {
      room.off(RoomStateEvent.Events, onState);
    };
  }, [room]);

  return ids;
}
