// The community reconciler's core: what the panel wants (the web's DesiredFeed) against what the
// homeserver holds → a list of operations. PURE: no I/O, no clock, no imports; reconcile.mjs reads
// both sides, calls planAll, and performs the ops. Spec: docs/superpowers/specs/
// 2026-10-23-community-management-discord-design.md §4.1–4.5.
//
// desired — the DesiredFeed, as JSON:
//   { serverName, hubRoomId, serviceUserId, hiddenUserIds, spaces: SpaceRow[], rooms: RoomRow[],
//     roles: RoleRow[], people: [{userId, level}], supporters: [userId], banned: [userId],
//     timedOut: [{userId, until}], putBack, retentionCapDays, siteBanReason,
//     bridgeBots: [userId] (the site's Bridge accounts setting), bridgeUserPatterns?: [regex source],
//     discordBot?: userId (the Discord bridge's own bot while it is on: seated at 100 in the hub and in
//     every room linked to Discord), discordSpaceLinked?: boolean (the hub is linked to a Discord server) }
// actual — built by reconcile.mjs from the homeserver (Maps or plain objects, both accepted):
//   { hub: { roomId, children: [{roomId, order, via}] },
//     rooms: Map<roomId, { name, topic, avatar, joinRule, allow: [{type, room_id}], history,
//       retention (max_lifetime ms | null = an event with no limit | absent/undefined = no event),
//       encrypted, published, powerLevels (the content),
//       members: Map<userId, membership>, banReasons?: Map<userId, reason> (the reason on each
//       membership "ban" event; a ban is the site's when it equals desired.siteBanReason),
//       tombstone (m.room.tombstone content | null),
//       creators?: [userId] (create sender + additional_creators), type?: "m.space",
//       children?: [{roomId, order, via}] (spaces), forum?: boolean, unreadable?: true,
//       banner?: the url of its app.blackbranch.banner state event (spaces),
//       spaceKind?: the content `kind` of the space's app.blackbranch.space_kind state event, or of
//       its create content's app.blackbranch.space_kind when there is no state event,
//       bridgeHints?: [userId] (the bridge bots its m.bridge state names: a hint, never trusted) }> }
//   A room the service account cannot read is `{ unreadable: true }`: it is warned about, never
//   recreated. A room id absent from `rooms` is gone: an unarchived row recreates it.
//
// Ops are plain objects with `op` (the kind), `roomId` (the room written; null on a create) and
// `label` (how describe() names it). A room this plan creates is named before it exists by its
// pending ref, `new:<table>:<rowId>` (pendingRef): the create op carries it as `ref`, and later ops
// use it as roomId / parentId / childId or inside content. The executor replaces every string equal
// to a ref, anywhere in a later op, with the room id the create returned.

const ROOM_VERSION = "12";
const DAY_MS = 86_400_000;
const ARCHIVED = 100;
const SUPPORTER = 10;
const MOD_LEVEL = 50;
const TIMED_OUT = -1;
const MODES = ["report", "adopt", "apply"];
/** Who can post (spec §4.3) → events_default. */
const POST_LEVEL = { everyone: 0, supporters: SUPPORTER, mods: 50, staff: 75 };
/** Who can see, for the invite-only rungs: everyone at this level or above in `people`. */
const SEE_RUNG = { mods: 50, staff: 75 };
const SPACE_EVENTS_DEFAULT = 50;
// The per-event table (spec §4.2 + research-mapping §4): access, retention, encryption and the
// ladder itself are owner decisions (100); editing a channel is Staff (75); pins and forum tags are
// moderation (50); upgrading a room stays the creator's (150 in room v12).
const EVENT_LEVELS = {
  "m.room.power_levels": 100,
  "m.room.join_rules": 100,
  "m.room.history_visibility": 100,
  "m.room.encryption": 100,
  "m.room.server_acl": 100,
  "m.room.retention": 100,
  "m.room.guest_access": 100,
  "m.room.tombstone": 150,
  "m.room.name": 75,
  "m.room.topic": 75,
  "m.room.avatar": 75,
  "m.room.canonical_alias": 75,
  "m.space.child": 75,
  "m.space.parent": 75,
  "m.room.pinned_events": 50,
  "app.blackbranch.forum.tags_available": 50,
};
const MODERATION = { users_default: 0, state_default: 50, ban: 50, kick: 50, redact: 50, invite: 50 };
const ENCRYPTION = { algorithm: "m.megolm.v1.aes-sha2", rotation_period_ms: 604800000, rotation_period_msgs: 100 };
// The product's forum flag (web matrixNamespace.ts ROOM_TYPE; bootstrap.mjs writes the same).
const FORUM_FLAG = "app.blackbranch.room_type";
// The product's space-kind marker (spec §4.3): hub | category | gate. A space this plan creates holds
// it in its create content for good; an existing space without it gets the same name as a state event
// (create content cannot change after the fact). The client reads either.
const SPACE_KIND = "app.blackbranch.space_kind";
// A space's banner, the wide picture over its channel list (web matrixNamespace.ts SPACE_BANNER):
// { url: mxc }. Its own event, so the space's m.room.avatar stays its icon.
const BANNER = "app.blackbranch.banner";
const KIND_WORDS = { hub: "the community's main space", category: "a category", gate: "the hidden supporters space" };
/** Changes that undo something done by hand in another app: drift, not ops, when put-back is off. */
const PUT_BACK = true;
const PHASE = { createSpace: 0, createRoom: 1 };

/** The name a room or space has in a plan before it exists. */
export function pendingRef(table, id) {
  return `new:${table}:${id}`;
}

// ── Reading the two sides ──────────────────────────────────────────────────────────────────────
const asMap = (x) => (x instanceof Map ? x : new Map(Object.entries(x ?? {})));
const norm = (s) => (s === undefined || s === null || s === "" ? null : s);

/** Canonical JSON (sorted keys) — equality of two settings contents regardless of key order. */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}
const same = (a, b) => canon(a) === canon(b);

/**
 * The bridge's own accounts, from the feed's `bridgeUserPatterns` (regex sources from the bridge
 * registration). Each is anchored here — tested as ^(?:src)$ — so a registration pattern written
 * without anchors cannot match a longer id on another server. A pattern that does not compile, or
 * that accepts the empty string (it would match almost anything, e.g. "" or ".*"), is not usable.
 */
function bridgePatterns(sources) {
  const out = [];
  for (const src of sources ?? []) {
    if (typeof src !== "string") continue;
    let re;
    try { re = new RegExp(`^(?:${src})$`); } catch { continue; }
    if (re.test("")) continue;
    out.push(re);
  }
  return out;
}
const isBridgeAccount = (c, u) => c.bridgePatterns.some((re) => re.test(u));
/**
 * The site's bridge accounts (the feed's `bridgeBots`, an admin setting) present in a room, as a member
 * or in its power list: the only bridge bots the core trusts. Never someone on the ladder, hidden, or
 * site-banned (a site ban always wins). A room with one is a bridged room.
 */
