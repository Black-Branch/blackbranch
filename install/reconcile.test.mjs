// The community reconciler's command (install/matrix/reconcile.mjs), run for real as a child process
// against a small fake homeserver and a fake site in this process. Run: node --test install/
//
// The fake homeserver starts as the community in fixtures/community/actual.json (the one whose
// state already matches fixtures/community/feed.json), served as Matrix state events; the fake site
// serves that feed and keeps what the command posts back: the run log, the ids of rooms it made,
// and the rows adopt imports. Each test changes one thing and reads what the command did.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeClient } from "./matrix/homeserver.mjs";
import { readRoom } from "./matrix/reconcile.mjs";
import { bundleShaped, ownerShaped } from "./fixtures/community/shapes.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(path.join(here, "fixtures/community", f), "utf8"));
const S = "example.test";
const id = (x) => `!${x}:${S}`;
const u = (x) => `@${x}:${S}`;
const SERVICE = u("community");
const TOKEN = "syt_Y29tbXVuaXR5_reconcile_test_token";
const SETUP_PENDING_WORDS = "this site is being set up";
const SECRET = "reconcile-test-internal-secret";

/** One clock for both fakes: each request they receive gets the next tick, so a test can order a
 *  site call against a homeserver call. */
const clock = { t: 0 };

// ── The fake homeserver ─────────────────────────────────────────────────────────────────────────
/** `actual` (the fixture's shape) served as state events. Options: whoami (the token's user),
 *  whoamiStatus, forbidden (room ids the account may not read: 403), fail(method, path) → true
 *  makes that request answer 500, refuse → 403, drop → the connection is cut with no answer. A room's
 *  `inviters` ({userId: sender}) name who sent a member event (an invite's inviter). A room's
 *  `bridges` ([{sender, bridgebot, type?}]) become bridge state events; /sync lists the rooms where the
 *  service account's membership is "invite", and /join accepts one. A room id it does not hold answers as Synapse 1.162 does (asked of
 *  the throwaway pair, Task 1.6): 403 M_FORBIDDEN "not in room" for its state, and 404 M_NOT_FOUND
 *  from the room directory, which knows every room the server holds. */
function fakeHomeserver(actual, opts = {}) {
  const rooms = new Map();
  const calls = [];
  let n = 0;
  const put = (room, type, key, content, sender = SERVICE) => room.state.set(`${type}\u0000${key}`, { content, sender });
  for (const [rid, r] of Object.entries(actual.rooms)) {
    const room = { state: new Map(), listed: !!r.published };
    const [creator, ...more] = r.creators ?? [SERVICE];
    put(room, "m.room.create", "", { room_version: "12", ...(r.type ? { type: r.type } : {}), ...(more.length ? { additional_creators: more } : {}) }, creator);
    if (r.name != null) put(room, "m.room.name", "", { name: r.name });
    if (r.topic != null) put(room, "m.room.topic", "", { topic: r.topic });
    if (r.avatar != null) put(room, "m.room.avatar", "", { url: r.avatar });
    if (r.joinRule) put(room, "m.room.join_rules", "", { join_rule: r.joinRule, ...(r.allow?.length ? { allow: r.allow } : {}) });
    if (r.history) put(room, "m.room.history_visibility", "", { history_visibility: r.history });
    // retention: a number = an event with that limit; null = an event with no limit ({}); absent = no event.
    if (r.retention !== undefined) put(room, "m.room.retention", "", r.retention === null ? {} : { max_lifetime: r.retention });
    if (r.encrypted) put(room, "m.room.encryption", "", { algorithm: "m.megolm.v1.aes-sha2" });
    if (r.forum) put(room, "app.blackbranch.room_type", "", { type: "forum" });
    if (r.spaceKind) put(room, "app.blackbranch.space_kind", "", { kind: r.spaceKind });
    if (r.banner) put(room, "app.blackbranch.banner", "", { url: r.banner });
    if (r.tombstone) put(room, "m.room.tombstone", "", r.tombstone);
    for (const [i, br] of (r.bridges ?? []).entries()) put(room, br.type ?? "m.bridge", `bridge${i}`, { bridgebot: br.bridgebot, channel: { id: `c${i}` } }, br.sender);
    put(room, "m.room.power_levels", "", r.powerLevels ?? {});
    for (const [who, m] of Object.entries(r.members ?? {})) {
      const reason = r.banReasons?.[who];
      put(room, "m.room.member", who, { membership: m, ...(reason ? { reason } : {}) }, r.inviters?.[who] ?? who);
    }
    for (const ch of r.children ?? []) put(room, "m.space.child", ch.roomId, { via: ch.via, ...(ch.order != null ? { order: ch.order } : {}) }, ch.by ?? SERVICE);
    rooms.set(rid, room);
  }
  const srv = createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    const url = new URL(req.url, "http://x");
    const segs = url.pathname.replace(/^\/_matrix\/client\/v3/, "").split("/").map(decodeURIComponent);
    const p = segs.join("/");
    calls.push({ method: req.method, path: p, query: url.searchParams.toString(), body, t: ++clock.t });
    const send = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { errcode: "M_UNKNOWN_TOKEN" });
    if (opts.drop?.(req.method, p)) { req.socket.destroy(); return; }
    // limit(method, path) → ms: answer 429 with that retry_after_ms (once per request path when `limitOnce`).
    const lim = opts.limit?.(req.method, p);
    if (lim !== undefined && lim !== null) return send(429, { errcode: "M_LIMIT_EXCEEDED", error: "Too Many Requests", retry_after_ms: lim });
    if (opts.fail?.(req.method, p)) return send(500, { errcode: "M_UNKNOWN", error: "the fake says no" });
    if (opts.refuse?.(req.method, p)) return send(403, { errcode: "M_FORBIDDEN", error: opts.refuseText ?? "not allowed" });
    if (p === "/account/whoami") {
      return (opts.whoamiStatus ?? 200) === 200 ? send(200, { user_id: opts.whoami ?? SERVICE }) : send(opts.whoamiStatus, { errcode: "M_UNKNOWN_TOKEN" });
    }
    if (p === "/createRoom" && req.method === "POST") {
      const rid = `!made${++n}:${S}`;
      const room = { state: new Map(), listed: body.visibility === "public" };
      put(room, "m.room.create", "", { ...(body.creation_content ?? {}), room_version: body.room_version });
      put(room, "m.room.member", SERVICE, { membership: "join" });
      put(room, "m.room.power_levels", "", body.power_level_content_override ?? {});
      for (const s of body.initial_state ?? []) put(room, s.type, s.state_key, s.content);
      if (body.name) put(room, "m.room.name", "", { name: body.name });
      if (body.topic) put(room, "m.room.topic", "", { topic: body.topic });
      rooms.set(rid, room);
      return send(200, { room_id: rid });
    }
    // The account's pending invites: a sync filtered down to them (rooms.invite).
    if (p === "/sync" && req.method === "GET") {
      const invite = {};
      for (const [rid, room] of rooms) {
        const ev = room.state.get(`m.room.member\u0000${SERVICE}`);
        if (ev?.content.membership === "invite") invite[rid] = { invite_state: { events: [{ type: "m.room.member", state_key: SERVICE, sender: ev.sender, content: ev.content }] } };
      }
      return send(200, { next_batch: "s1", rooms: { join: {}, invite, leave: {} } });
    }
    if (segs[1] === "join" && req.method === "POST") {
      const room = rooms.get(segs[2]);
      const m = room?.state.get(`m.room.member\u0000${SERVICE}`)?.content.membership;
      if (!room || (m !== "invite" && m !== "join")) return send(403, { errcode: "M_FORBIDDEN" });
      put(room, "m.room.member", SERVICE, { membership: "join" });
      return send(200, { room_id: segs[2] });
    }
    const [, a, rid, b, type, key] = segs;
    if (a === "directory" && rid === "list" && b === "room") {
      const room = rooms.get(type);
      if (!room) return send(404, { errcode: "M_NOT_FOUND" });
      if (req.method === "GET") return send(200, { visibility: room.listed ? "public" : "private" });
      room.listed = body.visibility === "public"; return send(200, {});
    }
    if (a !== "rooms") return send(404, { errcode: "M_UNRECOGNIZED" });
    const room = rooms.get(rid);
    if (opts.forbidden?.has(rid)) return send(403, { errcode: "M_FORBIDDEN" });
    if (!room) return send(403, { errcode: "M_FORBIDDEN", error: `User ${SERVICE} not in room ${rid}, and room previews are disabled` });
    // Like Synapse: an account that never joined is refused; one that LEFT still reads the state as it
    // was when it left (allow_departed_users), but may write nothing.
    const mine = room.state.get(`m.room.member\u0000${SERVICE}`)?.content.membership;
    if (!mine || (mine !== "join" && req.method !== "GET")) return send(403, { errcode: "M_FORBIDDEN" });
    if (b === "state" && req.method === "GET" && type === undefined) {
      return send(200, [...room.state].map(([k, v]) => {
        const [t, sk] = k.split("\u0000");
        return { type: t, state_key: sk, content: v.content, sender: v.sender, event_id: "$e" };
      }));
    }
    if (b === "state" && req.method === "PUT") { put(room, type, key ?? "", body); return send(200, { event_id: "$e" }); }
    const membership = { invite: "invite", kick: "leave", ban: "ban", unban: "leave" }[b];
    if (membership && req.method === "POST") { put(room, "m.room.member", body.user_id, { membership, ...(body.reason ? { reason: body.reason } : {}) }); return send(200, {}); }
    return send(404, { errcode: "M_UNRECOGNIZED" });
  });
  const writes = () => calls.filter((c) => c.method !== "GET");
  const stateOf = (rid, type, key = "") => rooms.get(rid)?.state.get(`${type}\u0000${key}`)?.content;
  return { srv, rooms, calls, writes, stateOf };
}

// ── The fake site ───────────────────────────────────────────────────────────────────────────────
/** Serves `feed` and keeps what is posted back. The run log is two-phase like the site's route: a
 *  post without an id is a row (unfinished when it has no finishedAt) → {id}; a post with an id
 *  fills that unfinished row (409 when there is none). `made` records a room's id on its row (the
 *  next read of the feed has it). Options: feedStatus (the feed's answer), runFailures (every run
 *  log post answers 503 that many times first), startFailures (only a start does). */
