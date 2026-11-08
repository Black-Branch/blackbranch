"use client";

// A message whose key has not reached this device says it is waiting, and fixes itself when the
// key arrives (Element shows the failure; we also show the wait). The key usually comes late in
// one of two ways: the sender's device shares it a moment after the message, or another of the
// reader's own devices receives it and puts it in the server-side key backup. The SDK asks the
// backup once per session at the moment decryption fails and not again, so while the open room
// holds waiting rows this asks again: `restoreKeyBackup` at 10 s, 30 s and 2 min, and when the
// tab comes back into view (at most once a minute) — never two restores within 20 s on one client,
// and at most three schedules per room for the session until a key really arrives (MIN_GAP_MS,
// MAX_SCHEDULES; kept per client across re-opens and shared by every view). An imported key makes the SDK retry the
// waiting events itself, and the `Decrypted` subscriptions every panel already has repaint them.
//
// Never `decryptEventIfNeeded` here: it is a no-op once an event has failed. `restoreKeyBackup`
// only imports room keys — no setup, bootstrap, signing, store or device is touched
// (vault systems/matrix-crypto.md). No SDK import: the DM window's chunk stays free of it.
import { useEffect, useState } from "react";
import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";

const DECRYPTED = "Event.decrypted";
const TIMELINE = "Room.timeline";

/** The failures a late key can still fix: the key never reached this device (yet), or the
 *  backup holds keys but not this one (yet). */
const WAITING_CODES = new Set(["MEGOLM_UNKNOWN_INBOUND_SESSION_ID", "OLM_UNKNOWN_MESSAGE_INDEX", "HISTORICAL_MESSAGE_WORKING_BACKUP"]);
const WAITING_COPY = "🔒 Waiting for this message's key…";
const SETTLED_COPY = "🔒 Can't read this message on this device — the sender's device didn't share its key";

/** Seconds after the first waiting row at which the backup is asked again. */
const RETRY_AT_MS = [10_000, 30_000, 120_000];
/** A tab coming back into view asks at most this often. */
const VISIBLE_GAP_MS = 60_000;
/** No two restores closer than this, whatever asks: each one downloads the whole backup (the SDK
 *  offers no per-room or per-session restore), and anyone in a room can send lines this device
 *  cannot read. */
const MIN_GAP_MS = 20_000;
/** Schedules per room for the session; past it the rows still say they are waiting but nothing
 *  more is scheduled, until a key really arrives or the tab comes back into view. */
const MAX_SCHEDULES = 3;

/** The lock row's words for a decryption failure code (`ev.decryptionFailureReason`). `settled`:
 *  the retries are spent and the key still has not come.
 *  @test-only every row reaches it through lockCopy below (the DM window too, since it renders the
 *  Community row — client polish Task 11); keyWait.test.ts pins each code's words directly. */
export function keyWaitCopy(code: string | undefined, settled: boolean): string {
  if (code && WAITING_CODES.has(code)) return settled ? SETTLED_COPY : WAITING_COPY;
  switch (code) {
    case "HISTORICAL_MESSAGE_NO_KEY_BACKUP":
    case "HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED":
      return "🔒 sent before you signed in on this device";
    case "HISTORICAL_MESSAGE_USER_NOT_JOINED":
      return "🔒 sent before you joined";
    case "MEGOLM_KEY_WITHHELD":
    case "MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE":
    case "UNSIGNED_SENDER_DEVICE":
      return "🔒 waiting for the sender to share the key";
    default:
      return "🔒 can’t decrypt this message";
  }
}

const isWaiting = (e: MatrixEvent): boolean => e.isDecryptionFailure() && WAITING_CODES.has(String(e.decryptionFailureReason ?? ""));

/** The lock row's words for this event, or undefined when it reads as a message. An event still
 *  being decrypted waits too. Callers pass it to the row as a prop: the SDK decrypts the SAME
 *  event object in place, so only a changed prop repaints a memoised row. */
export function lockCopy(e: MatrixEvent, settled: boolean): string | undefined {
  if (e.isDecryptionFailure()) return keyWaitCopy(String(e.decryptionFailureReason ?? ""), settled);
  if (e.getType() === "m.room.encrypted") return WAITING_COPY;
  return undefined;
}

type VisibilityTarget = Pick<EventTarget, "addEventListener" | "removeEventListener"> & { visibilityState: string };

/** One room's wait on one client: kept across unmounts so re-opening the room never resets it;
 *  every view of the room joins the one schedule. */
type RoomWait = {
  seen: Set<string>;
  schedules: number;
  settled: boolean;
  timers: ReturnType<typeof setTimeout>[];
  views: Set<(settled: boolean) => void>;
  /** Unsubscribe; null while no view of the room is open. */
  off: (() => void) | null;
};
/** Per client, for the session: `restoreKeyBackup` restores the account's WHOLE backup, so the
 *  floor between two restores is the client's, not a room's or a view's. */
