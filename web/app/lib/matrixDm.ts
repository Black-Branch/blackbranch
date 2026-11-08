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
import { echoState } from "./localEcho.ts";
import { stripReplyFallback } from "./stripReplyFallback.ts";
import { isVerificationEvent } from "./timelineRows.ts";

const DIRECT = "m.direct";
const MESSAGE = "m.room.message";
const ENCRYPTED = "m.room.encrypted";
const MEMBER = "m.room.member";
const MEMBERSHIP = "RoomMember.membership";
const TIMELINE = "Room.timeline";
const ROOM_EVENT = "Room";

type DirectMap = Record<string, string[]>;

/** `m.direct` as the account holds it: partner id → room ids. */
function directMap(client: MatrixClient): DirectMap {
  return (client.getAccountData(DIRECT as never)?.getContent() as DirectMap | undefined) ?? {};
}


const isMember = (m: { membership?: string }) => m.membership === "join" || m.membership === "invite";

/** Newest activity first (Element's rule, so both clients converge); a tie goes to the newer room. */
function newestFirst(a: Room, b: Room): number {
  const created = (r: Room) => r.currentState.getStateEvents("m.room.create", "")?.getTs() ?? 0;
  return b.getLastActiveTimestamp() - a.getLastActiveTimestamp() || created(b) - created(a);
}

/**
 * THE test of a private conversation between `me` and `partner` — the one predicate for every room
 * we find, every room in our `m.direct`, every accepted invite we file, and the gate before every
 * send. On the room's members as loaded (load them first; lazy loading hides people):
 *  - nobody but the two of you is joined or invited (the server's counts AND the member list, at
 *    most two), you are in it, and the partner is a member who is not banned — after they left it
 *    is you alone, and the re-invite makes it two again;
 *  - a closed room: join rule invite or private, never public; history never world-readable;
 *  - marked direct: an is_direct member event, or our own `m.direct` filing.
 * `getDMInviter` alone proves nothing: anyone can make a room flagged is_direct, invite you and add a
 * third person, or open it to the world.
 */
function privateWith(room: Room, me: string, partner: string, listed: boolean, ourMarkOnly = false): boolean {
  const people = room.getMembers().filter(isMember).map((m) => m.userId);
  if (!people.includes(me) || people.some((p) => p !== me && p !== partner)) return false;
  if (room.getJoinedMemberCount() + room.getInvitedMemberCount() > 2) return false;
  const theirs = room.getMember(partner)?.membership;
  if (!theirs || theirs === "ban") return false;
  const rule = room.getJoinRule();
  if (rule !== "invite" && rule !== "private") return false;
  if (room.getHistoryVisibility() === "world_readable") return false;
  const direct = (id: string) => (room.getMember(id)?.events.member?.getContent() as { is_direct?: unknown } | undefined)?.is_direct === true;
  // Our own filing only, where it decides more than a send (the moderation fence): every is_direct
  // mark — even the one on our member event — was written by whoever sent the invite.
  if (ourMarkOnly) return listed;
  return listed || direct(me) || direct(partner) || invitedBetween(room, me, partner);
}

/** The DM invite between the two of you, after it was accepted: the join event replaces the invite
 *  and carries no is_direct, but keeps it in its prev_content (RoomMember.getDMInviter reads both).
 *  Either they invited you marked direct, or you invited them. The same mark `direct` reads on a
 *  pending invite, still written by whoever sent it — so it never counts where only our own filing
 *  may (ourMarkOnly). */
function invitedBetween(room: Room, me: string, partner: string): boolean {
  const inviter = (id: string) => room.getMember(id)?.getDMInviter?.();
  return inviter(me) === partner || inviter(partner) === me;
}

const isListed = (client: MatrixClient, partner: string, roomId: string) => (directMap(client)[partner] ?? []).includes(roomId);

const otherPerson = (room: Room, me: string) => room.getMembers().find((m) => m.userId !== me && m.membership !== "ban")?.userId;

/** The other person of `room` when it is a private conversation of ours (privateWith), else null.
 *  On members as loaded. The DM list's grouping key (dmConversations.ts). */
export function dmPartnerOf(room: Room, me: string, direct: Set<string>): string | null {
  const partner = otherPerson(room, me);
  return partner && privateWith(room, me, partner, direct.has(room.roomId)) ? partner : null;
}

