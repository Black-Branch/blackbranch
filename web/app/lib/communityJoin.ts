import type { Room } from "matrix-js-sdk";
import { findRoomByAlias } from "./matrixRooms.ts";
import { SPACE_KIND, readFirst } from "./matrixNamespace.ts";

// The community bootstrap's background join (useCommunityBootstrap): find the hub, then join the
// children of its tree the member may join on their own. Who can see a channel is the server's
// to say (spec 2026-10-23 §4.3): a room the member cannot satisfy is never tried, and the hidden
// supporters space is only ever entered by the service account's invite.

/** One room of GET /_matrix/client/v1/rooms/{id}/hierarchy (only the fields read here). */
export type HierarchyEntry = {
  room_id: string;
  room_type?: string | null;
  /** Absent means public (the spec's default for a published-room chunk). */
  join_rule?: string;
  allowed_room_ids?: string[];
  children_state?: { state_key: string; content?: Record<string, unknown> }[];
};

type LocalRoom = {
  roomId: string;
  getMyMembership(): string;
  currentState: { getStateEvents(type: string, key: string): { getContent(): Record<string, unknown> } | null };
};

/** The slice of MatrixClient this uses; the SDK's client satisfies it. */
export type JoinClient = {
  getRooms(): LocalRoom[];
  getRoom(roomId: string): LocalRoom | null;
  joinRoom(roomIdOrAlias: string, opts?: { viaServers?: string[] }): Promise<{ roomId: string } | string>;
  getRoomHierarchy(roomId: string, limit?: number, maxDepth?: number): Promise<{ rooms: HierarchyEntry[] }>;
};

const RESTRICTED = new Set(["restricted", "knock_restricted"]);

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** A gate space, by its kind wherever the client can see it: the entry, the parent's link, or —
 *  when the client already knows the room (an invite) — its space_kind state event `{ kind }` or its
 *  create content (the reconciler writes both). */
function isGate(e: HierarchyEntry, link: Record<string, unknown> | undefined, local: LocalRoom | null): boolean {
  if (e.room_type !== "m.space") return false;
  const create = local?.currentState.getStateEvents("m.room.create", "")?.getContent();
  const own = e as Record<string, unknown>;
  return readFirst(SPACE_KIND, (k) => str(own[k]) ?? str(link?.[k])
    ?? str(local?.currentState.getStateEvents(k, "")?.getContent()?.kind) ?? str(create?.[k])) === "gate";
}

/** Joins in waves: a room restricted through a space the member is about to join waits for it. */
function joinWaves(entries: HierarchyEntry[], hubId: string, client: JoinClient) {
  const links = new Map<string, Record<string, unknown>>();
  for (const e of entries) for (const cs of e.children_state ?? []) if (cs.state_key && cs.content) links.set(cs.state_key, cs.content);
  const isJoined = (id: string) => client.getRoom(id)?.getMyMembership() === "join";
  // Rooms the member is in, or is about to be in by an earlier wave. A room allowed through a room
  // outside the tree (the hidden gate) counts when the member is in that room.
  const inside = new Set<string>([hubId]);
  const satisfies = (id: string) => inside.has(id) || isJoined(id);

  let left = entries.filter((e) => e.room_id && !satisfies(e.room_id)
    && !isGate(e, links.get(e.room_id), client.getRoom(e.room_id))
    && (e.join_rule === undefined || e.join_rule === "public" || RESTRICTED.has(e.join_rule)));
  const waves: { roomId: string; via: string[] | undefined }[][] = [];
  for (;;) {
    const wave = left.filter((e) => !RESTRICTED.has(e.join_rule ?? "") || (e.allowed_room_ids ?? []).some(satisfies));
    if (wave.length === 0) break;
    waves.push(wave.map((e) => ({ roomId: e.room_id, via: (links.get(e.room_id)?.via as string[] | undefined) })));
    for (const e of wave) inside.add(e.room_id);
    left = left.filter((e) => !wave.includes(e));
  }
  return waves;
}

/** Find (or join) the hub — the room the server names first, its alias only as the fallback — then
 *  join what the member may of its tree. Failures are logged, never thrown: this runs in the background. */
export async function joinCommunity(
  client: JoinClient,
  opts: { hubRoomId: string | null; hubAlias: string; serverName: string; log?: Pick<Console, "warn"> },
): Promise<void> {
  const log = opts.log ?? console;
  const idOf = (r: { roomId: string } | string) => (typeof r === "string" ? r : r.roomId);
  let hubId: string | null = null;
  if (opts.hubRoomId) {
    if (client.getRoom(opts.hubRoomId)?.getMyMembership() === "join") hubId = opts.hubRoomId;
    else {
      try { hubId = idOf(await client.joinRoom(opts.hubRoomId, { viaServers: [opts.serverName] })); }
      catch (e) { log.warn("[Matrix] could not join community hub by id:", e); }
    }
  }
  if (!hubId) {
    hubId = findRoomByAlias(client.getRooms() as unknown as Room[], opts.hubAlias)?.roomId ?? null;
    if (!hubId) {
      try { hubId = idOf(await client.joinRoom(opts.hubAlias)); }
      catch (e) { log.warn("[Matrix] could not join community hub:", e); }
    }
  }
  if (!hubId) return;
  try {
    const hier = await client.getRoomHierarchy(hubId, 100, 5);
    for (const wave of joinWaves(hier?.rooms ?? [], hubId, client)) {
      await Promise.all(wave.map((t) =>
        client.joinRoom(t.roomId, { viaServers: t.via?.length ? t.via : [opts.serverName] })
          .catch((err: unknown) => log.warn("[Matrix] auto-join failed", t.roomId, err))));
    }
  } catch (e) {
    log.warn("[Matrix] hub hierarchy auto-join failed:", e);
  }
}
