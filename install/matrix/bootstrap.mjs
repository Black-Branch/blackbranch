// The homeserver's first-run bootstrap: the community
// space, #general and #forum (the Forums tab's first room), created AS the account that will own them (room version 12: the creator's
// power is permanent, so the rooms are theirs). Every step looks first and creates
// only what is missing, so running it again changes nothing.
//
//   node bootstrap.mjs < token         (the owner's access token on stdin, never in argv or env)
//
// Inputs (env): MX_BASE (the homeserver's client API, e.g. http://synapse:8008), MX_SERVER_NAME,
// MX_SPACE_NAME (the space's display name — the site's name), and the room ids already recorded in
// instance config, if any: MX_STORED_HUB, MX_STORED_GENERAL. A recorded room that is gone is
// REPORTED, not silently replaced by a second one; MX_RECREATE=1 allows making a new one.
// MX_COMMUNITY_USER (the community service account, when this install has one): invited into the
// three rooms and granted 100 in each, so the community reconciler can read and keep them (its own
// first run accepts the invites). The rooms stay the owner's: a creator's power is permanent.
// Output: one JSON line on stdout, {"hub","general","forum","created":[…]}; progress on stderr.
// (The forum room is found by its alias on a re-run: it has no instance-config key of its own.)
//
// Run by `blackbranch matrix bootstrap` (inside the stream-api image, on the bundle's network; the
// setup pages' community step asks for it through the host request `matrix-bootstrap`) and by
// the maintainers' disposable test install (on the host). It writes Matrix's m.* state, and one
// state event of the PRODUCT's namespace — the forum flag (web matrixNamespace.ts ROOM_TYPE, the same
// name on every install) — never an install's own prefix.
import { makeClient } from "./homeserver.mjs";
import { FORUM_ORDER, GENERAL_ORDER, ROOM_VERSION, forumBody, generalBody, hubBody } from "./community-rooms.mjs";

const env = process.env;
const BASE = (env.MX_BASE ?? "").replace(/\/+$/, "");
const SERVER = env.MX_SERVER_NAME ?? "";
const SPACE_NAME = env.MX_SPACE_NAME || SERVER;
const RECREATE = env.MX_RECREATE === "1";
const COMMUNITY = env.MX_COMMUNITY_USER ?? "";
const COMMUNITY_LEVEL = 100;
const HUB_ALIAS = "community-hub";
const GENERAL_ALIAS = "general";
const FORUM_ALIAS = "forum";
// The rooms' bodies, join rule and places in the space: community-rooms.mjs (what the reconciler keeps).

const log = (m) => process.stderr.write(`   ${m}\n`);
const fail = (m) => { process.stderr.write(`bootstrap: ${m}\n`); process.exit(1); };

if (!BASE || !SERVER) fail("MX_BASE and MX_SERVER_NAME are required");
if (COMMUNITY && !COMMUNITY.endsWith(`:${SERVER}`)) fail(`MX_COMMUNITY_USER ${COMMUNITY} is not an account on ${SERVER}`);

let token = "";
for await (const c of process.stdin) token += c;
token = token.trim();
if (!token) fail("no access token on stdin");

// The shared client (homeserver.mjs): `call` here is its request() — the answer whatever the status,
// since a 404 is an answer to this script — and `must` fails the run on anything but a 2xx.
const hs = makeClient({ base: BASE, token });
const call = (method, path, body) => hs.request(method, path, body);
const must = async (what, method, path, body) => {
  try { return (await hs.must(what, hs.call(method, path, body))) ?? {}; } catch (e) { return fail(e.message); }
};
const enc = encodeURIComponent;

const me = (await must("whoami", "GET", "/account/whoami")).user_id;
if (!me || !me.endsWith(`:${SERVER}`)) fail(`the token belongs to ${me ?? "nobody"}, not an account on ${SERVER}`);
log(`signed in as ${me}`);