/** isDmRoom on OUR filing only — the room is in our `m.direct` (filed when we made it or accepted its
 *  invite here) — never an is_direct mark, which whoever sent the invite wrote. The moderation
 *  scope's DM fence (matrixRooms): what keeps a room out of site moderation must be something the
 *  other person cannot set. */
export function isOwnDmRoom(room: Room, me: string, direct: Set<string>): boolean {
  const partner = otherPerson(room, me);
  return !!partner && privateWith(room, me, partner, direct.has(room.roomId), true);
}

/** Rooms we are in where `partner` appears or that our `m.direct` files under them. */
function candidates(client: MatrixClient, partner: string): Room[] {
  return client.getRooms().filter((r) => r.getMyMembership() === "join" && !r.isSpaceRoom()
    && (isListed(client, partner, r.roomId) || r.getDMInviter() === partner || r.getMembers().some((m) => m.userId === partner)));
}

/** The existing private conversation with `partner`, on members as loaded: of every room that
 *  passes privateWith — listed in `m.direct` or not — the most recently active. Null when none.
 *  The DM list's active room (dmConversations.ts), so the list and the sender always agree. */
export function findExistingDm(client: MatrixClient, me: string, partner: string): Room | null {
  return candidates(client, partner)
    .filter((r) => privateWith(r, me, partner, isListed(client, partner, r.roomId)))
    .sort(newestFirst)[0] ?? null;
}

/** The send gate (and the test before filing a room): `room` is still a private conversation with
 *  `partner`, its members loaded first. */
export async function strictlyOurs(client: MatrixClient, room: Room, partner: string, accepted = false): Promise<boolean> {
  await room.loadMembersIfNeeded();
  const me = client.getUserId();
  // `accepted`: we are filing a DM request we just accepted (acceptInviteAndFile) — its direct mark
  // was on the invite, which the join replaced.
  return !!me && privateWith(room, me, partner, accepted || isListed(client, partner, room.roomId));
}

/** The joined DM room with `userId` our `m.direct` lists (the most recently active), or null. */
// @parked plugin API: a site plugin's console beside the chat reads or drives the chat through it
export function findDm(client: MatrixClient, userId: string): Room | null {
  const listed = new Set(directMap(client)[userId] ?? []);
  return client.getRooms().filter((r) => listed.has(r.roomId) && r.getMyMembership() === "join").sort(newestFirst)[0] ?? null;
}

type PartnerMembership = "join" | "invite" | "leave" | "ban";

/** Where the other person stands in a DM room. Members are lazy-loaded, so they are loaded first:
 *  before that, a member who left reads as unknown (null). */
export async function partnerMembership(room: Room, userId: string): Promise<PartnerMembership | null> {
  await room.loadMembersIfNeeded();
  const m = room.getMember(userId)?.membership;
  return m === "join" || m === "invite" || m === "leave" || m === "ban" ? m : null;
}

/** The existing conversation (findExistingDm, every candidate's members loaded first) and where the
 *  partner stands in it. A room that passes is filed in our `m.direct` only if WE made it (its
 *  create event is ours) — one the other person made can be sent into after the strict check, but
 *  is never filed by finding it: m.direct is our own record and feeds the moderation fence. Accepted
 *  invites are filed when accepted (rememberDm). No room is ever left or deleted. Makes nothing,
 *  invites no one. */
async function existingDm(client: MatrixClient, userId: string): Promise<{ room: Room; partner: PartnerMembership | null } | null> {
  const me = client.getUserId();
  if (!me) return null;
  const rooms = candidates(client, userId);
  for (const r of rooms) await r.loadMembersIfNeeded();
  const passing = rooms.filter((r) => privateWith(r, me, userId, isListed(client, userId, r.roomId)));
  const ours = (r: Room) => r.currentState.getStateEvents("m.room.create", "")?.getSender() === me;
  const toFile = passing.filter((r) => !isListed(client, userId, r.roomId) && ours(r)).map((r) => r.roomId);
  if (toFile.length) await mergeDirect(client, { [userId]: toFile });
  const room = findExistingDm(client, me, userId);
  return room ? { room, partner: await partnerMembership(room, userId) } : null;
}

/** The DM with `userId` if one exists — never makes a room or sends an invite: opening a
 *  conversation is not sending one (the room and the request come with the first line). */
export async function findDmRoom(client: MatrixClient, userId: string): Promise<Room | null> {
  return (await existingDm(client, userId))?.room ?? null;
}


