// The homeserver's first-run bootstrap: the community
// space and #general, created AS the account that will own them (room version 12: the creator's
// power is permanent, so the rooms are theirs). Every step looks first and creates
// only what is missing, so running it again changes nothing.
//
//   node bootstrap.mjs < token         (the owner's access token on stdin, never in argv or env)
//
// Inputs (env): MX_BASE (the homeserver's client API, e.g. http://synapse:8008), MX_SERVER_NAME,
// MX_SPACE_NAME (the space's display name — the site's name), and the room ids already recorded in
// instance config, if any: MX_STORED_HUB, MX_STORED_GENERAL. A recorded room that is gone is
// REPORTED, not silently replaced by a second one; MX_RECREATE=1 allows making a new one.
// Output: one JSON line on stdout, {"hub","general","created":[…]}; progress on stderr.
//
// Run by `blackbranch matrix bootstrap` (inside the stream-api image, on the bundle's network; the
// setup pages' community step asks for it through the host request `matrix-bootstrap`) and by
// the maintainers' disposable test install (on the host). It writes no data type of the site's own — only
// Matrix's m.* state — so a fresh install's rooms carry no namespace but Matrix's.

const env = process.env;
const BASE = (env.MX_BASE ?? "").replace(/\/+$/, "");
const SERVER = env.MX_SERVER_NAME ?? "";
const SPACE_NAME = env.MX_SPACE_NAME || SERVER;
const RECREATE = env.MX_RECREATE === "1";
const HUB_ALIAS = "community-hub";
const GENERAL_ALIAS = "general";
// #general keeps 30 days of messages (the server's allowed range is 1 day – 1 year).
const GENERAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const log = (m) => process.stderr.write(`   ${m}\n`);
const fail = (m) => { process.stderr.write(`bootstrap: ${m}\n`); process.exit(1); };

if (!BASE || !SERVER) fail("MX_BASE and MX_SERVER_NAME are required");

let token = "";
for await (const c of process.stdin) token += c;
token = token.trim();
if (!token) fail("no access token on stdin");

async function call(method, path, body) {
  const res = await fetch(`${BASE}/_matrix/client/v3${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, json, text };
}
const must = async (what, method, path, body) => {
  const r = await call(method, path, body);
  if (r.status < 200 || r.status > 299) fail(`${what}: ${r.status} ${r.text.slice(0, 200)}`);
  return r.json ?? {};
};
const enc = encodeURIComponent;

const me = (await must("whoami", "GET", "/account/whoami")).user_id;
if (!me || !me.endsWith(`:${SERVER}`)) fail(`the token belongs to ${me ?? "nobody"}, not an account on ${SERVER}`);
log(`signed in as ${me}`);

const ROOM_VERSION = "12";

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
  body: { name: SPACE_NAME, preset: "public_chat", visibility: "public", room_version: ROOM_VERSION, creation_content: { type: "m.space" } },
});
const general = await ensureRoom({
  label: "#general", alias: GENERAL_ALIAS, stored: env.MX_STORED_GENERAL,
  body: {
    name: "general", preset: "public_chat", visibility: "public", room_version: ROOM_VERSION,
    initial_state: [{ type: "m.room.retention", state_key: "", content: { max_lifetime: GENERAL_RETENTION_MS } }],
  },
});

// The space ⇄ room links, each written only when it is not already there with a `via`.
async function ensureLink(roomId, type, stateKey) {
  const r = await call("GET", `/rooms/${enc(roomId)}/state/${type}/${enc(stateKey)}`);
  if (r.status === 200 && Array.isArray(r.json?.via) && r.json.via.length) return;
  await must(`${type} link`, "PUT", `/rooms/${enc(roomId)}/state/${type}/${enc(stateKey)}`, { via: [SERVER] });
  created.push(type);
  log(`linked: ${type}`);
}
await ensureLink(hub, "m.space.child", general);
await ensureLink(general, "m.space.parent", hub);

// Both rooms in the server's public room list, so a Matrix app can find them. The rendered Synapse
// config allows listing exactly these two aliases (install/matrix/render.sh). A server that refuses
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

process.stdout.write(`${JSON.stringify({ hub, general, created })}\n`);