/** Who made the room — its m.room.create's sender plus the content's additional_creators (room
 *  v12: every one of them holds permanent, undemotable power) — and its version, when the owner can
 *  read its state (joined), else null. The sender is only in the event, never in the content, so
 *  this reads the room's state as events rather than the create event's content. */
async function originOf(roomId) {
  const r = await call("GET", `/rooms/${enc(roomId)}/state`);
  if (r.status !== 200 || !Array.isArray(r.json)) return null;
  const ev = r.json.find((e) => e?.type === "m.room.create" && e.state_key === "");
  if (!ev) return null;
  const extra = Array.isArray(ev.content?.additional_creators) ? ev.content.additional_creators : [];
  // A malformed entry counts as someone else, never as nobody.
  return { creators: [ev.sender, ...extra].map((u) => (typeof u === "string" ? u : "?")), version: String(ev.content?.room_version ?? "1") };
}
/** Why the room is not the owner's alone, or null when it is: the owner made it, nobody else is a
 *  creator, and it is the version the bootstrap makes. Listing the owner among additional_creators
 *  of someone else's room is not enough — whoever made it stays a creator for good; a room of
 *  another version has another creator model (before v12 a creator can be outranked). */
function notOwned({ creators, version }) {
  if (version !== ROOM_VERSION) return `it is room version ${version}, not ${ROOM_VERSION}`;
  const others = creators.filter((u) => u !== me);
  if (creators[0] !== me || others.length) return `made by ${others[0] ?? creators[0]}, not by ${me} alone`;
  return null;
}
async function byAlias(alias) {
  const r = await call("GET", `/directory/room/${enc(`#${alias}:${SERVER}`)}`);
  return r.status === 200 ? r.json?.room_id ?? null : null;
}
const created = [];

// A room the owner did not create is never adopted. Until the registration switch existed, sign-up
// was open before the operator reached the community step, so anyone could make #community-hub and
// #general first; their creator power is permanent, so recording those ids would hand them the
// community for good. The alias has to go before the bootstrap can make the real rooms.
function refuseForeign(label, alias, roomId, why) {
  fail(`${label}: #${alias}:${SERVER} is room ${roomId}, ${why} — refusing to adopt it. ` +
    `Remove the alias (and the room) as a server admin, then run the community step again: see "A community alias someone else made" in install/README.md`);
}

async function ensureRoom({ label, alias, stored, body }) {
  if (stored) {
    const origin = await originOf(stored);
    if (origin) {
      const why = notOwned(origin);
      if (why) refuseForeign(label, alias, stored, why);
      log(`${label}: ${stored} (recorded)`); return stored;
    }
    if (!RECREATE) fail(`${label}: the recorded room ${stored} is gone or not joined by ${me} — not making a second one silently (MX_RECREATE=1 to replace it)`);
    log(`${label}: the recorded room ${stored} is gone; replacing it`);
  }
  const existing = await byAlias(alias);
  if (existing) {
    let origin = await originOf(existing);
    let joined = false;
    if (!origin) {
      await must(`join ${label}`, "POST", `/join/${enc(existing)}`, {});
      joined = true;
      origin = await originOf(existing);
    }
    const why = origin ? notOwned(origin) : "its creation event cannot be read";
    if (why) {
      // Joined only to read who made it: do not stay in someone else's room.
      if (joined) await call("POST", `/rooms/${enc(existing)}/leave`, {});
      refuseForeign(label, alias, existing, why);
    }
    log(`${label}: ${existing} (#${alias} exists)`);
    return existing;
  }
  const id = (await must(`create ${label}`, "POST", "/createRoom", { room_alias_name: alias, ...body })).room_id;
  created.push(label);
  log(`${label}: created ${id} (#${alias})`);
  return id;
}

const hub = await ensureRoom({
  label: "community space", alias: HUB_ALIAS, stored: env.MX_STORED_HUB,
  body: hubBody(SPACE_NAME),
});
const general = await ensureRoom({ label: "#general", alias: GENERAL_ALIAS, stored: env.MX_STORED_GENERAL, body: generalBody(hub) });

// The space ⇄ room links, each written only when it is not already there with a `via` (and, for a
// child, an `order`: #general before #forum, so every reader, the community import included, lists
// them the same way). An order already there is the panel's from then on, and is left as it is.
async function ensureLink(roomId, type, stateKey, order) {
  const r = await call("GET", `/rooms/${enc(roomId)}/state/${type}/${enc(stateKey)}`);
  const have = r.status === 200 && r.json && typeof r.json === "object" ? r.json : null;
  if (have && Array.isArray(have.via) && have.via.length && (order === undefined || typeof have.order === "string")) return;
  const content = { ...(have && Array.isArray(have.via) && have.via.length ? have : { via: [SERVER] }), ...(order === undefined ? {} : { order }) };
  await must(`${type} link`, "PUT", `/rooms/${enc(roomId)}/state/${type}/${enc(stateKey)}`, content);
  created.push(type);
  log(`linked: ${type}`);
}
const forum = await ensureRoom({ label: "#forum", alias: FORUM_ALIAS, stored: undefined, body: forumBody(hub) });

await ensureLink(hub, "m.space.child", general, GENERAL_ORDER);
await ensureLink(general, "m.space.parent", hub);
await ensureLink(hub, "m.space.child", forum, FORUM_ORDER);
await ensureLink(forum, "m.space.parent", hub);

// The rooms in the server's public room list, so a Matrix app can find them. The rendered Synapse
// config allows listing exactly these three aliases (install/matrix/render.sh). A server that refuses
// (another homeserver's rules) leaves them unlisted — the site joins by alias, so nothing breaks —
// and the run says so rather than failing.
async function ensurePublished(label, roomId) {
  const r = await call("GET", `/directory/list/room/${enc(roomId)}`);
  if (r.status === 200 && r.json?.visibility === "public") return;
  const w = await call("PUT", `/directory/list/room/${enc(roomId)}`, { visibility: "public" });
  if (w.status >= 200 && w.status <= 299) { created.push(`listed ${label}`); log(`listed: ${label}`); return; }
  log(`${label}: not in the public room list (${w.status}; listing needs a server admin sign-in)`);
}
await ensurePublished("community space", hub);
await ensurePublished("#general", general);
await ensurePublished("#forum", forum);

// The community service account: 100 in each room (written only when it is not already), then
// invited (only when it is neither in nor invited). Granted first, so its first run can act at once.
async function ensureCommunity(label, roomId) {
  const pl = await call("GET", `/rooms/${enc(roomId)}/state/m.room.power_levels/`);
  const content = pl.status === 200 && pl.json && typeof pl.json === "object" ? pl.json : {};
  if (content.users?.[COMMUNITY] !== COMMUNITY_LEVEL) {
    await must(`grant the community account 100 in ${label}`, "PUT", `/rooms/${enc(roomId)}/state/m.room.power_levels/`,
      { ...content, users: { ...(content.users ?? {}), [COMMUNITY]: COMMUNITY_LEVEL } });
    created.push(`community account power in ${label}`);
    log(`${label}: the community account holds 100`);
  }
  const m = await call("GET", `/rooms/${enc(roomId)}/state/m.room.member/${enc(COMMUNITY)}`);
  const membership = m.status === 200 ? m.json?.membership : null;
  if (membership !== "join" && membership !== "invite") {
    await must(`invite the community account to ${label}`, "POST", `/rooms/${enc(roomId)}/invite`, { user_id: COMMUNITY });
    created.push(`community account invited to ${label}`);
    log(`${label}: the community account is invited`);
  }
}
if (COMMUNITY) {
  await ensureCommunity("community space", hub);
  await ensureCommunity("#general", general);
  await ensureCommunity("#forum", forum);
}

process.stdout.write(`${JSON.stringify({ hub, general, forum, created })}\n`);
