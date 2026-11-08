// The reconciler's feed (GET /api/internal/community/desired) and its run log, the pure half: a fake
// db.query answers each read with fixture rows. The SQL itself runs against real Postgres in
// desiredServer.db.test.ts; the routes' wiring is app/api/internal/community/desired.test.ts.
// Run: env -u DATABASE_URL node --test app/lib/community/desiredServer.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { columnEntitledSql } from "../subscriptions/entitlement.ts";
import { bridgeAccountsFrom, buildDesiredFeed, feedEnv, parseRun, readerUserIdFrom, FORUM_READER_LOCALPART, type FeedEnv } from "./desiredServer.ts";
import { bridgeLinksFrom, linkedGuildOf } from "./discordLinks.ts";
import { INSTANCE_KEYS } from "../instanceSchema.generated.mjs";
import { SITE_BAN_REASON } from "../siteBanReason.ts";
import { SITE_BAN_REASON as SYNC_REASON } from "../siteBanSync.ts";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const FUTURE = new Date(NOW + 3_600_000);
const PAST = new Date(NOW - 3_600_000);

const ENV: FeedEnv = {
  serverName: "example.test",
  serviceUserId: "@blackbranch:example.test",
  readerUserId: "@reader:example.test",
  hubRoomId: "!configured-hub:example.test",
  streamerId: "@streamer:example.test",
  botIds: ["@bot:example.test", "@helper:example.test"],
  sources: ["stripe"],
  putBack: true,
  retentionCapDays: 365,
  bridgeAccounts: [" @bridge:example.test ", "not an id", "@bridge:example.test", "@a:example.test"],
  now: NOW,
};

type Row = Record<string, unknown>;
type Fixture = { users?: Row[]; supporters?: Row[]; bans?: Row[]; spaces?: Row[] };

