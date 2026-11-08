// The Discord import's confirm against a real Postgres (discordImportAdmin.ts): the rows spike 0.3's
// server becomes, a retry that makes nothing twice, a restart between the read and the next import,
// a second import's ticked change, and a read too old to trust. The host is a stand-in that answers
// at once; its copy of the read is the fixture as the bridge's reader writes it.
//
// Run locally against a throwaway database built by the chain (never the prod DATABASE_URL):
//   ./migrations/replay-into.sh "postgres://…/cmty_scratch"
//   env -u DATABASE_URL SQL_PARSE_DATABASE_URL=postgres://…/cmty_scratch node --test app/lib/community/discordImportAdmin.db.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { confirmImportResponse, readImportResponse, type ImportDeps } from "./discordImportAdmin.ts";

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
const here = path.dirname(fileURLToPath(import.meta.url));
type RawChannel = { id: string; name: string; type: number; position: number; parent_id: string | null; topic?: string | null; permission_overwrites: { id: string; type: number; allow: string; deny: string }[] };
type RawRole = { id: string; name: string; position: number; permissions: string; managed: boolean; tags?: Record<string, string | null> };
const RAW = JSON.parse(readFileSync(path.join(here, "../../../../install/fixtures/discord/guild.json"), "utf8")) as {
  guild: { id: string; name: string; premium_tier: number }; channels: RawChannel[]; roles: RawRole[]; emojis: { animated: boolean }[];
};
const G = RAW.guild.id;

/** The reader's line (install/ooye/discord-read.js `guild`) for the fixture, with `edit` applied to its channels. */
function line(readAt: string, edit: (c: RawChannel[]) => RawChannel[] = (c) => c) {
  return {
    v: 1, ok: true, guild: { id: G, name: RAW.guild.name, premiumTier: RAW.guild.premium_tier },
    channels: edit(RAW.channels).map((c) => ({ id: c.id, name: c.name, type: c.type, position: c.position, parentId: c.parent_id, topic: c.topic ?? null,
      overwrites: c.permission_overwrites.map((o) => ({ id: o.id, type: o.type, allow: o.allow, deny: o.deny })) })),
    roles: RAW.roles.map((r) => ({ id: r.id, name: r.name, position: r.position, permissions: r.permissions, managed: r.managed, tags: r.tags ?? {} })),
    emoji: { static: 59, animated: 32 }, readAt,
  };
}

function deps(pool: Pool, file: () => unknown, now = Date.parse("2026-11-04T12:00:00Z")): ImportDeps & { asked: string[] } {
  const asked: string[] = [];
  let at = "";
  return {
    asked, pool, canCall: true, admin: "@admin:example.test", now: () => now, log: { log: () => {}, error: () => {} },
    askHost: async (verb) => { asked.push(verb); at = new Date(now).toISOString(); return { ok: true, requestedAt: new Date(now - 1000).toISOString() }; },
    hostAnswer: async () => ({ ok: true, at, message: "read" }),
    hostFile: async () => file(),
    dropToken: async () => ({ ok: true }),
    reconcile: async () => { asked.push("community-reconcile"); return { ok: true, requestedAt: "2026-11-04T12:00:00Z" }; },
    retentionCapDays: () => 365,
    waits: { hostMs: 0, stepMs: 1 },
  };
}
const post = (body: unknown) => new Request("http://site.test/api/admin/community/discord/import", { method: "POST", body: JSON.stringify(body) });
const id = (name: string, type = 0) => RAW.channels.find((c) => c.name === name && c.type === type)!.id;

async function fresh(pool: Pool) {
  await pool.query("DELETE FROM site.community_rooms");
  await pool.query("DELETE FROM site.community_spaces");
  await pool.query("DELETE FROM site.community_discord_roles");
  await pool.query("DELETE FROM site.community_discord_import");
  await pool.query(`INSERT INTO site.community_spaces (kind, name, order_key, matrix_room_id) VALUES ('hub', 'Example', 'a0', '!hub:example.test')`);
  await pool.query(`INSERT INTO site.community_rooms (space_id, kind, name, order_key, matrix_room_id)
    SELECT id, 'text', 'general', 'a0', '!general:example.test' FROM site.community_spaces WHERE kind = 'hub'`);
}

