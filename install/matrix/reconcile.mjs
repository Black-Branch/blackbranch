// The community reconciler: what the Admin Panel wants (the site's desired-state feed) against what
// the homeserver holds, planned by reconcile-core.mjs and carried out here. The host runs it in a
// one-shot container (`blackbranch community reconcile`, unit blackbranch-community@<mode>.service).
//
//   node reconcile.mjs --mode report|adopt|apply [--web <url>] [--base <homeserver>] [--once]
//
//   report  reads both sides and lists what apply would do. Changes nothing.
//   adopt   sends the rooms and spaces in the community that no row knows to the site, as rows
//           (and follows upgraded rooms). Never writes to the homeserver.
//   apply   makes the homeserver match the panel. On a fresh install (no hub row yet) it first does
//           what adopt does, reads the feed again and goes on ("first run: adopted the hub").
//   --once  one pass, then exit: what it always does (accepted so a caller can say so).
//
// Input: the service account's token on stdin (never on the command line; never printed).
// Environment:
//   COMMUNITY_WEB_BASE  the site (default http://web:3000); --web wins
//   STREAM_API_SECRET   the internal secret the site's feed and run log answer to (required)
//   MX_BASE             the homeserver (default http://synapse:8008); --base wins
//   MX_SERVER_NAME      this install's Matrix server name; the feed must name the same one
//   MX_AS_USER          the account the token must be (an appservice's own sender). The token
//                       acts as itself: no op names another sender, so no request carries user_id.
// Output: one JSON line on stdout, {mode, ok, drift, applied, error} (each entry with its sentence as
//         `said`); one line per op on stderr.
// Exit: 0 done; 1 report found something to change, or apply finished with ops the homeserver refused
//       (each listed in drift as an `op_failed` warn); 2 failed (bad usage, no token, the site or the
//       homeserver did not answer, the token is not the community's account, or the run log could not
//       be written); 75 refused because the site is still being set up (`refused: "setup_pending"`:
//       nothing read or written, no run row; the host counts it neither a failure nor an outcome).
//
// What it reads of each room is reconcile-core.mjs's `actual` entry; a ban's reason goes beside the
// members, in `banReasons` (Map<userId, reason>): the core lifts a room ban only when that reason IS
// the site's marker (the feed's siteBanReason) and the site ban has ended. The bridge bots a room's
// bridge state names (m.bridge, uk.half-shot.bridge, any sender) go in `bridgeHints`: a hint only.
// What the core trusts as a bridge's account comes from the site's settings (the feed's bridgeBots).
// apply refuses a feed with no marker (exit 2, nothing written); report warns.
//
// While it reads, every run (report too) joins the community's rooms it is not in yet: the setup's
// bootstrap invites it into the rooms the streamer made (the hub, #general, #forum) and grants it 100
// there, and it cannot read a room it has not joined. Joined: the hub, a room a row names, or a room
// the hub's creator or someone at 100 in the hub linked into the hub or into one of the community's
// own spaces under it, at any depth. A room linked into the community that it is not in is said
// (not_joined, from the hub's links). Any other invite is left pending; only an
// account whose own sync works (a plain token; never an appservice's sender) lists it (invite_ignored).
//
// Every run is also posted to the site's run log (POST /api/internal/community/runs). A room this
// run makes is recorded on its row at once (POST /api/internal/community/made), before anything else
// is done with it, so the next run never makes it twice. An op the homeserver refuses fails that room
// only: the rest of that room's ops are skipped (and every op that names a room it was making), the
// other rooms go on, and the run ends not ok. The next run plans again from what the homeserver then
// holds. A homeserver that does not answer at all, or a site write that fails, stops the run.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeClient, HomeserverError } from "./homeserver.mjs";
import { planAll, describe } from "./reconcile-core.mjs";

