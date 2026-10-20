// Shared Matrix room/space helpers used by both the full-page community client
// (CommunityPage.tsx) and the stream-page sidebar (MatrixPanel.tsx). These were
// previously copy-pasted in both files; this is the single source of truth.
//
// Pure functions only (no React, no hooks) so either client component can import
// them freely.

import { EventType, NotificationCountType } from "matrix-js-sdk";
import type { MatrixClient, Room, RoomMember } from "matrix-js-sdk";
import { matrixServerName } from "./matrixConfig.ts";
import { siteName } from "./siteName.ts";
import { ROOM_TYPE, readFirst } from "./matrixNamespace.ts";

// Aliases on THIS install's server (matrix.serverName — an install value, so these are constant
// for the life of the process; the server name never changes anyway). Display/lookup only: the stable handle for a room is its id.
export const COMMUNITY_HUB_ALIAS = `#community-hub:${matrixServerName()}`;
export const GENERAL_ALIAS = `#general:${matrixServerName()}`;
// Where the "＋ Suggest" button on a feed item posts — the Content forum room (a
// room in the Forum space, NOT the space itself). The website renders it with the
// forum-post format (title + body), so the Suggest flow opens the New Post modal
// prefilled rather than posting a plain message. See useContentSuggestion.
export const CONTENT_SUGGESTIONS_ALIAS = `#contentforum:${matrixServerName()}`;

// Moved to matrixDisplay.ts (SDK-free at runtime) so eager components don't pull
// the SDK through this module; re-exported here so the Matrix tree's imports keep working.
import { localpart } from "./matrixDisplay.ts";
export { localpart };

/** Room ids the server has tagged as direct messages (m.direct account data). */
export function getDmRoomIds(client: MatrixClient | null): Set<string> {
  if (!client) return new Set();
  const data = (client.getAccountData(EventType.Direct)?.getContent() ?? {}) as Record<string, string[]>;
  return new Set(Object.values(data).flat());
}

/** The other member of a DM room, or null if the room isn't a DM. */
export function dmPartner(room: Room, myUserId: string, dmRoomIds: Set<string>): RoomMember | null {
  const isDm = dmRoomIds.has(room.roomId) || !!room.getDMInviter();
  if (!isDm) return null;
  return room.getMembers().find((m) => m.userId !== myUserId) ?? null;
}

/** Display label for a room — partner name for DMs, room name otherwise. */
export function roomLabel(room: Room, myUserId: string, dmRoomIds: Set<string>): string {
  const partner = dmPartner(room, myUserId, dmRoomIds);
  if (partner) return partner.name || localpart(partner.userId);
  return room.name || room.roomId;
}

function isSpace(room: Room): boolean {
  return room.getType() === "m.space";
}

// Custom room-type marker (ROOM_TYPE, matrixNamespace.ts). A forum room is an ordinary room
// flagged with this state event so our client renders it Reddit/Discord-forum style; other
// Matrix clients ignore the unknown state and show it as a normal threaded room.
// The flag is the ONLY thing that makes a forum — the same rule the Forums tab's reader uses
// (forumReader.ts), so the two surfaces cannot disagree. No list of "forum spaces" auto-formats
// every room under a space.
export function isForumRoom(room: Room): boolean {
  // The product name's flag, else the legacy one's. Empty content (a cleared flag) counts as no flag.
  const type = readFirst(ROOM_TYPE, (t) => {
    const v = room.currentState.getStateEvents(t, "")?.getContent()?.type;
    return typeof v === "string" ? v : undefined;
  });
  return type === "forum";
}

/** True when a space-child/space-parent link is live: the spec makes an empty or
 *  missing `via` the way a link is REMOVED, so a link without it is not a link.
 *  Both directions must agree — checking it on one side only meant a removed
 *  m.space.child could still be resurrected by a stale m.space.parent. */
function hasVia(ev: { getContent(): { via?: unknown } }): boolean {
  const via = ev.getContent()?.via;
  return Array.isArray(via) && via.length > 0;
}

/** Child rooms of a space, resolving both m.space.child and m.space.parent links. */
// @test-only matrixRooms.test.ts walks space children from fixtures.
export function getSpaceChildren(space: Room, allRooms: Room[]): Room[] {
  const childEvents = space.currentState.getStateEvents("m.space.child") ?? [];
  const childIdsFromSpace = new Set(
    childEvents
      .filter(hasVia)
      .map((ev) => ev.getStateKey())
      .filter(Boolean) as string[]
  );
  return allRooms.filter((r) => {
    if (childIdsFromSpace.has(r.roomId)) return true;
    const parentEvents = r.currentState.getStateEvents("m.space.parent") ?? [];
    return parentEvents.some((ev) => ev.getStateKey() === space.roomId && hasVia(ev));
  });
}

export function findRoomByAlias(rooms: Room[], alias: string): Room | null {
  return (
    rooms.find(
      (r) =>
        r.getMyMembership() === "join" &&
        (r.getCanonicalAlias() === alias || r.getAltAliases().includes(alias))
    ) ?? null
  );
}

