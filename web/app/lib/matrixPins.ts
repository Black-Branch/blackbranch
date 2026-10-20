import { EventType } from "matrix-js-sdk";
import type { MatrixClient, Room, StateEvents } from "matrix-js-sdk";

// Channel pins = m.room.pinned_events, the Matrix primitive Element already
// lists in a room's info panel. Not bridged: the Discord bridge neither reads
// Discord's pins nor writes ours (portal.go returns early on the pin system
// message and has no ChannelPinsUpdate handler), so pins live on the site and
// in Element only.

/** Discord's cap per channel; also keeps the state event bounded. */
export const PIN_LIMIT = 50;

/** The slice of Room these read; an SDK Room satisfies it. */
export type PinRoom = {
  currentState: {
    getStateEvents(type: string, key: string): { getContent(): Record<string, unknown> } | null | undefined;
    maySendStateEvent(type: string, userId: string): boolean;
  };
};

/** Pinned event ids in stored (pin) order — strings only, deduplicated. */
export function pinnedEventIds(room: PinRoom): string[] {
  const raw = room.currentState.getStateEvents(EventType.RoomPinnedEvents, "")?.getContent().pinned;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const id of raw) if (typeof id === "string" && id && !out.includes(id)) out.push(id);
  return out;
}

/** The room's own power-level rule for the state event (state_default is 50
 *  unless the room says otherwise) — not a number hardcoded here. */
export function canPin(room: PinRoom, userId: string): boolean {
  return room.currentState.maySendStateEvent(EventType.RoomPinnedEvents, userId);
}

/** The list after pinning (`pinned` false) or unpinning (`pinned` true)
 *  `eventId`; null when a pin would pass the limit. */
export function pinnedAfterToggle(current: readonly string[], eventId: string, pinned: boolean): string[] | null {
  if (pinned) return current.filter((id) => id !== eventId);
  if (current.includes(eventId)) return [...current];
  if (current.length >= PIN_LIMIT) return null;
  return [...current, eventId];
}

export function writePinned(client: MatrixClient, room: Room, ids: string[]): Promise<unknown> {
  return client.sendStateEvent(
    room.roomId,
    EventType.RoomPinnedEvents,
    { pinned: ids } as StateEvents[EventType.RoomPinnedEvents],
    ""
  );
}