const USAGE = "usage: node reconcile.mjs --mode report|adopt|apply [--web <url>] [--base <homeserver>] [--once]";
const MODES = ["report", "adopt", "apply"];
const SITE = "/api/internal/community";
const SITE_TIMEOUT_MS = 30_000;
const SITE_TRIES = 3;
/** A homeserver 429: at most this many waits per request, each at most this long. */
const HS_RETRIES = 3;
const HS_MAX_WAIT_MS = 30_000;
/** Rooms read in one run at most: a community this size is already far past what the panel shows. */
const MAX_ROOMS = 2000;
const FORUM_FLAG = "app.blackbranch.room_type";
const SPACE_KIND = "app.blackbranch.space_kind";
// A space's banner (reconcile-core.mjs BANNER): { url: mxc }.
const BANNER = "app.blackbranch.banner";
const ROOM_ID = /^![^\s/?#]+$/;
// A bridge's own state events (MSC2346 and its older name); each names its bot in `bridgebot`.
const BRIDGE_EVENTS = ["m.bridge", "uk.half-shot.bridge"];
// A sync that returns only the invites: no timeline, state, presence or account data.
const INVITES_FILTER = JSON.stringify({
  presence: { types: [] }, account_data: { types: [] },
  room: { timeline: { limit: 0, types: [] }, state: { types: [] }, ephemeral: { types: [] }, account_data: { types: [] } },
});

class Fatal extends Error {}
// Until setup finishes the site answers every API 503 with these words (web/proxy.ts): the site is
// waiting, not failing, so a run then is refused (exit 75, as busy), never a failure or an alert.
const SETUP_PENDING = "this site is being set up";
class SetupPending extends Error {}
const SETUP_PENDING_EXIT = 75;
const enc = encodeURIComponent;
/** The run's own secrets (the token, the site's secret), cut out of anything it writes. */
const SECRETS = [];
/** Text with every secret and anything token-shaped replaced: a homeserver's answer can quote a
 *  request back (a token in a query, an Authorization header), and run rows reach the panel. */
function redact(text) {
  let t = String(text);
  for (const s of SECRETS) if (s) t = t.split(s).join("[secret]");
  return t
    .replace(/Bearer\s+[^\s"',;]+/gi, "Bearer [secret]")
    .replace(/(access_token|token|secret|password)(["']?\s*[=:]\s*["']?)[^\s"'&,;}]+/gi, "$1$2[secret]")
    .replace(/\b(syt|mct|mat|mas|mau|sk|ghp|xox[bp])_[A-Za-z0-9_-]{6,}/g, "[secret]");
}
/** `v` with every string redacted, at any depth. */
function scrub(v) {
  if (typeof v === "string") return redact(v);
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]));
  return v;
}
const say = (line) => process.stderr.write(`${redact(line)}\n`);
const message = (e) => (e instanceof Error ? e.message : String(e));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = { mode: null, web: null, base: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--once") continue;
    if (a === "--mode" || a === "--web" || a === "--base") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Fatal(`${a} needs a value. ${USAGE}`);
      out[a.slice(2)] = v;
      continue;
    }
    throw new Fatal(`unknown argument ${a}. ${USAGE}`);
  }
  if (!MODES.includes(out.mode)) throw new Fatal(USAGE);
  return out;
}

async function readToken() {
  let s = "";
  for await (const c of process.stdin) s += c;
  return s.split("\n")[0].trim();
}