export function isEncryptedRoom(room: Room): boolean {
  return (room.currentState.getStateEvents("m.room.encryption") ?? []).length > 0;
}

export function roomUnreads(room: Room) {
  return {
    total: room.getUnreadNotificationCount(NotificationCountType.Total) ?? 0,
    highlight: room.getUnreadNotificationCount(NotificationCountType.Highlight) ?? 0,
  };
}

export function aggregateUnreads(rooms: Room[]) {
  return rooms.reduce(
    (acc, r) => {
      const u = roomUnreads(r);
      return { total: acc.total + u.total, highlight: acc.highlight + u.highlight };
    },
    { total: 0, highlight: 0 }
  );
}

// ─── nav data model ───────────────────────────────────────────────────────────

export type SpaceNode = {
  space: Room;
  channels: Room[];
  subSpaces: SpaceNode[];
};

// @test-only matrixRooms.test.ts builds space trees from fixtures.
export function buildSpaceNode(space: Room, allRooms: Room[], seen: Set<string> = new Set()): SpaceNode {
  const children = getSpaceChildren(space, allRooms);
  // Matrix lets a user put space A inside space B and B inside A — nothing in
  // the protocol forbids a cycle, and Element will happily create one. Without
  // this guard the recursion below never terminates and takes the tab with it.
  const nextSeen = new Set(seen).add(space.roomId);
  const subSpaces = children
    .filter((r) => isSpace(r) && !nextSeen.has(r.roomId))
    .map((s) => buildSpaceNode(s, allRooms, nextSeen));

  // A room may legitimately sit in several spaces at once (Matrix has no single
  // "the" parent). This rail is Discord-shaped, though, where a channel lives in
  // exactly one place — so when a room is BOTH a direct child here and nested in
  // a sub-space below, the deeper, more specific home wins and it is not also
  // listed at this level. Without this it renders twice in one column, which
  // reads as a bug rather than as "it is in two spaces".
  const nestedIds = new Set(subSpaces.flatMap(allChannelsInNode).map((r) => r.roomId));
  return {
    space,
    channels: children.filter((r) => !isSpace(r) && !nestedIds.has(r.roomId)),
    subSpaces,
  };
}

export function allChannelsInNode(node: SpaceNode): Room[] {
  return [...node.channels, ...node.subSpaces.flatMap(allChannelsInNode)];
}

export type NavData = {
  spaceTree: SpaceNode[];
  orphanChannels: Room[];
  dms: Room[];
};

export function buildNav(rooms: Room[], myUserId: string, dmRoomIds: Set<string>): NavData {
  const spaces = rooms.filter(isSpace);
  const allChildIds = new Set(
    spaces.flatMap((s) => getSpaceChildren(s, rooms).map((r) => r.roomId))
  );
  const topLevelSpaces = spaces.filter((s) => !allChildIds.has(s.roomId));
  const dms = rooms.filter((r) => !isSpace(r) && dmPartner(r, myUserId, dmRoomIds) !== null);
  const dmIds = new Set(dms.map((r) => r.roomId));
  const orphanChannels = rooms.filter(
    (r) => !isSpace(r) && !dmIds.has(r.roomId) && !allChildIds.has(r.roomId)
  );
  return {
    spaceTree: topLevelSpaces.map((s) => buildSpaceNode(s, rooms)),
    orphanChannels,
    dms,
  };
}

// ─── Discord-style rail model ─────────────────────────────────────────────────
// A "server" in the far-left rail = one top-level space (its direct channels +
// sub-spaces become the channel column). Orphan channels (not in any space) fold
// into a synthetic main server, named after the site, so they're always reachable.

const MAIN_SERVER_ID = "__main__";

export type RailServer = {
  id: string;
  name: string;
  /** null for the synthetic main server (orphan channels). */
  room: Room | null;
  channels: Room[];
  subSpaces: SpaceNode[];
};

export function buildServers(nav: NavData): RailServer[] {
  const servers: RailServer[] = [];
  if (nav.orphanChannels.length > 0) {
    servers.push({
      id: MAIN_SERVER_ID,
      name: siteName(),
      room: null,
      channels: nav.orphanChannels,
      subSpaces: [],
    });
  }
  for (const node of nav.spaceTree) {
    servers.push({
      id: node.space.roomId,
      name: node.space.name || node.space.roomId,
      room: node.space,
      channels: node.channels,
      subSpaces: node.subSpaces,
    });
  }
  return servers;
}

/** Every channel reachable inside a server (direct + nested sub-spaces). */
export function serverChannels(server: RailServer): Room[] {
  return [...server.channels, ...server.subSpaces.flatMap(allChannelsInNode)];
}

/** Rooms the user has favourited (m.favourite tag) — the Home "pinned" set. */
export function favouriteRooms(rooms: Room[]): Room[] {
  return rooms.filter((r) => !isSpace(r) && !!r.tags?.["m.favourite"]);
}
