// What the Discord bridge has linked, for the panel's Discord page (community plan task 2.4): the
// reader inside the bridge's container (install/ooye/links.js), run for real against a database with
// OOYE 3.7's own table definitions, and the host's two requests (`discord-links`, `discord-guild-<id>`)
// that run it and leave its answer in results/. Run: node --test install/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { fakeHome } from "./scratch-home.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const LINKS = path.join(here, "ooye/links.js");
const GUILD = "100000000000000101";
const CHANNEL = "100000000000000201";

// OOYE 3.7's tables as its migrations leave them (read from a migrated ooye.db, `sqlite_master`).
const SCHEMA = `
CREATE TABLE "guild_active" ("guild_id" TEXT NOT NULL, "autocreate" INTEGER NOT NULL, PRIMARY KEY("guild_id")) WITHOUT ROWID;
CREATE TABLE "guild_space" ("guild_id" TEXT NOT NULL, "space_id" TEXT NOT NULL, "privacy_level" INTEGER NOT NULL DEFAULT 0,
  presence INTEGER NOT NULL DEFAULT 1, url_preview INTEGER NOT NULL DEFAULT 1, webhook_profile INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY("guild_id"), FOREIGN KEY("guild_id") REFERENCES "guild_active"("guild_id") ON DELETE CASCADE) WITHOUT ROWID;
CREATE TABLE "channel_room" ("channel_id" TEXT NOT NULL, "room_id" TEXT NOT NULL UNIQUE, "name" TEXT NOT NULL, "nick" TEXT,
  "thread_parent" TEXT, "custom_avatar" TEXT, "last_bridged_pin_timestamp" INTEGER, "speedbump_checked" INTEGER,
  "guild_id" TEXT NOT NULL, "custom_topic" INTEGER DEFAULT 0, PRIMARY KEY("channel_id"),
  FOREIGN KEY("guild_id") REFERENCES "guild_active"("guild_id") ON DELETE CASCADE) WITHOUT ROWID;`;

function ooyeDb(file, rows = (db) => {}) {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  rows(db);
  db.close();
}
const links = (dbFile, ...args) => spawnSync(process.execPath, ["--no-warnings", LINKS, ...args], { encoding: "utf8", env: { ...process.env, BB_OOYE_DB: dbFile } });

