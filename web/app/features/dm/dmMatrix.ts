// The DM window's Matrix side.
// Reads the page's one client through app/lib/matrixHandle.ts and makes rooms only through
// app/lib/matrixDm.ts, the one place a DM room is found or made.
// Nothing here touches crypto setup, a store or a device — those belong to the Matrix client
// layer, whose device↔crypto-store invariants are strict. The encryption check READS (getCrypto,
// isEncryptionEnabledInRoom, getUserDeviceInfo — the same key query sending into the room makes).
// Type-only SDK imports keep matrix-js-sdk out of the chunk.
import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";
import { matrixHandle, onMatrixHandle, type MxHandle } from "@/app/lib/matrixHandle";
import { dmLines, dmRooms, onDmMessage, openOrCreateDm, rememberDm, type DmLine } from "@/app/lib/matrixDm";

const MY_MEMBERSHIP = "Room.myMembership";
const TIMELINE = "Room.timeline";
const DECRYPTED = "Event.decrypted";
const LOCAL_ECHO = "Room.localEchoUpdated";

/** How long opening waits for the client to start (sign-in check, SDK, crypto, first sync). */
const READY_MS = 30_000;
/** A nudge looks back this far for what arrived before the client was up. */
const SCAN_BACK_MS = 10 * 60_000;

export type Ready = { ok: true; client: MatrixClient } | { ok: false; reason: "signin" | "down" };

/** The client, started if it is not running (opening a DM is real intent). */
export function ensureMatrix(): Promise<Ready> {
  const settle = (h: MxHandle): Ready | null =>
    h.status === "ready" && h.client ? { ok: true, client: h.client }
    : h.status === "notoken" ? { ok: false, reason: "signin" }
    : h.status === "error" ? { ok: false, reason: "down" }
    : null;
  const now = settle(matrixHandle());
  if (now) return Promise.resolve(now);
  void matrixHandle().startClient().catch(() => {});
  return new Promise((resolve) => {
    const timer = setTimeout(() => { off(); resolve({ ok: false, reason: "down" }); }, READY_MS);
    const off = onMatrixHandle((h) => {
      const r = settle(h);
      if (!r) return;
      clearTimeout(timer);
      off();
      resolve(r);
    });
  });
}

/** A pending DM invite from `userId`, if there is one. */
function inviteFrom(client: MatrixClient, userId: string): Room | null {
  return client.getRooms().find((r) => r.getMyMembership() === "invite" && r.getDMInviter() === userId) ?? null;
}

/** Join an invite and file it under its partner in `m.direct` (the Community tab's Accept). */
export async function acceptInvite(client: MatrixClient, roomId: string, partner: string): Promise<void> {
  await client.joinRoom(roomId);
  await rememberDm(client, partner, roomId);
}

/** The conversation with `userId`: their pending invite accepted, else found or made. */
export async function openConversation(client: MatrixClient, userId: string): Promise<Room | null> {
  const invite = inviteFrom(client, userId);
  if (invite) {
    await acceptInvite(client, invite.roomId, userId);
    return client.getRoom(invite.roomId);
  }
  return openOrCreateDm(client, userId);
}

export type Arrival = { partner: string; roomId: string; invite: boolean };

/** New invites and new messages from others, from now on. */
export function watchArrivals(client: MatrixClient, fn: (a: Arrival) => void): () => void {
  const me = client.getUserId();
  const onMembership = (room: Room, membership: string, prev?: string) => {
    if (membership !== "invite" || prev === "invite") return;
    const inviter = room.getDMInviter();
    if (inviter && inviter !== me) fn({ partner: inviter, roomId: room.roomId, invite: true });
  };
  client.on(MY_MEMBERSHIP as never, onMembership as never);
  const offMessages = onDmMessage(client, null, (room, line) => {
    if (line.fromId === me) return;
    const partner = dmRooms(client).find((d) => d.room.roomId === room.roomId)?.userId ?? line.fromId;
    fn({ partner, roomId: room.roomId, invite: false });
  });
  return () => {
    client.off(MY_MEMBERSHIP as never, onMembership as never);
    offMessages();
  };
}

/** What arrived in the last few minutes, newest first — after a nudge started the client late. */
export function recentArrivals(client: MatrixClient, now = Date.now()): Arrival[] {
  const me = client.getUserId();
  const out: (Arrival & { ts: number })[] = [];
  for (const room of client.getRooms()) {
    if (room.getMyMembership() !== "invite") continue;
    const inviter = room.getDMInviter();
    // An invite's stripped state may carry no timestamp (0): kept, since the nudge says it is new.
    const ts = room.getMember(me ?? "")?.events.member?.getTs() ?? 0;
    if (inviter && inviter !== me && (ts === 0 || now - ts < SCAN_BACK_MS)) out.push({ partner: inviter, roomId: room.roomId, invite: true, ts });
  }
  for (const { userId, room } of dmRooms(client)) {
    const last = dmLines(room).at(-1);
    const unread = room.getUnreadNotificationCount("total" as never) ?? 0;
    if (last && last.fromId !== me && unread > 0 && now - last.ts < SCAN_BACK_MS) {
      out.push({ partner: userId, roomId: room.roomId, invite: false, ts: last.ts });
    }
  }
  return out.sort((a, b) => b.ts - a.ts).map((a) => ({ partner: a.partner, roomId: a.roomId, invite: a.invite }));
}

/** The room's lines, kept current: new events, decryptions and the sender's own echo. */
export function followLines(client: MatrixClient, roomId: string, fn: (lines: DmLine[]) => void): () => void {
  const push = () => {
    const room = client.getRoom(roomId);
    if (room) fn(dmLines(room).slice(-50));
  };
  const onTimeline = (_ev: MatrixEvent, room?: Room) => { if (room?.roomId === roomId) push(); };
  const onDecrypted = (ev: MatrixEvent) => { if (ev.getRoomId() === roomId) push(); };
  client.on(TIMELINE as never, onTimeline as never);
  client.on(DECRYPTED as never, onDecrypted as never);
  client.on(LOCAL_ECHO as never, onTimeline as never);
  push();
  return () => {
    client.off(TIMELINE as never, onTimeline as never);
    client.off(DECRYPTED as never, onDecrypted as never);
    client.off(LOCAL_ECHO as never, onTimeline as never);
  };
}

/** The one plain red line when encryption is not in force, or null when it is. */
export async function encryptionCaution(client: MatrixClient, roomId: string, peer: string, name: string): Promise<string | null> {
  const crypto = client.getCrypto();
  if (!crypto) return "Encryption isn't running in this browser — messages here are not protected.";
  if (!(await crypto.isEncryptionEnabledInRoom(roomId))) return "This conversation isn't encrypted.";
  const devices = await crypto.getUserDeviceInfo([peer], true);
  if (!devices.get(peer)?.size) return `${name} hasn't set up encrypted messages yet — they may not be able to read this.`;
  return null;
}
