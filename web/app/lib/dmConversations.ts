// The DM list's model (client polish Task 20; dm-crypto-research B.4 option 1): one conversation per
// PERSON. Every private room with someone (dmPartnerOf — the one strict predicate) is grouped under
// them; the active room is the one a line goes into (findExistingDm, the most recently active), so
// the list and the sender always agree; the other rooms fold in as "Earlier conversation". Nothing
// is ever left or deleted here except by the person's own Leave, and a room with no line is listed
// nowhere (dm-crypto-research C.4).
//
// Type-only SDK imports (the event names are the SDK's own strings), so this runs on a fake client
// in tests, like matrixDm.ts.
import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";
import { dmPartnerOf, findExistingDm } from "./matrixDm.ts";
import { DM_CLOSED, readFirst } from "./matrixNamespace.ts";
import { isTimelineRow } from "./timelineRows.ts";
import { mediaKindLabel } from "./mediaKind.ts";
import { stripReplyFallback } from "./stripReplyFallback.ts";
import { snippet } from "./textFormat.ts";
import { memberName } from "./matrixDisplay.ts";
import { senderLabel } from "./discordSender.ts";

export type DmConversation = {
  partner: string;
  /** The room a line goes into (findExistingDm). */
  active: Room;
  /** The person's other rooms that hold a line, newest first. */
  earlier: Room[];
  /** The newest line's time (ms), 0 when none is loaded. */
  lastTs: number;
  preview: string;
  unread: { total: number; highlight: number };
  pinned: boolean;
  /** Every private room with the person, empty ones included — what Leave leaves. */
  rooms: Room[];
};

/** Closed conversations: partner → when (ms). The row comes back with a line newer than that. */
export type ClosedMap = Record<string, number>;

const FAVOURITE = "m.favourite";
const DIRECT = "m.direct";
const PREVIEW_MAX = 60;

/** Every room id our m.direct files, under anyone. */
export const directSet = (client: MatrixClient): Set<string> => {
  const map = (client.getAccountData(DIRECT as never)?.getContent() ?? {}) as Record<string, unknown>;
  return new Set(Object.values(map).flatMap((v) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])));
};

/** The room's newest line as the list shows it (the timeline's own row rule: no edit, reaction,
 *  thread reply or verification request), or null when none is loaded. */
function lastLine(room: Room): MatrixEvent | null {
  const evs = room.getLiveTimeline().getEvents();
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e && isTimelineRow(room, e)) return e;
  }
  return null;
}

/** No line at all, and the timeline reaches back to the room's start — provably empty. A room
 *  whose start is not loaded may hold older lines, so it is not called empty. */
function isEmpty(room: Room): boolean {
  const evs = room.getLiveTimeline().getEvents();
  return !evs.some((e) => isTimelineRow(room, e)) && evs.some((e) => e.getType() === "m.room.create");
}

/** One line's preview: its own words (never a reply's quoted fallback), "📷 Image" for media,
 *  "Can't be read on this device" for a line that failed to decrypt; "You: " on our own; one line,
 *  cut at 60. A line still decrypting has no words yet ("").
 *  @test-only exported for its own tests; the list reads it through dmConversations. */
export function previewOf(ev: MatrixEvent, me: string): string {
  const mine = ev.getSender() === me ? "You: " : "";
  if (ev.isDecryptionFailure()) return `${mine}Can't be read on this device`;
  const type = ev.getType();
  if (type === "m.room.encrypted") return "";
  const c = ev.getContent() as { msgtype?: unknown; body?: unknown; "m.relates_to"?: { "m.in_reply_to"?: unknown } };
  const media = mediaKindLabel(type, c.msgtype);
  if (media) return mine + media;
  const body = String(c.body ?? "");
  const words = (c["m.relates_to"]?.["m.in_reply_to"] ? stripReplyFallback(body) : body).replace(/\s+/g, " ").trim();
  return mine + snippet(words, PREVIEW_MAX - mine.length);
}

const unreadOf = (r: Room) => ({
  total: r.getUnreadNotificationCount("total" as never) ?? 0,
  highlight: r.getUnreadNotificationCount("highlight" as never) ?? 0,
});

/** The conversation with `partner` out of their rooms, or null when none holds a line. */
function build(client: MatrixClient, me: string, partner: string, rooms: Room[]): DmConversation | null {
  const active = findExistingDm(client, me, partner) ?? rooms[0];
  if (!active) return null;
  const withLines = rooms.filter((r) => !isEmpty(r));
  if (!withLines.length) return null;
  const last = new Map(withLines.map((r) => [r.roomId, lastLine(r)]));
  const ts = (r: Room) => last.get(r.roomId)?.getTs() ?? 0;
  const earlier = withLines.filter((r) => r !== active).sort((a, b) => ts(b) - ts(a) || b.getLastActiveTimestamp() - a.getLastActiveTimestamp());
  const shown = [active, ...earlier];
  const newest = shown.reduce<MatrixEvent | null>((best, r) => {
    const l = last.get(r.roomId) ?? null;
    return l && (!best || l.getTs() > best.getTs()) ? l : best;
  }, null);
  const unread = shown.map(unreadOf).reduce((a, u) => ({ total: a.total + u.total, highlight: a.highlight + u.highlight }), { total: 0, highlight: 0 });
  return {
    partner,
    active,
    earlier,
    lastTs: newest?.getTs() ?? 0,
    preview: newest ? previewOf(newest, me) : "",
    unread,
    pinned: rooms.some((r) => !!r.tags?.[FAVOURITE]),
    rooms: [active, ...rooms.filter((r) => r !== active).sort((a, b) => b.getLastActiveTimestamp() - a.getLastActiveTimestamp())],
  };
}