function fakeSite(feed, opts = {}) {
  const runs = [], made = [], adopted = [], calls = [];
  let runFailures = opts.runFailures ?? 0;
  let startFailures = opts.startFailures ?? 0;
  const srv = createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    const p = new URL(req.url, "http://x").pathname;
    calls.push({ method: req.method, path: p, body, t: ++clock.t });
    const send = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    // Until setup finishes, the site's gate (web/proxy.ts) answers every API this, before any route.
    if (opts.setup?.pending) return send(503, { error: SETUP_PENDING_WORDS });
    if (req.headers.authorization !== `Bearer ${SECRET}`) return send(401, { error: "unauthorized" });
    if (p === "/api/internal/community/desired" && req.method === "GET") {
      return (opts.feedStatus ?? 200) === 200 ? send(200, feed) : send(opts.feedStatus, { error: "unavailable" });
    }
    if (p === "/api/internal/community/runs" && req.method === "POST") {
      if (runFailures > 0) { runFailures--; return send(503, { error: "unavailable" }); }
      if (body.id === undefined) {
        if (body.finishedAt === undefined && startFailures > 0) { startFailures--; return send(503, { error: "unavailable" }); }
        const row = { ...body, id: runs.length + 1 };
        runs.push(row); return send(200, { id: row.id });
      }
      const row = runs.find((r) => r.id === body.id);
      if (!row || row.finishedAt) return send(409, { error: "no unfinished run with that id" });
      Object.assign(row, body); return send(200, { id: row.id });
    }
    if (p === "/api/internal/community/made" && req.method === "POST") {
      const row = (body.table === "spaces" ? feed.spaces : feed.rooms).find((r) => r.id === body.id);
      if (!row) return send(404, { error: "no such row" });
      row.matrixRoomId = body.matrixRoomId; made.push(body); return send(200, { ok: true });
    }
    if (p === "/api/internal/community/adopt" && req.method === "POST") {
      adopted.push(body);
      opts.onAdopt?.(body, feed); // what the site's route writes (rows the next feed read has)
      return send(200, { id: 100 + adopted.length });
    }
    return send(404, { error: "not found" });
  });
  return { srv, runs, made, adopted, calls };
}

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${srv.address().port}`)));
const close = (srv) => new Promise((r) => srv.close(() => r()));

/** Both fakes up for the test's body; closed after. */
async function withFakes({ feed = load("feed.json"), actual = load("actual.json"), hs: hsOpts = {}, site: siteOpts = {} } = {}, fn) {
  const hs = fakeHomeserver(actual, hsOpts);
  const site = fakeSite(feed, siteOpts);
  const hsBase = await listen(hs.srv), webBase = await listen(site.srv);
  try { return await fn({ hs, site, feed, hsBase, webBase }); } finally { await close(hs.srv); await close(site.srv); }
}

/** The command, as the host runs it: the token on stdin, everything else in the environment. */
function reconcile(args, { hsBase, webBase, env = {}, token = TOKEN }) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(here, "matrix/reconcile.mjs"), ...args], {
      env: { PATH: process.env.PATH, MX_BASE: hsBase, COMMUNITY_WEB_BASE: webBase, STREAM_API_SECRET: SECRET, MX_SERVER_NAME: S, ...env },
    });
    let out = "", err = "";
    p.stdout.on("data", (c) => (out += c)); p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => {
      const lines = out.trim().split("\n").filter(Boolean);
      let result = null;
      try { result = JSON.parse(lines.at(-1)); } catch { /* the test says what it got */ }
      resolve({ code, out, err, lines, result });
    });
    p.stdin.end(token === null ? "" : `${token}\n`);
  });
}

/** A new channel in the Talk category that the homeserver does not have yet. */
const eventsRow = (over = {}) => ({
  id: 7, spaceId: 2, kind: "text", name: "events", topic: null, avatarMxc: null, orderKey: "a6", see: "everyone", post: "everyone",
  retentionDays: null, encrypted: false, published: false, archived: false, matrixRoomId: null, discordChannelId: null, ...over,
});

// ── Report ──────────────────────────────────────────────────────────────────────────────────────
test("report exits 0 when the homeserver matches the panel, and writes nothing", async () => {
  await withFakes({}, async ({ hs, site, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "report"], { hsBase, webBase });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.lines.length, 1, "stdout is one JSON line");
    assert.deepEqual(r.result, { mode: "report", ok: true, drift: [], applied: [], error: null });
    assert.deepEqual(hs.writes(), [], "report never writes to the homeserver");
    // Vacuity: it did read every room the panel names.
    for (const rid of ["hub", "talk", "gate", "general", "news", "lounge", "mods", "vip", "staff"]) {
      assert.ok(hs.calls.some((c) => c.method === "GET" && c.path === `/rooms/${id(rid)}/state`), rid);
    }
    assert.equal(site.runs.length, 1);
    assert.equal(site.runs[0].mode, "report");
  });
});

test("report prints the drift and exits 1 when a room is missing; still nothing written", async () => {
  const feed = load("feed.json");
  feed.rooms.push(eventsRow());
  await withFakes({ feed }, async ({ hs, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "report"], { hsBase, webBase });
    assert.equal(r.code, 1, r.err);
    assert.equal(r.result.ok, true);
    assert.ok(r.result.drift.some((o) => o.op === "createRoom" && o.label === "#events"), JSON.stringify(r.result.drift));
    assert.match(r.err, /^create #events$/m, "one plain line per op on stderr");
    assert.match(r.err, /^put #events in the category Talk$/m);
    assert.deepEqual(hs.writes(), []);
  });
});

// ── Apply ───────────────────────────────────────────────────────────────────────────────────────
test("apply creates the missing room as the panel says, records its id, then a second apply only reads", async () => {
  const feed = load("feed.json");
  feed.rooms.push(eventsRow());
  await withFakes({ feed }, async ({ hs, site, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.result.ok, true); assert.equal(r.result.error, null);
    const create = hs.calls.find((c) => c.path === "/createRoom");
    assert.ok(create, "a room was made");
    const b = create.body;
    assert.equal(b.room_version, "12");
    assert.equal(b.name, "events");
    const st = (t) => b.initial_state.find((s) => s.type === t)?.content;
    assert.deepEqual(st("m.room.guest_access"), { guest_access: "forbidden" });
    assert.deepEqual(st("m.room.join_rules"), { join_rule: "restricted", allow: [{ type: "m.room_membership", room_id: id("hub") }] });
    assert.deepEqual(st("m.room.history_visibility"), { history_visibility: "shared" });
    const newId = [...hs.rooms.keys()].find((k) => k.startsWith("!made"));
    // Its id is on its row before anything else is done with it.
    assert.deepEqual(site.made, [{ table: "rooms", id: 7, matrixRoomId: newId, replaces: null }]);
    // Linked into its category, both ways.
    assert.deepEqual(hs.stateOf(id("talk"), "m.space.child", newId), { via: [S], order: "a6" });
    assert.deepEqual(hs.stateOf(newId, "m.space.parent", id("talk")), { via: [S], canonical: true });
    // The run log has it, with the made room's real id (never the plan's placeholder).
    assert.equal(site.runs.length, 1);
    const run = site.runs[0];
    assert.equal(run.mode, "apply"); assert.equal(run.ok, true); assert.equal(run.error, null);
    assert.ok(Date.parse(run.startedAt) <= Date.parse(run.finishedAt));
    assert.deepEqual(run.applied.map((o) => o.op), ["createRoom", "linkChild", "ban"]);
    assert.equal(run.applied[0].roomId, newId);
    // The create keeps its placeholder's name as `ref` (which create made which id); nothing else does.
    assert.equal(run.applied[0].ref, "new:rooms:7");
    assert.doesNotMatch(JSON.stringify(run.applied.map(({ ref, ...o }) => o)), /new:rooms:7/, "no placeholder is left in the log");
    assert.deepEqual(r.result.applied, run.applied, "stdout says what the log says");
    assert.match(r.err, /^create #events$/m);

    const before = hs.calls.length;
    const again = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(again.code, 0, again.err);
    assert.deepEqual(again.result.applied, [], JSON.stringify(again.result.applied));
    assert.deepEqual(hs.calls.slice(before).filter((c) => c.method !== "GET"), [], "the second apply only reads");
    assert.ok(hs.calls.slice(before).some((c) => c.path === `/rooms/${newId}/state`), "vacuity: it read the room it made");
    assert.equal(site.made.length, 1);
  });
});

test("whoami_failure_is_fatal: the feed answers, whoami is refused → exit 2, nothing written to the homeserver", async () => {
  await withFakes({ hs: { whoamiStatus: 401 } }, async ({ hs, site, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(r.code, 2, r.err);
    assert.equal(r.result.ok, false);
    assert.match(r.result.error, /whoami|sign in|token/i);
    assert.deepEqual(hs.writes(), []);
    assert.deepEqual(hs.calls.map((c) => c.path), ["/account/whoami"], "nothing else was asked");
    assert.ok(site.calls.some((c) => c.path === "/api/internal/community/desired"), "vacuity: the feed was read first");
    assert.equal(site.runs.length, 1, "the failure is in the run log");
    assert.equal(site.runs[0].ok, false);
  });
});

test("the token must be the site's community account: another account → exit 2, nothing written", async () => {
  await withFakes({ hs: { whoami: u("streamer") } }, async ({ hs, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(r.code, 2, r.err);
    assert.match(r.result.error, new RegExp(`${u("streamer")}.*${SERVICE}`));
    assert.deepEqual(hs.writes(), []);
  });
  // MX_AS_USER names the account the token must be; one that is not the site's is refused too.
  await withFakes({}, async ({ hs, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "apply"], { hsBase, webBase, env: { MX_AS_USER: u("someone") } });
    assert.equal(r.code, 2, r.err);
    assert.deepEqual(hs.writes(), []);
  });
});

test("feed unreachable is fatal: exit 2, the homeserver never asked", async () => {
  await withFakes({ site: { feedStatus: 503 } }, async ({ hs, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(r.code, 2, r.err);
    assert.equal(r.result.ok, false);
    assert.match(r.result.error, /site|feed/i);
    assert.deepEqual(hs.calls, []);
  });
  // Nothing listening at all.
  await withFakes({}, async ({ hs, hsBase }) => {
    const r = await reconcile(["--mode", "report"], { hsBase, webBase: "http://127.0.0.1:9" });
    assert.equal(r.code, 2, r.err);
    assert.deepEqual(hs.calls, []);
  });
});

test("refused_setup_pending: before setup finishes (the site answers 503 being set up) a run is refused, exit 75, nothing asked or written", async () => {
  const setup = { pending: true };
  await withFakes({ site: { setup } }, async ({ hs, site, hsBase, webBase }) => {
    for (const mode of ["report", "adopt", "apply"]) {
      const r = await reconcile(["--mode", mode], { hsBase, webBase });
      assert.equal(r.code, 75, `${mode}: ${r.err}`);
      assert.equal(r.result.refused, "setup_pending", mode);
      assert.equal(r.result.ok, false);
      assert.match(r.result.error, /still being set up/);
      assert.deepEqual(hs.calls, [], `${mode}: the homeserver is never asked`);
    }
    assert.deepEqual(site.runs, [], "no run row (the site would refuse it anyway)");
    // Retry: once setup is finished, the same command runs as usual.
    setup.pending = false;
    const after = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(after.code, 0, after.err);
    assert.equal(after.result.ok, true);
    assert.equal(after.result.refused, undefined, "a run that ran is not refused");
    assert.equal(site.runs.length, 1);
  });
});

test("a 503 that is not the setup gate is still a failed run (exit 2)", async () => {
  await withFakes({ site: { feedStatus: 503 } }, async ({ hsBase, webBase }) => {
    const r = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(r.code, 2, r.err);
    assert.equal(r.result.refused, undefined);
  });
});

test("the setup gate's words are the site's own (web/proxy.ts)", () => {
  const proxy = readFileSync(path.join(here, "../web/proxy.ts"), "utf8");
  assert.ok(proxy.includes(`NextResponse.json({ error: "${SETUP_PENDING_WORDS}" }, { status: 503`), "the fake answers as the real gate does");
  assert.match(readFileSync(path.join(here, "matrix/reconcile.mjs"), "utf8"), new RegExp(`const SETUP_PENDING = "${SETUP_PENDING_WORDS}";`));
});

test("the server name the install has must be the feed's", async () => {
  await withFakes({}, async ({ hs, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "apply"], { hsBase, webBase, env: { MX_SERVER_NAME: "other.test" } });
    assert.equal(r.code, 2, r.err);
    assert.match(r.result.error, /other\.test/);
    assert.deepEqual(hs.calls, []);
  });
});

test("a room this run makes is named by its new id everywhere later, inside settings too", async () => {
  // The supporters space is gone from the homeserver: it is made again, and the supporter channel's
  // "who can join" (which names the space inside its content) and the invites name the new space.
  const feed = load("feed.json");
  const actual = load("actual.json");
  delete actual.rooms[id("gate")];
  await withFakes({ feed, actual }, async ({ hs, site, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(r.code, 0, r.err);
    const gate = [...hs.rooms.keys()].find((k) => k.startsWith("!made"));
    assert.ok(gate);
    assert.deepEqual(site.made, [{ table: "spaces", id: 3, matrixRoomId: gate, replaces: id("gate") }]);
    assert.deepEqual(hs.stateOf(id("lounge"), "m.room.join_rules"), { join_rule: "restricted", allow: [{ type: "m.room_membership", room_id: gate }] });
    assert.equal(hs.stateOf(gate, "m.room.member", u("alice"))?.membership, "invite", "the supporter is invited into the new space");
    assert.doesNotMatch(JSON.stringify(hs.calls), /new:spaces:3/, "no placeholder ever reached the homeserver");
    assert.doesNotMatch(JSON.stringify(site.runs[0].applied.map(({ ref, ...o }) => o)), /new:spaces:3/);
  });
});

test("a room the account cannot read is warned about and never made again", async () => {
  await withFakes({ hs: { forbidden: new Set([id("news")]) } }, async ({ hs, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(r.code, 0, r.err);
    assert.ok(!hs.calls.some((c) => c.path === "/createRoom"), "nothing made");
    assert.ok(r.result.drift.some((o) => o.op === "warn" && o.code === "cannot_read" && o.roomId === id("news")), JSON.stringify(r.result.drift));
    assert.match(r.err, /cannot read #news/);
  });
});

test("a room the account has left is not read: Synapse still shows its state from then, which is old", async () => {
  const actual = load("actual.json");
  actual.rooms[id("news")].members[SERVICE] = "leave";
  actual.rooms[id("news")].name = "old name";
  await withFakes({ actual }, async ({ hs, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(r.code, 0, r.err);
    assert.ok(hs.calls.some((c) => c.path === `/rooms/${id("news")}/state` && c.method === "GET"), "vacuity: it was asked");
    // It tries to get back in (a row's room is the community's); refused, it writes nothing else.
    assert.deepEqual(hs.writes().map((c) => c.path), [`/join/${id("news")}`], "no rename from the old state, nothing made");
    assert.ok(r.result.drift.some((o) => o.code === "cannot_read" && o.roomId === id("news")));
  });
});

test("a room the homeserver says is not there is made again, and the new id replaces the old on its row", async () => {
  const actual = load("actual.json");
  delete actual.rooms[id("vip")];
  actual.rooms[id("talk")].children = actual.rooms[id("talk")].children.filter((c) => c.roomId !== id("vip"));
  await withFakes({ actual }, async ({ hs, site, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(r.code, 0, r.err);
    const made = [...hs.rooms.keys()].find((k) => k.startsWith("!made"));
    assert.deepEqual(site.made, [{ table: "rooms", id: 5, matrixRoomId: made, replaces: id("vip") }]);
    assert.match(r.err, /^create #vip again \(the old room is gone\)$/m);
  });
});

test("a room's listing that cannot be read fails the run: never guessed as unlisted, nothing written", async () => {
  // #general is listed; a 5xx on its listing must not read as "not listed" (apply would list it again on a guess).
  const fail = (m, p) => m === "GET" && p === `/directory/list/room/${id("general")}`;
  const feed = load("feed.json");
  feed.rooms.find((r) => r.name === "news").topic = "What is new";
  await withFakes({ feed, hs: { fail } }, async ({ hs, site, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(r.code, 2, r.err);
    assert.equal(r.result.ok, false);
    assert.match(r.result.error, /listing of !general:example\.test: 500/);
    assert.ok(hs.calls.some((c) => fail(c.method, c.path)), "vacuity: the listing was asked");
    assert.deepEqual(hs.writes(), [], "no write on a guess, the topic change included");
    assert.equal(site.runs[0].ok, false);
  });
});

test("an unreadable room is handed to the core with an empty creators list, never undefined", async () => {
  const actual = load("actual.json");
  actual.rooms[id("vip")].members[SERVICE] = "leave"; // the account left: old state, not read
  await withFakes({ actual, hs: { forbidden: new Set([id("news")]) } }, async ({ hsBase }) => {
    const hs = makeClient({ base: hsBase, token: TOKEN });
    assert.deepEqual(await readRoom(hs, id("news"), SERVICE), { unreadable: true, creators: [] }, "refused (403)");
    assert.deepEqual(await readRoom(hs, id("vip"), SERVICE), { unreadable: true, creators: [] }, "not joined");
    assert.deepEqual((await readRoom(hs, id("general"), SERVICE)).creators, [SERVICE], "vacuity: a readable room has its creators");
  });
});

test("a_room_without_a_retention_event_gets_one_even_when_the_cap_is_off", async () => {
  // Cap off (0 = no limit): a channel with no days of its own keeps messages forever, written as {}.
  // A room with NO retention event would otherwise fall to the homeserver's own default (180 days).
  const feed = load("feed.json");
  feed.retentionCapDays = 0;
  const actual = load("actual.json");
  for (const n of ["news", "lounge", "mods", "vip", "staff"]) actual.rooms[id(n)].retention = null; // an event, no limit
  delete actual.rooms[id("news")].retention; // no event at all
  await withFakes({ feed, actual }, async ({ hs, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(hs.writes().map((c) => [c.method, c.path, c.body]), [
      ["PUT", `/rooms/${id("news")}/state/m.room.retention`, {}],
    ], "only the room with no event is written; the rooms whose event is {} are left");
    assert.deepEqual(hs.stateOf(id("news"), "m.room.retention"), {});
    const before = hs.writes().length;
    assert.equal((await reconcile(["--mode", "apply"], { hsBase, webBase })).code, 0);
    assert.equal(hs.writes().length, before, "then nothing more");
  });
});

// ── Whose room ban it is: the reason on the ban ─────────────────────────────────────────────────
test("reasons_reach_the_core: the site's room bans are lifted when its ban ends, a mod's own never; a new ban carries the marker", async () => {
  const feed = load("feed.json");
  const MARK = feed.siteBanReason;
  feed.banned = [u("eve")]; // mallory's site ban ended; eve is newly banned
  const actual = load("actual.json");
  actual.rooms[id("vip")].banReasons = { [u("mallory")]: "spam, by hand" }; // a mod's own ban in #vip
  await withFakes({ feed, actual }, async ({ hs, hsBase, webBase }) => {
    const client = makeClient({ base: hsBase, token: TOKEN });
    const read = await readRoom(client, id("general"), SERVICE);
    assert.equal(read.banReasons.get(u("mallory")), MARK, "the ban event's reason, read");
    assert.equal(read.banReasons.has(u("streamer")), false, "only bans carry a reason here");

    const r = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(r.code, 0, r.err);
    const unbanned = hs.calls.filter((c) => c.method === "POST" && c.path.endsWith("/unban")).map((c) => c.path.split("/")[2]).sort();
    assert.deepEqual(unbanned, [id("gate"), id("general"), id("hub"), id("lounge"), id("mods"), id("news"), id("staff"), id("talk")].sort(),
      "every room but #vip, where the ban is a mod's own");
    assert.equal(hs.stateOf(id("vip"), "m.room.member", u("mallory")).membership, "ban");
    assert.ok(r.result.drift.some((e) => e.kind === "ban" && e.roomId === id("vip")), "the mod's ban is reported");
    const bans = hs.calls.filter((c) => c.method === "POST" && c.path.endsWith("/ban"));
    assert.equal(bans.length, 9);
    assert.ok(bans.every((c) => c.body.user_id === u("eve") && c.body.reason === MARK), "each new ban carries the site's marker");
    // Retry: the next run finds eve's bans the site's, and changes nothing.
    const before = hs.writes().length;
    assert.equal((await reconcile(["--mode", "apply"], { hsBase, webBase })).code, 0);
    assert.equal(hs.writes().length, before);
  });
});

test("missing_marker_fails_apply_and_warns_report: no site ban marker → apply writes nothing and fails; report warns", async () => {
  for (const marker of [undefined, ""]) {
    const feed = load("feed.json");
    if (marker === undefined) delete feed.siteBanReason; else feed.siteBanReason = marker;
    feed.rooms.find((r) => r.name === "news").topic = "What is new"; // something apply would otherwise do
    await withFakes({ feed }, async ({ hs, site, hsBase, webBase }) => {
      const r = await reconcile(["--mode", "apply"], { hsBase, webBase });
      assert.equal(r.code, 2, r.err);
      assert.equal(r.result.ok, false);
      assert.equal(r.result.error, "the site did not send its ban marker; nothing applied");
      assert.deepEqual(hs.writes(), [], "nothing written");
      assert.equal(site.runs.at(-1).ok, false, "the failure is in the run log");
      // A check still runs, and says so.
      const rep = await reconcile(["--mode", "report"], { hsBase, webBase });
      assert.notEqual(rep.code, 2, rep.err);
      assert.ok(rep.result.drift.some((o) => o.code === "site_ban_reason_unknown"), JSON.stringify(rep.result.drift.map((o) => o.code)));
      assert.deepEqual(hs.writes(), []);
    });
  }
});

// ── A fresh install: no hub row yet ─────────────────────────────────────────────────────────────
test("first_apply_adopts_the_hub_then_applies: no hub row → the hub (and the setup's channels) become rows, then apply builds them", async () => {
  // A fresh bundle: the setup made the hub room (the feed knows its id) but nothing has made its row,
  // and the setup's channel list waits for it. The site's /adopt route writes the hub's row and, with
  // it, the setup's channels (here: #lobby, not made yet).
  const feed = load("feed.json");
  feed.spaces = []; feed.rooms = [];
  const actual = load("actual.json");
  actual.rooms = { [id("hub")]: { ...actual.rooms[id("hub")], children: [] } };
  actual.hub.children = [];
  const onAdopt = (op, f) => {
    if (op.op !== "adoptRow" || op.table !== "spaces" || op.row.kind !== "hub") return;
    f.spaces.push({ id: 1, parentId: null, ...op.row, orderKey: "a0" });
    f.rooms.push({ id: 1, spaceId: 1, kind: "text", name: "lobby", topic: null, avatarMxc: null, orderKey: "a0", see: "everyone", post: "everyone",
      retentionDays: null, encrypted: false, published: false, archived: false, matrixRoomId: null, discordChannelId: null });
  };
  await withFakes({ feed, actual, site: { onAdopt } }, async ({ hs, site, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /^first run: adopted the hub$/m);
    assert.equal(site.adopted.length, 1, "the hub, once");
    assert.equal(site.adopted[0].row.kind, "hub");
    assert.equal(site.calls.filter((c) => c.path === "/api/internal/community/desired").length, 2, "the feed read again after the adopt");
    const lobby = site.made.find((m) => m.table === "rooms" && m.id === 1);
    assert.ok(lobby, "the setup's channel was made in the same run");
    assert.deepEqual(hs.stateOf(id("hub"), "m.space.child", lobby.matrixRoomId)?.via, [S]);
    assert.equal(site.runs.length, 1, "one run, one row");
    assert.equal(site.runs[0].mode, "apply");
    assert.deepEqual(site.runs[0].applied.map((o) => o.op).slice(0, 2), ["adoptRow", "createRoom"]);

    // A second run: the hub has its row; no adopt, nothing to write.
    const writes = hs.writes().length;
    const again = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(again.code, 0, again.err);
    assert.equal(site.adopted.length, 1, "no adopt the second time");
    assert.doesNotMatch(again.err, /first run/);
    assert.equal(hs.writes().length, writes);
  });
  // Report never adopts (it changes nothing).
  const f2 = load("feed.json"); f2.spaces = []; f2.rooms = [];
  await withFakes({ feed: f2 }, async ({ site, hsBase, webBase }) => {
    await reconcile(["--mode", "report"], { hsBase, webBase });
    assert.equal(site.adopted.length, 0);
  });
});

// ── Installs shaped like the real ones (fixtures/community/shapes.mjs) ───────────────────────────
/** A site that turns each adoptRow into a row, as the real /adopt route does. */
const rowsFromAdopt = (op, f) => {
  if (op.op !== "adoptRow") return;
  if (op.table === "spaces") f.spaces.push({ id: f.spaces.length + 1, parentId: null, ...op.row });
  else f.rooms.push({ id: f.rooms.length + 1, spaceId: null, ...op.row });
};
const powerOf = (hs, rid) => hs.stateOf(rid, "m.room.power_levels");

test("bundle_shaped: the bootstrap's invites are accepted on the first run, the rooms imported, and the service keeps its 100", async () => {
  const { feed, actual } = bundleShaped();
  for (const r of Object.values(actual.rooms)) { r.members[SERVICE] = "invite"; r.inviters = { [SERVICE]: u("streamer") }; } // the bootstrap's invites, not joined
  // An invite to a room outside the community is never accepted.
  actual.rooms[id("elsewhere")] = { name: "elsewhere", creators: [u("stranger")], members: { [u("stranger")]: "join", [SERVICE]: "invite" }, inviters: { [SERVICE]: u("stranger") } };
  await withFakes({ feed, actual, site: { onAdopt: rowsFromAdopt } }, async ({ hs, site, hsBase, webBase }) => {
    // A report first (the proving order): it joins what it was invited to, so it can read the rooms.
    const rep = await reconcile(["--mode", "report"], { hsBase, webBase });
    assert.equal(rep.result.ok, true, rep.err);
    const joins = hs.writes().map((c) => c.path).sort();
    assert.deepEqual(joins, [`/join/${id("bforum")}`, `/join/${id("bgeneral")}`, `/join/${id("bhub")}`].sort(), "report writes nothing but the account's own joins");
    assert.ok(!rep.result.drift.some((d) => d.code === "no_hub_access" || d.code === "cannot_read"), JSON.stringify(rep.result.drift));
    assert.ok(rep.result.drift.some((d) => d.code === "not_in_panel" && d.roomId === id("bgeneral")), "it can see what adopt would import");
    assert.deepEqual(rep.result.drift.filter((d) => d.code === "invite_ignored").map((d) => [d.roomId, d.inviter]), [[id("elsewhere"), u("stranger")]]);
    assert.equal(site.adopted.length, 0, "report never adopts");
    // apply: the first run adopts all three, reads the feed again, then keeps them.
    const r = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(site.adopted.map((o) => [o.table, o.row.kind]), [["spaces", "hub"], ["rooms", "text"], ["rooms", "forum"]]);
    for (const rid of [id("bhub"), id("bgeneral"), id("bforum")]) {
      assert.equal(powerOf(hs, rid).users[SERVICE], 100, `the service keeps 100 in ${rid}`);
      assert.equal(powerOf(hs, rid).users[u("streamer")], undefined, "the creator is never listed");
    }
    assert.ok(r.result.applied.some((o) => o.op === "setPowerLevels"), "vacuity: power was written");
    assert.deepEqual(r.result.applied.filter((o) => o.putBack).map((o) => o.said), [], "the bootstrap's rooms: nothing put back on the first run");
    // Retry: the next apply writes nothing and joins nothing.
    const before = hs.writes().length;
    const again = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(again.code, 0, again.err);
    assert.equal(hs.writes().length, before, JSON.stringify(hs.writes().slice(before)));
  });
});

test("no_hub_access_warns_and_writes_nothing (bundle_shaped): the hub not readable and no row, never a silent green", async () => {
  const { feed, actual } = bundleShaped();
  for (const r of Object.values(actual.rooms)) delete r.members[SERVICE]; // never invited
  await withFakes({ feed, actual, site: { onAdopt: rowsFromAdopt } }, async ({ hs, site, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(r.code, 0, r.err);
    assert.ok(r.result.drift.some((d) => d.op === "warn" && d.code === "no_hub_access"), JSON.stringify(r.result.drift));
    assert.equal(site.adopted.length, 0);
    assert.deepEqual(hs.writes().map((c) => c.path), [`/join/${id("bhub")}`], "one refused try to get into the hub; nothing else");
  });
});

test("owner_shaped through the command: the streamer's rooms, a bridged room and a hand-granted 100", async () => {
  const { feed, actual } = ownerShaped();
  // The bridge's bot is named in the bridged room's m.bridge state, sent by the bot itself (at 100).
  const br = actual.rooms[id("obridged")];
  br.bridges = [{ sender: u("discordbot"), bridgebot: u("discordbot") }];
  delete br.bridgeHints;
  await withFakes({ feed, actual }, async ({ hs, hsBase, webBase }) => {
    const rep = await reconcile(["--mode", "report"], { hsBase, webBase });
    assert.equal(rep.code, 1, rep.err);
    assert.deepEqual(hs.writes(), [], "report writes nothing");
    const r = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(r.code, 0, r.err);
    for (const n of ["ohub", "ogeneral", "obridged", "omodchat"]) {
      const pl = powerOf(hs, id(n));
      assert.equal(pl.users[SERVICE], 100, `the service keeps 100 in ${n}`);
      assert.equal(pl.users[u("oldadmin")], 100, `a hand-granted 100 is out of reach in ${n}`);
      assert.equal(pl.users[u("streamer")], undefined);
    }
    assert.equal(powerOf(hs, id("obridged")).users[u("discordbot")], 100, "the bridge's bot keeps its grant");
    assert.equal(powerOf(hs, id("obridged")).users[u("discord_123")], undefined, "no patterns: an unknown grant is not kept");
    assert.ok(!r.result.drift.some((d) => d.code === "bridge_accounts_unknown"), "the bridge is listed: no bridge gap");
    assert.equal(hs.stateOf(id("obridged"), "m.room.member", u("discordbot")).membership, "join");
    assert.ok(r.result.drift.some((d) => d.code === "grant_out_of_reach" && d.roomId === id("ogeneral")));
    const again = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(again.code, 0, again.err);
    assert.deepEqual(again.result.applied, [], "the second apply writes nothing");
  });
});

test("readRoom reads the bots a room's bridge state names, whoever sent it, as a hint only", async () => {
  const actual = load("actual.json");
  actual.rooms[id("general")].bridges = [
    { sender: u("bot1"), bridgebot: u("bot1") },
    { sender: u("moddy"), bridgebot: u("moddy") },
    { sender: SERVICE, bridgebot: u("bot2"), type: "uk.half-shot.bridge" },
    { sender: u("streamer"), bridgebot: "not an id" },
  ];
  await withFakes({ actual }, async ({ hsBase }) => {
    const hs = makeClient({ base: hsBase, token: TOKEN });
    const g = await readRoom(hs, id("general"), SERVICE);
    assert.deepEqual(g.bridgeHints, [u("bot1"), u("bot2"), u("moddy")]);
    assert.equal(g.bridgeBots, undefined, "nothing read from a room is trusted as a bridge account");
    assert.deepEqual((await readRoom(hs, id("news"), SERVICE)).bridgeHints, [], "vacuity: a room with no bridge names none");
  });
});

// ── Invites: only the community's rooms are joined ──────────────────────────────────────────────
/** A hub the streamer made (service joined at 100 there), `n` rooms linked under it, each with the
 *  service invited by `inviter`; the feed names only the hub. */
function invitedCommunity(n, inviter = u("streamer"), linkedBy = u("streamer")) {
  const { feed, actual } = ownerShaped();
  feed.rooms = [];
  const hub = actual.rooms[id("ohub")];
  const children = Array.from({ length: n }, (_, i) => ({ roomId: id(`c${i + 1}`), order: `a${i}`, via: [S], by: linkedBy }));
  hub.children = children; actual.hub.children = children;
  for (const k of Object.keys(actual.rooms)) if (k !== id("ohub")) delete actual.rooms[k];
  for (const ch of children) {
    actual.rooms[ch.roomId] = { ...structuredClone(actual.rooms[id("ohub")]), name: ch.roomId.slice(1, 4), type: undefined, spaceKind: undefined, children: [],
      joinRule: "restricted", allow: [{ type: "m.room_membership", room_id: id("ohub") }], retention: 365 * 86400000,
      members: { [u("streamer")]: "join", [SERVICE]: "invite" }, inviters: { [SERVICE]: inviter } };
  }
  return { feed, actual };
}

test("first_owner_shaped_run_joins_eleven_rooms: the streamer (the hub's creator) invited the account into the hub's eleven rooms", async () => {
  const { feed, actual } = invitedCommunity(11);
  await withFakes({ feed, actual, site: { onAdopt: rowsFromAdopt } }, async ({ hs, site, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "report"], { hsBase, webBase });
    assert.equal(r.result.ok, true, r.err);
    const joined = hs.writes().filter((c) => c.path.startsWith("/join/")).map((c) => c.path).sort();
    assert.equal(joined.length, 11, JSON.stringify(joined));
    assert.ok(!r.result.drift.some((d) => d.code === "cannot_read" || d.code === "invite_ignored"), JSON.stringify(r.result.drift.filter((d) => d.op === "warn")));
    const ad = await reconcile(["--mode", "adopt"], { hsBase, webBase });
    assert.equal(ad.code, 0, ad.err);
    assert.equal(site.adopted.length, 11, "every one of them imported");
  });
});

test("joins_hub_child_invited_by_hub_admin: a hub child its admin linked is joined; one a mod linked is not", async () => {
  // The hub vouches for a child by who linked it there (the invite's own sender cannot be read: Synapse
  // refuses /sync to an appservice's sender). A mod (50) can link a child; that is not enough.
  const { feed, actual } = invitedCommunity(2);
  actual.hub.children[1].by = u("moddy");
  actual.rooms[id("ohub")].children[1].by = u("moddy");
  actual.rooms[id("c2")].inviters = { [SERVICE]: u("moddy") };
  await withFakes({ feed, actual }, async ({ hs, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "report"], { hsBase, webBase });
    assert.equal(r.result.ok, true, r.err);
    assert.deepEqual(hs.writes().map((c) => c.path), [`/join/${id("c1")}`]);
    // Linked into the hub but not joined: listed once, from the hub's links (never also as an invite).
    assert.deepEqual(r.result.drift.filter((d) => d.code === "not_joined").map((d) => d.roomId), [id("c2")]);
    assert.deepEqual(r.result.drift.filter((d) => d.code === "invite_ignored"), []);
  });
  // oldadmin holds 100 in the fixture's hub: an admin there, not its creator.
  const admin = invitedCommunity(1, u("oldadmin"), u("oldadmin"));
  await withFakes(admin, async ({ hs, hsBase, webBase }) => {
    await reconcile(["--mode", "report"], { hsBase, webBase });
    assert.deepEqual(hs.writes().map((c) => c.path), [`/join/${id("c1")}`], "a child a hub admin linked is joined");
  });
});

test("an appservice sender cannot sync: the run still joins the community's rooms, and says nothing about it", async () => {
  // Synapse answers /sync for an appservice's own sender with 500 (NotImplementedError).
  const { feed, actual } = invitedCommunity(2);
  const fail = (m, p) => m === "GET" && p === "/sync";
  await withFakes({ feed, actual, hs: { fail } }, async ({ hs, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "report"], { hsBase, webBase });
    assert.equal(r.result.ok, true, r.err);
    assert.ok(hs.calls.some((c) => c.path === "/sync"), "vacuity: it asked");
    assert.deepEqual(hs.writes().map((c) => c.path).sort(), [`/join/${id("c1")}`, `/join/${id("c2")}`]);
    assert.doesNotMatch(r.err, /pending invites/);
  });
});

test("ignores_invite_from_stranger_room: an invite outside the hub's own rooms is never joined, only said", async () => {
  const { feed, actual } = invitedCommunity(1);
  // A stranger's room, and a room linked under a non-hub space (a stranger's child link), both inviting.
  actual.rooms[id("stranger")] = { name: "free stuff", creators: [u("stranger")], members: { [u("stranger")]: "join", [SERVICE]: "invite" }, inviters: { [SERVICE]: u("stranger") } };
  const c1 = actual.rooms[id("c1")];
  c1.members[SERVICE] = "join"; delete c1.inviters;
  c1.type = "m.space"; c1.children = [{ roomId: id("deep"), order: null, via: [S], by: u("stranger") }];
  actual.rooms[id("deep")] = { name: "deep", creators: [u("streamer")], members: { [u("streamer")]: "join", [SERVICE]: "invite" }, inviters: { [SERVICE]: u("streamer") } };
  await withFakes({ feed, actual }, async ({ hs, hsBase, webBase }) => {
    for (const mode of ["report", "apply"]) {
      const r = await reconcile(["--mode", mode], { hsBase, webBase });
      assert.ok(r.result, r.err);
      assert.deepEqual(hs.writes().filter((c) => c.path.startsWith("/join/")), [], `${mode}: joined nothing`);
      // The account's own sync works here (a plain-token account, as on an install older than the
      // bundle): the stranger's invite is listed; the room under a space in the hub is "not joined".
      assert.deepEqual(r.result.drift.filter((d) => d.code === "invite_ignored").map((d) => d.roomId), [id("stranger")]);
      assert.match(r.result.drift.find((d) => d.roomId === id("stranger")).said, /from @stranger:example\.test was left as it is/);
      assert.deepEqual(r.result.drift.filter((d) => d.code === "not_joined").map((d) => d.roomId), [id("deep")]);
    }
  });
});

test("stranger_invite_unlisted_on_an_appservice: no sync, so a stranger's invite stays pending and is never listed; a room linked into the hub it is not in is not_joined", async () => {
  const { feed, actual } = invitedCommunity(2);
  actual.hub.children[1].by = u("moddy"); // linked by a mod: not the hub's word, so never joined
  actual.rooms[id("ohub")].children[1].by = u("moddy");
  actual.rooms[id("stranger")] = { name: "free stuff", creators: [u("stranger")], members: { [u("stranger")]: "join", [SERVICE]: "invite" }, inviters: { [SERVICE]: u("stranger") } };
  const fail = (m, p) => m === "GET" && p === "/sync"; // Synapse answers an appservice's own /sync with 500
  await withFakes({ feed, actual, hs: { fail } }, async ({ hs, hsBase, webBase }) => {
    for (const mode of ["report", "apply"]) {
      const r = await reconcile(["--mode", mode], { hsBase, webBase });
      assert.equal(r.result.ok, true, r.err);
      assert.deepEqual(hs.writes().filter((c) => c.path.startsWith("/join/")).map((c) => c.path), [`/join/${id("c1")}`], `${mode}: only the hub's own room`);
      assert.equal(hs.stateOf(id("stranger"), "m.room.member", SERVICE).membership, "invite", "the stranger's invite stays pending");
      assert.ok(!r.result.drift.some((d) => d.roomId === id("stranger")), `${mode}: the stranger's room is never listed`);
      assert.deepEqual(r.result.drift.filter((d) => d.code === "not_joined").map((d) => d.roomId), [id("c2")]);
      assert.deepEqual(r.result.drift.filter((d) => d.code === "invite_ignored"), []);
    }
  });
});