/** One open-or-make per person at a time: a second call while one is running gets the same answer
 *  (a double tap, or the window and Community at once, made two rooms one second apart). */
const inFlight = new Map<string, Promise<Room | null>>();

/** Open the DM with `userId`, or make it: direct, private, no guests, encrypted (megolm), written into
 *  `m.direct`, and waited for until sync delivers it (4 s at most). Null when it could not be made.
 *  Called when a line is sent (or a request confirmed), never merely to look: an existing room is
 *  always reused (findDmRoom's search). One they LEFT (or declined) gets a fresh invite, so they
 *  see a new request and the history stays in one room — otherwise every line would go into a room
 *  nobody reads.
 *  The ban check below is a COURTESY, not a control: it runs in the viewer's own browser, which a
 *  banned person controls. The real refusals are server-side (the DM name-lookup and nudge routes,
 *  dm/banGate.ts); stopping a banned account at the homeserver itself needs a homeserver module
 *  that checks site bans — outside the web app.
 *  @test-only product code reaches it through roomForSending in this file (which adds the privacy
 *  gate); matrixDm.test.ts pins the one create path — its shape, the lock, the re-invite — directly. */
export async function openOrCreateDm(client: MatrixClient, userId: string, banned: () => Promise<boolean> = viewerBanned): Promise<Room | null> {
  const running = inFlight.get(userId);
  if (running) return running;
  const once = openOrCreateOnce(client, userId, banned).finally(() => { inFlight.delete(userId); });
  inFlight.set(userId, once);
  return once;
}

/** How long a re-invite waits to show in our own room state before the send gives up. */
const INVITE_SEEN_MS = 8_000;

/** Invite `userId` back into a private room they left, and resolve true once OUR client sees them
 *  invited. The line that follows is encrypted for the members the room's local state lists
 *  (joined + invited): sent before sync brings the invite back, it would be shared with none of
 *  their devices and stay unreadable for them for good. False when the invite was not seen in time
 *  (nothing is sent then), or when the room is no longer private (never an invite into a room
 *  someone else has joined). The invite is a member event marked is_direct: their client shows a
 *  DM request only by that mark (Room.getDMInviter), and a plain /invite does not carry it. */
async function reinvite(client: MatrixClient, room: Room, userId: string): Promise<boolean> {
  if (!(await strictlyOurs(client, room, userId))) return false;
  const invited = () => room.getMember(userId)?.membership === "invite";
  const seen = new Promise<boolean>((resolve) => {
    const onMember = (_ev: unknown, member: { roomId?: string; userId?: string }) => {
      if (member?.roomId === room.roomId && member.userId === userId && invited()) done(true);
    };
    const timer = setTimeout(() => done(invited()), INVITE_SEEN_MS);
    const done = (v: boolean) => { clearTimeout(timer); client.off(MEMBERSHIP as never, onMember as never); resolve(v); };
    client.on(MEMBERSHIP as never, onMember as never);
  });
  await client.sendStateEvent(room.roomId, MEMBER as never, { membership: "invite", is_direct: true } as never, userId);
  return invited() || seen;
}