// ── The site ────────────────────────────────────────────────────────────────────────────────────
function siteClient(base, secret) {
  const root = base.replace(/\/+$/, "");
  async function once(method, path, body) {
    const res = await fetch(`${root}${SITE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${secret}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(SITE_TIMEOUT_MS),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON: the status says enough */ }
    return { status: res.status, json, text };
  }
  /** A request; a network failure or a 5xx is tried again (three tries). Throws with `what` in front. */
  async function must(what, method, path, body) {
    let last = "";
    for (let attempt = 1; attempt <= SITE_TRIES; attempt++) {
      try {
        const r = await once(method, path, body);
        if (r.status >= 200 && r.status < 300) return r.json;
        if (r.status === 503 && r.json?.error === SETUP_PENDING) throw new SetupPending(`${what}: the site is still being set up`);
        last = `${r.status} ${r.text.slice(0, 200)}`;
        if (r.status < 500) break;
      } catch (e) {
        if (e instanceof SetupPending) throw e;
        last = message(e);
      }
      if (attempt < SITE_TRIES) await sleep(500 * attempt);
    }
    throw new Error(`${what}: ${last}`);
  }
  return { must };
}

function checkFeed(feed) {
  if (!feed || typeof feed !== "object" || typeof feed.serverName !== "string" || typeof feed.serviceUserId !== "string"
    || !Array.isArray(feed.spaces) || !Array.isArray(feed.rooms)) {
    throw new Fatal("the site's community feed is not in the expected shape");
  }
  return feed;
}

// ── What the homeserver holds ───────────────────────────────────────────────────────────────────
/** One room as the core reads it; null when the homeserver says there is no such room; {unreadable}
 *  when the account may not read it or is not in it (creators empty, so the core never reads
 *  undefined). Any other refusal of the state, or of a readable room's listing, fails the run: a
 *  guess there could make a room twice, or list one that is not listed.
 *  Synapse answers a room it does not hold (purged, or never there) with 403 "not in room", the same
 *  as a room that exists without us, so a 403 asks the room directory: only its 404 M_NOT_FOUND (the
 *  server does not hold the room at all) means gone; any other answer there, a 5xx or 429 included,
 *  leaves the room unreadable, which is warned about and never remade (both read on Synapse 1.162).
 *  @test-only exported for reconcile.test.mjs; the command reaches it through readActual */
export async function readRoom(hs, roomId, me) {
  const UNREADABLE = { unreadable: true, creators: [] };
  const r = await hs.request("GET", `/rooms/${enc(roomId)}/state`);
  if (r.status === 404 && r.json?.errcode === "M_NOT_FOUND") return null;
  if (r.status === 403) {
    const dir = await hs.request("GET", `/directory/list/room/${enc(roomId)}`);
    return dir.status === 404 && dir.json?.errcode === "M_NOT_FOUND" ? null : UNREADABLE;
  }
  if (r.status < 200 || r.status > 299 || !Array.isArray(r.json)) {
    throw new HomeserverError(r.status, r.json?.errcode ?? null, r.text, `read ${roomId}: ${r.status} ${r.text.slice(0, 200)}`);
  }
  const byKey = new Map();
  for (const e of r.json) if (e && typeof e.type === "string" && typeof e.state_key === "string") byKey.set(`${e.type}\u0000${e.state_key}`, e);
  const content = (type, key = "") => byKey.get(`${type}\u0000${key}`)?.content ?? null;
  const members = new Map();
  // The reason on each ban: the core tells the site's own room bans (its marker) from a mod's.
  const banReasons = new Map();
  const children = [];
  for (const e of byKey.values()) {
    if (e.type === "m.room.member" && typeof e.content?.membership === "string") {
      members.set(e.state_key, e.content.membership);
      if (e.content.membership === "ban" && typeof e.content.reason === "string") banReasons.set(e.state_key, e.content.reason);
    }
    if (e.type === "m.space.child") {
      children.push({ roomId: e.state_key, order: typeof e.content?.order === "string" ? e.content.order : null, via: Array.isArray(e.content?.via) ? e.content.via : [],
        by: typeof e.sender === "string" ? e.sender : null, ts: Number.isFinite(e.origin_server_ts) ? e.origin_server_ts : null });
    }
  }
  // State kept from before the account left is old: a room it is not in is not read.
  if (members.get(me) !== "join") return UNREADABLE;
  const create = byKey.get("m.room.create\u0000");
  const creators = [create?.sender, ...(Array.isArray(create?.content?.additional_creators) ? create.content.additional_creators : [])]
    .filter((x) => typeof x === "string");
  const join = content("m.room.join_rules");
  const tomb = content("m.room.tombstone");
  const power = content("m.room.power_levels") ?? {};
  // Who the room's bridge state says bridges it. Anyone with state power can write one, so it grants
  // nothing: the core only says so when the id is not among the site's bridge accounts.
  const bridgeHints = [];
  for (const e of byKey.values()) {
    if (!BRIDGE_EVENTS.includes(e.type)) continue;
    const bot = e.content?.bridgebot;
    if (typeof bot === "string" && /^@[^\s:]+:[^\s]+$/.test(bot) && !bridgeHints.includes(bot)) bridgeHints.push(bot);
  }
  const dir = await hs.request("GET", `/directory/list/room/${enc(roomId)}`);
  if (dir.status !== 200 || (dir.json?.visibility !== "public" && dir.json?.visibility !== "private")) {
    throw new HomeserverError(dir.status, dir.json?.errcode ?? null, dir.text, `read the listing of ${roomId}: ${dir.status} ${dir.text.slice(0, 200)}`);
  }
  return {
    name: content("m.room.name")?.name ?? null,
    topic: content("m.room.topic")?.topic ?? null,
    avatar: content("m.room.avatar")?.url ?? null,
    banner: content(BANNER)?.url ?? null,
    joinRule: join?.join_rule ?? null,
    allow: Array.isArray(join?.allow) ? join.allow : [],
    // Matrix's default when a room has none.
    history: content("m.room.history_visibility")?.history_visibility ?? "shared",
    // A number: the event's limit. null: an event with no limit ({}: forever). undefined: no event, so the
    // homeserver's own default applies, which the core counts as out of step.
    retention: !byKey.has("m.room.retention\u0000") ? undefined
      : typeof content("m.room.retention")?.max_lifetime === "number" ? content("m.room.retention").max_lifetime : null,
    encrypted: typeof content("m.room.encryption")?.algorithm === "string",
    published: dir.json.visibility === "public",
    powerLevels: power,
    members,
    banReasons,
    tombstone: typeof tomb?.replacement_room === "string" ? tomb : null,
    creators,
    type: create?.content?.type ?? null,
    // What kind of space it is (hub, category, gate): the marker event, else what the create said.
    spaceKind: content(SPACE_KIND)?.kind ?? create?.content?.[SPACE_KIND] ?? null,
    children,
    forum: content(FORUM_FLAG)?.type === "forum",
    bridgeHints: bridgeHints.sort(),
  };
}

/** The rooms the account is invited to and has not joined (a sync filtered down to them), each with
 *  who invited it, for the run's notes only. Synapse refuses /sync to an appservice's own sender (500,
 *  NotImplementedError: the bundle's account), so this is best effort: none known then, said nowhere. */
async function pendingInvites(hs, me) {
  const r = await hs.request("GET", "/sync", undefined, { filter: INVITES_FILTER, timeout: 0 });
  if (r.status < 200 || r.status > 299) return new Map();
  const out = new Map();
  for (const [rid, room] of Object.entries(r.json?.rooms?.invite ?? {})) {
    const events = Array.isArray(room?.invite_state?.events) ? room.invite_state.events : [];
    const mine = events.find((e) => e?.type === "m.room.member" && e.state_key === me && e.content?.membership === "invite");
    out.set(rid, typeof mine?.sender === "string" ? mine.sender : null);
  }
  return out;
}

/**
 * Whether a room is the community's own: the configured hub, a room a row already names (`known`), or
 * a room linked into a space that is itself the community's (`link.parent` in `ours`: read, since an
 * unreadable room gives no links) by the hub's creator or someone at 100 in the HUB (`link.by`: the
 * hub vouches for it), whichever of the community's spaces the link lives in and however deep. Never
 * a room reached through a tombstone, through a space nobody vouched for, or on an invite alone:
 * anyone who can invite the account could otherwise pull it into a room it would then read and write.
 * (The invite's own sender cannot be read: Synapse refuses /sync to an appservice's sender.)
 */
function acceptable(rid, link, { hubId, known, hub, ours }) {
  if (rid === hubId || known.has(rid)) return true;
  if (!link?.parent || !ours.has(link.parent) || !hub || hub.unreadable || typeof link.by !== "string") return false;
  const lv = hub.powerLevels?.users?.[link.by];
  return (hub.creators ?? []).includes(link.by) || (typeof lv === "number" && lv >= 100);
}

/** The hub, every room a row names, everything linked under them, and every room an upgrade led to.
 *  A room the account cannot read is joined first, then read, when it is the community's
 *  (acceptable): the join works when the owner invited the account (or the room lets it in). Each
 *  link walked carries the space it lives in and who sent it. A pending invite to a room outside the
 *  community's links, when the homeserver lists it, is left as it is and said (`notes`:
 *  invite_ignored); one inside them is the core's not_joined instead. */
async function readActual(hs, feed, me) {
  const invites = await pendingInvites(hs, me);
  const hubId = feed.hubRoomId ?? feed.spaces.find((s) => s.kind === "hub")?.matrixRoomId ?? null;
  const known = new Set([...feed.spaces.map((s) => s.matrixRoomId), ...feed.rooms.map((r) => r.matrixRoomId)].filter(Boolean));
  const queue = [hubId, ...known].filter(Boolean).map((rid) => ({ rid, link: null }));
  // Every room looked at → whether it is the community's own (acceptable). Only a readable one of
  // those (`ours`) vouches for what it links. One met first through a link nobody vouched for is
  // looked at once more when a vouched link reaches it later in the walk.
  const seen = new Map();
  const ours = new Set();
  const rooms = new Map();
  while (queue.length) {
    const { rid, link } = queue.shift();
    if (typeof rid !== "string" || !ROOM_ID.test(rid)) continue;
    const accept = acceptable(rid, link, { hubId, known, hub: rooms.get(hubId), ours });
    if (seen.has(rid) && (seen.get(rid) || !accept)) continue;
    if (!seen.has(rid) && seen.size >= MAX_ROOMS) throw new Fatal(`the community has more than ${MAX_ROOMS} rooms; nothing was changed`);
    seen.set(rid, accept);
    const prior = rooms.get(rid); // looked at once more: a room already read is not read again
    let entry = prior && !prior.unreadable ? prior : await readRoom(hs, rid, me);
    if (accept && entry?.unreadable) {
      invites.delete(rid);
      const j = await hs.request("POST", `/join/${enc(rid)}`, {});
      if (j.status >= 200 && j.status < 300) { say(`joined ${rid}: the community's account was let in`); entry = await readRoom(hs, rid, me); }
    }
    if (!entry) continue;
    rooms.set(rid, entry);
    if (entry.unreadable) continue;
    if (accept) ours.add(rid);
    for (const ch of entry.children) {
      // A removed link (content emptied, no via) is still an event its remover sent: it is read like any
      // room, but it vouches for nothing (an admin taking a room out is never them linking it).
      const linked = Array.isArray(ch.via) && ch.via.length > 0;
      queue.push({ rid: ch.roomId, link: linked ? { parent: rid, by: ch.by ?? null } : null });
      // Linked into the community: one not joined is the core's not_joined, never also an invite here.
      if (linked) invites.delete(ch.roomId);
    }
    if (entry.tombstone) queue.push({ rid: entry.tombstone.replacement_room, link: null });
  }
  const notes = [...invites].sort(([a], [b]) => (a < b ? -1 : 1)).map(([rid, inviter]) => ({
    op: "warn", code: "invite_ignored", roomId: rid, label: rid, inviter,
    message: `an invite to ${rid}${inviter ? ` from ${inviter}` : ""} was left as it is: it is not one of the community's rooms`,
  }));
  return { hub: hubId ? { roomId: hubId, children: rooms.get(hubId)?.children ?? [] } : null, rooms, notes };
}