// ── Invites: rooms nested under the hub's categories (Task 1.13b) ───────────────────────────────
// Who may pull the account into a room is the property; how deep the room sits is not. A room the
// account cannot read is joined when the community's own link tree reaches it (hub → a space the run
// accepted or a row names → …) AND the link into its parent was sent by the hub's creator or someone
// at 100 in the HUB's power levels, whichever accepted space the link lives in.
/** invitedCommunity(1) with c1 made a category the account is already in, and `deep` linked under it
 *  by `linkedBy`, the account invited there. */
function nestedCommunity(linkedBy = u("streamer")) {
  const { feed, actual } = invitedCommunity(1);
  const c1 = actual.rooms[id("c1")];
  c1.members[SERVICE] = "join"; delete c1.inviters;
  c1.type = "m.space"; c1.spaceKind = "category";
  c1.children = [{ roomId: id("deep"), order: null, via: [S], by: linkedBy }];
  actual.rooms[id("deep")] = { name: "deep", creators: [u("streamer")], members: { [u("streamer")]: "join", [SERVICE]: "invite" }, inviters: { [SERVICE]: u("streamer") } };
  return { feed, actual };
}
/** A room's power levels with only `users` changed. */
const withUsers = (pl, users) => ({ ...structuredClone(pl), users });
const joinsOf = (hs) => hs.writes().filter((c) => c.path.startsWith("/join/")).map((c) => c.path).sort();
const codesOf = (r, code) => r.result.drift.filter((d) => d.code === code).map((d) => d.roomId).sort();

