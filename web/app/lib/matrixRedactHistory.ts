// Deleting a banned person's community messages from the moderator's own client (client polish
// Task 21: Discord's "Delete message history" on a ban). The site holds no homeserver credential
// that may redact in the rooms; a moderator's account can (power 50), as with the ban itself.
//
// Per room it pages back until an event older than the window is loaded (at most
// REDACT_MAX_PAGES pages), collects the person's lines, then redacts them one at a time through
// attemptWithRetry — sequential for the same reason moderateEverywhere is: Synapse's rate limiter
// would otherwise make a throttled redaction read as a refused one. An encrypted line needs no
// decryption: its sender is visible.

import type { MatrixClient, Room } from "matrix-js-sdk";
import { attemptWithRetry, type ScopeRoom } from "./matrixModerate.ts";
import {
  buildNav, buildServers, findRoomByAlias, getDmRoomIds, moderationSyncRooms, COMMUNITY_HUB_ALIAS,
} from "./matrixRooms.ts";

/** Pages of scrollback per room at most: a busy channel cannot hold the dialog for minutes.
 *  @test-only redactHistory below reads it; the test pages past it. */
export const REDACT_MAX_PAGES = 20;
/** Redactions per run at most; the rest is reported as failed (the member card's retry).
 *  @test-only redactHistory below reads it; the test runs past it. */
export const REDACT_MAX_TOTAL = 1000;
const PAGE_SIZE = 50;

// The event types that are a line someone wrote. Never a state event (their membership, a name).
const LINE_TYPES = new Set(["m.room.message", "m.room.encrypted", "m.sticker", "m.poll.start", "org.matrix.msc3381.poll.start"]);

type HistoryEvent = {
  getId(): string | undefined; getSender(): string | undefined; getTs(): number;
  getType(): string; getWireType?(): string; isState(): boolean; isRedacted(): boolean;
};
type HistoryRoom = { roomId: string; getDMInviter(): string | undefined; getLiveTimeline(): { getEvents(): HistoryEvent[] } };

/** The slice of MatrixClient this needs; an SDK client satisfies it. */
export type RedactClient = {
  getRoom(roomId: string): HistoryRoom | null;
  getAccountData: MatrixClient["getAccountData"];
  scrollback(room: HistoryRoom, limit?: number): Promise<unknown>;
  redactEvent(roomId: string, eventId: string, txnId?: string, opts?: { reason?: string }): Promise<unknown>;
};

export type RedactOutcome = { redacted: number; failed: number; rooms: number };

const isLine = (e: HistoryEvent) => !e.isState() && (LINE_TYPES.has(e.getType()) || LINE_TYPES.has(e.getWireType?.() ?? ""));

/** The person's lines in `room` newer than `since`, paging back as far as the window (or the bound). */
async function linesOf(client: RedactClient, room: HistoryRoom, userId: string, since: number): Promise<string[]> {
  for (let page = 0; page < REDACT_MAX_PAGES; page++) {
    const events = room.getLiveTimeline().getEvents();
    if (events.length > 0 && events[0]!.getTs() < since) break;
    const before = events.length;
    await client.scrollback(room, PAGE_SIZE);
    // A page that adds nothing is the start of the room.
    if (room.getLiveTimeline().getEvents().length === before) break;
  }
  return room.getLiveTimeline().getEvents()
    .filter((e) => e.getSender() === userId && e.getTs() >= since && isLine(e) && !e.isRedacted())
    .map((e) => e.getId() ?? "")
    // A local echo (~id) is not on the server yet.
    .filter((id) => id.startsWith("$"));
}

/**
 * Redact `userId`'s lines newer than `since` in every room of `rooms` that is not a direct
 * conversation, with `reason`. Never throws for one line; reports what went and what did not.
 */
export async function redactHistory(
  client: RedactClient,
  rooms: ScopeRoom[],
  userId: string,
  since: number,
  reason?: string,
  onProgress?: (done: number, total: number) => void,
  sleep?: (ms: number) => Promise<void>,
): Promise<RedactOutcome> {
  const direct = getDmRoomIds(client as unknown as MatrixClient);
  const todo: { roomId: string; id: string }[] = [];
  let scanned = 0;
  for (const scope of rooms) {
    const room = client.getRoom(scope.roomId);
    // A direct conversation is never part of a ban's reach (the member card's own rule).
    if (!room || direct.has(room.roomId) || !!room.getDMInviter()) continue;
    scanned++;
    for (const id of await linesOf(client, room, userId, since)) todo.push({ roomId: room.roomId, id });
  }
  const run = todo.slice(0, REDACT_MAX_TOTAL);
  let redacted = 0;
  let failed = todo.length - run.length;
  onProgress?.(0, run.length);
  for (const [i, line] of run.entries()) {
    const r = await attemptWithRetry(
      () => client.redactEvent(line.roomId, line.id, undefined, reason ? { reason } : {}).then(() => undefined),
      undefined,
      sleep,
    );
    if (r.status === "ok") redacted++;
    else failed++;
    onProgress?.(i + 1, run.length);
  }
  return { redacted, failed, rooms: scanned };
}

/** The community channels a ban covers when it is made outside the community (the Mod Panel's
 *  Bans form, a live-chat card): the hub server's moderated channels (moderationSyncRooms), never
 *  a DM. Empty when the hub is not loaded. */
export function communityScope(client: MatrixClient, me: string): ScopeRoom[] {
  const rooms: Room[] = client.getRooms();
  const dm = getDmRoomIds(client);
  const hub = findRoomByAlias(rooms, COMMUNITY_HUB_ALIAS);
  const server = hub ? buildServers(buildNav(rooms, me, dm)).find((s) => s.room?.roomId === hub.roomId) ?? null : null;
  return moderationSyncRooms(server, rooms, me, dm).map((r) => ({ roomId: r.roomId, name: r.name || r.roomId }));
}