test("dump: the servers the bridge knows, the space each is linked to, and every channel's room (its own thread rooms left out)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bb-ooye-"));
  try {
    const f = path.join(dir, "ooye.db");
    ooyeDb(f, (db) => {
      db.prepare("INSERT INTO guild_active VALUES (?, 0)").run(GUILD);
      db.prepare("INSERT INTO guild_space (guild_id, space_id, privacy_level) VALUES (?, ?, 1)").run(GUILD, "!hub:example.test");
      db.prepare("INSERT INTO channel_room (channel_id, room_id, name, guild_id) VALUES (?, ?, 'test', ?)").run(CHANNEL, "!general:example.test", GUILD);
      db.prepare("INSERT INTO channel_room (channel_id, room_id, name, guild_id, thread_parent) VALUES ('100000000000000202', '!thread:example.test', 'a thread', ?, ?)").run(GUILD, CHANNEL);
    });
    const r = links(f, "dump");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    assert.deepEqual(JSON.parse(r.stdout), {
      v: 1,
      guilds: [{ guildId: GUILD, autocreate: 0, spaceId: "!hub:example.test", privacyLevel: 1 }],
      links: [
        { channelId: CHANNEL, roomId: "!general:example.test", guildId: GUILD, name: "test" },
      ],
    });
    assert.equal(r.stdout.split("\n").length, 2, "one line");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("activate: self-service for that server (the bridge makes no rooms of its own), once, and only a Discord id", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bb-ooye-"));
  try {
    const f = path.join(dir, "ooye.db");
    ooyeDb(f, (db) => db.prepare("INSERT INTO guild_active VALUES ('1111111111111111111', 1)").run());
    const r = links(f, "activate", GUILD);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).guilds.map((g) => [g.guildId, g.autocreate]), [[GUILD, 0], ["1111111111111111111", 1]]);
    // retry: again changes nothing; a server someone switched to easy mode is put back to self-service.
    assert.equal(links(f, "activate", GUILD).status, 0);
    assert.equal(links(f, "activate", "1111111111111111111").status, 0);
    const db = new DatabaseSync(f, { readOnly: true });
    assert.deepEqual(db.prepare("SELECT guild_id, autocreate FROM guild_active ORDER BY guild_id").all().map((x) => [x.guild_id, x.autocreate]),
      [[GUILD, 0], ["1111111111111111111", 0]]);
    // The row is what the bridge's own link-space needs first (guild_space's key points at it).
    db.close();
    const w = new DatabaseSync(f); w.exec("PRAGMA foreign_keys = on");
    w.prepare("INSERT INTO guild_space (guild_id, space_id) VALUES (?, '!hub:example.test')").run(GUILD);
    assert.throws(() => w.prepare("INSERT INTO guild_space (guild_id, space_id) VALUES ('2222222222222222222', '!x:example.test')").run(), /FOREIGN KEY/);
    w.close();
    for (const bad of [[], ["activate"], ["activate", "12"], ["activate", `${GUILD}; DROP TABLE guild_active`], ["drop"]]) {
      const b = links(f, ...bad);
      assert.equal(b.status, 1, bad.join(" "));
      assert.equal(b.stdout, "");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a database the bridge has not set up yet, or none at all: said, exit 1, nothing written", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bb-ooye-"));
  try {
    const empty = path.join(dir, "empty.db");
    new DatabaseSync(empty).close();
    const r = links(empty, "activate", GUILD);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /has not set up its database yet/);
    assert.match(links(path.join(dir, "missing.db"), "dump").stderr, /cannot open/);
    assert.ok(!existsSync(path.join(dir, "missing.db")), "dump opens read-only: it never makes a database");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** A bundle home with the bridge switched on and a bridge database in fake/ooye.db. */
function bridgeHome(extra = "COMPOSE_PROFILES=discord") {
  const h = fakeHome(extra);
  mkdirSync(path.join(h.home, "requests")); mkdirSync(path.join(h.home, "results"), { mode: 0o755 });
  ooyeDb(path.join(h.fake, "ooye.db"));
  const ask = (verb, env = {}) => {
    writeFileSync(path.join(h.home, `requests/${verb}.req`), "");
    const r = h.runWith({ FAKE_NODE: process.execPath, FAKE_LINKS_JS: LINKS, ...env }, "process-requests");
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(readFileSync(path.join(h.home, "results/discord-links.json"), "utf8"));
  };
  const data = () => JSON.parse(readFileSync(path.join(h.home, "results/discord-bridge-links.json"), "utf8"));
  return { ...h, ask, data };
}