test("nested_room_linked_by_hub_creator_is_joined: a room under an accepted category, linked by the hub's creator, is joined and read", async () => {
  await withFakes({ ...nestedCommunity(), site: { onAdopt: rowsFromAdopt } }, async ({ hs, site, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "report"], { hsBase, webBase });
    assert.equal(r.result.ok, true, r.err);
    assert.deepEqual(joinsOf(hs), [`/join/${id("deep")}`]);
    assert.equal(hs.stateOf(id("deep"), "m.room.member", SERVICE).membership, "join");
    // Read after the join: in the community, not in the panel (adopt's), never "not kept".
    assert.deepEqual(codesOf(r, "not_joined"), []);
    assert.ok(codesOf(r, "not_in_panel").includes(id("deep")), JSON.stringify(r.result.drift.filter((d) => d.op === "warn")));
    assert.ok(r.err.includes(`joined ${id("deep")}: the community's account was let in`), r.err);
    const ad = await reconcile(["--mode", "adopt"], { hsBase, webBase });
    assert.equal(ad.code, 0, ad.err);
    assert.ok(site.adopted.some((a) => JSON.stringify(a).includes(id("deep"))), `adopt imports it: ${JSON.stringify(site.adopted)}`);
  });
});

test("nested_room_linked_without_hub_power_is_not_joined: a link by someone with no power in the hub joins nothing", async () => {
  // A stranger, and catadmin: 100 in the CATEGORY but nothing in the hub. Only the hub's word counts.
  for (const who of [u("stranger"), u("catadmin")]) {
    const shape = nestedCommunity(who);
    const c1 = shape.actual.rooms[id("c1")];
    c1.powerLevels = withUsers(c1.powerLevels, { [SERVICE]: 100, [u("catadmin")]: 100 });
    await withFakes(shape, async ({ hs, hsBase, webBase }) => {
      const r = await reconcile(["--mode", "report"], { hsBase, webBase });
      assert.equal(r.result.ok, true, r.err);
      assert.deepEqual(joinsOf(hs), [], `${who}: no join request sent`);
      assert.deepEqual(codesOf(r, "not_joined"), [id("deep")], who);
      assert.deepEqual(codesOf(r, "invite_ignored"), [], `${who}: listed once, as not_joined`);
      assert.equal(hs.stateOf(id("deep"), "m.room.member", SERVICE).membership, "invite", "the invite stays pending");
    });
  }
});

