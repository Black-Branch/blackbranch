// Direct messages on the one Matrix client: the ONE place a DM room is
// found or made — the Community tab and the terminal both call it, so the room's shape
// (direct, private, no guests, encrypted) cannot drift between them — and the reads the
// terminal makes over a DM room's timeline.
//
// Type-only SDK imports on purpose: the terminal is lazy-loaded and must not pull
// matrix-js-sdk into its chunk; the string event types below are the SDK's own values.
// Nothing here touches crypto: no setup, no bootstrap, no cross-signing, no store, no
// device — those belong to the Matrix client layer, whose device↔crypto-store invariants are
// strict. A line this device cannot decrypt is reported as such, never requested.
import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";
import { sendReadMarker } from "./matrixPrivacy.ts";
import { viewerBanned } from "./dm/banGate.ts";

const DIRECT = "m.direct";
const MESSAGE = "m.room.message";
const TIMELINE = "Room.timeline";
const ROOM_EVENT = "Room";

type DirectMap = Record<string, string[]>;

/** `m.direct` as the account holds it: partner id → room ids. */
function directMap(client: MatrixClient): DirectMap {
  return (client.getAccountData(DIRECT as never)?.getContent() as DirectMap | undefined) ?? {};
}

/** The joined DM room with `userId`, or null. */
// @parked plugin API: a console beside the chat (the owner plugin's terminal, app/(owner)/_terminal) reads or drives the chat through it
export function findDm(client: MatrixClient, userId: string): Room | null {
  return (directMap(client)[userId] ?? [])
    .map((id) => client.getRoom(id))
    .find((r): r is Room => !!r && r.getMyMembership() === "join") ?? null;
}

/** Open the DM with `userId`, or make it: direct, private, no guests, encrypted (megolm), written into
 *  `m.direct`, and waited for until sync delivers it (4 s at most). Null when it could not be made.
 *  The ban check below is a COURTESY, not a control: it runs in the viewer's own browser, which a
 *  banned person controls. The real refusals are server-side (the DM name-lookup and nudge routes,
 *  dm/banGate.ts); stopping a banned account at the homeserver itself needs a homeserver module
 *  that checks site bans — outside the web app. */
export async function openOrCreateDm(client: MatrixClient, userId: string, banned: () => Promise<boolean> = viewerBanned): Promise<Room | null> {
  const existing = findDm(client, userId);
  if (existing) return existing;
  if (await banned()) return null;
  const { room_id } = await client.createRoom({
    is_direct: true,
    invite: [userId],
    preset: "private_chat" as never,
    initial_state: [
      { type: "m.room.guest_access", state_key: "", content: { guest_access: "forbidden" } },
      { type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } },
    ] as never,
  });
  const current = directMap(client);
  await client.setAccountData(DIRECT as never, { ...current, [userId]: [...(current[userId] ?? []), room_id] } as never);
  // Wait for the new room to land in sync rather than a fixed sleep (which races and silently
  // no-ops the open on a slow sync); resolve the moment the Room event fires for our id.
  const now = client.getRoom(room_id);
  if (now) return now;
  return new Promise<Room | null>((resolve) => {
    const onRoom = (r: Room) => {
      if (r.roomId !== room_id) return;
      clearTimeout(timer);
      client.off(ROOM_EVENT as never, onRoom as never);
      resolve(r);
    };
    const timer = setTimeout(() => { client.off(ROOM_EVENT as never, onRoom as never); resolve(client.getRoom(room_id)); }, 4000);
    client.on(ROOM_EVENT as never, onRoom as never);
  });
}

/** Add `roomId` to `m.direct` under `userId` if it is not there (an accepted DM invite). */
export async function rememberDm(client: MatrixClient, userId: string, roomId: string): Promise<void> {
  const current = directMap(client);
  if ((current[userId] ?? []).includes(roomId)) return;
  await client.setAccountData(DIRECT as never, { ...current, [userId]: [...(current[userId] ?? []), roomId] } as never);
}

/** Every joined DM room with the partner it is with. */
// @parked plugin API: a console beside the chat (the owner plugin's terminal, app/(owner)/_terminal) reads or drives the chat through it
export function dmRooms(client: MatrixClient): { userId: string; room: Room }[] {
  const out: { userId: string; room: Room }[] = [];
  for (const [userId, ids] of Object.entries(directMap(client))) {
    const room = ids.map((id) => client.getRoom(id)).find((r): r is Room => !!r && r.getMyMembership() === "join");
    if (room) out.push({ userId, room });
  }
  return out;
}

export type DmLine = { ts: number; fromId: string; text: string; undecryptable?: boolean };

/** A message event as a line: its body after decryption, `[image]`/`[file]` for media, or the
 *  mark of a line this device cannot read. Null for anything that is not a message to show. */
function dmLineOf(ev: MatrixEvent): DmLine | null {
  if (ev.getType() !== MESSAGE || ev.isRedacted()) return null;
  const sender = ev.getSender() ?? "";
  const ts = ev.getTs();
  if (ev.isDecryptionFailure()) return { ts, fromId: sender, text: "", undecryptable: true };
  const c = ev.getContent() as { msgtype?: string; body?: string; "m.new_content"?: unknown };
  // An edit event is folded into its original by the SDK (getContent on the original answers the new text).
  if (c["m.new_content"]) return null;
  const text = c.msgtype === "m.image" ? "[image]" : c.msgtype === "m.file" ? "[file]" : c.msgtype === "m.audio" ? "[audio]" : c.msgtype === "m.video" ? "[video]" : String(c.body ?? "");
  return { ts, fromId: sender, text };
}

/** The room's lines as the client holds them (the live timeline — the first page). */
// @parked plugin API: a console beside the chat (the owner plugin's terminal, app/(owner)/_terminal) reads or drives the chat through it
export function dmLines(room: Room): DmLine[] {
  const out: DmLine[] = [];
  for (const ev of room.getLiveTimeline().getEvents()) {
    const l = dmLineOf(ev);
    if (l) out.push(l);
  }
  return out;
}

/** The read receipt the Community timeline sends: on the room's last event. */
// @parked plugin API: a console beside the chat (the owner plugin's terminal, app/(owner)/_terminal) reads or drives the chat through it
export function markDmRead(client: MatrixClient, room: Room): void {
  const evs = room.getLiveTimeline().getEvents();
  const last = evs[evs.length - 1];
  if (last) void sendReadMarker(client, room.roomId, last, { single: true }).catch(() => {});
}

/** New message events in DM rooms (any room when `roomId` is null), decrypted first when they need it. */
// @parked plugin API: a console beside the chat (the owner plugin's terminal, app/(owner)/_terminal) reads or drives the chat through it
export function onDmMessage(client: MatrixClient, roomId: string | null, fn: (room: Room, line: DmLine) => void): () => void {
  const handler = (ev: MatrixEvent, room: Room | undefined, toStart: boolean | undefined, _removed: boolean, data: { liveEvent?: boolean }) => {
    if (!room || toStart || data?.liveEvent === false) return;
    if (roomId ? room.roomId !== roomId : !dmRooms(client).some((d) => d.room.roomId === room.roomId)) return;
    if (ev.getType() !== MESSAGE) return;
    void client.decryptEventIfNeeded(ev).catch(() => {}).then(() => {
      const l = dmLineOf(ev);
      if (l) fn(room, l);
    });
  };
  client.on(TIMELINE as never, handler as never);
  return () => client.off(TIMELINE as never, handler as never);
}