type ClientWait = { lastCall: number; inFlight: boolean; rooms: Map<string, RoomWait> };
let WAITS = new WeakMap<MatrixClient, ClientWait>();

/** Forget every count and floor: called on sign-out, an account switch and a revoked session. */
export function forgetKeyWaits(): void {
  WAITS = new WeakMap();
}

/** Join (or start) the wait for one room: `onSettled(true)` once the last scheduled try found the
 *  rows still waiting, `onSettled(false)` whenever a message starts waiting again. Returns stop.
 *  @test-only exported for its own tests: product code waits through `useKeyWait` (below). */
export function startKeyWait(client: MatrixClient, room: Room, onSettled: (settled: boolean) => void, doc: VisibilityTarget): () => void {
  let cw = WAITS.get(client);
  if (!cw) { cw = { lastCall: -Infinity, inFlight: false, rooms: new Map() }; WAITS.set(client, cw); }
  const c = cw;
  let rw = c.rooms.get(room.roomId);
  if (!rw) { rw = { seen: new Set(), schedules: 0, settled: false, timers: [], views: new Set(), off: null }; c.rooms.set(room.roomId, rw); }
  const r = rw;
  r.views.add(onSettled);
  const stop = () => {
    r.views.delete(onSettled);
    if (!r.views.size && r.off) { r.off(); r.off = null; }
  };
  // Another view of this room is open: share its schedule.
  if (r.off) { onSettled(r.settled); return stop; }

  let stopped = false;
  const setSettled = (s: boolean) => { r.settled = s; for (const v of r.views) v(s); };
  const waitingIds = (): string[] => room.getLiveTimeline().getEvents().filter(isWaiting).map((e) => e.getId() ?? "");
  const clear = () => { for (const t of r.timers) clearTimeout(t); r.timers = []; };

  const restore = async (last: boolean) => {
    if (stopped || !waitingIds().length) return;
    if (!c.inFlight && Date.now() - c.lastCall >= MIN_GAP_MS) {
      c.lastCall = Date.now();
      c.inFlight = true;
      try {
        await client.getCrypto()?.restoreKeyBackup();
      } catch {
        // No backup key on this device, or the server refused: the copy settles, nothing else.
      } finally {
        c.inFlight = false;
      }
    }
    if (last && !stopped && waitingIds().length) setSettled(true);
  };

  // A new waiting message — or the room opened again with rows still waiting and not settled —
  // (re)starts the schedule, up to MAX_SCHEDULES per room for the session; past that the rows
  // still say they are waiting, and no restore is scheduled. The last waiting row resolving ends it.
  const check = (opening = false) => {
    if (stopped) return;
    const ids = waitingIds();
    const now = new Set(ids);
    for (const id of r.seen) if (!now.has(id)) r.seen.delete(id);
    if (!ids.length) { clear(); return; }
    const fresh = ids.some((id) => !r.seen.has(id));
    for (const id of ids) r.seen.add(id);
    if (!fresh && !(opening && !r.settled)) return;
    if (fresh) setSettled(false);
    if (r.schedules >= MAX_SCHEDULES) return;
    r.schedules++;
    clear();
    setSettled(false);
    r.timers = RETRY_AT_MS.map((ms, i) => setTimeout(() => void restore(i === RETRY_AT_MS.length - 1), ms));
  };
  const onTimeline = () => check();
  const onDecrypted = (e: MatrixEvent) => {
    if (e.getRoomId() !== room.roomId) return;
    // Only a waiting row that really decrypted lifts the cap (a redacted one does not).
    if (!e.isDecryptionFailure() && r.seen.has(e.getId() ?? "")) r.schedules = 0;
    check();
  };
  const onVisible = () => {
    if (doc.visibilityState !== "visible" || Date.now() - c.lastCall < VISIBLE_GAP_MS) return;
    r.schedules = 0;
    void restore(false);
  };

  client.on(DECRYPTED as never, onDecrypted as never);
  room.on(TIMELINE as never, onTimeline as never);
  doc.addEventListener("visibilitychange", onVisible);
  r.off = () => {
    stopped = true;
    clear();
    client.off(DECRYPTED as never, onDecrypted as never);
    room.off(TIMELINE as never, onTimeline as never);
    doc.removeEventListener("visibilitychange", onVisible);
  };
  onSettled(r.settled);
  check(true);
  return stop;
}

/** While `room` holds messages waiting for their key, ask the key backup again on the schedule
 *  above. Returns `settled`: the tries are spent, so the waiting rows say the key never came. */
export function useKeyWait(client: MatrixClient | null | undefined, room: Room | null | undefined): boolean {
  const [state, setState] = useState<{ roomId: string | null; settled: boolean }>({ roomId: null, settled: false });
  const roomId = room?.roomId ?? null;
  useEffect(() => {
    if (!client || !room) return;
    return startKeyWait(client, room, (settled) => setState({ roomId: room.roomId, settled }), document);
  }, [client, room]);
  // A settle from the room before is never this room's.
  return state.roomId === roomId && state.settled;
}