test("nested_room_linked_by_hub_admin_is_joined: 100 in the hub, not its creator, and no power in the category", async () => {
  const shape = nestedCommunity(u("oldadmin"));
  // oldadmin holds 100 in the hub (the fixture); the category gives it nothing: the hub's levels decide.
  const c1 = shape.actual.rooms[id("c1")];
  c1.powerLevels = withUsers(c1.powerLevels, { [SERVICE]: 100 });
  assert.equal(shape.actual.rooms[id("ohub")].powerLevels.users[u("oldadmin")], 100, "vacuity: an admin of the hub");
  assert.ok(!shape.actual.rooms[id("ohub")].creators.includes(u("oldadmin")), "vacuity: not its creator");
  await withFakes(shape, async ({ hs, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "report"], { hsBase, webBase });
    assert.equal(r.result.ok, true, r.err);
    assert.deepEqual(joinsOf(hs), [`/join/${id("deep")}`]);
    assert.deepEqual(codesOf(r, "not_joined"), []);
  });
});

test("nested_two_levels_down_is_joined: hub → category → sub-space → room, every link by the creator, the account invited to both", async () => {
  const { feed, actual } = nestedCommunity();
  // The sub-space sits between the category and the room; the account is only invited there too.
  actual.rooms[id("c1")].children = [{ roomId: id("sub"), order: null, via: [S], by: u("streamer") }];
  actual.rooms[id("sub")] = { name: "sub", type: "m.space", creators: [u("streamer")], members: { [u("streamer")]: "join", [SERVICE]: "invite" },
    inviters: { [SERVICE]: u("streamer") }, children: [{ roomId: id("deep"), order: null, via: [S], by: u("streamer") }] };
  await withFakes({ feed, actual }, async ({ hs, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "report"], { hsBase, webBase });
    assert.equal(r.result.ok, true, r.err);
    // The sub-space first (its links are known only once it is read), then the room under it.
    assert.deepEqual(hs.writes().map((c) => c.path), [`/join/${id("sub")}`, `/join/${id("deep")}`]);
    assert.deepEqual(codesOf(r, "not_joined"), []);
  });
});