/** Every joined private room, by the person it is with. */
function byPartner(client: MatrixClient, me: string): Map<string, Room[]> {
  const direct = directSet(client);
  const out = new Map<string, Room[]>();
  for (const room of client.getRooms()) {
    if (room.getMyMembership() !== "join" || room.isSpaceRoom()) continue;
    // Never a DM (privateWith's own count rule), and a big channel's member list is not walked.
    if (room.getJoinedMemberCount() + room.getInvitedMemberCount() > 2) continue;
    const partner = dmPartnerOf(room, me, direct);
    if (!partner) continue;
    out.set(partner, [...(out.get(partner) ?? []), room]);
  }
  return out;
}

/**
 * The DM list: one conversation per person, pinned first (m.favourite on any of their rooms — the
 * Home "pinned" tag), then by the newest line. A person with no line in any room is left out (an
 * invite we RECEIVED is a request, answered in the Invites section); a person in `closed` is left
 * out until a line newer than the close.
 */
export function dmConversations(client: MatrixClient, me: string, closed: ClosedMap): DmConversation[] {
  const out: DmConversation[] = [];
  for (const [partner, rooms] of byPartner(client, me)) {
    const c = build(client, me, partner, rooms);
    if (c) out.push(c);
  }
  return notClosed(out.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastTs - a.lastTs), closed);
}

/** The conversations not closed: a close holds until a line newer than it. */
export function notClosed(convs: DmConversation[], closed: ClosedMap): DmConversation[] {
  return convs.filter((c) => !(c.partner in closed && c.lastTs <= closed[c.partner]!));
}

/** The conversation with one person (closed or not), or null — the DM window's menu. */
export function conversationWith(client: MatrixClient, me: string, partner: string): DmConversation | null {
  const rooms = byPartner(client, me).get(partner);
  return rooms ? build(client, me, partner, rooms) : null;
}

/** The closed map as the account holds it; anything not a person → time pair is ignored. */
export function readClosed(client: MatrixClient): ClosedMap {
  const raw = readFirst(DM_CLOSED, (k) => client.getAccountData(k as never)?.getContent() as Record<string, unknown> | undefined) ?? {};
  const out: ClosedMap = {};
  for (const [k, v] of Object.entries(raw)) if (k.startsWith("@") && typeof v === "number" && Number.isFinite(v)) out[k] = v;
  return out;
}

/** Close (Discord's X): hide the person from the list until their next line. Read at the moment of
 *  the one write, like mergeDirect, so a close made elsewhere in between is kept. */
async function closeConversation(client: MatrixClient, partner: string): Promise<void> {
  await client.setAccountData(DM_CLOSED.write as never, { ...readClosed(client), [partner]: Date.now() } as never);
}

/** Leave every private room with the person (the confirm comes first, in the menu): they see that
 *  you left. Active room first, so a failure part-way still leaves the one they write into. */
async function leaveConversation(client: MatrixClient, conv: DmConversation): Promise<void> {
  for (const r of conv.rooms) await client.leave(r.roomId);
}

/** Pin puts m.favourite on the active room; Unpin takes it off every room of the person (a pin from
 *  another client may sit on an older one). */
async function pinConversation(client: MatrixClient, conv: DmConversation, on: boolean): Promise<void> {
  if (on) { await client.setRoomTag(conv.active.roomId, FAVOURITE, {}); return; }
  for (const r of conv.rooms) if (r.tags?.[FAVOURITE]) await client.deleteRoomTag(r.roomId, FAVOURITE);
}

/** What a conversation's menu (components/DmActionsMenu) does, for one conversation. */
export type DmActions = {
  pinned: boolean;
  onPin: (on: boolean) => Promise<void>;
  onHide: () => Promise<void>;
  onLeave: () => Promise<void>;
};

/** The menu's actions on `conv` — the one wiring for the Community row and the DM window. */
export function conversationActions(client: MatrixClient, conv: DmConversation): DmActions {
  return {
    pinned: conv.pinned,
    onPin: (on) => pinConversation(client, conv, on),
    onHide: () => closeConversation(client, conv.partner),
    onLeave: () => leaveConversation(client, conv),
  };
}

/** The person as a row shows them: their name in the conversation (a bridged Discord name without
 *  its suffix, marked), and their picture. */
export function partnerFace(conv: DmConversation): { label: string; fromDiscord: boolean; mxc: string | null } {
  const member = conv.rooms.map((r) => r.getMember(conv.partner)).find((m) => !!m) ?? null;
  const { label, fromDiscord } = senderLabel(memberName(member, conv.partner), conv.partner);
  return { label, fromDiscord, mxc: member?.getMxcAvatarUrl() ?? null };
}

/** The person's rooms before `room` in their conversation, newest first: from the active room all
 *  of `earlier`, from an earlier room the ones older than it. */
export function earlierThan(conv: DmConversation, room: Room | null): Room[] {
  if (!room || room === conv.active) return conv.earlier;
  const at = conv.earlier.indexOf(room);
  return at < 0 ? [] : conv.earlier.slice(at + 1);
}