test("the discord-guild request marks the server in the bridge, then leaves the links in results/", () => {
  const h = bridgeHome();
  try {
    const a = h.ask(`discord-guild-${GUILD}`);
    assert.equal(a.ok, true, a.message);
    assert.equal(a.request, `discord-guild-${GUILD}`);
    assert.equal(a.message, `the bridge may link Discord server ${GUILD}`);
    assert.deepEqual(h.data().guilds, [{ guildId: GUILD, autocreate: 0, spaceId: null, privacyLevel: null }]);
    assert.match(h.calls(), new RegExp(`^compose exec -T ooye node --no-warnings /opt/blackbranch-ooye/links\\.js activate ${GUILD}$`, "m"));
    // discord-links reads again, and changes nothing.
    const again = h.ask("discord-links");
    assert.equal(again.ok, true, again.message);
    assert.equal(again.message, "links read");
    assert.equal(h.data().guilds.length, 1);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("discord-guild with anything but a Discord id never reaches the bridge", () => {
  const h = bridgeHome();
  try {
    for (const bad of ["discord-guild-12", "discord-guild-100000000000000101123", "discord-guild-"]) {
      const a = h.ask(bad);
      assert.equal(a.ok, false, bad);
      assert.match(a.message, /17 to 20 digits/);
    }
    assert.doesNotMatch(h.calls(), /links\.js/);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("with the bridge switched off or stopped, the requests say so and leave no links for the site", () => {
  const off = bridgeHome("");
  try {
    writeFileSync(path.join(off.home, "results/discord-bridge-links.json"), '{"v":1,"guilds":[],"links":[]}\n');
    const a = off.ask("discord-links");
    assert.equal(a.ok, false);
    assert.equal(a.message, "the Discord bridge is switched off");
    assert.ok(!existsSync(path.join(off.home, "results/discord-bridge-links.json")), "an old copy goes");
  } finally { rmSync(off.home, { recursive: true, force: true }); }
  const stopped = bridgeHome();
  try {
    const a = stopped.ask("discord-links", { FAKE_STATE: "exited" });
    assert.equal(a.ok, false);
    assert.match(a.message, /not running/);
  } finally { rmSync(stopped.home, { recursive: true, force: true }); }
});

test("while an update runs, discord-links still reads; discord-guild waits", () => {
  const h = bridgeHome();
  // An update holds its lock (install/blackbranch update_running) for as long as this runs.
  const lock = path.join(h.home, "state/update.lock");
  writeFileSync(lock, "");
  const holder = spawn("flock", [lock, "sleep", "30"], { stdio: "ignore" });
  try {
    for (let i = 0; i < 100 && spawnSync("flock", ["-n", lock, "true"]).status === 0; i++) spawnSync("sleep", ["0.05"]);
    assert.notEqual(spawnSync("flock", ["-n", lock, "true"]).status, 0, "vacuity: the update's lock is held");
    const w = h.ask(`discord-guild-${GUILD}`);
    assert.equal(w.ok, false);
    assert.match(w.message, /an update is running/);
    assert.equal(w.request, `discord-guild-${GUILD}`);
    assert.doesNotMatch(h.calls(), /links\.js activate/);
    const r = h.ask("discord-links");
    assert.equal(r.ok, true, r.message);
  } finally {
    holder.kill();
    rmSync(h.home, { recursive: true, force: true });
  }
});

test("the bridge image carries the reader and the link calls; the site never gets the bridge's token or address", () => {
  const df = readFileSync(path.join(here, "ooye/Dockerfile"), "utf8");
  assert.match(df, /^COPY entrypoint\.js init\.js links\.js link\.js discord-read\.js \/opt\/blackbranch-ooye\/$/m);
  const compose = readFileSync(path.join(here, "compose.yaml"), "utf8");
  const web = compose.split(/\n {2}caddy:\n/)[0].split(/\n {2}web:\n/)[1];
  assert.ok(web && /\n {6}STREAM_API_URL: /.test(web), "vacuity: the web service's block was found");
  assert.doesNotMatch(web, /OOYE/, "no bridge token or address in the site's environment");
  assert.doesNotMatch(compose, /OOYE_AS_TOKEN/, "no service at all gets the as_token through compose");
  assert.doesNotMatch(readFileSync(path.join(here, "../web/.env.example"), "utf8"), /OOYE/);
});

test("link.js refuses a bad call before anything else (no ids in their shape, no bridge reached)", () => {
  const LINK = path.join(here, "ooye/link.js");
  const dir = mkdtempSync(path.join(tmpdir(), "bb-link-"));
  try {
    for (const bad of [[], ["drop", "@a:example.test", GUILD], ["link", "@a:example.test", GUILD, "general", CHANNEL], ["link", "@a:example.test", "12", "!r:x", CHANNEL],
      ["privacy", "a", GUILD], ["unlink", "@a:example.test", GUILD], ["privacy", "@a:example.test", `${GUILD}$(id)`]]) {
      const r = spawnSync(process.execPath, [LINK, ...bad], { cwd: dir, encoding: "utf8" });
      assert.equal(r.status, 1, bad.join(" "));
      assert.equal(r.stdout, "");
    }
    // In shape, but no registration here: still exit 1 and nothing on stdout.
    const r = spawnSync(process.execPath, [LINK, "privacy", "@a:example.test", GUILD], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no registration\.yaml/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the panel's Discord calls: ids from the request's name, rooms from the site's rows, the bridge's answer as the result", () => {
  const h = bridgeHome();
  try {
    writeFileSync(path.join(h.fake, "hub-room"), "!hub:example.test\n");
    writeFileSync(path.join(h.fake, `channel-room-${CHANNEL}`), "!general:example.test\n");
    const call = (verb) => {
      writeFileSync(path.join(h.home, `requests/${verb}.req`), "");
      const r = h.runWith({ FAKE_NODE: process.execPath, FAKE_LINKS_JS: LINKS }, "process-requests");
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(readFileSync(path.join(h.home, "results/discord-call.json"), "utf8"));
    };
    const space = call(`discord-link-space-${GUILD}`);
    assert.equal(space.ok, true, space.message);
    assert.equal(space.request, `discord-link-space-${GUILD}`);
    assert.deepEqual(JSON.parse(space.message), { ok: true, status: 204, data: "" });
    assert.equal(call(`discord-privacy-${GUILD}`).ok, true);
    assert.equal(call(`discord-link-${GUILD}-${CHANNEL}`).ok, true);
    assert.equal(call(`discord-unlink-${GUILD}-${CHANNEL}`).ok, true);
    assert.equal(call(`discord-unlink-space-${GUILD}`).ok, true);
    const SVC = "@blackbranch:example.test";
    assert.deepEqual(readFileSync(path.join(h.fake, "link-args"), "utf8").trim().split("\n"), [
      `link-space ${SVC} ${GUILD} !hub:example.test`, `privacy ${SVC} ${GUILD}`, `link ${SVC} ${GUILD} !general:example.test ${CHANNEL}`,
      `unlink ${SVC} ${GUILD} ${CHANNEL}`, `unlink-space ${SVC} ${GUILD}`,
    ]);
    // The links are read again after each call.
    assert.ok(existsSync(path.join(h.home, "results/discord-bridge-links.json")));
    // The bridge's refusal is the message, the request itself answered.
    writeFileSync(path.join(h.fake, "link-out"), '{"ok":false,"status":400,"data":"OOYE needs power level 100 (admin) in the target Matrix room"}\n');
    const refused = call(`discord-link-${GUILD}-${CHANNEL}`);
    assert.equal(refused.ok, true);
    assert.deepEqual(JSON.parse(refused.message), { ok: false, status: 400, data: "OOYE needs power level 100 (admin) in the target Matrix room" });
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("a Discord call with ids out of shape, or a channel no linkable row is marked for, never reaches the bridge", () => {
  const h = bridgeHome();
  try {
    writeFileSync(path.join(h.fake, "hub-room"), "!hub:example.test\n");
    const ask = (verb) => {
      writeFileSync(path.join(h.home, `requests/${verb}.req`), "");
      assert.equal(h.runWith({ FAKE_NODE: process.execPath, FAKE_LINKS_JS: LINKS }, "process-requests").status, 0);
      return JSON.parse(readFileSync(path.join(h.home, "results/discord-call.json"), "utf8"));
    };
    for (const bad of [`discord-link-space-12`, `discord-privacy-${GUILD}0000`, `discord-link-${GUILD}`, `discord-link-${GUILD}-12`, `discord-unlink-${GUILD}-${CHANNEL}-1`]) {
      const a = ask(bad);
      assert.equal(a.ok, false, bad);
      assert.match(a.message, /17 to 20 digits/);
    }
    const none = ask(`discord-link-${GUILD}-${CHANNEL}`);
    assert.equal(none.ok, false);
    assert.match(none.message, /no room the panel may link is marked for that channel/);
    // A room id the site's rows hold in another shape is not passed on either.
    writeFileSync(path.join(h.fake, `channel-room-${CHANNEL}`), "general; rm -rf /\n");
    assert.equal(ask(`discord-link-${GUILD}-${CHANNEL}`).ok, false);
    writeFileSync(path.join(h.fake, "hub-room"), "not a room\n");
    assert.match(ask(`discord-link-space-${GUILD}`).message, /no main space/);
    assert.ok(!existsSync(path.join(h.fake, "link-args")), "the bridge was never called");
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});