function bridgeBotsOf(c, entry) {
  const members = membersOf(entry);
  const listed = entry?.powerLevels?.users ?? {};
  return [...c.bridgeBotIds].filter((u) => (members.has(u) || u in listed) && !c.people.has(u) && !c.hidden.has(u) && !c.banned.has(u)).sort();
}
/** A room whose bridge state names a bot the site's settings do not list: said, never trusted. */
function unlistedBridgeWarn(c, roomId, label, entry) {
  const unlisted = (entry?.bridgeHints ?? []).filter((u) => !c.bridgeBotIds.has(u));
  if (!unlisted.length) return null;
  const who = unlisted.join(", ");
  return warn("bridge_account_unlisted", roomId, label,
    `${label} looks bridged by ${who}: add ${unlisted.length === 1 ? "it" : "them"} under Bridge accounts if that is right`);
}

function context(desired, actual) {
  const rooms = asMap(actual?.rooms);
  const spaces = desired.spaces ?? [];
  const hubRow = spaces.find((s) => s.kind === "hub") ?? null;
  const hubId = desired.hubRoomId ?? hubRow?.matrixRoomId ?? actual?.hub?.roomId ?? null;
  const c = {
    desired, actual, rooms, hubRow, hubId,
    server: desired.serverName,
    service: desired.serviceUserId,
    spaceById: new Map(spaces.map((s) => [s.id, s])),
    gateRow: spaces.find((s) => s.kind === "gate") ?? null,
    people: new Map(),
    supporters: new Set(desired.supporters ?? []),
    banned: new Set(desired.banned ?? []),
    timedOut: new Set((desired.timedOut ?? []).map((t) => t.userId)),
    putBack: desired.putBack !== false,
    hidden: new Set([desired.serviceUserId, ...(desired.hiddenUserIds ?? [])]),
    bridgePatterns: bridgePatterns(desired.bridgeUserPatterns),
    bridgeBotIds: new Set((desired.bridgeBots ?? []).filter((u) => typeof u === "string")),
    discordBot: null,
    discordSpaceLinked: desired.discordSpaceLinked === true,
  };
  for (const p of desired.people ?? []) c.people.set(p.userId, Math.max(c.people.get(p.userId) ?? -Infinity, p.level));
  // The Discord bridge's bot: trusted as a bridge account, and seated where the bridge needs it (its
  // link calls refuse a space or room where it is below 100). Never a site-banned or hidden account.
  const bot = desired.discordBot;
  if (typeof bot === "string" && /^@[^\s:]+:[^\s]+$/.test(bot) && !c.banned.has(bot) && !c.hidden.has(bot) && !c.people.has(bot)) {
    c.discordBot = bot;
    c.bridgeBotIds.add(bot);
  }
  // Every room id a row knows (the hub included): the rest of the hierarchy is "not in the panel".
  c.known = new Set([hubId, ...spaces.map((s) => s.matrixRoomId), ...(desired.rooms ?? []).map((r) => r.matrixRoomId)].filter(Boolean));
  return c;
}

function childrenOf(c, roomId) {
  if (roomId && roomId === c.actual?.hub?.roomId) return c.actual.hub.children ?? [];
  return c.rooms.get(roomId)?.children ?? [];
}
const membersOf = (entry) => asMap(entry?.members);
const isIn = (m) => m === "join" || m === "invite";

/**
 * Where a row stands on the homeserver:
 *   present — the room is there and readable (entry set)
 *   create  — no room yet, or it is gone: this plan makes it (id = its pending ref)
 *   unreadable / tombstoned — there but not ours to touch now (warned)
 *   gone-archived — archived and gone: nothing to do
 *   gone-bridged  — linked to Discord and gone: the bridge made it, so it is not remade here
 */
function rowState(c, table, row) {
  if (table === "spaces" && row.kind === "hub") {
    const entry = c.rooms.get(c.hubId);
    return entry && !entry.unreadable ? { id: c.hubId, state: "present", entry } : { id: c.hubId, state: "unreadable" };
  }
  const mid = row.matrixRoomId;
  if (mid) {
    const entry = c.rooms.get(mid);
    if (entry?.unreadable) return { id: mid, state: "unreadable" };
    if (entry?.tombstone?.replacement_room) return { id: mid, state: "tombstoned", entry };
    if (entry) return { id: mid, state: "present", entry };
  }
  if (table === "rooms" && row.archived) return { id: mid ?? null, state: "gone-archived" };
  if (table === "rooms" && mid && row.discordChannelId) return { id: mid, state: "gone-bridged" };
  return { id: pendingRef(table, row.id), state: "create", ...(mid ? { replaces: mid } : {}) };
}
const live = (st) => st.state === "present" || st.state === "create";
const isRef = (id) => typeof id === "string" && id.startsWith("new:");

const roomLabel = (name) => `#${name}`;
function spaceLabel(row, name = row.name) {
  if (row.kind === "hub") return "the community";
  if (row.kind === "gate") return "the hidden supporters space";
  return `the category ${name}`;
}

/** The space a room or category sits in: its row and where that row stands. */
function parentOf(c, table, row) {
  const pid = table === "rooms" ? row.spaceId : row.parentId;
  const prow = pid === null || pid === undefined ? c.hubRow : c.spaceById.get(pid) ?? c.hubRow;
  if (!prow) return { row: null, st: { id: c.hubId, state: c.rooms.has(c.hubId) || c.actual?.hub ? "present" : "unreadable" }, label: "the community" };
  return { row: prow, st: rowState(c, "spaces", prow), label: spaceLabel(prow) };
}

function warn(code, roomId, label, message) {
  return { op: "warn", code, roomId, label, message };
}

// ── Settings a row wants ───────────────────────────────────────────────────────────────────────
/** Who can join, from who can see (spec §4.3); `who` is the sentence describe() uses. */
function joinRuleFor(c, row) {
  if (row.see === "everyone") return { content: { join_rule: "restricted", allow: [{ type: "m.room_membership", room_id: c.hubId }] }, who: "everyone in the community" };
  if (row.see === "supporters" && c.gateRow) {
    const gate = rowState(c, "spaces", c.gateRow);
    return { content: { join_rule: "restricted", allow: [{ type: "m.room_membership", room_id: gate.id }] }, who: "supporters and above" };
  }
  // Mods, Staff, Invited — and Supporters with no gate to point at: never wider than asked.
  return { content: { join_rule: "invite" }, who: "invited people only" };
}
function spaceJoinRule(c, row) {
  if (row.kind === "gate") return { content: { join_rule: "invite" }, who: "invited people only" };
  return { content: { join_rule: "restricted", allow: [{ type: "m.room_membership", room_id: c.hubId }] }, who: "everyone in the community" };
}
function sameJoinRule(entry, content) {
  if ((entry.joinRule ?? null) !== content.join_rule) return false;
  if (!content.allow) return true;
  const ids = (a) => (a ?? []).filter((x) => x?.type === "m.room_membership").map((x) => x.room_id).sort();
  return same(ids(entry.allow), ids(content.allow));
}
/**
 * The max_lifetime (ms) every room's explicit m.room.retention event carries, or null for "keep
 * forever" (content {}). Spec §4.5 as amended: with the install cap on, a row's days are capped and a
 * row with no days means "as long as this server allows" — the cap; with the cap off (0, null or
 * absent), days are written as they are and no days means no limit. Never left to the server's
 * default policy.
 */
function retentionMs(c, row) {
  const days = row.retentionDays === null || row.retentionDays === undefined ? null : row.retentionDays;
  const cap = Number(c.desired.retentionCapDays);
  if (cap > 0) return (days === null ? cap : Math.min(days, cap)) * DAY_MS;
  return days === null ? null : days * DAY_MS;
}
const retentionContent = (ms) => (ms === null ? {} : { max_lifetime: ms });