// ── Carrying out the plan ───────────────────────────────────────────────────────────────────────
/** `v` with every string that is a made room's placeholder replaced by its id, at any depth. */
function substitute(v, refs) {
  if (typeof v === "string") return refs.get(v) ?? v;
  if (Array.isArray(v)) return v.map((x) => substitute(x, refs));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, refs)]));
  return v;
}

const statePath = (roomId, type, key = "") => `/rooms/${enc(roomId)}/state/${enc(type)}${key ? `/${enc(key)}` : ""}`;

/** One homeserver op; returns the op as done (a create carries the room id it got). */
async function perform(hs, op) {
  const what = describe(op);
  const putState = (roomId, type, content, key = "") => hs.must(what, hs.call("PUT", statePath(roomId, type, key), content));
  switch (op.op) {
    case "createSpace":
    case "createRoom": {
      const j = await hs.must(what, hs.call("POST", "/createRoom", op.body));
      if (typeof j?.room_id !== "string" || !ROOM_ID.test(j.room_id)) throw new Error(`${what}: the homeserver gave no room id`);
      return { ...op, roomId: j.room_id };
    }
    case "renameSpace":
    case "rename": await putState(op.roomId, "m.room.name", { name: op.to }); break;
    case "setTopic": await putState(op.roomId, "m.room.topic", { topic: op.topic ?? "" }); break;
    case "setAvatar": await putState(op.roomId, "m.room.avatar", op.url ? { url: op.url } : {}); break;
    case "setBanner": await putState(op.roomId, BANNER, op.url ? { url: op.url } : {}); break;
    case "setJoinRule": await putState(op.roomId, "m.room.join_rules", op.content); break;
    case "setHistory": await putState(op.roomId, "m.room.history_visibility", { history_visibility: op.history }); break;
    case "setRetention": await putState(op.roomId, "m.room.retention", op.content); break;
    case "publish": await hs.must(what, hs.call("PUT", `/directory/list/room/${enc(op.roomId)}`, { visibility: op.visibility })); break;
    case "archive":
    case "unarchive":
    case "setPowerLevels":
    case "setPowerRules": await putState(op.roomId, "m.room.power_levels", op.content); break;
    case "linkChild":
      await putState(op.parentId, "m.space.child", op.content, op.childId);
      await putState(op.childId, "m.space.parent", op.childParent, op.parentId);
      break;
    case "setOrder":
    case "unlinkChild": await putState(op.parentId, "m.space.child", op.content, op.childId); break;
    case "invite": await hs.must(what, hs.call("POST", `/rooms/${enc(op.roomId)}/invite`, { user_id: op.userId })); break;
    case "kick":
    case "ban": await hs.must(what, hs.call("POST", `/rooms/${enc(op.roomId)}/${op.op}`, { user_id: op.userId, reason: op.reason })); break;
    case "unban": await hs.must(what, hs.call("POST", `/rooms/${enc(op.roomId)}/unban`, { user_id: op.userId })); break;
    case "setState": await putState(op.roomId, op.type, op.content, op.stateKey ?? ""); break;
    default: throw new Error(`${what}: this command does not know how to do "${op.op}"`);
  }
  return op;
}