test("import over real tables: the server's 3 categories and 7 channels made once; a retry makes nothing; a restart and a second import propose only the change", async (t) => {
  if (!DB_URL) {
    assert.ok(!process.env.CI, "SQL_PARSE_DATABASE_URL must be set in CI");
    t.skip("SQL_PARSE_DATABASE_URL not set");
    return;
  }
  const pool = new Pool({ connectionString: DB_URL, max: 3 });
  const lock = await pool.connect();
  // Other db test files commit and wipe community rows too: hold their lock for this test's life.
  await lock.query("SELECT pg_advisory_lock(165165)");
  try {
    await fresh(pool);
    let file: unknown = line("2026-11-04T11:59:00Z");
    const d = deps(pool, () => file);
    const read = await readImportResponse(new Request("http://site.test/x", { method: "POST", body: JSON.stringify({ guildId: G }) }), d);
    assert.equal(read.status, 200, await read.clone().text());
    assert.deepEqual(d.asked, [`discord-read-${G}`]);
    const view = await read.json() as { here: { hubId: number; rooms: unknown[] }; savedTiers: object };
    assert.equal(view.here.rooms.length, 1);
    assert.deepEqual(view.savedTiers, {});

    // First confirm, the mod lodge's first channel renamed, as the streamer would.
    const choices = { rooms: { [id("𝓶𝓸𝓭-𝓰𝓮𝓷𝓮𝓻𝓪𝓵")]: { include: true, name: "mod-general" } }, spaces: {} };
    const first = await confirmImportResponse(post({ guildId: G, roleTiers: {}, choices }), d);
    assert.equal(first.status, 200, await first.clone().text());
    assert.deepEqual(await first.json().then((j: { spaces: number; rooms: number; updated: number }) => [j.spaces, j.rooms, j.updated]), [3, 7, 0]);
    assert.ok(d.asked.includes("community-reconcile"));
    const rooms = (await pool.query(`SELECT r.name, s.name AS space, s.kind, r.see_rule, r.post_rule, r.kind AS rkind, r.published, r.retention_days, r.discord_channel_id
      FROM site.community_rooms r JOIN site.community_spaces s ON s.id = r.space_id WHERE r.discord_import_id IS NOT NULL ORDER BY r.id`)).rows;
    assert.deepEqual(rooms.map((r) => [r.name, r.space, r.see_rule, r.post_rule, r.rkind, r.published, r.retention_days, r.discord_channel_id]), [
      ["rules", "Example", "everyone", "staff", "text", true, 30, null],
      ["alerts", "Stream", "everyone", "mods", "announcement", true, null, null],
      ["general", "Social", "everyone", "everyone", "text", true, 30, null],
      ["politics", "Social", "everyone", "everyone", "text", true, 30, null],
      ["tech", "Social", "everyone", "everyone", "text", true, 30, null],
      ["mod-general", "🔒 - 𝓜𝓸𝓭 𝓛𝓸𝓭𝓰𝓮", "mods", "everyone", "text", false, 30, null],
      ["mods", "🔒 - 𝓜𝓸𝓭 𝓛𝓸𝓭𝓰𝓮", "mods", "everyone", "text", false, 30, null],
    ]);
    const cats = (await pool.query(`SELECT c.name, h.kind AS parent FROM site.community_spaces c JOIN site.community_spaces h ON h.id = c.parent_id WHERE c.kind = 'category' ORDER BY c.order_key COLLATE "C"`)).rows;
    assert.deepEqual(cats.map((c) => [c.name, c.parent]), [["Stream", "hub"], ["Social", "hub"], ["🔒 - 𝓜𝓸𝓭 𝓛𝓸𝓭𝓰𝓮", "hub"]]);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM site.community_discord_roles WHERE guild_id = $1`, [G])).rows[0].n, 36);
    assert.deepEqual((await pool.query(`SELECT guild_name, imported_by FROM site.community_discord_import`)).rows, [{ guild_name: "Example Stream", imported_by: "@admin:example.test" }]);

    // retry: the same confirm again (an answer that got lost) makes nothing twice.
    const again = await confirmImportResponse(post({ guildId: G, roleTiers: {}, choices }), d);
    assert.deepEqual(await again.json().then((j: { spaces: number; rooms: number; words: string }) => [j.spaces, j.rooms, j.words]),
      [0, 0, "Nothing new to import: the community already has every channel you chose."]);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM site.community_rooms`)).rows[0].n, 8);

    // restart: a new process (fresh deps, nothing in memory) and a later read in which a channel was
    // renamed on Discord. The Mod is chosen Staff this time; the next read must offer that again.
    file = line("2026-11-04T12:30:00Z", (cs) => cs.map((c) => (c.name === "politics" ? { ...c, name: "news" } : c)));
    const d2 = deps(pool, () => file, Date.parse("2026-11-04T12:31:00Z"));
    const modRole = RAW.roles.find((r) => r.name === "Mod")!.id;
    const second = await confirmImportResponse(post({ guildId: G, roleTiers: { [modRole]: "staff" }, choices: { rooms: {}, spaces: {} } }), d2);
    assert.deepEqual(await second.json().then((j: { rooms: number; updated: number }) => [j.rooms, j.updated]), [0, 0], "a change is proposed unticked: nothing changes");
    assert.equal((await pool.query(`SELECT name FROM site.community_rooms WHERE discord_import_id = $1`, [id("politics")])).rows[0].name, "politics");
    const ticked = await confirmImportResponse(post({ guildId: G, roleTiers: { [modRole]: "staff" }, choices: { rooms: { [id("politics")]: { include: true } }, spaces: {} } }), d2);
    assert.deepEqual(await ticked.json().then((j: { rooms: number; updated: number }) => [j.rooms, j.updated]), [0, 1]);
    assert.equal((await pool.query(`SELECT name FROM site.community_rooms WHERE discord_import_id = $1`, [id("politics")])).rows[0].name, "news");
    // The next read offers the Mod as Staff again: the choice was saved.
    const reread = await readImportResponse(new Request("http://site.test/x", { method: "POST", body: JSON.stringify({ guildId: G }) }), d2);
    assert.deepEqual((await reread.json() as { savedTiers: Record<string, string> }).savedTiers[modRole], "staff");

    // A read more than an hour old is read again before it is imported.
    const d3 = deps(pool, () => file, Date.parse("2026-11-04T14:00:00Z"));
    const stale = await confirmImportResponse(post({ guildId: G, roleTiers: {}, choices: { rooms: {}, spaces: {} } }), d3);
    assert.equal(stale.status, 409);
    assert.match((await stale.json() as { error: string }).error, /more than an hour old/);
    // A read of another server is never imported as this one.
    const other = await confirmImportResponse(post({ guildId: "100000000000000102", roleTiers: {}, choices: { rooms: {}, spaces: {} } }), d2);
    assert.equal(other.status, 409);
  } finally {
    await fresh(pool).catch(() => {});
    await pool.query("DELETE FROM site.community_rooms").catch(() => {});
    await pool.query("DELETE FROM site.community_spaces").catch(() => {});
    await lock.query("SELECT pg_advisory_unlock(165165)");
    lock.release();
    await pool.end();
  }
});