async function openOrCreateOnce(client: MatrixClient, userId: string, banned: () => Promise<boolean>): Promise<Room | null> {
  const found = await existingDm(client, userId);
  if (found) {
    if (found.partner === "leave") {
      if (await banned()) return null;
      if (!(await reinvite(client, found.room, userId))) return null;
    }
    // In it, invited, re-invited — or not readable at all, which never justifies a second room.
    return found.room;
  }
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
  await mergeDirect(client, { [userId]: [room_id] });
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


/** The plain sentence for a line that could not even be put in the conversation. */
export const SEND_FAILED = "Couldn't send — check your connection and try again.";

/** The refusal when a conversation is not private (someone else in it, opened up). */
export const NOT_PRIVATE = "Not sent — this conversation isn't private any more.";

/**
 * The room a line to `userId` goes into, checked right before it goes.
 *  - `shownRoomId` (the conversation on screen): THAT room — re-inviting them first if they left —
 *    never another one; refused (NOT_PRIVATE) when it is not private by the strict rule. A line is
 *    never moved into a room the person did not see.
 *  - none (a draft): the existing private conversation, else a new one made here, on the first send
 *    or a confirmed request, one at a time per person.
 * Throws the plain sentence when there is nothing to send into; nothing is sent then.
 */
export async function roomForSending(client: MatrixClient, userId: string, shownRoomId?: string): Promise<Room> {
  let room: Room | null = null;
  try {
    if (shownRoomId) {
      room = client.getRoom(shownRoomId);
      if (room && !(await strictlyOurs(client, room, userId))) throw Object.assign(new Error(NOT_PRIVATE), { refusal: true });
      if (room && (await partnerMembership(room, userId)) === "leave" && !(await reinvite(client, room, userId))) room = null;
    } else {
      room = await openOrCreateDm(client, userId);
    }
  } catch (e) {
    if ((e as { refusal?: boolean }).refusal) throw e;
    console.error("[dm] could not open the conversation to send:", e);
    room = null;
  }
  if (!room) throw new Error(SEND_FAILED);
  // The same test every room passed to be found (privateWith), again right before the line goes:
  // someone may have joined since, or the room may never have been private (a group invite).
  if (!(await strictlyOurs(client, room, userId))) throw new Error(NOT_PRIVATE);
  return room;
}

/** Merge `additions` (partner → room ids) into `m.direct`, keeping everything already there. The map
 *  is read at the moment of the one write (no await between), never from an earlier copy: a write
 *  from a stale copy is how entries went missing and another client then made a duplicate room. */
export async function mergeDirect(client: MatrixClient, additions: Record<string, string[]>): Promise<void> {
  const current = directMap(client);
  const next: DirectMap = { ...current };
  let changed = false;
  for (const [userId, ids] of Object.entries(additions)) {
    const have = next[userId] ?? [];
    const add = ids.filter((id) => !have.includes(id));
    if (add.length) { next[userId] = [...have, ...add]; changed = true; }
  }
  if (changed) await client.setAccountData(DIRECT as never, next as never);
}

/** File `roomId` under `userId` in `m.direct` — an accepted DM invite — only if it is a private
 *  conversation with them (privateWith): an invite into a group or world-readable room is not one.
 *  @test-only exported for its own tests: product code files an accepted invite through
 *  acceptInviteAndFile (below), which reads the invite's mark before joining. */
export async function rememberDm(client: MatrixClient, userId: string, roomId: string, accepted = false): Promise<void> {
  const room = client.getRoom(roomId);
  if (!room || !(await strictlyOurs(client, room, userId, accepted))) return;
  await mergeDirect(client, { [userId]: [roomId] });
}

/** Accept an invite; when it is a DM request — our invite marked is_direct by the person who sent it
 *  — file it in our `m.direct` (the one auto-filing besides rooms we make). The mark is read from the
 *  invite BEFORE joining: our join event replaces the invite and carries no is_direct, and the
 *  creator's never did, so judged after the join a plain two-person DM looked "not private" — it was
 *  never filed and the accepting side's window said "This isn't a private conversation" (Task 22's
 *  look). Every other part of the strict rule is still judged on the room as joined. Returns the
 *  person it was filed under, or null (not a DM request, or not private). */
export async function acceptInviteAndFile(client: MatrixClient, roomId: string): Promise<string | null> {
  const asked = client.getRoom(roomId)?.getDMInviter() ?? null;
  await client.joinRoom(roomId);
  if (!asked) return null;
  await rememberDm(client, asked, roomId, true);
  return isListed(client, asked, roomId) ? asked : null;
}

/** Every joined DM room with the partner it is with. */
// @parked plugin API: a site plugin's console beside the chat reads or drives the chat through it
export function dmRooms(client: MatrixClient): { userId: string; room: Room }[] {
  const out: { userId: string; room: Room }[] = [];
  for (const [userId, ids] of Object.entries(directMap(client))) {
    const room = ids.map((id) => client.getRoom(id)).find((r): r is Room => !!r && r.getMyMembership() === "join");
    if (room) out.push({ userId, room });
  }
  return out;
}

export type DmLine = {
  /** The event id; a local echo's `~…` id until the server confirms it. */
  id: string;
  ts: number;
  fromId: string;
  text: string;
  undecryptable?: boolean;
  /** Why it can't be read (the SDK's DecryptionFailureCode), for keyWait.ts `keyWaitCopy`. */
  code?: string;
  /** Our own line on its way, or one that did not reach the server. Absent = sent. */
  status?: "sending" | "failed";
  /** A reply: the line it answers and who wrote that line ("" when unknown). */
  replyTo?: { id: string; sender: string };
};

type Relates = { rel_type?: string; is_falling_back?: boolean; "m.in_reply_to"?: { event_id?: string } };

/** The sender a reply fallback quotes ("> <@id> …", the spec's rendering for plain clients). */
const fallbackSender = (body: string): string => /^> <(@[^>\s]+)>/.exec(body)?.[1] ?? "";

/** A message event as a line: its body after decryption, `[image]`/`[file]` for media, or the
 *  mark of a line this device cannot read. Null for anything that is not a message to show.
 *  A reply shows its own words only — the quoted original and its sender's Matrix id are the
 *  fallback for plain clients — and names whom it answers in `replyTo`: the original's real
 *  sender when this device holds it (the quote is the replier's own text), else the quoted one. */
function dmLineOf(ev: MatrixEvent, room?: Room): DmLine | null {
  if (ev.getType() !== MESSAGE || ev.isRedacted()) return null;
  // Another client's verification request is a message whose body is fallback text: never a line.
  if (isVerificationEvent(ev)) return null;
  const id = ev.getId() ?? "";
  const sender = ev.getSender() ?? "";
  const ts = ev.getTs();
  if (ev.isDecryptionFailure()) return { id, ts, fromId: sender, text: "", undecryptable: true, code: String(ev.decryptionFailureReason ?? "") };
  const c = ev.getContent() as { msgtype?: string; body?: string; "m.new_content"?: unknown; "m.relates_to"?: Relates };
  // An edit event is folded into its original by the SDK (getContent on the original answers the new text).
  if (c["m.new_content"]) return null;
  const rel = c["m.relates_to"];
  // A thread reply's m.in_reply_to is context for plain clients, not a quote (as MatrixMessageRow).
  const replyId = rel?.rel_type === "m.thread" && rel.is_falling_back === true ? undefined : rel?.["m.in_reply_to"]?.event_id;
  const body = String(c.body ?? "");
  const text = c.msgtype === "m.image" ? "[image]" : c.msgtype === "m.file" ? "[file]" : c.msgtype === "m.audio" ? "[audio]" : c.msgtype === "m.video" ? "[video]" : replyId ? stripReplyFallback(body) : body;
  const echo = echoState(ev);
  return {
    id, ts, fromId: sender, text,
    ...(echo === "sent" ? {} : { status: echo }),
    ...(replyId ? { replyTo: { id: replyId, sender: room?.findEventById(replyId)?.getSender() ?? fallbackSender(body) } } : {}),
  };
}

/** The room's lines as the client holds them (the live timeline — the first page). */
// @parked plugin API: a site plugin's console beside the chat reads or drives the chat through it
export function dmLines(room: Room): DmLine[] {
  const out: DmLine[] = [];
  for (const ev of room.getLiveTimeline().getEvents()) {
    const l = dmLineOf(ev, room);
    if (l) out.push(l);
  }
  return out;
}

/** The read receipt the Community timeline sends: on the room's last event. */
// @parked plugin API: a site plugin's console beside the chat reads or drives the chat through it
export function markDmRead(client: MatrixClient, room: Room): void {
  const evs = room.getLiveTimeline().getEvents();
  const last = evs[evs.length - 1];
  if (last) void sendReadMarker(client, room.roomId, last, { single: true }).catch(() => {});
}

/** New message events in DM rooms (any room when `roomId` is null), decrypted first when they need it. */
// @parked plugin API: a site plugin's console beside the chat reads or drives the chat through it
export function onDmMessage(client: MatrixClient, roomId: string | null, fn: (room: Room, line: DmLine) => void): () => void {
  const handler = (ev: MatrixEvent, room: Room | undefined, toStart: boolean | undefined, _removed: boolean, data: { liveEvent?: boolean }) => {
    if (!room || toStart || data?.liveEvent === false) return;
    if (roomId ? room.roomId !== roomId : !dmRooms(client).some((d) => d.room.roomId === room.roomId)) return;
    // The SDK emits a line before the decryption it started finishes: it still reads m.room.encrypted
    // here, so the type is judged after decrypting (dmLineOf drops what is not a message).
    const type = ev.getType();
    if (type !== MESSAGE && type !== ENCRYPTED) return;
    void client.decryptEventIfNeeded(ev).catch(() => {}).then(() => {
      const l = dmLineOf(ev, room);
      if (l) fn(room, l);
    });
  };
  client.on(TIMELINE as never, handler as never);
  return () => client.off(TIMELINE as never, handler as never);
}