test("hub_direct_child_still_joined_beside_nested: the hub's own child and a nested one are both joined (regression)", async () => {
  const { feed, actual } = nestedCommunity();
  const hub = actual.rooms[id("ohub")];
  hub.children.push({ roomId: id("c2"), order: "b0", via: [S], by: u("streamer") }); actual.hub.children = hub.children;
  actual.rooms[id("c2")] = { ...structuredClone(actual.rooms[id("deep")]), name: "c2" };
  await withFakes({ feed, actual }, async ({ hs, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "report"], { hsBase, webBase });
    assert.equal(r.result.ok, true, r.err);
    assert.deepEqual(joinsOf(hs), [`/join/${id("c2")}`, `/join/${id("deep")}`]);
    assert.deepEqual(codesOf(r, "not_joined"), []);
  });
});

test("nested_under_unvouched_space_is_not_joined: a space the hub's word did not bring in hands out nothing, even one the account is in", async () => {
  // c1 itself linked into the hub by a stranger: the account happens to be in it (readable), but the run
  // never accepted it, so the creator's link under it does not reach the community's tree.
  const { feed, actual } = nestedCommunity();
  const hub = actual.rooms[id("ohub")];
  hub.children[0].by = u("stranger"); actual.hub.children = hub.children;
  await withFakes({ feed, actual }, async ({ hs, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "report"], { hsBase, webBase });
    assert.equal(r.result.ok, true, r.err);
    assert.deepEqual(joinsOf(hs), []);
    assert.deepEqual(codesOf(r, "not_joined"), [id("deep")]);
  });
});

/** nestedCommunity with c1 a PANEL ROW (a category in the feed, as adopt leaves it) and its own link in
 *  the hub sent by a stranger: c1 is the community's only because the panel names it, never through
 *  the hub's link, so a link inside it is judged by its sender alone. */
function panelCategoryCommunity(linkedBy) {
  const shape = nestedCommunity(linkedBy);
  const hub = shape.actual.rooms[id("ohub")];
  hub.children[0].by = u("stranger"); shape.actual.hub.children = hub.children;
  shape.feed.spaces.push({ id: 2, parentId: 1, kind: "category", name: shape.actual.rooms[id("c1")].name, topic: null, avatarMxc: null,
    orderKey: "a0", matrixRoomId: id("c1"), gateTier: null });
  return shape;
}

test("panel_category_link_without_hub_power_is_not_joined: inside a category the panel knows, a link by someone with no hub power joins nothing", async () => {
  for (const who of [u("stranger"), u("catadmin")]) {
    const shape = panelCategoryCommunity(who);
    const c1 = shape.actual.rooms[id("c1")];
    c1.powerLevels = withUsers(c1.powerLevels, { [SERVICE]: 100, [u("catadmin")]: 100 });
    await withFakes(shape, async ({ hs, hsBase, webBase }) => {
      const r = await reconcile(["--mode", "report"], { hsBase, webBase });
      assert.equal(r.result.ok, true, r.err);
      assert.ok(hs.calls.some((c) => c.path === `/rooms/${id("deep")}/state`), `${who}: vacuity: the category was read and its link walked`);
      assert.deepEqual(joinsOf(hs), [], `${who}: no join request sent`);
      assert.deepEqual(codesOf(r, "not_joined"), [id("deep")], who);
      assert.equal(hs.stateOf(id("deep"), "m.room.member", SERVICE).membership, "invite", "the invite stays pending");
    });
  }
});

test("panel_category_link_by_hub_admin_is_joined: inside a category the panel knows, a link by the creator or a hub admin is joined", async () => {
  for (const who of [u("streamer"), u("oldadmin")]) {
    const shape = panelCategoryCommunity(who);
    const c1 = shape.actual.rooms[id("c1")];
    c1.powerLevels = withUsers(c1.powerLevels, { [SERVICE]: 100 });
    await withFakes(shape, async ({ hs, hsBase, webBase }) => {
      const r = await reconcile(["--mode", "report"], { hsBase, webBase });
      assert.equal(r.result.ok, true, r.err);
      assert.deepEqual(joinsOf(hs), [`/join/${id("deep")}`], who);
      assert.deepEqual(codesOf(r, "not_joined"), [], who);
    });
  }
});

test("nested_reached_first_through_unvouched_space_is_still_joined: a later vouched link to the same room wins", async () => {
  // The hub lists x (a stranger's link, the account in it) BEFORE c1 (the creator's); both link deep.
  // The walk meets deep through x first; the creator's link through c1 still brings it in.
  const { feed, actual } = nestedCommunity();
  const hub = actual.rooms[id("ohub")];
  hub.children.unshift({ roomId: id("x"), order: "0", via: [S], by: u("stranger") }); actual.hub.children = hub.children;
  actual.rooms[id("x")] = { name: "x", type: "m.space", creators: [u("stranger")], members: { [u("stranger")]: "join", [SERVICE]: "join" },
    children: [{ roomId: id("deep"), order: null, via: [S], by: u("stranger") }] };
  await withFakes({ feed, actual }, async ({ hs, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "report"], { hsBase, webBase });
    assert.equal(r.result.ok, true, r.err);
    assert.deepEqual(joinsOf(hs), [`/join/${id("deep")}`]);
    assert.deepEqual(codesOf(r, "not_joined"), []);
  });
});

test("removed_link_vouches_for_nothing: a link the creator emptied (no via) joins nothing, in the hub or under a category", async () => {
  // Removing a child leaves an m.space.child with empty content whose sender is still the admin who
  // removed it: that is them taking the room out, never them linking it.
  const { feed, actual } = nestedCommunity();
  actual.rooms[id("c1")].children = [{ roomId: id("deep"), order: null, via: undefined, by: u("streamer") }];
  const hub = actual.rooms[id("ohub")];
  hub.children.push({ roomId: id("gone"), order: null, via: undefined, by: u("streamer") }); actual.hub.children = hub.children;
  actual.rooms[id("gone")] = { ...structuredClone(actual.rooms[id("deep")]), name: "gone" };
  await withFakes({ feed, actual }, async ({ hs, hsBase, webBase }) => {
    assert.equal(JSON.stringify(hs.stateOf(id("c1"), "m.space.child", id("deep"))), "{}", "vacuity: the removed link is served as an empty event");
    const r = await reconcile(["--mode", "report"], { hsBase, webBase });
    assert.equal(r.result.ok, true, r.err);
    assert.ok(hs.calls.some((c) => c.path === `/rooms/${id("deep")}/state`), "vacuity: the removed child was looked at");
    assert.deepEqual(joinsOf(hs), [], "no join request sent");
    assert.deepEqual(codesOf(r, "not_joined"), [], "not linked into the community, so not said as not joined");
    // Outside the community's links: the account's own sync lists both as invites left as they are.
    assert.deepEqual(codesOf(r, "invite_ignored"), [id("deep"), id("gone")]);
  });
});

test("nested_restart: the run after the join reads the nested room as it is and joins nothing more", async () => {
  await withFakes(nestedCommunity(), async ({ hs, hsBase, webBase }) => {
    const first = await reconcile(["--mode", "report"], { hsBase, webBase });
    assert.equal(first.result.ok, true, first.err);
    const before = hs.writes().length;
    assert.equal(before, 1, "vacuity: the first run joined");
    const again = await reconcile(["--mode", "report"], { hsBase, webBase });
    assert.equal(again.result.ok, true, again.err);
    assert.deepEqual(hs.writes().slice(before), [], "nothing more");
    assert.deepEqual(codesOf(again, "not_joined"), []);
    assert.ok(codesOf(again, "not_in_panel").includes(id("deep")));
  });
});

test("nested_retry: a refused join leaves the room not_joined; the next run joins it", async () => {
  let refusals = 1;
  const fail = (m, p) => m === "POST" && p === `/join/${id("deep")}` && refusals-- > 0;
  await withFakes({ ...nestedCommunity(), hs: { fail } }, async ({ hs, hsBase, webBase }) => {
    const first = await reconcile(["--mode", "report"], { hsBase, webBase });
    assert.equal(first.result.ok, true, first.err);
    assert.equal(refusals, 0, "vacuity: the join was asked for and refused");
    assert.equal(hs.stateOf(id("deep"), "m.room.member", SERVICE).membership, "invite", "the refused join changed nothing");
    assert.deepEqual(codesOf(first, "not_joined"), [id("deep")]);
    const again = await reconcile(["--mode", "report"], { hsBase, webBase });
    assert.equal(again.result.ok, true, again.err);
    assert.equal(hs.stateOf(id("deep"), "m.room.member", SERVICE).membership, "join");
    assert.deepEqual(codesOf(again, "not_joined"), []);
  });
});

