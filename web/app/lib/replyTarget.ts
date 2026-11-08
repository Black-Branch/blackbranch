"use client";

// What a reply's quote shows (Discord: the original's first line, a tap jumps to it). The
// original is often older than the loaded window, so "not in the room" is not "deleted": it is
// fetched once, shared by every quote of it, and only a redacted original reads as deleted.
import { useEffect, useReducer } from "react";
import { MatrixEvent, MatrixEventEvent, RoomEvent } from "matrix-js-sdk";
import type { MatrixClient, Room } from "matrix-js-sdk";
import { fetchedEvents, fetchKey, type Fetched } from "./fetchedEvents.ts";

export type ReplyTarget = { state: "loaded"; ev: MatrixEvent } | { state: "loading" } | { state: "deleted" } | { state: "unavailable" };

const { inFlight, results } = fetchedEvents;
const WATCHED = new WeakSet<Room>();

/** A redaction of a cached original drops it, so the next quote fetches the redacted copy. */
function watch(room: Room): void {
  if (WATCHED.has(room)) return;
  WATCHED.add(room);
  room.on(RoomEvent.Redaction, (redaction: MatrixEvent) => {
    const id = redaction.getAssociatedId();
    if (id) forget(room, id);
  });
}

function forget(room: Room, id: string): void {
  const key = fetchKey(room.roomId, id);
  inFlight.delete(key);
  results.delete(key);
}

/** The event `id` of `room` from the server, decrypted if it needs it; one request per room and id
 *  however many ask. A redacted result is returned as the event. Any error — not found, not
 *  visible to this viewer (history from before they joined), a key this device does not hold, an
 *  event of another room — is "unavailable". */
export function fetchEventOnce(client: MatrixClient, room: Room, id: string): Promise<Fetched> {
  watch(room);
  const key = fetchKey(room.roomId, id);
  const cached = inFlight.get(key);
  if (cached) return cached;
  const p = client.fetchRoomEvent(room.roomId, id)
    .then(async (raw): Promise<Fetched> => {
      // A fresh event that has never been tried: decryptEventIfNeeded does decrypt it.
      const ev = new MatrixEvent(raw);
      if (ev.getRoomId() !== room.roomId) return "unavailable";
      await client.decryptEventIfNeeded(ev);
      return ev.isDecryptionFailure() || ev.getType() === "m.room.encrypted" ? "unavailable" : ev;
    })
    .catch((): Fetched => "unavailable")
    // Kept only while this fetch is still the entry: a redaction or a sign-out may have dropped it.
    .then((r) => { if (inFlight.get(key) === p) results.set(key, r); return r; });
  inFlight.set(key, p);
  return p;
}

function targetOf(room: Room, id: string): ReplyTarget {
  const fetched = room.findEventById(id) ?? results.get(fetchKey(room.roomId, id));
  if (!fetched) return { state: "loading" };
  if (fetched === "unavailable") return { state: "unavailable" };
  return fetched.isRedacted() ? { state: "deleted" } : { state: "loaded", ev: fetched };
}

/** The quoted original of a reply, kept current: loaded from the room or fetched once; "deleted"
 *  only when the event itself is redacted. */
export function useReplyTarget(client: MatrixClient | null | undefined, room: Room, id: string): ReplyTarget {
  const [, repaint] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    let live = true;
    const load = () => {
      if (client && !room.findEventById(id) && !results.has(fetchKey(room.roomId, id))) {
        void fetchEventOnce(client, room, id).then(() => { if (live) repaint(); });
      }
    };
    // Deleted while on screen: in the room the SDK redacts the event in place; a fetched copy is
    // fetched again (the server answers with the redacted event).
    const onRedaction = (redaction: MatrixEvent) => {
      if (redaction.getAssociatedId() !== id) return;
      forget(room, id);
      load();
      repaint();
    };
    // The original waiting for its key decrypts in place (keyWait.ts): the quote's text changes
    // while the event object does not, so repaint on its decrypt.
    const onDecrypted = (ev: MatrixEvent) => {
      if (ev.getId() === id && ev.getRoomId() === room.roomId) repaint();
    };
    room.on(RoomEvent.Redaction, onRedaction);
    client?.on(MatrixEventEvent.Decrypted, onDecrypted);
    load();
    return () => {
      live = false;
      room.off(RoomEvent.Redaction, onRedaction);
      client?.off(MatrixEventEvent.Decrypted, onDecrypted);
    };
  }, [client, room, id]);
  return targetOf(room, id);
}
