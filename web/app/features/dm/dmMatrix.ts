// The DM window's Matrix side.
// Reads the page's one client through app/lib/matrixHandle.ts and makes rooms only through
// app/lib/matrixDm.ts, the one place a DM room is found or made.
// Nothing here touches crypto setup, a store or a device — those belong to the Matrix client
// layer, whose device↔crypto-store invariants are strict. The encryption check READS (getCrypto,
// isEncryptionEnabledInRoom, getUserDeviceInfo — the same key query sending into the room makes).
// Type-only SDK imports keep matrix-js-sdk out of the chunk.
import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";
import { matrixHandle, onMatrixHandle, type MxHandle } from "@/app/lib/matrixHandle";
import { acceptInviteAndFile, dmLines, dmRooms, findDmRoom, NOT_PRIVATE, onDmMessage, roomForSending, SEND_FAILED, strictlyOurs } from "@/app/lib/matrixDm";
import { buildMatrixMessage, type MatrixMessageContent } from "@/app/lib/buildMatrixMessage";
import type { EmoteMap } from "@/app/lib/emoteMap";
import { echoState, localEchoOf, retryEcho } from "@/app/lib/localEcho";
import type { DmPerson } from "@/app/lib/dm/bus";

const MY_MEMBERSHIP = "Room.myMembership";
const MEMBERSHIP = "RoomMember.membership";
/** The SDK's EventType.RoomMessage, as its own string (type-only SDK imports here). */
const ROOM_MESSAGE = "m.room.message";

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

/** Accept a DM request: join, and file it under the person who sent it in `m.direct` — judged on the
 *  invite as it stood before the join (acceptInviteAndFile). */
export async function acceptInvite(client: MatrixClient, roomId: string): Promise<void> {
  await acceptInviteAndFile(client, roomId);
}

/** The conversation with `userId` as it stands: their pending invite accepted, else the existing
 *  room, else null — opening never makes a room or sends a request (that comes with the first line,
 *  `roomForSending`; a never-used conversation leaves nothing on the server or for them).
 *  @test-only exported for its own tests: product code opens through `openThenSend` (below). */
export async function openConversation(client: MatrixClient, userId: string): Promise<Room | null> {
  const invite = inviteFrom(client, userId);
  if (invite) {
    await acceptInvite(client, invite.roomId);
    return client.getRoom(invite.roomId);
  }
  return findDmRoom(client, userId);
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

/** Send one line from the bound chat box — its content built by buildMatrixMessage (emotes,
 *  markdown, and the reply it answers). True = it reached the server. A send that failed but
 *  left its line in the conversation (the SDK keeps the "Not sent" echo, with Retry and Delete)
 *  resolves false: the box clears, the line holds the text. Only a send that left no line throws,
 *  with the plain sentence; the SDK's own error goes to the console. The explicit null thread id
 *  keeps a line that starts with "$" from being read as a thread id. */
export async function sendDmLine(client: MatrixClient, roomId: string, content: MatrixMessageContent): Promise<boolean> {
  const txnId = client.makeTxnId();
  try {
    await client.sendEvent(roomId, null, ROOM_MESSAGE as never, content as never, txnId);
    return true;
  } catch (e) {
    console.error("[dm] send failed:", e);
    const room = client.getRoom(roomId);
    if (room && localEchoOf(room, txnId)) return false;
    throw new Error(SEND_FAILED);
  }
}

/** What `openThenSend` shows in the window, step by step (a patch of the window's conversation). */
export type OpenStep = {
  phase?: "open"; roomId?: string; invite?: boolean; draft?: boolean; notPrivate?: boolean; kept?: string; error?: string;
};

/** `/dm name text`: the window opens on what was found FIRST (as `/dm name` does — a group shows its
 *  not-private note and button), then the line is sent into it. A refusal (not private; a re-invite
 *  our state never showed) is shown in its own words and the line is KEPT for the window — never
 *  lost, never "couldn't open". "sent" when the line went (the caller nudges them). Opening itself
 *  failing throws, as before. */
export async function openThenSend(client: MatrixClient, partner: string, text: string | undefined, show: (p: OpenStep) => void, emotes: EmoteMap = {}): Promise<"opened" | "sent" | "kept"> {
  const room = await openConversation(client, partner);
  // A room found by the strict lookup is private; one accepted from their invite is checked.
  const ok = !!room && await strictlyOurs(client, room, partner);
  show(room ? { phase: "open", roomId: room.roomId, invite: false, notPrivate: !ok } : { phase: "open", draft: true });
  if (!text) return "opened";
  try {
    // Into the room shown (re-inviting them if they left), else the first line makes one.
    const into = await roomForSending(client, partner, room?.roomId);
    if (into.roomId !== room?.roomId) show({ roomId: into.roomId, draft: false, notPrivate: false });
    // A line that fails stays in the conversation as "Not sent" with Retry; it throws only when no
    // line was made at all.
    return (await sendDmLine(client, into.roomId, buildMatrixMessage(text, emotes))) ? "sent" : "opened";
  } catch (e) {
    const said = e instanceof Error && e.message === NOT_PRIVATE ? NOT_PRIVATE : SEND_FAILED;
    show({ kept: text, error: said, ...(said === NOT_PRIVATE ? { notPrivate: true } : {}) });
    return "kept";
  }
}

/** Retry a "Not sent" line (by its echo id) — a resend is a send, so it passes the same privacy
 *  gate first. "sent" when it reached the server, "refused" when the conversation is not private any
 *  more (nothing is sent), "failed" when it failed again (the row stays Not sent), "gone" when the
 *  line is not there. */
export async function retryDmLine(client: MatrixClient, roomId: string, partner: string, id: string): Promise<"sent" | "refused" | "failed" | "gone"> {
  const room = client.getRoom(roomId);
  const ev = room?.findEventById(id);
  if (!room || !ev) return "gone";
  if (!(await strictlyOurs(client, room, partner))) return "refused";
  await retryEcho(client, room, ev);
  return echoState(ev) === "sent" ? "sent" : "failed";
}

/** "<username> isn't in this conversation" once the other person left or was banned, else null
 *  (still invited counts as reachable: the request is theirs to answer). */
export function partnerLeftCaution(room: Room, partner: DmPerson): string | null {
  const m = room.getMember(partner.matrixId)?.membership;
  return m === "leave" || m === "ban" ? `${partner.username} isn't in this conversation` : null;
}

/** Calls `fn` on every membership change in `roomId`. */
export function onPartnerChange(client: MatrixClient, roomId: string, fn: () => void): () => void {
  const handler = (_ev: MatrixEvent, member: { roomId?: string }) => { if (member?.roomId === roomId) fn(); };
  client.on(MEMBERSHIP as never, handler as never);
  return () => client.off(MEMBERSHIP as never, handler as never);
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