// ── The space-kind marker ───────────────────────────────────────────────────────────────────────
test("a space without its kind marker gets one; a space made here carries it from the start; then nothing more", async () => {
  const actual = load("actual.json");
  delete actual.rooms[id("talk")].spaceKind;
  delete actual.rooms[id("gate")];
  await withFakes({ actual }, async ({ hs, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(hs.stateOf(id("talk"), "app.blackbranch.space_kind"), { kind: "category" });
    const gate = [...hs.rooms.keys()].find((k) => k.startsWith("!made"));
    assert.equal(hs.stateOf(gate, "m.room.create")["app.blackbranch.space_kind"], "gate", "in the create, read back as the kind");
    const before = hs.writes().length;
    const again = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(again.code, 0, again.err);
    assert.deepEqual(hs.writes().slice(before), [], "the marker read from the create and the state event: nothing to write");
  });
});

test("the hub refusing its marker (the streamer's room): said, and the rest of the run goes on", async () => {
  const feed = load("feed.json");
  feed.rooms.find((r) => r.name === "news").topic = "What is new";
  const actual = load("actual.json");
  delete actual.rooms[id("hub")].spaceKind;
  const refuse = (m, p) => m === "PUT" && p === `/rooms/${id("hub")}/state/app.blackbranch.space_kind`;
  await withFakes({ feed, actual, hs: { refuse } }, async ({ hs, site, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.result.ok, true);
    assert.ok(hs.calls.some((c) => refuse(c.method, c.path)), "vacuity: the marker was tried");
    assert.ok(r.result.drift.some((o) => o.code === "cannot_write" && o.roomId === id("hub")), JSON.stringify(r.result.drift));
    assert.ok(!r.result.applied.some((o) => o.op === "setState"), "not listed as done");
    assert.equal(hs.stateOf(id("news"), "m.room.topic").topic, "What is new", "the op after it still ran");
    assert.equal(site.runs[0].ok, true);
  });
  // Any other refusal fails the run (not ok, exit 1), its room only.
  const fail = (m, p) => m === "PUT" && p === `/rooms/${id("news")}/state/m.room.topic`;
  await withFakes({ feed: (() => { const f = load("feed.json"); f.rooms.find((x) => x.name === "news").topic = "x"; return f; })(), hs: { refuse: fail } }, async ({ hsBase, webBase }) => {
    const r = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(r.code, 1, r.err);
    assert.equal(r.result.ok, false);
    assert.ok(r.result.drift.some((o) => o.code === "op_failed" && o.roomId === id("news")));
  });
});

test("the run log carries each entry's plain sentence (`said`), as the panel shows it", async () => {
  const feed = load("feed.json");
  feed.rooms.find((r) => r.name === "general").name = "lobby";
  await withFakes({ feed }, async ({ site, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(r.code, 0, r.err);
    const rename = site.runs[0].applied.find((o) => o.op === "rename");
    assert.ok(rename, JSON.stringify(site.runs[0].applied));
    assert.equal(rename.said, "rename #general to #lobby");
    assert.equal(rename.putBack, true, "a rename of a room that exists undoes a hand-made name: the panel says Put back");
    for (const o of [...site.runs[0].applied, ...site.runs[0].drift]) assert.equal(typeof o.said, "string", JSON.stringify(o));
  });
  const reported = load("feed.json");
  reported.rooms.push(eventsRow());
  await withFakes({ feed: reported }, async ({ site, hsBase, webBase }) => {
    await reconcile(["--mode", "report"], { hsBase, webBase });
    assert.ok(site.runs[0].drift.some((o) => o.said === "create #events"), JSON.stringify(site.runs[0].drift));
  });
});

// ── Partial apply: restart and retry ────────────────────────────────────────────────────────────
test("partial apply: a refused op fails its room only; the other rooms are done; the run ends not ok (exit 1)", async () => {
  const feed = load("feed.json");
  feed.rooms.find((r) => r.name === "general").name = "lobby";
  const news = feed.rooms.find((r) => r.name === "news");
  news.topic = "What is new"; news.published = false;
  // The topic write fails: #news's later ops (its listing) wait; #general and every other room are done.
  const fail = (m, p) => m === "PUT" && p === `/rooms/${id("news")}/state/m.room.topic`;
  await withFakes({ feed, hs: { fail } }, async ({ hs, site, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(r.code, 1, r.err);
    assert.equal(r.result.ok, false);
    assert.match(r.result.error, /1 change the homeserver refused \(#news\); every other room was done/);
    assert.deepEqual(r.result.applied.map((o) => o.op), ["rename"]);
    const failed = r.result.drift.filter((o) => o.code === "op_failed");
    assert.deepEqual(failed.map((o) => [o.roomId, o.failed.op, o.failed.status]), [[id("news"), "setTopic", 500]]);
    assert.match(failed[0].failed.body, /the fake says no/, "the homeserver's answer, cut short");
    assert.ok(!hs.calls.some((c) => c.method === "PUT" && c.path === `/directory/list/room/${id("news")}`), "the rest of #news was not tried");
    assert.match(r.err, /^skipped \(its room failed earlier in this run\): take #news out of the public room directory$/m);
    assert.equal(site.runs.length, 1);
    assert.equal(site.runs[0].ok, false);
    assert.deepEqual(site.runs[0].applied.map((o) => o.op), ["rename"]);
    assert.equal(hs.stateOf(id("general"), "m.room.name").name, "lobby");
  });
});

test("failure_in_one_room_isolated: #general refuses its power levels, #news still gets the ban", async () => {
  const feed = load("feed.json");
  feed.people.push({ userId: u("newmod"), level: 50 }); // every room's ladder changes (power ops come before bans)
  feed.banned.push(u("eve"));
  const refuse = (m, p) => m === "PUT" && p === `/rooms/${id("general")}/state/m.room.power_levels`;
  await withFakes({ feed, hs: { refuse } }, async ({ hs, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(r.code, 1, r.err);
    assert.ok(hs.calls.some((c) => refuse(c.method, c.path)), "vacuity: #general's power write was tried");
    const banned = (rid) => hs.stateOf(rid, "m.room.member", u("eve"))?.membership === "ban";
    assert.ok(banned(id("news")), "#news got its ban");
    assert.ok(banned(id("hub")) && banned(id("staff")), "and every other room");
    assert.ok(!banned(id("general")), "#general's own ops wait for the next run");
    const f = r.result.drift.find((o) => o.code === "op_failed");
    assert.deepEqual([f.roomId, f.failed.op, f.failed.status, f.failed.errcode], [id("general"), "setPowerLevels", 403, "M_FORBIDDEN"]);
  });
});

test("a rate-limited op is waited out when the wait is short; a long one fails its room at once", async () => {
  const feed = load("feed.json");
  feed.banned.push(u("eve"));
  let left = 1; // the first ban answers 429 (1.2 s) once, then the homeserver takes it
  const limit = (m, p) => (m === "POST" && p.endsWith("/ban") && left-- > 0 ? 1200 : null);
  await withFakes({ feed, hs: { limit } }, async ({ hs, hsBase, webBase }) => {
    const started = Date.now();
    const r = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.result.ok, true);
    assert.ok(Date.now() - started >= 1200, "it waited as the server asked");
    const bans = hs.calls.filter((c) => c.method === "POST" && c.path.endsWith("/ban"));
    assert.equal(bans.length, r.result.applied.filter((o) => o.op === "ban").length + 1, "the refused one was sent again, once");
  });
  // A wait longer than 30 s (Synapse's per-recipient invite limit answers minutes): not retried early.
  const long = (m, p) => (m === "POST" && p === `/rooms/${id("news")}/ban` ? 300_000 : null);
  await withFakes({ feed: (() => { const f = load("feed.json"); f.banned.push(u("eve")); return f; })(), hs: { limit: long } }, async ({ hs, hsBase, webBase }) => {
    const started = Date.now();
    const r = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.ok(Date.now() - started < 20_000, "no five-minute wait");
    assert.equal(r.code, 1, r.err);
    const f = r.result.drift.find((d) => d.code === "op_failed");
    assert.deepEqual([f.roomId, f.failed.status, f.failed.errcode], [id("news"), 429, "M_LIMIT_EXCEEDED"]);
    assert.equal(hs.calls.filter((c) => c.path === `/rooms/${id("news")}/ban`).length, 1, "asked once");
    assert.equal(hs.stateOf(id("general"), "m.room.member", u("eve")).membership, "ban", "the other rooms still got theirs");
  });
});

test("run_rows_carry_no_secrets: a refusal that quotes the token back is saved without it, the rest of its words kept", async () => {
  const feed = load("feed.json");
  feed.rooms.find((r) => r.name === "news").topic = "What is new";
  const refuse = (m, p) => m === "PUT" && p === `/rooms/${id("news")}/state/m.room.topic`;
  const refuseText = `denied for Authorization: Bearer ${TOKEN} (access_token=${TOKEN}; secret ${SECRET}; other syt_abcdefghijkl) WORDS-AFTER-THE-TOKEN`;
  await withFakes({ feed, hs: { refuse, refuseText } }, async ({ site, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(r.code, 1, r.err);
    const row = JSON.stringify(site.runs[0]);
    // Vacuity: the refusal's own words reached the row and stdout.
    assert.match(row, /WORDS-AFTER-THE-TOKEN/);
    assert.match(r.out, /WORDS-AFTER-THE-TOKEN/);
    for (const where of [row, r.out, r.err]) {
      assert.ok(!where.includes(TOKEN), "never the token");
      assert.ok(!where.includes(SECRET), "never the site's secret");
      assert.doesNotMatch(where, /syt_abcdefghijkl/, "nothing token-shaped");
    }
    const f = site.runs[0].drift.find((d) => d.code === "op_failed");
    assert.ok(f.failed.body.length <= 300, "the excerpt is capped");
  });
  // A fatal error that quotes it (a listing that cannot be read) is cut the same way.
  const fail = (m, p) => m === "GET" && p === `/directory/list/room/${id("general")}`;
  await withFakes({ hs: { fail } }, async ({ site, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "report"], { hsBase, webBase, token: TOKEN });
    assert.equal(r.code, 2);
    assert.ok(!JSON.stringify(site.runs).includes(TOKEN));
  });
});

test("a homeserver that stops answering stops the run (exit 2): no room is guessed at", async () => {
  const feed = load("feed.json");
  feed.rooms.find((r) => r.name === "general").name = "lobby";
  feed.rooms.find((r) => r.name === "news").topic = "What is new";
  const drop = (m, p) => m === "PUT" && p === `/rooms/${id("general")}/state/m.room.name`;
  await withFakes({ feed, hs: { drop } }, async ({ hs, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(r.code, 2, r.err);
    assert.match(r.result.error, /^rename #general to #lobby: 0 /, "status 0: no answer at all");
    assert.ok(!hs.calls.some((c) => c.method === "PUT" && c.path === `/rooms/${id("news")}/state/m.room.topic`));
  });
});

test("restart: the run after a partial apply does only what is left", async () => {
  const feed = load("feed.json");
  feed.rooms.find((r) => r.name === "general").name = "lobby";
  const news = feed.rooms.find((r) => r.name === "news");
  news.topic = "What is new"; news.published = false;
  let broken = true;
  const fail = (m, p) => broken && m === "PUT" && p === `/rooms/${id("news")}/state/m.room.topic`;
  await withFakes({ feed, hs: { fail } }, async ({ hs, hsBase, webBase }) => {
    assert.equal((await reconcile(["--mode", "apply"], { hsBase, webBase })).code, 1);
    broken = false;
    const before = hs.writes().length;
    const r = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.result.applied.map((o) => o.op), ["setTopic", "publish"], "the rename is not done twice; the skipped listing is");
    assert.equal(hs.writes().length, before + 2);
    assert.equal(hs.stateOf(id("news"), "m.room.topic").topic, "What is new");
  });
});

test("retry: a refusal that persists is refused the same way each run, and nothing else is done twice", async () => {
  const feed = load("feed.json");
  feed.rooms.find((r) => r.name === "general").name = "lobby";
  feed.rooms.find((r) => r.name === "news").topic = "What is new";
  const fail = (m, p) => m === "PUT" && p === `/rooms/${id("news")}/state/m.room.topic`;
  await withFakes({ feed, hs: { fail } }, async ({ hsBase, webBase }) => {
    const first = await reconcile(["--mode", "apply"], { hsBase, webBase });
    const second = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(first.code, 1); assert.equal(second.code, 1);
    assert.deepEqual(second.result.applied, [], "the rename was done once");
    const failedOps = (r) => r.result.drift.filter((o) => o.code === "op_failed").map((o) => [o.roomId, o.failed.op]);
    assert.deepEqual(failedOps(second), failedOps(first));
  });
});

// ── The run's row: written when it starts, filled when it ends ──────────────────────────────────
// The Community page refuses a channel delete while a run is going; a timer run has no host answer,
// so its row must be there from the start, before the run makes any room.
test("two phases: the run's row is posted before its first homeserver write, then finished by that id", async () => {
  const feed = load("feed.json");
  feed.rooms.push(eventsRow());
  await withFakes({ feed }, async ({ hs, site, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(r.code, 0, r.err);
    const posts = site.calls.filter((c) => c.path === "/api/internal/community/runs");
    assert.equal(posts.length, 2, "a start and a finish");
    const [start, finish] = posts;
    assert.deepEqual(Object.keys(start.body).sort(), ["mode", "startedAt"], "the start says only what run it is");
    assert.equal(start.body.mode, "apply");
    const firstWrite = hs.calls.find((c) => c.method !== "GET");
    assert.ok(firstWrite, "vacuity: the run wrote");
    assert.ok(start.t < firstWrite.t, "the row is there before the first write");
    assert.ok(start.t < hs.calls[0].t, "before the homeserver is asked anything");
    assert.equal(finish.body.id, 1, "the finish names the start's row");
    assert.equal(finish.body.ok, true);
    assert.ok(finish.body.finishedAt);
    assert.equal(site.runs.length, 1, "one row for the run");
    assert.equal(site.runs[0].startedAt, start.body.startedAt);
    assert.deepEqual(site.runs[0].applied.map((o) => o.op), ["createRoom", "linkChild", "ban"]);
  });
});

test("a start the site cannot take: the run goes on, says so, and posts one whole row at the end", async () => {
  await withFakes({ site: { startFailures: 3 } }, async ({ site, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "report"], { hsBase, webBase });
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /could not be marked as started/);
    const posts = site.calls.filter((c) => c.path === "/api/internal/community/runs");
    assert.equal(posts.length, 4, "three tries of the start, then the whole run");
    assert.equal(posts[3].body.id, undefined, "no id: a one-shot row");
    assert.ok(posts[3].body.startedAt && posts[3].body.finishedAt);
    assert.equal(site.runs.length, 1);
    assert.equal(site.runs[0].ok, true);
  });
});

test("restart: a finish whose row is gone (pruned, or finished by another) is posted as a whole row instead", async () => {
  await withFakes({}, async ({ site, hsBase, webBase }) => {
    // The site loses the started row while the run is going (a run log of 50 pruned it).
    const orig = site.runs.push.bind(site.runs);
    site.runs.push = (row) => { const n = orig(row); if (row.finishedAt === undefined) row.finishedAt = "taken"; return n; };
    const r = await reconcile(["--mode", "report"], { hsBase, webBase });
    assert.equal(r.code, 0, r.err);
    const posts = site.calls.filter((c) => c.path === "/api/internal/community/runs");
    assert.deepEqual(posts.map((c) => (c.body.id === undefined ? (c.body.finishedAt ? "whole" : "start") : "finish")), ["start", "finish", "whole"]);
    assert.equal(site.runs.at(-1).ok, true);
  });
});

test("retry: a run log the site could not take is sent again, and recorded once", async () => {
  await withFakes({ site: { runFailures: 1 } }, async ({ site, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "report"], { hsBase, webBase });
    assert.equal(r.code, 0, r.err);
    assert.equal(site.runs.length, 1);
    // The start's failed post, its retry, then the finish: three posts, one row, finished.
    assert.equal(site.calls.filter((c) => c.path === "/api/internal/community/runs").length, 3);
    assert.ok(site.runs[0].finishedAt);
  });
  // A log that never goes in: the run says so and fails (exit 2), whatever it did.
  await withFakes({ site: { runFailures: 99 } }, async ({ hsBase, webBase }) => {
    const r = await reconcile(["--mode", "report"], { hsBase, webBase });
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, /run log/);
  });
});

// ── Adopt ───────────────────────────────────────────────────────────────────────────────────────
test("adopt sends each room no row knows to the site, parents first, and writes nothing to the homeserver", async () => {
  const actual = load("actual.json");
  // A category made by hand in Element with one channel in it, linked into the hub.
  actual.rooms[id("hand")] = { ...actual.rooms[id("talk")], name: "Hand made", children: [{ roomId: id("clips"), order: "b0", via: [S] }] };
  actual.rooms[id("clips")] = { ...actual.rooms[id("general")], name: "clips", children: undefined };
  actual.rooms[id("hub")].children = [...actual.rooms[id("hub")].children, { roomId: id("hand"), order: "a9", via: [S] }];
  await withFakes({ actual }, async ({ hs, site, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "adopt"], { hsBase, webBase });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(site.adopted.map((o) => [o.op, o.table, o.matrixRoomId, o.parentRoomId]), [
      ["adoptRow", "spaces", id("hand"), id("hub")],
      ["adoptRow", "rooms", id("clips"), id("hand")],
    ]);
    assert.equal(site.adopted[1].row.see, "everyone");
    assert.deepEqual(hs.writes(), []);
    assert.deepEqual(site.runs[0].applied.map((o) => o.op), ["adoptRow", "adoptRow"]);
  });
});

// ── The command line ───────────────────────────────────────────────────────────────────────────
test("the token travels on stdin only and is never printed; no request acts as another user", async () => {
  await withFakes({}, async ({ hs, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "report"], { hsBase, webBase, env: { MX_AS_USER: SERVICE } });
    assert.equal(r.code, 0, r.err);
    assert.ok(!r.out.includes(TOKEN) && !r.err.includes(TOKEN), "the token is never printed");
    // The service account is the registration's own sender: it acts as itself, so no request
    // carries user_id (the masquerade).
    assert.ok(hs.calls.length > 5);
    assert.ok(hs.calls.every((c) => !/user_id=/.test(c.query)), JSON.stringify(hs.calls.filter((c) => c.query)));
    const none = await reconcile(["--mode", "report"], { hsBase, webBase, token: null });
    assert.equal(none.code, 2);
    assert.match(none.err, /token/);
  });
});

test("--web and --base name the site and the homeserver; usage errors exit 2", async () => {
  await withFakes({}, async ({ hsBase, webBase }) => {
    const r = await reconcile(["--mode", "report", "--once", "--web", webBase, "--base", hsBase],
      { hsBase: "http://127.0.0.1:9", webBase: "http://127.0.0.1:9" });
    assert.equal(r.code, 0, r.err);
    for (const args of [[], ["--mode"], ["--mode", "delete"], ["--mode", "report", "--nope"]]) {
      const bad = await reconcile(args, { hsBase, webBase });
      assert.equal(bad.code, 2, `${args.join(" ")}: ${bad.err}`);
      assert.match(bad.err, /usage: node reconcile\.mjs --mode report\|adopt\|apply/);
    }
    const noSecret = await reconcile(["--mode", "report"], { hsBase, webBase, env: { STREAM_API_SECRET: "" } });
    assert.equal(noSecret.code, 2);
    assert.match(noSecret.err, /STREAM_API_SECRET/);
  });
});

// ── The community's banner (Task 25) ────────────────────────────────────────────────────────────
test("apply puts the panel's banner on the community space as app.blackbranch.banner; restart: the next apply only reads", async () => {
  const feed = load("feed.json");
  feed.spaces[0].bannerMxc = "mxc://example.test/banner1";
  await withFakes({ feed }, async ({ hs, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(hs.stateOf(id("hub"), "app.blackbranch.banner"), { url: "mxc://example.test/banner1" });
    assert.equal(hs.stateOf(id("hub"), "m.room.avatar"), undefined, "the icon is untouched");
    assert.ok(r.result.applied.some((o) => o.op === "setBanner" && o.roomId === id("hub")), JSON.stringify(r.result.applied));
    assert.match(r.err, /^change the banner of the community$/m);
    // A second run (the timer, or the host restarted) reads the banner back and changes nothing.
    const before = hs.calls.length;
    const again = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(again.code, 0, again.err);
    assert.ok(!again.result.applied.some((o) => o.op === "setBanner"), JSON.stringify(again.result.applied));
    assert.ok(!hs.calls.slice(before).some((c) => c.method === "PUT" && c.path.includes("app.blackbranch.banner")));
    assert.ok(hs.calls.slice(before).some((c) => c.path === `/rooms/${id("hub")}/state`), "vacuity: it read the hub again");
  });
});

test("banner retry: a refused banner write fails the run, and the next run writes it", async () => {
  const feed = load("feed.json");
  feed.spaces[0].bannerMxc = "mxc://example.test/banner1";
  const gate = { refuse: true };
  const hsOpts = { fail: (m, p) => gate.refuse && m === "PUT" && p.includes("app.blackbranch.banner") };
  await withFakes({ feed, hs: hsOpts }, async ({ hs, hsBase, webBase }) => {
    const r = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.notEqual(r.code, 0, "a write the homeserver refused is not a clean run");
    assert.equal(hs.stateOf(id("hub"), "app.blackbranch.banner"), undefined);
    gate.refuse = false;
    const again = await reconcile(["--mode", "apply"], { hsBase, webBase });
    assert.equal(again.code, 0, again.err);
    assert.deepEqual(hs.stateOf(id("hub"), "app.blackbranch.banner"), { url: "mxc://example.test/banner1" });
  });
});

test("readRoom reads a space's banner (null when it has none)", async () => {
  const actual = load("actual.json");
  actual.rooms[id("hub")].banner = "mxc://example.test/b";
  await withFakes({ actual }, async ({ hsBase }) => {
    const hs = makeClient({ base: hsBase, token: TOKEN });
    assert.equal((await readRoom(hs, id("hub"), SERVICE)).banner, "mxc://example.test/b");
    assert.equal((await readRoom(hs, id("talk"), SERVICE)).banner, null);
  });
});

test("vacuity: this file was read to its end", () => {
  const me = readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.match(me, /\n\/\/ END: reconcile\.test\.mjs\n$/);
});
// END: reconcile.test.mjs