/** Every room an op writes to (a link writes to both ends). */
const roomsOf = (op) => [op.roomId, op.parentId, op.childId, op.ref].filter((x) => typeof x === "string" && x);
/** A placeholder left in an op after substitution: the room it names was never made. */
function unresolved(v) {
  if (typeof v === "string") return v.startsWith("new:");
  if (Array.isArray(v)) return v.some(unresolved);
  if (v && typeof v === "object") return Object.values(v).some(unresolved);
  return false;
}
/** What the run log keeps of a refusal: the status and the start of the homeserver's answer (an error
 *  body never carries the token; anything shaped like one is cut out anyway). */
const excerpt = (body) => redact(String(body ?? "")).slice(0, EXCERPT_MAX);
const EXCERPT_MAX = 300;

/**
 * Apply's ops (and adopt's site writes), in order. An op the homeserver refuses fails its room: it is
 * recorded in `failures` (as an `op_failed` warn), the rest of that room's ops are skipped, and every
 * other room goes on. A homeserver that does not answer at all, or a site write that fails, throws.
 */
async function carryOut(plan, { hs, site, applied, notes, failures = [] }) {
  const refs = new Map();
  const failed = new Set();
  for (const planned of plan.ops) {
    const op = substitute(planned, refs);
    if (op.op === "warn") { notes.push(op); say(op.message); continue; }
    if (op.op === "adoptRow" || op.op === "followTombstone") {
      await site.must(describe(op), "POST", "/adopt", op);
      applied.push(op);
      say(describe(op));
      continue;
    }
    const rooms = roomsOf(op);
    if (rooms.some((r) => failed.has(r)) || unresolved({ ...op, ref: null })) {
      for (const r of rooms) failed.add(r);
      say(`skipped (its room failed earlier in this run): ${describe(op)}`);
      continue;
    }
    let done;
    try {
      done = await perform(hs, op);
    } catch (e) {
      if (!(e instanceof HomeserverError) || e.status === 0) throw e;
      // A space's kind marker the account may not write (the hub is usually the streamer's room): said,
      // and the run goes on. Apps then read the kind from the create, or not at all; nothing else depends on it.
      if (op.op === "setState" && e.status === 403) {
        const w = { op: "warn", code: "cannot_write", roomId: op.roomId, label: op.label,
          message: `could not ${describe(op)}: the community's account may not change ${op.label}` };
        notes.push(w); say(w.message);
        continue;
      }
      for (const r of rooms) failed.add(r);
      const f = { op: "warn", code: "op_failed", roomId: op.roomId ?? op.ref ?? null, label: op.label,
        failed: { op: op.op, status: e.status, errcode: e.errcode ?? null, body: excerpt(e.body) },
        message: `could not ${describe(op)} (the homeserver answered ${e.status}${e.errcode ? ` ${e.errcode}` : ""}); the rest of ${op.label} waits for the next run` };
      failures.push(f); say(f.message);
      continue;
    }
    applied.push(done);
    say(describe(done));
    if (done.op === "createRoom" || done.op === "createSpace") {
      refs.set(op.ref, done.roomId);
      // On its row before anything else is done with it: a run that dies after this never makes it twice.
      await site.must(`${describe(done)}: made as ${done.roomId}, but the site did not record it`, "POST", "/made",
        { table: done.row.table, id: done.row.id, matrixRoomId: done.roomId, replaces: done.replaces ?? null });
    }
  }
}