/** A db whose every read is recorded; each table answers its fixture rows. */
function fakeDb(f: Fixture = {}) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const db = {
    calls,
    query: async <R extends object>(sql: string, params?: unknown[]): Promise<{ rows: R[] }> => {
      calls.push({ sql, params });
      const rows = (r: Row[]) => ({ rows: r as R[] });
      if (/FROM site\.community_roles/.test(sql)) return rows([{ key: "admin", label: "Admin", level: 100, colour: null, hoist: true, orderKey: "a0", builtin: true }]);
      if (/FROM site\.community_spaces/.test(sql)) return rows(f.spaces ?? []);
      if (/FROM site\.community_rooms/.test(sql)) return rows([]);
      if (/FROM site\.bans/.test(sql)) return rows(f.bans ?? []);
      if (/gift_subscriptions/.test(sql)) return rows(f.supporters ?? []);
      if (/FROM site\.users/.test(sql)) return rows(f.users ?? []);
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return db;
}

const user = (matrix_id: string, flags: Partial<Record<"is_admin" | "is_staff" | "is_mod" | "is_bot", boolean>>): Row =>
  ({ matrix_id, is_admin: false, is_staff: false, is_mod: false, is_bot: false, ...flags });
const levelOf = (people: { userId: string; level: number }[], id: string) => people.find((p) => p.userId === id)?.level;

test("people: admin 100, staff 75, mod 50, bot 50; staff and mod at once is 75 (the highest)", async () => {
  const feed = await buildDesiredFeed(fakeDb({ users: [
    user("@ada:example.test", { is_admin: true }),
    user("@sam:example.test", { is_staff: true }),
    user("@mo:example.test", { is_mod: true }),
    user("@both:example.test", { is_staff: true, is_mod: true }),
    user("@flagged-bot:example.test", { is_bot: true }),
  ] }), ENV);
  assert.equal(levelOf(feed.people, "@ada:example.test"), 100);
  assert.equal(levelOf(feed.people, "@sam:example.test"), 75);
  assert.equal(levelOf(feed.people, "@mo:example.test"), 50);
  assert.equal(levelOf(feed.people, "@both:example.test"), 75);
  assert.equal(levelOf(feed.people, "@flagged-bot:example.test"), 50, "site.users.is_bot is a bot");
  assert.equal(levelOf(feed.people, "@bot:example.test"), 50, "bot.matrixId is a bot");
  assert.equal(levelOf(feed.people, "@helper:example.test"), 50, "staff.extraMatrixIds sit with the bots");
  assert.equal(levelOf(feed.people, "@streamer:example.test"), 100, "the streamer is an admin (spec §4.2)");
  assert.equal(new Set(feed.people.map((p) => p.userId)).size, feed.people.length, "one entry per person");
});

test("people: the bot account flagged a mod too stays at 50; an admin who is also the bot is 100", async () => {
  const feed = await buildDesiredFeed(fakeDb({ users: [
    user("@bot:example.test", { is_mod: true, is_bot: true }),
    user("@helper:example.test", { is_admin: true }),
  ] }), ENV);
  assert.equal(levelOf(feed.people, "@bot:example.test"), 50);
  assert.equal(levelOf(feed.people, "@helper:example.test"), 100);
});

test("people: the hidden accounts never get a level, whatever their flags", async () => {
  const feed = await buildDesiredFeed(fakeDb({ users: [
    user("@blackbranch:example.test", { is_admin: true }),
    user("@reader:example.test", { is_bot: true }),
  ] }), { ...ENV, botIds: ["@reader:example.test"] });
  assert.equal(levelOf(feed.people, "@blackbranch:example.test"), undefined);
  assert.equal(levelOf(feed.people, "@reader:example.test"), undefined);
  assert.deepEqual(feed.hiddenUserIds, ["@blackbranch:example.test", "@reader:example.test"]);
  assert.equal(feed.serviceUserId, "@blackbranch:example.test");
});

test("hidden ids: no forum reader = the service account alone", async () => {
  const feed = await buildDesiredFeed(fakeDb(), { ...ENV, readerUserId: null });
  assert.deepEqual(feed.hiddenUserIds, ["@blackbranch:example.test"]);
});

test("feed_carries_the_site_ban_reason: the marker the reconciler writes on, and reads off, the site's room bans", async () => {
  const feed = await buildDesiredFeed(fakeDb(), ENV);
  assert.equal(feed.siteBanReason, SITE_BAN_REASON);
  assert.ok(SITE_BAN_REASON.length > 0, "vacuity: a marker an empty reason cannot match");
  // One source: the browser sync (until the reconciler takes over) marks its room bans with the same value.
  assert.equal(SYNC_REASON, SITE_BAN_REASON);
});

test("bans: expires_at null is banned, in the future is timedOut with that until, in the past is neither", async () => {
  const feed = await buildDesiredFeed(fakeDb({ bans: [
    { matrix_id: "@gone:example.test", expires_at: null },
    { matrix_id: "@quiet:example.test", expires_at: FUTURE },
    { matrix_id: "@served:example.test", expires_at: PAST },
  ] }), ENV);
  assert.deepEqual(feed.banned, ["@gone:example.test"]);
  assert.deepEqual(feed.timedOut, [{ userId: "@quiet:example.test", until: FUTURE.toISOString() }]);
});

test("bans: a banned mod holds no level and is no supporter; a timed-out one keeps both (read only, the −1 is the reconciler's)", async () => {
  const feed = await buildDesiredFeed(fakeDb({
    users: [user("@mo:example.test", { is_mod: true }), user("@sam:example.test", { is_staff: true })],
    supporters: [{ matrix_id: "@mo:example.test" }, { matrix_id: "@sam:example.test" }, { matrix_id: "@fan:example.test" }],
    bans: [{ matrix_id: "@mo:example.test", expires_at: null }, { matrix_id: "@sam:example.test", expires_at: FUTURE }],
  }), ENV);
  assert.equal(levelOf(feed.people, "@mo:example.test"), undefined);
  assert.equal(levelOf(feed.people, "@sam:example.test"), 75, "a timed-out staffer stays staff");
  assert.ok(!feed.supporters.includes("@mo:example.test"), "a banned person is not invited to the supporters' gate");
  assert.ok(feed.supporters.includes("@sam:example.test"), "a timed-out supporter keeps reading (read only, spec §4.2)");
  assert.ok(feed.supporters.includes("@fan:example.test"));
  assert.deepEqual(feed.timedOut, [{ userId: "@sam:example.test", until: FUTURE.toISOString() }]);
});

test("lapse_during_timeout_keeps_timeout", async () => {
  // A supporter whose access ends while timed out: out of the supporters (the gate removes them),
  // still timed out until the same end, still at their level.
  const f: Fixture = {
    users: [user("@mo:example.test", { is_mod: true })],
    supporters: [{ matrix_id: "@mo:example.test" }],
    bans: [{ matrix_id: "@mo:example.test", expires_at: FUTURE }],
  };
  const before = await buildDesiredFeed(fakeDb(f), ENV);
  assert.ok(before.supporters.includes("@mo:example.test"));
  const after = await buildDesiredFeed(fakeDb({ ...f, supporters: [] }), ENV);
  assert.ok(!after.supporters.includes("@mo:example.test"), "lapsed: no longer a supporter");
  assert.deepEqual(after.timedOut, [{ userId: "@mo:example.test", until: FUTURE.toISOString() }], "the timeout is untouched");
  assert.equal(levelOf(after.people, "@mo:example.test"), 50);
});

test("bridgeBots: the site's Bridge accounts, trimmed, whole Matrix ids only, once each, sorted", async () => {
  const feed = await buildDesiredFeed(fakeDb(), ENV);
  assert.deepEqual(feed.bridgeBots, ["@a:example.test", "@bridge:example.test"]);
  assert.deepEqual((await buildDesiredFeed(fakeDb(), { ...ENV, bridgeAccounts: [] })).bridgeBots, []);
});

test("the Discord bridge's accounts: its bot joins bridgeBots once, its user regex is passed on unchanged; none while it is off", async () => {
  const host = { v: 1, bot: "@_ooye_bot:example.test", userPatterns: ["@_ooye_.*:example\\.test"] };
  const feed = await buildDesiredFeed(fakeDb(), { ...ENV, bridgeAccounts: ["@_ooye_bot:example.test", "@a:example.test"] }, bridgeAccountsFrom(host, "example.test"));
  assert.deepEqual(feed.bridgeBots, ["@_ooye_bot:example.test", "@a:example.test"]);
  assert.deepEqual(feed.bridgeUserPatterns, ["@_ooye_.*:example\\.test"]);
  const off = await buildDesiredFeed(fakeDb(), ENV);
  assert.deepEqual(off.bridgeUserPatterns, []);
  assert.ok(!off.bridgeBots.includes("@_ooye_bot:example.test"));
  assert.deepEqual(await buildDesiredFeed(fakeDb(), ENV, bridgeAccountsFrom(null, "example.test")), off, "no host file = off");
});

test("the Discord bridge's seat and link: its bot to seat, and whether the hub is the space a Discord server is linked to", async () => {
  const host = bridgeAccountsFrom({ v: 1, bot: "@_ooye_bot:example.test", userPatterns: ["@_ooye_.*:example\\.test"] }, "example.test");
  const hub = (await buildDesiredFeed(fakeDb(), ENV)).hubRoomId;
  assert.ok(hub, "vacuity: the fixture has a hub");
  const linked = bridgeLinksFrom({ v: 1, guilds: [{ guildId: "100000000000000101", autocreate: 0, spaceId: hub, privacyLevel: 1 }], links: [] });
  const on = await buildDesiredFeed(fakeDb(), ENV, host, linked);
  assert.equal(on.discordBot, "@_ooye_bot:example.test");
  assert.equal(on.discordSpaceLinked, true);
  // Linked to another space, not linked yet, or the bridge off: the hub is the panel's.
  const elsewhere = bridgeLinksFrom({ v: 1, guilds: [{ guildId: "100000000000000101", autocreate: 0, spaceId: "!other:example.test", privacyLevel: 1 }], links: [] });
  assert.equal((await buildDesiredFeed(fakeDb(), ENV, host, elsewhere)).discordSpaceLinked, false);
  assert.equal((await buildDesiredFeed(fakeDb(), ENV, host)).discordSpaceLinked, false);
  const off = await buildDesiredFeed(fakeDb(), ENV, bridgeAccountsFrom(null, "example.test"), linked);
  assert.deepEqual([off.discordBot, off.discordSpaceLinked], [null, false]);
});

test("bridgeLinksFrom: the host's file field by field; anything else is unknown (null), never empty", () => {
  const good = { v: 1, guilds: [{ guildId: "100000000000000101", autocreate: 0, spaceId: "!hub:example.test", privacyLevel: 1 }],
    links: [{ channelId: "100000000000000201", roomId: "!r:example.test", guildId: "100000000000000101", name: "test" }] };
  assert.deepEqual(bridgeLinksFrom(good), { guilds: [{ guildId: "100000000000000101", spaceId: "!hub:example.test", privacyLevel: 1 }],
    links: [{ channelId: "100000000000000201", roomId: "!r:example.test", guildId: "100000000000000101", name: "test" }] });
  // An empty record is known and empty, never unknown.
  assert.deepEqual(bridgeLinksFrom({ v: 1, guilds: [], links: [] }), { guilds: [], links: [] });
  for (const bad of [null, [], { ...good, v: 2 }, { ...good, guilds: [{ guildId: "12", spaceId: null }] }, { ...good, links: [{ ...good.links[0], roomId: "general" }] }, { v: 1, guilds: {}, links: [] }]) {
    assert.equal(bridgeLinksFrom(bad), null, JSON.stringify(bad));
  }
  assert.equal(linkedGuildOf(bridgeLinksFrom(good)!, "!hub:example.test")?.guildId, "100000000000000101");
  assert.equal(linkedGuildOf(bridgeLinksFrom(good)!, null), null);
});

test("bridgeAccountsFrom: a file not in the host's shape is no bridge at all; another server's bot is not ours", () => {
  const none = { bot: null, userPatterns: [] };
  for (const bad of [null, [], "x", { v: 2, userPatterns: ["x"] }, { v: 1, userPatterns: "x" }, { v: 1, userPatterns: [1] },
    { v: 1, userPatterns: [""] }, { v: 1, userPatterns: ["a", "b", "c", "d", "e"] }, { v: 1, userPatterns: ["x".repeat(301)] }]) {
    assert.deepEqual(bridgeAccountsFrom(bad, "example.test"), none, JSON.stringify(bad));
  }
  assert.equal(bridgeAccountsFrom({ v: 1, bot: "@_ooye_bot:other.test", userPatterns: [] }, "example.test").bot, null);
  assert.equal(bridgeAccountsFrom({ v: 1, bot: "not an id", userPatterns: [] }, "example.test").bot, null);
  assert.deepEqual(bridgeAccountsFrom({ v: 1, bot: "@_ooye_bot:example.test", userPatterns: ["p"] }, "example.test"), { bot: "@_ooye_bot:example.test", userPatterns: ["p"] });
});

test("the feed only reads: no write, and never the lift log (an audit log nothing acts on)", async () => {
  const db = fakeDb({ bans: [{ matrix_id: "@back:example.test", expires_at: null }] });
  const feed = await buildDesiredFeed(db, ENV);
  assert.deepEqual(feed.banned, ["@back:example.test"]);
  assert.ok(db.calls.length >= 4, "vacuity: the feed's reads were recorded");
  for (const c of db.calls) {
    assert.doesNotMatch(c.sql, /community_unbans/, "the lift log is not the feed's");
    assert.doesNotMatch(c.sql, /\b(DELETE|INSERT|UPDATE)\b/, "a GET writes nothing");
  }
});

test("timed_out_mod_keeps_level_in_people", async () => {
  // The reconciler builds the mods room's membership from `people`: dropping a timed-out mod
  // would kick them out of it. The timeout travels in `timedOut` alone.
  const feed = await buildDesiredFeed(fakeDb({
    users: [user("@mo:example.test", { is_mod: true })],
    bans: [{ matrix_id: "@mo:example.test", expires_at: FUTURE }],
  }), ENV);
  assert.equal(levelOf(feed.people, "@mo:example.test"), 50);
  assert.deepEqual(feed.timedOut.map((t) => t.userId), ["@mo:example.test"]);
  assert.deepEqual(feed.banned, []);
});

test("timedOut: one entry per person, the latest end, however many live timed rows there are", async () => {
  const LATER = new Date(FUTURE.getTime() + 86_400_000);
  const feed = await buildDesiredFeed(fakeDb({ bans: [
    { matrix_id: "@quiet:example.test", expires_at: FUTURE },
    { matrix_id: "@quiet:example.test", expires_at: LATER },
    { matrix_id: "@quiet:example.test", expires_at: PAST },
  ] }), ENV);
  assert.deepEqual(feed.timedOut, [{ userId: "@quiet:example.test", until: LATER.toISOString() }]);
});

test("a permanent ban outranks a live timeout: banned only, no level", async () => {
  const feed = await buildDesiredFeed(fakeDb({
    users: [user("@mo:example.test", { is_mod: true })],
    bans: [{ matrix_id: "@mo:example.test", expires_at: FUTURE }, { matrix_id: "@mo:example.test", expires_at: null }],
  }), ENV);
  assert.deepEqual(feed.banned, ["@mo:example.test"]);
  assert.deepEqual(feed.timedOut, []);
  assert.equal(levelOf(feed.people, "@mo:example.test"), undefined);
});

test("feedEnv: the service account's name comes from the schema's product default when unset (one source)", () => {
  const saved = process.env.INSTALL_VALUES;
  process.env.INSTALL_VALUES = JSON.stringify({ "matrix.serverName": "example.test" });
  try {
    const def = INSTANCE_KEYS.find((e) => e.key === "community.serviceLocalpart")?.default;
    assert.equal(typeof def, "string");
    assert.equal(feedEnv().serviceUserId, `@${def}:example.test`);
  } finally {
    if (saved === undefined) delete process.env.INSTALL_VALUES; else process.env.INSTALL_VALUES = saved;
  }
});

test("supporters: the list the entitlement query returned, read through columnEntitledSql with the sources", async () => {
  const db = fakeDb({ supporters: [{ matrix_id: "@fan:example.test" }, { matrix_id: "@gifted:example.test" }] });
  const feed = await buildDesiredFeed(db, { ...ENV, streamerId: null, botIds: [] });
  assert.deepEqual(feed.supporters, ["@fan:example.test", "@gifted:example.test"]);
  const read = db.calls.find((c) => /gift_subscriptions/.test(c.sql));
  assert.ok(read, "no supporters query was made");
  const sourcesParam = /\$(\d+)::text\[\]/.exec(read.sql);
  assert.ok(sourcesParam, "the supporters query has no sources parameter");
  assert.ok(read.sql.includes(columnEntitledSql("u.matrix_id", `$${sourcesParam[1]}`)), "the supporters query does not read the one entitlement predicate");
  assert.deepEqual(read.params?.[Number(sourcesParam[1]) - 1], ["stripe"], "the sources that count are the parameter");
  assert.doesNotMatch(read.sql, /provider_status|period_end/, "paidThrough's trial exclusion has no place in 'entitled now'");
});

test("supporters: the staff accounts are comp Supporters (as the site's own entitlement says), once each", async () => {
  const feed = await buildDesiredFeed(fakeDb({ supporters: [{ matrix_id: "@streamer:example.test" }] }), ENV);
  assert.deepEqual(feed.supporters, ["@bot:example.test", "@helper:example.test", "@streamer:example.test"]);
});

test("the hub: the hub space row's room when it has one, else the room the server's setup recorded", async () => {
  const hubRow = { id: 1, parentId: null, kind: "hub", name: "Hub", topic: null, avatarMxc: null, orderKey: "a0", matrixRoomId: "!row-hub:example.test", gateTier: null };
  assert.equal((await buildDesiredFeed(fakeDb({ spaces: [hubRow] }), ENV)).hubRoomId, "!row-hub:example.test");
  assert.equal((await buildDesiredFeed(fakeDb({ spaces: [{ ...hubRow, matrixRoomId: null }] }), ENV)).hubRoomId, "!configured-hub:example.test");
  assert.equal((await buildDesiredFeed(fakeDb(), { ...ENV, hubRoomId: null })).hubRoomId, null);
});

test("the feed carries the desired state, the server name and the install settings as given", async () => {
  const feed = await buildDesiredFeed(fakeDb(), { ...ENV, putBack: false, retentionCapDays: 30 });
  assert.equal(feed.serverName, "example.test");
  assert.equal(feed.roles.length, 1);
  assert.deepEqual(feed.spaces, []);
  assert.deepEqual(feed.rooms, []);
  assert.equal(feed.putBack, false);
  assert.equal(feed.retentionCapDays, 30);
  assert.deepEqual(Object.keys(feed).sort(), [
    "banned", "bridgeBots", "bridgeUserPatterns", "discordBot", "discordSpaceLinked", "hiddenUserIds", "hubRoomId", "people", "putBack", "retentionCapDays", "roles", "rooms",
    "serverName", "serviceUserId", "siteBanReason", "spaces", "supporters", "timedOut",
  ]);
});

test("restart: the feed holds no process state — the same rows give the same feed, a changed row a changed feed", async () => {
  const f: Fixture = { users: [user("@mo:example.test", { is_mod: true })], bans: [] };
  const first = await buildDesiredFeed(fakeDb(f), ENV);
  assert.deepEqual(await buildDesiredFeed(fakeDb(f), ENV), first);
  const after = await buildDesiredFeed(fakeDb({ ...f, bans: [{ matrix_id: "@mo:example.test", expires_at: null }] }), ENV);
  assert.equal(levelOf(after.people, "@mo:example.test"), undefined, "a ban made since the last read applies on the next one");
});

test("parseRun: the three modes, with their timestamps; anything else is refused", () => {
  for (const mode of ["report", "adopt", "apply"]) {
    const r = parseRun({ mode, startedAt: "2026-10-23T12:00:00Z", finishedAt: "2026-10-23T12:00:05Z", ok: true, drift: [{ room: "x" }], applied: [], error: null });
    assert.ok(r.ok, `${mode} refused`);
    assert.equal(r.run.mode, mode);
    assert.equal(r.run.startedAt, "2026-10-23T12:00:00.000Z");
  }
  for (const bad of [null, [], "report", { mode: "delete", startedAt: "2026-10-23T12:00:00Z" }, { mode: "apply" },
    { mode: "apply", startedAt: "yesterday" }, { mode: "apply", startedAt: "2026-10-23T12:00:00Z", ok: "yes" },
    { mode: "apply", startedAt: "2026-10-23T12:00:00Z", error: 5 }, { mode: "apply", startedAt: "2026-10-23T12:00:00Z", finishedAt: "later" }]) {
    assert.equal(parseRun(bad).ok, false, JSON.stringify(bad));
  }
});

test("parseRun: a run still going has no finish, no verdict and no lists; a long error is cut, not refused", () => {
  const r = parseRun({ mode: "report", startedAt: "2026-10-23T12:00:00Z", error: "x".repeat(10_000) });
  assert.ok(r.ok);
  assert.equal(r.run.finishedAt, null);
  assert.equal(r.run.ok, null);
  assert.equal(r.run.drift, null);
  assert.equal(r.run.applied, null);
  assert.equal(r.run.error?.length, 2000);
});

test("readerUserIdFrom: the id the site names, else the install's reader when it has a token, else none", () => {
  assert.equal(readerUserIdFrom({ MATRIX_READER_USER_ID: "@named:example.test", MATRIX_READER_TOKEN: "t" }, "example.test"), "@named:example.test");
  assert.equal(readerUserIdFrom({ MATRIX_READER_TOKEN: "t" }, "example.test"), `@${FORUM_READER_LOCALPART}:example.test`);
  assert.equal(readerUserIdFrom({}, "example.test"), null);
  assert.equal(readerUserIdFrom({ MATRIX_READER_USER_ID: "" }, "example.test"), null);
});

test("the install's forum reader is the account the host makes (install/blackbranch READER_LOCALPART)", () => {
  const host = readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "install", "blackbranch"), "utf8");
  assert.match(host, new RegExp(`^READER_LOCALPART="${FORUM_READER_LOCALPART}"$`, "m"));
});

test("the feed's retention cap has one default: the schema's (no second copy of the number here)", () => {
  const src = readFileSync(join(import.meta.dirname, "desiredServer.ts"), "utf8");
  // Vacuity: the scan read to the end of the file (its last route).
  assert.match(src, /\n {4}return UNAVAILABLE\(\);\n {2}\}\n\}\n$/);
  assert.match(src, /retentionCapDays: typeof cap === "number" \? cap : Number\(instanceEntry\(CAP_KEY\)\?\.default\),/);
  assert.doesNotMatch(src, /\b365\b/);
});
