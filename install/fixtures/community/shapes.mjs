// Two communities shaped like real installs, for the reconciler's core and command tests. The main
// fixture pair (feed.json + actual.json) is a community the service account made itself; these are
// the two it meets in practice, where it made nothing.
//
//   bundleShaped()  a fresh bundle: the setup's bootstrap made the hub, #general and #forum as the
//                   streamer, invited the service account into each and granted it 100. No row yet.
//                   `actual` is as the service account reads it once it has joined.
//   ownerShaped()   an install whose rooms predate the reconciler: every room made by the streamer,
//                   the service account granted 100 by hand, a mautrix-style bridged room (its bot
//                   named in m.bridge state, at 100, and listed in the feed's bridgeBots), a
//                   hand-granted 100 nobody on the ladder holds,
//                   and Synapse's own per-event table (tombstone at 100). Rows already adopted.
// Both return fresh objects ({ feed, actual }) on every call. Plain data; no I/O.
import { FORUM_ORDER, GENERAL_ORDER, GENERAL_RETENTION_MS, forumBody, joinedViaHub } from "../../matrix/community-rooms.mjs";

const S = "example.test";
const id = (x) => `!${x}:${S}`;
const u = (x) => `@${x}:${S}`;
const SERVICE = u("community");
const STREAMER = u("streamer");
const DAY = 86_400_000;

/** Synapse's power levels for a room the streamer made with preset public_chat (room v12). */
const synapseDefault = (users) => ({
  users_default: 0, events_default: 0, state_default: 50, ban: 50, kick: 50, redact: 50, invite: 0, historical: 100,
  events: {
    "m.room.name": 50, "m.room.power_levels": 100, "m.room.history_visibility": 100, "m.room.canonical_alias": 50,
    "m.room.avatar": 50, "m.room.tombstone": 100, "m.room.server_acl": 100, "m.room.encryption": 100,
  },
  users,
});

const baseFeed = () => ({
  serverName: S,
  hubRoomId: id("bhub"),
  serviceUserId: SERVICE,
  hiddenUserIds: [SERVICE],
  spaces: [],
  rooms: [],
  roles: [],
  people: [{ userId: STREAMER, level: 100 }, { userId: u("moddy"), level: 50 }],
  supporters: [],
  banned: [],
  timedOut: [],
  siteBanReason: "Banned by the example site",
  putBack: true,
  retentionCapDays: 365,
});

export function bundleShaped() {
  const members = { [STREAMER]: "join", [SERVICE]: "join", [u("viewer")]: "join" };
  const room = (over) => ({
    topic: null, avatar: null, joinRule: "public", allow: [], history: "shared", encrypted: false, published: true,
    powerLevels: synapseDefault({ [SERVICE]: 100 }), members: { ...members }, banReasons: {}, tombstone: null,
    creators: [STREAMER], ...over,
  });
  // The bootstrap's own shape (install/matrix/community-rooms.mjs): its join rule and places.
  const children = () => [{ roomId: id("bgeneral"), order: GENERAL_ORDER, via: [S] }, { roomId: id("bforum"), order: FORUM_ORDER, via: [S] }];
  const viaHub = () => ({ joinRule: joinedViaHub(id("bhub")).join_rule, allow: joinedViaHub(id("bhub")).allow });
  const forum = forumBody(id("bhub"));
  const actual = {
    hub: { roomId: id("bhub"), children: children() },
    rooms: {
      [id("bhub")]: room({ name: "Example Stream", type: "m.space", spaceKind: null, children: children() }),
      [id("bgeneral")]: room({ name: "general", retention: GENERAL_RETENTION_MS, ...viaHub() }),
      [id("bforum")]: room({ name: "forum", topic: forum.topic, forum: true, ...viaHub() }),
    },
  };
  return { feed: baseFeed(), actual };
}

export function ownerShaped() {
  const feed = baseFeed();
  feed.hubRoomId = id("ohub");
  feed.timedOut = [{ userId: u("tim"), until: "2026-10-24T00:00:00.000Z" }];
  feed.banned = [u("mallory")];
  // The bridge's bot, listed under the site's Bridge accounts (Task 1.13 Step 1 adds it before the first apply).
  feed.bridgeBots = [u("discordbot")];
  feed.spaces = [{ id: 1, parentId: null, kind: "hub", name: "Example Stream", topic: null, avatarMxc: null, orderKey: null, matrixRoomId: id("ohub"), gateTier: null }];
  const row = (n, name, over) => ({
    id: n, spaceId: null, kind: "text", name, topic: null, avatarMxc: null, orderKey: `a${n}`, see: "everyone", post: "everyone",
    retentionDays: null, encrypted: false, published: false, archived: false, matrixRoomId: id(`o${name}`), discordChannelId: null, ...over,
  });
  // The bridged room is a plain row (adopt marks nothing as Discord-linked: that is Slice 2's OOYE link).
  feed.rooms = [row(1, "general"), row(2, "bridged"), row(3, "modchat", { see: "invited", post: "mods" })];
  const members = { [STREAMER]: "join", [SERVICE]: "join", [u("moddy")]: "join", [u("viewer")]: "join", [u("tim")]: "join", [u("oldadmin")]: "join" };
  const users = { [SERVICE]: 100, [u("moddy")]: 50, [u("oldadmin")]: 100 };
  const room = (name, over) => ({
    name, topic: null, avatar: null, joinRule: "restricted", allow: [{ type: "m.room_membership", room_id: id("ohub") }], history: "shared",
    retention: 365 * DAY, encrypted: false, published: false,
    powerLevels: synapseDefault({ ...users }), members: { ...members }, banReasons: {}, tombstone: null, creators: [STREAMER], ...over,
  });
  const actual = {
    hub: { roomId: id("ohub"), children: ["general", "bridged", "modchat"].map((n, i) => ({ roomId: id(`o${n}`), order: `a${i + 1}`, via: [S] })) },
    rooms: {
      [id("ohub")]: room("Example Stream", { type: "m.space", spaceKind: "hub", joinRule: "public", allow: [], retention: undefined,
        children: ["general", "bridged", "modchat"].map((n, i) => ({ roomId: id(`o${n}`), order: `a${i + 1}`, via: [S] })) }),
      [id("ogeneral")]: room("general"),
      [id("obridged")]: room("bridged", {
        joinRule: "public", allow: [],
        powerLevels: synapseDefault({ ...users, [u("discordbot")]: 100, [u("discord_123")]: 50 }),
        members: { ...members, [u("discordbot")]: "join", [u("discord_123")]: "join", [u("discord_456")]: "join" },
        bridgeHints: [u("discordbot")],
      }),
      [id("omodchat")]: room("modchat", { joinRule: "invite", allow: [] }),
    },
  };
  // The site's moderators are already at 50 in the per-event table's eyes; only the posting rule differs in #modchat.
  actual.rooms[id("omodchat")].powerLevels.events_default = 50;
  return { feed, actual };
}