// ── One run ─────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const startedAt = new Date().toISOString();
  const result = { mode: null, ok: false, drift: [], applied: [], error: null };
  let site = null;
  let runId = null;
  let code = 2;
  try {
    const args = parseArgs(process.argv.slice(2));
    result.mode = args.mode;
    const secret = process.env.STREAM_API_SECRET ?? "";
    if (!secret) throw new Fatal("STREAM_API_SECRET is not set: the site's community feed answers only to it");
    SECRETS.push(secret);
    site = siteClient(args.web ?? process.env.COMMUNITY_WEB_BASE ?? "http://web:3000", secret);
    // The run's row, unfinished, before anything else: the panel refuses a channel delete while a run
    // is going (it may be making that very room), and a timer run has no other trace until it ends.
    try {
      const j = await site.must("the run's start", "POST", "/runs", { mode: args.mode, startedAt });
      runId = Number.isSafeInteger(j?.id) ? j.id : null;
    } catch (e) {
      if (e instanceof SetupPending) throw e;
      say(`reconcile: this run could not be marked as started in the run log (${message(e)}); it goes on, and its whole row is posted at the end`);
    }
    const token = await readToken();
    if (!token) throw new Fatal("no token on stdin: the community account's token is read from there");
    SECRETS.push(token);

    let feed;
    try { feed = checkFeed(await site.must("the site's community feed", "GET", "/desired")); } catch (e) {
      throw e instanceof Fatal || e instanceof SetupPending ? e : new Fatal(`the site's community feed could not be read (${message(e)})`);
    }
    // Without the site's ban marker no room ban can be placed or told apart: apply refuses (a red run gets the
    // site updated; a green one with a warning could hide unenforced bans for a long time). Report still runs.
    if (args.mode === "apply" && !(typeof feed.siteBanReason === "string" && feed.siteBanReason)) {
      throw new Fatal("the site did not send its ban marker; nothing applied");
    }
    const server = process.env.MX_SERVER_NAME;
    if (server && server !== feed.serverName) throw new Fatal(`the site says its chat server is ${feed.serverName}, but this install's is ${server}`);
    const asUser = process.env.MX_AS_USER || null;
    if (asUser && asUser !== feed.serviceUserId) throw new Fatal(`MX_AS_USER is ${asUser}, but the site's community account is ${feed.serviceUserId}`);

    // A rate limit is waited out when it is short (the per-sender limits answer seconds: an invite
    // burst on an install whose account is not an appservice sender); one the server says lasts longer
    // than HS_MAX_WAIT_MS fails that op at once (its room waits for the next run) instead of retrying early.
    const hs = makeClient({ base: args.base ?? process.env.MX_BASE ?? "http://synapse:8008", token,
      retries: HS_RETRIES, maxWaitMs: HS_MAX_WAIT_MS, longWait: "answer" });
    let me;
    try { me = await hs.whoami(); } catch (e) {
      throw new Fatal(`the homeserver did not accept the community account's token (whoami: ${message(e)}); nothing was changed`);
    }
    if (me !== feed.serviceUserId) throw new Fatal(`the token signs in as ${me}, but the site's community account is ${feed.serviceUserId}; nothing was changed`);

    let actual = await readActual(hs, feed, me);
    const readNotes = () => actual.notes ?? [];
    // A fresh install: the setup made the hub room, but nothing has made its row, so the panel's rows
    // (and the setup's channel list, which the site writes with the hub's row) do not exist yet. apply
    // first does what --mode adopt would, reads the feed again, then goes on. A hub with a row skips it.
    if (args.mode === "apply" && !feed.spaces.some((s) => s.kind === "hub")) {
      const first = planAll(feed, actual, { mode: "adopt" });
      if (first.ops.some((o) => o.op === "adoptRow" && o.row?.kind === "hub")) {
        await carryOut(first, { hs, site, applied: result.applied, notes: [] });
        say("first run: adopted the hub");
        try { feed = checkFeed(await site.must("the site's community feed", "GET", "/desired")); } catch (e) {
          throw e instanceof Fatal ? e : new Fatal(`the site's community feed could not be read after adopting the hub (${message(e)})`);
        }
        actual = await readActual(hs, feed, me);
      }
    }
    const plan = planAll(feed, actual, { mode: args.mode });
    result.drift = plan.drift;
    const notes = [];
    const failures = [];
    try {
      await carryOut(plan, { hs, site, applied: result.applied, notes, failures });
    } finally {
      result.drift = [...failures, ...notes, ...readNotes(), ...plan.drift];
    }
    for (const d of plan.drift) say(args.mode === "report" || !d.op || d.op === "warn" ? describe(d) : `left as it is (put-back is off): ${describe(d)}`);
    if (failures.length) {
      result.ok = false;
      result.error = `${failures.length} change${failures.length === 1 ? "" : "s"} the homeserver refused (${[...new Set(failures.map((f) => f.label))].join(", ")}); every other room was done`;
      say(`reconcile: ${result.error}`);
      code = 1;
    } else {
      result.ok = true;
      code = args.mode === "report" && result.drift.some((d) => d.op !== "warn") ? 1 : 0;
    }
  } catch (e) {
    result.ok = false;
    if (e instanceof SetupPending) {
      // Nothing was read or written; the site cannot take a run row yet, so none is posted.
      result.refused = "setup_pending";
      result.error = "the site is still being set up, so nothing was run; runs start once setup is finished";
      say(`reconcile: ${result.error}`);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = SETUP_PENDING_EXIT;
      return;
    }
    result.error = message(e);
    say(`reconcile: ${result.error}`);
    code = 2;
  }
  // Each entry carries its plain sentence: the panel shows these words and has no copy of describe().
  const said = (op) => { try { return { ...op, said: describe(op) }; } catch { return op; } };
  // Nothing a run writes (its row, stdout) carries a secret or anything shaped like one.
  result.drift = scrub(result.drift.map(said));
  result.applied = scrub(result.applied.map(said));
  result.error = result.error === null ? null : redact(result.error);
  if (site && result.mode) {
    const end = { finishedAt: new Date().toISOString(), ok: result.ok, drift: result.drift, applied: result.applied, error: result.error };
    let logged = false;
    if (runId !== null) {
      // Fill in the row this run started. A row that is gone (pruned) or already finished: a whole row instead.
      try { await site.must("the run log", "POST", "/runs", { id: runId, ...end }); logged = true; } catch (e) {
        say(`reconcile: the run's row could not be finished (${message(e)}); posting it whole`);
      }
    }
    if (!logged) {
      try {
        await site.must("the run log", "POST", "/runs", { mode: result.mode, startedAt, ...end });
      } catch (e) {
        say(`reconcile: the run log could not be written (${message(e)})`);
        code = 2;
      }
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = code;
}

// Run when executed (`node reconcile.mjs …`); a test that imports readRoom runs nothing.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