/** The m.room.power_levels keys the core writes and compares; every other key is the room's own. */
const MANAGED_POWER_KEYS = new Set(["users", "users_default", "events", "events_default", "state_default", "ban", "kick", "redact", "invite", "notifications"]);
const LEVEL_KEYS = ["users_default", "events_default", "state_default", "ban", "kick", "redact", "invite"];
function unmanagedPower(content) {
  const out = {};
  for (const [k, v] of Object.entries(content ?? {})) if (!MANAGED_POWER_KEYS.has(k)) out[k] = v;
  return out;
}
const levelOf = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * The service account's own power in an existing room: unlimited where it is a creator (room v12),
 * else its entry in the power list (or the room's default). A room this plan creates is its own.
 */
function serviceLevel(c, entry) {
  if (!entry || (entry.creators ?? []).includes(c.service)) return Infinity;
  const pl = entry.powerLevels ?? {};
  return levelOf(pl.users?.[c.service]) ?? levelOf(pl.users_default) ?? 0;
}
function sortedUsers(users) {
  const out = {};
  for (const u of Object.keys(users).sort()) out[u] = users[u];
  return out;
}

/**
 * What Matrix lets the service account write (the power-levels authorisation rules), applied to a
 * wanted content. In a room it did not create, its own entry is kept as it is (never lowered: that
 * would end every later write), and anything at or above its own level (a user who holds as much as
 * it does, an event or default set above it) is kept as found: a change there is refused, and the
 * refusal would take the room's whole write with it. Creators are never listed (room v12).
 * Returns the content and the users kept against the ladder's wish (planPower says so).
 */
function fitToService(c, wanted, entry) {
  const creators = entry?.creators ?? [];
  const users = { ...(wanted.users ?? {}) };
  for (const u of creators) delete users[u];
  const mine = serviceLevel(c, entry);
  if (mine === Infinity) {
    delete users[c.service];
    return { content: { ...wanted, users: sortedUsers(users) }, held: [] };
  }
  const have = entry?.powerLevels ?? {};
  const haveUsers = have.users ?? {};
  const held = [];
  if (haveUsers[c.service] !== undefined) users[c.service] = haveUsers[c.service];
  else delete users[c.service];
  for (const [u, raw] of Object.entries(haveUsers)) {
    const lv = levelOf(raw);
    if (u === c.service || lv === undefined || lv < mine || creators.includes(u)) continue;
    if (users[u] !== raw) held.push(u);
    users[u] = raw;
  }
  const out = { ...wanted };
  // A changed level is refused when the old or the new one is above the sender's own.
  const refused = (want, had) => want !== had && ((levelOf(had) ?? -Infinity) > mine || (levelOf(want) ?? -Infinity) > mine);
  for (const k of LEVEL_KEYS) {
    if (k in out && refused(out[k], have[k])) { if (have[k] === undefined) delete out[k]; else out[k] = have[k]; }
  }
  if (out.events) {
    const events = { ...out.events };
    for (const k of new Set([...Object.keys(events), ...Object.keys(have.events ?? {})])) {
      const had = have.events?.[k];
      if (refused(events[k], had)) { if (had === undefined) delete events[k]; else events[k] = had; }
    }
    out.events = events;
  }
  if (out.notifications && refused(out.notifications.room, have.notifications?.room)) {
    if (have.notifications === undefined) delete out.notifications; else out.notifications = have.notifications;
  }
  return { content: { ...out, users: sortedUsers(users) }, held: held.sort() };
}

/**
 * The full settings content of who-can-do-what for one room or space. `users` lists only the ladder
 * (Admin 100, Staff 75, Mod 50, Bot 50), supporters at 10 where posting is for supporters, and the
 * timed out at −1 (that wins over every other level), and never anyone at 0 (that is everyone's
 * default). In a room where one of the site's bridge accounts is (bridgeBotsOf), the bot keeps its
 * grant, and so does a puppet the feed's bridgeUserPatterns name while it is below a mod's. A room linked to Discord keeps the bridge's own per-event table and the
 * bridge's own grants above 0 (OOYE rewrites those when it links). Then fitted to what the service
 * account may write (fitToService: creators never listed, its own level never lowered).
 */
function powerFor(c, table, row, entry) {
  const isRoom = table === "rooms";
  const users = new Map();
  for (const [u, level] of c.people) if (level > 0) users.set(u, level);
  if (isRoom && row.post === "supporters") for (const u of c.supporters) if ((users.get(u) ?? 0) < SUPPORTER) users.set(u, SUPPORTER);
  for (const u of c.timedOut) users.set(u, TIMED_OUT); // every room AND space of the community
  const had = entry?.powerLevels?.users ?? {};
  // A room where one of the site's bridge accounts is, is bridged. Kept there: the bot's grant, and a
  // grant to an account the feed's bridgeUserPatterns name (a puppet) while it is below a mod's (a
  // puppet never needs moderation; a higher one is dropped and said). Every other grant follows the
  // ladder exactly as in any room (one the service cannot change stays: grant_out_of_reach). A site
  // ban or timeout always wins.
  const bots = bridgeBotsOf(c, entry);
  const bridge = { dropped: [], hubCopies: [] };
  if (bots.length && !(isRoom && row.discordChannelId)) {
    for (const u of bots) if (!users.has(u) && (levelOf(had[u]) ?? 0) > 0) users.set(u, had[u]);
    for (const [u, lv] of Object.entries(had)) {
      if (users.has(u) || c.hidden.has(u) || c.banned.has(u) || c.people.has(u) || c.timedOut.has(u) || (levelOf(lv) ?? 0) <= 0) continue;
      if (u === c.service || (entry?.creators ?? []).includes(u)) continue;
      if (!isBridgeAccount(c, u)) continue;
      if (lv < MOD_LEVEL) users.set(u, lv); else bridge.dropped.push(u);
    }
  }
  let events = { ...EVENT_LEVELS, ...(isRoom && row.kind === "announcement" ? { "m.reaction": 0 } : {}) };
  const linked = isRoom && !!row.discordChannelId;
  // What the Discord bridge sets when it links or syncs a room (OOYE create-room.js channelToKState):
  // who may post and who may notify the room, from the Discord channel's @everyone permissions, and
  // its per-event table. Kept as found on a linked room, so the two never take turns writing them.
  const bridgeOwned = {};
  if (linked && entry?.powerLevels) {
    const pl = entry.powerLevels;
    if (pl.events) events = { ...pl.events };
    if (levelOf(pl.events_default) !== undefined) bridgeOwned.events_default = pl.events_default;
    if (pl.notifications && typeof pl.notifications === "object") bridgeOwned.notifications = pl.notifications;
    // The bridge's own grants stay; a grant to anyone else is the ladder's to decide (a mod demoted
    // on the site loses it here too), and never survives a site ban or a hidden account. With the
    // bridge accounts unknown, every existing grant stays (planPower warns).
    // (The service account's own entry is fitToService's; the bridge's bot gets its seat below.)
    const keep = (u) => !c.banned.has(u) && !c.hidden.has(u) && (!c.bridgePatterns.length || isBridgeAccount(c, u));
    for (const [u, level] of Object.entries(had)) if (!users.has(u) && level > 0 && keep(u)) users.set(u, level);
    // The bridge copies the hub's own grants into every room it links (OOYE create-room.js), so a grant
    // the ladder drops here comes back at the bridge's next sync of the channel. Said, by name.
    const hubUsers = c.rooms.get(c.hubId)?.powerLevels?.users ?? {};
    for (const [u, level] of Object.entries(hubUsers)) {
      if ((levelOf(level) ?? 0) > 0 && !users.has(u) && u !== c.service && u !== c.discordBot && !(entry.creators ?? []).includes(u) && !keep(u)) bridge.hubCopies.push(u);
    }
  }
  // The bridge links a room only while its bot is in it at 100 (OOYE link.js).
  if (linked && c.discordBot) users.set(c.discordBot, 100);
  const fitted = fitToService(c, {
    // Keys the core does not manage (Synapse's "historical" on every room it makes) stay as found:
    // never a difference, and kept when the core writes for another reason.
    ...unmanagedPower(entry?.powerLevels),
    ...MODERATION,
    events_default: isRoom ? POST_LEVEL[row.post] ?? POST_LEVEL.everyone : SPACE_EVENTS_DEFAULT,
    notifications: { room: 50 },
    events,
    ...bridgeOwned,
    users: Object.fromEntries(users),
  }, entry);
  return { ...fitted, bridge };
}
const powerContent = (c, table, row, entry) => powerFor(c, table, row, entry).content;
const looksArchived = (entry) => entry?.powerLevels?.events_default === ARCHIVED;

/**
 * Content the core does not otherwise manage (an archived room, the hub), with only the timeouts
 * applied: everyone timed out at −1, and a −1 left from a timeout that has ended removed. The rest
 * of the content is kept as it is, fitted to what the service account may write (fitToService).
 */
function withTimeouts(c, content, entry) {
  const users = { ...(content?.users ?? {}) };
  for (const [u, level] of Object.entries(users)) if (level === TIMED_OUT && !c.timedOut.has(u)) delete users[u];
  for (const u of c.timedOut) if (u !== c.service) users[u] = TIMED_OUT;
  return fitToService(c, { ...(content ?? {}), users }, entry);
}

function createBody(c, table, row) {
  const isSpace = table === "spaces";
  const join = isSpace ? spaceJoinRule(c, row) : joinRuleFor(c, row);
  const state = [
    { type: "m.room.guest_access", state_key: "", content: { guest_access: "forbidden" } },
    { type: "m.room.join_rules", state_key: "", content: join.content },
    { type: "m.room.history_visibility", state_key: "", content: { history_visibility: "shared" } },
  ];
  if (row.avatarMxc) state.push({ type: "m.room.avatar", state_key: "", content: { url: row.avatarMxc } });
  if (isSpace && row.bannerMxc) state.push({ type: BANNER, state_key: "", content: { url: row.bannerMxc } });
  if (!isSpace) {
    state.push({ type: "m.room.retention", state_key: "", content: retentionContent(retentionMs(c, row)) });
    if (row.encrypted) state.push({ type: "m.room.encryption", state_key: "", content: { ...ENCRYPTION } });
    if (row.kind === "forum") state.push({ type: FORUM_FLAG, state_key: "", content: { type: "forum" } });
  }
  return {
    room_version: ROOM_VERSION,
    name: row.name,
    ...(row.topic ? { topic: row.topic } : {}),
    visibility: "private",
    creation_content: isSpace ? { type: "m.space", [SPACE_KIND]: row.kind } : {},
    initial_state: state,
    power_level_content_override: powerContent(c, table, row, null),
  };
}

/** Name, topic and picture of an existing room or space: each a put-back when it differs. */
/** `bridged`: a room linked to Discord. The bridge fills in a topic and a picture the room lacks (the
 *  Discord channel's topic, the server's icon), and keeps any the room has (OOYE stores Matrix-side
 *  changes as the room's own): so a row's topic or picture is written, and none is never put back
 *  over the bridge's. `bridgeSpace`: the hub while it is linked to a Discord server, whose name and
 *  picture the bridge sets from the server's own at every sync (OOYE create-space.js). */
function profileOps(c, roomId, label, entry, row, { renameOp, bridged = false, bridgeSpace = false }) {
  const ops = [];
  if (!bridgeSpace && (entry.name ?? null) !== row.name) ops.push({ op: renameOp, roomId, label, from: entry.name ?? null, to: row.name, putBack: PUT_BACK });
  if (!(bridged && norm(row.topic) === null) && norm(entry.topic) !== norm(row.topic)) ops.push({ op: "setTopic", roomId, label, topic: norm(row.topic), putBack: PUT_BACK });
  const bridgeAvatar = bridgeSpace || (bridged && norm(row.avatarMxc) === null);
  if (!bridgeAvatar && norm(entry.avatar) !== norm(row.avatarMxc)) ops.push({ op: "setAvatar", roomId, label, url: norm(row.avatarMxc), putBack: PUT_BACK });
  return ops;
}

function stateWarning(st, label) {
  if (st.state === "unreadable") return warn("cannot_read", st.id, label, `cannot read ${label}: the community's account is not in it`);
  if (st.state === "tombstoned") return warn("upgraded", st.id, label, `${label} was upgraded to a new room; run adopt to follow it`);
  if (st.state === "gone-bridged") return warn("bridged_room_gone", st.id, label, `${label} is linked to Discord and is gone; link the channel again`);
  return null;
}

/** The hub has no row yet and the service account cannot read it (not invited, or not joined):
 *  nothing can be imported or kept until it is in, so the run says so. */
function noHubAccess(c) {
  if (c.hubRow || !c.hubId) return null;
  const e = c.rooms.get(c.hubId);
  if (e && !e.unreadable) return null;
  return warn("no_hub_access", c.hubId, "the community",
    "cannot read the community's main space: the community's account is not in it, so nothing can be imported or kept. Invite it to the space and give it full power there");
}

// ── Hierarchy ──────────────────────────────────────────────────────────────────────────────────
/**
 * A space's children in a fixed order, whatever order the homeserver listed its state in: by
 * `order` (Matrix's rule: those with one first, compared as strings), then by when the link was made
 * (`ts`, its origin_server_ts), then by room id.
 */
function sortedChildren(list) {
  const key = (ch) => [typeof ch?.order === "string" ? 0 : 1, ch?.order ?? "", Number.isFinite(ch?.ts) ? ch.ts : Infinity, ch?.roomId ?? ""];
  const cmp = (a, b) => {
    const x = key(a), y = key(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
  };
  return [...list].sort(cmp);
}

/** A room one of the site's bridge accounts made (its creator): a Discord thread the bridge opened as
 *  a room of its own and put in the hub. The bridge's, not the panel's: never listed, never imported. */
function bridgeMade(c, roomId) {
  const creator = c.rooms.get(roomId)?.creators?.[0];
  return typeof creator === "string" && c.bridgeBotIds.has(creator);
}

/** Every room under the hub, depth first, parents before children (each space's in sortedChildren
 *  order); each once. */
function walk(c) {
  const out = [];
  const seen = new Set([c.hubId]);
  const visit = (parent) => {
    for (const ch of sortedChildren(childrenOf(c, parent))) {
      if (!ch?.roomId || seen.has(ch.roomId) || !(ch.via ?? []).length) continue;
      seen.add(ch.roomId);
      out.push({ roomId: ch.roomId, parentRoomId: parent, order: ch.order ?? null });
      visit(ch.roomId);
    }
  };
  if (c.hubId) visit(c.hubId);
  return out;
}

// ── The planners ───────────────────────────────────────────────────────────────────────────────
/** Spaces (the hub's profile, categories, the supporters gate) and every space ⇄ child link. */
export function planSpaces(desired, actual) {
  const c = context(desired, actual);
  if (!c.hubId) return [warn("no_hub", null, "the community", "there is no community space yet; run the community setup first")];
  const ops = [];
  const noAccess = noHubAccess(c);
  if (noAccess) ops.push(noAccess);
  for (const row of desired.spaces ?? []) {
    const st = rowState(c, "spaces", row);
    const label = spaceLabel(row, st.entry?.name ?? row.name);
    if (st.state === "create") {
      ops.push({ op: "createSpace", ref: st.id, row: { table: "spaces", id: row.id }, roomId: null, ...(st.replaces ? { replaces: st.replaces } : {}), label: spaceLabel(row), body: createBody(c, "spaces", row) });
      continue;
    }
    if (st.state !== "present") { if (row.kind !== "hub" || c.hubRow) { const w = stateWarning(st, label); if (w) ops.push(w); } continue; }
    ops.push(...profileOps(c, st.id, label, st.entry, row, { renameOp: "renameSpace", bridgeSpace: row.kind === "hub" && c.discordSpaceLinked }));
    // A feed without the field (a site older than the banner) leaves whatever the space has.
    if ("bannerMxc" in row && norm(st.entry.banner) !== norm(row.bannerMxc)) {
      ops.push({ op: "setBanner", roomId: st.id, label, url: norm(row.bannerMxc), putBack: PUT_BACK });
    }
    // The kind marker is how the client tells a gate from a category: it always applies.
    if (st.entry.spaceKind !== row.kind) ops.push({ op: "setState", roomId: st.id, label, type: SPACE_KIND, stateKey: "", content: { kind: row.kind } });
    if (row.kind === "hub") continue; // the hub's access is the bootstrap's (public, listed)
    const join = spaceJoinRule(c, row);
    if (!sameJoinRule(st.entry, join.content)) ops.push({ op: "setJoinRule", roomId: st.id, label, content: join.content, who: join.who, putBack: PUT_BACK });
    if (st.entry.history !== "shared") ops.push({ op: "setHistory", roomId: st.id, label, history: "shared", putBack: PUT_BACK });
  }

  // Where each row should be linked: categories under the hub (or their parent), rooms under their
  // space; the gate nowhere (it is hidden); archived rooms nowhere. A Discord-linked room's link is
  // the bridge's. Unknown children are never unlinked.
  const wanted = []; // {parent, pst, child, label, parentLabel, order}
  const placeOf = new Map(); // child room id → desired parent id (null = not linked)
  for (const row of desired.spaces ?? []) {
    if (row.kind === "hub") continue;
    const st = rowState(c, "spaces", row);
    if (row.kind === "gate") { placeOf.set(st.id, null); continue; }
    const p = parentOf(c, "spaces", row);
    placeOf.set(st.id, p.st.id);
    if (live(st) && live(p.st)) wanted.push({ parent: p.st.id, pst: p.st, child: st.id, label: spaceLabel(row), parentLabel: p.label, order: row.orderKey });
  }
  const bridgedIds = new Set();
  const archivedIds = new Set(); // unlinking an archived room is the archive: it always applies
  for (const row of desired.rooms ?? []) {
    const st = rowState(c, "rooms", row);
    if (row.discordChannelId && st.state !== "create") { bridgedIds.add(st.id); continue; }
    if (row.archived) { placeOf.set(st.id, null); archivedIds.add(st.id); continue; }
    const p = parentOf(c, "rooms", row);
    placeOf.set(st.id, p.st.id);
    if (live(st) && live(p.st)) wanted.push({ parent: p.st.id, pst: p.st, child: st.id, label: roomLabel(row.name), parentLabel: p.label, order: row.orderKey });
  }
  for (const w of wanted) {
    const content = { via: [c.server], order: w.order };
    const have = w.pst.state === "present" ? childrenOf(c, w.parent).find((ch) => ch.roomId === w.child) : null;
    // Linking a room this plan creates always applies; re-linking or re-ordering two rooms that
    // both exist undoes a hand-made change, so it is a put-back.
    const existing = w.pst.state === "present" && !isRef(w.child) ? { putBack: PUT_BACK } : {};
    if (!have || !(have.via ?? []).length) {
      ops.push({ op: "linkChild", roomId: w.parent, parentId: w.parent, childId: w.child, label: w.label, parentLabel: w.parentLabel, content, childParent: { via: [c.server], canonical: true }, ...existing });
    } else if (have.order !== w.order) {
      ops.push({ op: "setOrder", roomId: w.parent, parentId: w.parent, childId: w.child, label: w.label, parentLabel: w.parentLabel, content, ...existing });
    }
  }
  // Unlinks: a known row linked somewhere it should not be.
  const parents = [{ id: c.hubId, label: "the community" }];
  for (const row of desired.spaces ?? []) {
    if (row.kind === "hub") continue;
    const st = rowState(c, "spaces", row);
    if (st.state === "present") parents.push({ id: st.id, label: spaceLabel(row) });
  }
  const labelOf = new Map([
    ...(desired.spaces ?? []).filter((s) => s.matrixRoomId).map((s) => [s.matrixRoomId, spaceLabel(s)]),
    ...(desired.rooms ?? []).filter((r) => r.matrixRoomId).map((r) => [r.matrixRoomId, roomLabel(r.name)]),
  ]);
  for (const p of parents) {
    for (const ch of childrenOf(c, p.id)) {
      if (!ch?.roomId || !(ch.via ?? []).length || !placeOf.has(ch.roomId) || bridgedIds.has(ch.roomId)) continue;
      if (placeOf.get(ch.roomId) === p.id) continue;
      ops.push({ op: "unlinkChild", roomId: p.id, parentId: p.id, childId: ch.roomId, label: labelOf.get(ch.roomId) ?? ch.roomId, parentLabel: p.label, content: {}, ...(archivedIds.has(ch.roomId) ? {} : { putBack: PUT_BACK }) });
    }
  }
  // Rooms in the community that no row knows: said, never touched (adopt imports them). One the account
  // is not in is said as that (the hub's links are the only word on what is the community's: an
  // appservice cannot list its own invites, so an invite to a room outside it is never listed).
  for (const w of walk(c)) {
    if (c.known.has(w.roomId) || bridgeMade(c, w.roomId)) continue;
    if (c.rooms.get(w.roomId)?.unreadable) {
      ops.push(warn("not_joined", w.roomId, w.roomId, `${w.roomId} is linked into the community, but the community's account is not in it, so it is not kept. The account joins a room only when the community's owner or an admin of its main space linked it, and every space above it, into the community and invited the account`));
      continue;
    }
    const name = c.rooms.get(w.roomId)?.name;
    const label = name ? (c.rooms.get(w.roomId)?.type === "m.space" ? `the category ${name}` : roomLabel(name)) : w.roomId;
    ops.push(warn("not_in_panel", w.roomId, label, `${label} is in the community but not in the panel; adopt imports it`));
  }
  return ops;
}

/** Channels: create, settings (name, topic, picture, who can join, history, retention, listing), archive. */
export function planRooms(desired, actual) {
  const c = context(desired, actual);
  if (!c.hubId) return [];
  const ops = [];
  if (!c.gateRow && (desired.rooms ?? []).some((r) => r.see === "supporters" && !r.archived)) {
    ops.push(warn("no_gate", null, "the community", "there is no supporters space, so supporter channels stay invite-only"));
  }
  for (const row of desired.rooms ?? []) {
    const st = rowState(c, "rooms", row);
    const label = roomLabel(st.entry?.name ?? row.name);
    if (st.state === "create") {
      ops.push({ op: "createRoom", ref: st.id, row: { table: "rooms", id: row.id }, roomId: null, ...(st.replaces ? { replaces: st.replaces } : {}), label: roomLabel(row.name), encrypted: !!row.encrypted, body: createBody(c, "rooms", row) });
      if (row.published) ops.push({ op: "publish", roomId: st.id, label: roomLabel(row.name), visibility: "public" });
      continue;
    }
    if (st.state !== "present") { const w = stateWarning(st, label); if (w) ops.push(w); continue; }
    const entry = st.entry;
    if (row.archived) {
      // Archived: nobody below 100 can post; every other setting stays as it is.
      // (The timeouts still apply: a timed-out person is −1 here too.)
      const content = { ...withTimeouts(c, entry.powerLevels, entry).content, events_default: ARCHIVED };
      if (!same(entry.powerLevels ?? {}, content)) ops.push({ op: "archive", roomId: st.id, label, content });
      continue;
    }
    if (looksArchived(entry)) ops.push({ op: "unarchive", roomId: st.id, label, content: powerContent(c, "rooms", row, entry) });
    const bridged = !!row.discordChannelId;
    ops.push(...profileOps(c, st.id, label, entry, row, { renameOp: "rename", bridged }));
    const join = joinRuleFor(c, row);
    if (!bridged && !sameJoinRule(entry, join.content)) ops.push({ op: "setJoinRule", roomId: st.id, label, content: join.content, who: join.who, putBack: PUT_BACK });
    // A linked room's history setting is the bridge's (OOYE's privacy level; "shared" at the panel's).
    if (!bridged && entry.history !== "shared") ops.push({ op: "setHistory", roomId: st.id, label, history: "shared", putBack: PUT_BACK });
    // actual.retention: a number = max_lifetime; null = an event with no limit ({}); absent = no
    // event at all (the server's default policy would apply), which is never in step. A missing
    // event is nobody's edit, so writing one always applies; changing a value is a put-back.
    const ms = retentionMs(c, row);
    if (entry.retention === undefined || (entry.retention ?? null) !== ms) {
      ops.push({ op: "setRetention", roomId: st.id, label, content: retentionContent(ms), days: ms === null ? null : ms / DAY_MS,
        ...(entry.retention === undefined ? {} : { putBack: PUT_BACK }) });
    }
    if (!!entry.encrypted !== !!row.encrypted) {
      ops.push(warn("encryption_only_at_create", st.id, label, entry.encrypted
        ? `${label} is encrypted, and encryption cannot be switched off`
        : `${label} is not encrypted, and encryption can only be chosen when a channel is made`));
    }
    if (!!entry.published !== !!row.published) ops.push({ op: "publish", roomId: st.id, label, visibility: row.published ? "public" : "private", putBack: PUT_BACK });
  }
  return ops;
}

const BRIDGE_UNKNOWN = (label) => `bridge accounts unknown in ${label}: every existing grant is kept and nobody is removed`;
/** A grant at or above the service account's own level, which it cannot change: kept, said once per
 *  room. The ids ride along for the record (`userIds`); the sentence names the room only. */
function heldWarn(roomId, label, held) {
  return { ...warn("grant_out_of_reach", roomId, label,
    `a power grant in ${label} is above what the community account can change; it was left as it is`), userIds: held };
}

/**
 * Who can post and moderate: the full content for every existing channel and space but the hub.
 * The ladder (`users`) always applies: moderation is the reconciler's job whatever the put-back
 * switch says. Every other key (the per-event table, events_default, state_default, kick, ban,
 * redact, invite) is a room setting like its name: with put-back off a difference there is a drift
 * entry (`setPowerRules`, never carried out), and only the ladder is written.
 */
export function planPower(desired, actual) {
  const c = context(desired, actual);
  if (!c.hubId) return [];
  const ops = [];
  const check = (table, row, label) => {
    const st = rowState(c, table, row);
    if (st.state !== "present") return;
    if (table === "rooms" && (row.archived || looksArchived(st.entry))) return; // planRooms' archive / unarchive
    const { content, held, bridge } = powerFor(c, table, row, st.entry);
    if (table === "rooms" && row.discordChannelId && !c.bridgePatterns.length) ops.push(warn("bridge_accounts_unknown", st.id, label, BRIDGE_UNKNOWN(label)));
    const unlisted = unlistedBridgeWarn(c, st.id, label, st.entry);
    if (unlisted) ops.push(unlisted);
    if (bridge.hubCopies.length) {
      const who = bridge.hubCopies.sort().join(", ");
      ops.push({ ...warn("hub_grant_copied", st.id, label, `the community's main space gives ${who} power that the site's roles do not; the Discord bridge copies it into ${label} at each sync and the server takes it away again. Remove it from the main space's settings`), userIds: [...bridge.hubCopies] });
    }
    if (bridge.dropped.length) ops.push(warn("bridge_grant_dropped", st.id, label, `${bridge.dropped.join(", ")} ${bridge.dropped.length === 1 ? "is a bridge account" : "are bridge accounts"} in ${label} with a moderator's power or more; ${bridge.dropped.length === 1 ? "that grant was" : "those grants were"} not kept`));
    if (held.length) ops.push(heldWarn(st.id, label, held));
    const have = st.entry.powerLevels ?? {};
    if (same(have, content)) return;
    const ladderOnly = { ...have, users: content.users };
    if (c.putBack || same(ladderOnly, content)) { ops.push({ op: "setPowerLevels", roomId: st.id, label, content }); return; }
    if (!same(have, ladderOnly)) ops.push({ op: "setPowerLevels", roomId: st.id, label, content: ladderOnly });
    ops.push({ op: "setPowerRules", roomId: st.id, label, content, putBack: PUT_BACK });
  };
  // The hub's settings are the bootstrap's; only the timeouts are applied there.
  const hub = c.rooms.get(c.hubId);
  if (hub && !hub.unreadable && hub.powerLevels) {
    // The Discord bridge's bot at 100 in the hub: its link-space call refuses a space where it is below.
    const hubPower = c.discordBot ? { ...hub.powerLevels, users: { ...(hub.powerLevels.users ?? {}), [c.discordBot]: 100 } } : hub.powerLevels;
    const { content, held } = withTimeouts(c, hubPower, hub);
    if (held.some((u) => c.timedOut.has(u))) ops.push(heldWarn(c.hubId, "the community", held));
    const unlisted = unlistedBridgeWarn(c, c.hubId, "the community", hub);
    if (unlisted) ops.push(unlisted);
    if (!same(hub.powerLevels, content)) ops.push({ op: "setPowerLevels", roomId: c.hubId, label: "the community", content });
  }
  for (const row of desired.spaces ?? []) if (row.kind !== "hub") check("spaces", row, spaceLabel(row));
  for (const row of desired.rooms ?? []) check("rooms", row, roomLabel(row.name));
  return ops;
}

/**
 * Who is in which room. Supporters (and everyone on the ladder at 10 or more) into the gate and every
 * supporter channel; out when they lapse (the feed's list already allows the billing grace). "Mods and
 * above" / "Staff and above": everyone at that level or more in `people` — bots too (they sit at 50
 * and the ladder cannot tell them from mods: controller ruling, 2026-10-23); out when they lose it.
 * Rungs are read from `people` only: a timed-out person must stay in `people` at their level (Task
 * 1.3's feed since fix round 2), and is then −1 in planPower but keeps their rooms; someone missing
 * from `people` has lost the rung, timed out or not. "Invited people only" and "Everyone": no
 * automatic invites or removals. Never removed: the hidden accounts (the service account, the forum
 * reader) and a room's creators.
 *
 * One of the site's bridge accounts (the feed's bridgeBots: an admin setting) is never removed or
 * reported, in any room, unless the site knows it otherwise (bridgeBotsOf: on the ladder, hidden, or
 * banned: a site ban always wins). A room's own bridge state is a hint only (bridge_account_unlisted).
 *
 * Discord-linked rooms: members matching one of the feed's `bridgeUserPatterns` (whole-id regex sources, anchored here; the
 * bridge's own accounts) are never touched; everyone else is handled as anywhere. With no patterns
 * (or none valid) the core cannot tell the two apart, so a linked room gets no removals and a warn.
 *
 * Site bans: a ban in every community room (the hub, its spaces, every channel), its reason the feed's
 * `siteBanReason` (web siteBanReason.ts, the one source). A room ban is the SITE's when its reason IS
 * that marker, exactly (`actual` room `banReasons`): it is lifted as soon as its user is not in
 * `banned` (the site ban ended, or became a timeout, which is −1 in planPower). Site state, so it
 * always applies. Any other ban (no reason, or a mod's reason, even one beginning with the marker's
 * words) is a mod's own: never touched, reported as a drift entry `{ kind: "ban", roomId, userId,
 * label }` (not an op). A
 * feed with no marker (a site older than this): no ban or unban at all, and one warn; reconcile.mjs
 * refuses to apply such a feed.
 */
export function planMembership(desired, actual) {
  const c = context(desired, actual);
  if (!c.hubId) return [];
  const ops = [];
  const hidden = new Set([c.service, ...(desired.hiddenUserIds ?? [])]);
  // A bridge bot the room names (its bridge state) is the bridge's, in any room: never removed or banned.
  const exempt = (u, entry) => hidden.has(u) || (entry?.creators ?? []).includes(u) || bridgeBotsOf(c, entry).includes(u);
  const byUser = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);
  const marker = typeof desired.siteBanReason === "string" && desired.siteBanReason ? desired.siteBanReason : null;
  if (!marker) ops.push(warn("site_ban_reason_unknown", null, "the community", "the site did not say how its room bans are marked, so no room ban was placed or lifted"));
  // Exactly the marker: the core writes exactly it, and the browser sync (web siteBanSync.ts) compares with ===.
  const bySite = (entry, u) => marker !== null && asMap(entry?.banReasons).get(u) === marker;
  const patterns = c.bridgePatterns;
  const isBridge = (u) => isBridgeAccount(c, u);
  const supporterSet = new Set([...c.supporters, ...[...c.people].filter(([, l]) => l >= SUPPORTER).map(([u]) => u)]);
  const rungSet = (level) => new Set([...c.people].filter(([, l]) => l >= level).map(([u]) => u));
  const sync = (st, label, entitled, reason, { linked = false } = {}) => {
    const members = membersOf(st.entry);
    for (const u of [...entitled].sort()) if (!c.banned.has(u) && !isIn(members.get(u))) ops.push({ op: "invite", roomId: st.id, label, userId: u });
    if (linked && !patterns.length) {
      ops.push(warn("bridge_accounts_unknown", st.id, label, BRIDGE_UNKNOWN(label)));
      return;
    }
    for (const [u, m] of [...members].sort(byUser)) {
      if (!isIn(m) || entitled.has(u) || exempt(u, st.entry) || (linked && isBridge(u))) continue;
      ops.push({ op: "kick", roomId: st.id, label, userId: u, reason });
    }
  };
  const bans = (st, label, { linked = false } = {}) => {
    const members = membersOf(st.entry);
    if (marker) for (const u of [...c.banned].sort()) if (members.get(u) !== "ban" && !exempt(u, st.entry)) ops.push({ op: "ban", roomId: st.id, label, userId: u, reason: marker });
    for (const [u, m] of [...members].sort(byUser)) {
      if (m !== "ban" || c.banned.has(u)) continue;
      if (bySite(st.entry, u)) ops.push({ op: "unban", roomId: st.id, label, userId: u });
      else if (!(linked && isBridge(u)) && !bridgeBotsOf(c, st.entry).includes(u)) ops.push({ kind: "ban", roomId: st.id, userId: u, label });
    }
  };

  // The Discord bridge's bot goes where it links: the hub (its space) and every room linked to Discord.
  const seat = (st, label) => {
    if (c.discordBot && !isIn(membersOf(st.entry).get(c.discordBot))) ops.push({ op: "invite", roomId: st.id, label, userId: c.discordBot });
  };
  if (c.rooms.get(c.hubId) && !c.rooms.get(c.hubId).unreadable) {
    seat({ id: c.hubId, entry: c.rooms.get(c.hubId) }, "the community");
    bans({ id: c.hubId, entry: c.rooms.get(c.hubId) }, "the community");
  }
  for (const row of desired.spaces ?? []) {
    if (row.kind === "hub") continue;
    const st = rowState(c, "spaces", row);
    if (!live(st)) continue;
    if (row.kind === "gate") sync(st, spaceLabel(row), supporterSet, "supporter access ended");
    bans(st, spaceLabel(row));
  }
  for (const row of desired.rooms ?? []) {
    const st = rowState(c, "rooms", row);
    if (!live(st)) continue;
    const label = roomLabel(row.name);
    const linked = !!row.discordChannelId;
    if (linked && !row.archived) seat(st, label);
    if (!row.archived) {
      if (row.see === "supporters") sync(st, label, supporterSet, "supporter access ended", { linked });
      else if (SEE_RUNG[row.see]) sync(st, label, rungSet(SEE_RUNG[row.see]), row.see === "mods" ? "no longer a mod" : "no longer staff", { linked });
    }
    bans(st, label, { linked });
  }
  return ops;
}

// ── Adopt ──────────────────────────────────────────────────────────────────────────────────────
function seeFrom(c, entry) {
  const rule = entry.joinRule ?? null;
  if (rule === "public") return "everyone";
  if (rule === "restricted" || rule === "knock_restricted") {
    const ids = (entry.allow ?? []).map((a) => a?.room_id);
    if (ids.includes(c.hubId)) return "everyone";
    if (c.gateRow?.matrixRoomId && ids.includes(c.gateRow.matrixRoomId)) return "supporters";
  }
  return "invited"; // never wider than the room is
}
function postFrom(entry) {
  const ed = Number(entry.powerLevels?.events_default ?? 0);
  if (ed >= POST_LEVEL.staff) return "staff";
  if (ed >= POST_LEVEL.mods) return "mods";
  if (ed >= POST_LEVEL.supporters) return "supporters";
  return "everyone";
}

function planAdopt(c) {
  const ops = [];
  const drift = [];
  const noAccess = noHubAccess(c);
  if (noAccess) drift.push(noAccess);
  if (!c.hubRow && c.hubId && c.rooms.get(c.hubId) && !c.rooms.get(c.hubId).unreadable) {
    const e = c.rooms.get(c.hubId);
    ops.push({ op: "adoptRow", table: "spaces", roomId: c.hubId, matrixRoomId: c.hubId, parentRoomId: null, label: "the community",
      row: { kind: "hub", name: e.name ?? "", topic: norm(e.topic), avatarMxc: norm(e.avatar), orderKey: null, matrixRoomId: c.hubId, gateTier: null } });
  }
  for (const w of walk(c)) {
    if (c.known.has(w.roomId) || bridgeMade(c, w.roomId)) continue;
    const e = c.rooms.get(w.roomId);
    if (!e || e.unreadable) { drift.push(warn("cannot_read", w.roomId, w.roomId, `cannot read ${w.roomId}: the community's account is not in it, so it cannot be imported`)); continue; }
    const base = { op: "adoptRow", roomId: w.roomId, matrixRoomId: w.roomId, parentRoomId: w.parentRoomId };
    if (e.type === "m.space") {
      ops.push({ ...base, table: "spaces", label: `the category ${e.name ?? w.roomId}`,
        row: { kind: "category", name: e.name ?? "", topic: norm(e.topic), avatarMxc: norm(e.avatar), orderKey: w.order, matrixRoomId: w.roomId, gateTier: null } });
    } else {
      ops.push({ ...base, table: "rooms", label: roomLabel(e.name ?? w.roomId),
        row: {
          kind: e.forum ? "forum" : "text", name: e.name ?? "", topic: norm(e.topic), avatarMxc: norm(e.avatar), orderKey: w.order,
          see: seeFrom(c, e), post: postFrom(e),
          retentionDays: e.retention ? Math.max(1, Math.round(e.retention / DAY_MS)) : null,
          encrypted: !!e.encrypted, published: !!e.published, archived: looksArchived(e),
          matrixRoomId: w.roomId, discordChannelId: null,
        } });
    }
  }
  // A row whose room was upgraded follows the tombstone to the newest room in the chain.
  const follow = (table, row, label) => {
    let id = row.matrixRoomId;
    const seen = new Set([id]);
    for (let e = c.rooms.get(id); e?.tombstone?.replacement_room && !seen.has(e.tombstone.replacement_room); e = c.rooms.get(id)) {
      id = e.tombstone.replacement_room;
      seen.add(id);
    }
    if (id !== row.matrixRoomId) ops.push({ op: "followTombstone", table, rowId: row.id, roomId: row.matrixRoomId, to: id, label });
  };
  for (const row of c.desired.spaces ?? []) if (row.matrixRoomId && row.kind !== "hub") follow("spaces", row, spaceLabel(row));
  for (const row of c.desired.rooms ?? []) if (row.matrixRoomId) follow("rooms", row, roomLabel(row.name));
  return { ops, drift };
}

/**
 * The whole plan for one run.
 *   report — performs nothing: `ops` is empty and `drift` lists everything apply would do.
 *   adopt  — only adoptRow (rooms and spaces in the hub no row knows, as they are) and
 *            followTombstone ops: database writes, never a homeserver write.
 *   apply  — everything, creates first (spaces, then rooms) so later ops can name them. With
 *            put-back off, changes that would undo a hand-made edit to an existing room (its name,
 *            topic, picture, who can join, history, retention, listing, its place or order in a
 *            space, and every power-level setting but the ladder: setPowerRules) are `drift`,
 *            not ops. Creates, archives, the ladder (`users`) and the membership it implies
 *            always apply.
 * Returns { mode, ops, drift }.
 */
export function planAll(desired, actual, { mode } = {}) {
  if (!MODES.includes(mode)) throw new Error(`unknown mode: ${mode} (report, adopt or apply)`);
  const c = context(desired, actual);
  if (mode === "adopt") return { mode, ...planAdopt(c) };
  const all = [...planSpaces(desired, actual), ...planRooms(desired, actual), ...planPower(desired, actual), ...planMembership(desired, actual)]
    .map((op, i) => ({ op, i }))
    .sort((a, b) => (PHASE[a.op.op] ?? 2) - (PHASE[b.op.op] ?? 2) || a.i - b.i)
    .map(({ op }) => op);
  const ops = [];
  const drift = [];
  const warned = new Set(); // one warn per code and room (planPower and planMembership can both say one)
  for (const op of all) {
    if (op.op === "warn") {
      const key = `${op.code}\u0000${op.roomId}`;
      if (warned.has(key)) continue;
      warned.add(key);
    }
    (!op.op || (op.putBack && !c.putBack) ? drift : ops).push(op);
  }
  if (mode === "report") return { mode, ops: [], drift: [...ops, ...drift] };
  return { mode, ops, drift };
}

// ── Plain words for the panel ──────────────────────────────────────────────────────────────────
/** One plain sentence per op ("rename #general to #lobby"). */
export function describe(op) {
  switch (op.op) {
    case "createSpace": return `create ${op.label}`;
    case "createRoom": return `create ${op.label}${op.replaces ? " again (the old room is gone)" : ""}${op.encrypted ? ", encrypted" : ""}`;
    case "renameSpace": return `rename ${op.label} to ${op.to}`;
    case "rename": return `rename #${op.from ?? "(no name)"} to #${op.to}`;
    case "setTopic": return op.topic ? `set the topic of ${op.label} to "${op.topic}"` : `clear the topic of ${op.label}`;
    case "setAvatar": return op.url ? `change the picture of ${op.label}` : `remove the picture of ${op.label}`;
    case "setBanner": return op.url ? `change the banner of ${op.label}` : `remove the banner of ${op.label}`;
    case "setJoinRule": return `change who can join ${op.label}: ${op.who}`;
    case "setHistory": return `let members of ${op.label} read messages from before they joined`;
    case "setRetention": return op.days === null ? `keep messages in ${op.label} forever` : `keep messages in ${op.label} for ${op.days} days`;
    case "publish": return op.visibility === "public" ? `list ${op.label} in the public room directory` : `take ${op.label} out of the public room directory`;
    case "archive": return `archive ${op.label}: nobody can post in it any more`;
    case "unarchive": return `bring ${op.label} back from the archive`;
    case "setPowerLevels": return `update who can post and moderate in ${op.label}`;
    case "setPowerRules": return `change what each rung may do in ${op.label}`;
    case "linkChild": return `put ${op.label} in ${op.parentLabel}`;
    case "unlinkChild": return `take ${op.label} out of ${op.parentLabel}`;
    case "setOrder": return `move ${op.label} to its place in ${op.parentLabel}`;
    case "invite": return `invite ${op.userId} to ${op.label}`;
    case "kick": return `remove ${op.userId} from ${op.label} (${op.reason})`;
    case "ban": return `ban ${op.userId} from ${op.label}`;
    case "unban": return `lift the ban on ${op.userId} in ${op.label}`;
    case "setState":
      if (op.type === SPACE_KIND) return `mark ${op.label} so apps know it is ${KIND_WORDS[op.content?.kind] ?? "a space"}`;
      return `update a setting of ${op.label}`;
    case "warn": return op.message;
    case undefined:
      if (op.kind === "ban") return `${op.userId} is banned from ${op.label}, but not by the site: left as it is`;
      throw new Error(`no description for ${JSON.stringify(op)}`);
    case "adoptRow": return `import ${op.label} into the panel`;
    case "followTombstone": return `follow ${op.label} to its upgraded room`;
    default: throw new Error(`no description for op ${op.op}`);
  }
}
