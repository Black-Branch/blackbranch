// The Discord import's proposal (discordImport.ts): spike 0.3's server, read by the bridge's own reader
// (install/ooye/discord-read.js, run for real against a stand-in Discord serving the recorded shapes),
// reduced to the community byte for byte; the sentence matcher on each rule; a second import's diff;
// the confirm's plan. Run: env -u DATABASE_URL node --test app/lib/community/discordImport.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  diffImport, guildFrom, importPlan, proposeCommunity, type DiscordGuild, type ImportedHere, type Proposal,
} from "./discordImport.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "../../../..");
const READ_JS = path.join(ROOT, "install/ooye/discord-read.js");
const RAW = JSON.parse(readFileSync(path.join(ROOT, "install/fixtures/discord/guild.json"), "utf8")) as {
  guild: { id: string }; channels: { id: string; name: string; type: number }[]; roles: { id: string; name: string }[];
};
const G = RAW.guild.id;
const TOKEN = "MTAwMDAwMDAwMDAwMDAwOTAw.Gabcde.not-a-real-token-only-a-test-string";

/** A stand-in Discord serving the fixture; every request recorded (method, path, auth). */
async function standIn(): Promise<{ url: string; seen: { method: string; path: string; auth: string }[]; close: () => Promise<void> }> {
  const seen: { method: string; path: string; auth: string }[] = [];
  const r = RAW as unknown as Record<string, unknown>;
  const routes: Record<string, unknown> = {
    "/users/@me": r.me, "/applications/@me": r.application, "/users/@me/guilds": r.guilds,
    [`/guilds/${G}`]: r.guild, [`/guilds/${G}/channels`]: r.channels, [`/guilds/${G}/roles`]: r.roles, [`/guilds/${G}/emojis`]: r.emojis,
  };
  const server: Server = createServer((req, res) => {
    seen.push({ method: req.method ?? "", path: req.url ?? "", auth: String(req.headers.authorization ?? "") });
    const body = routes[req.url ?? ""];
    res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? { message: "Unknown Guild", code: 10004 }));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((ok) => server.close(() => ok())) };
}

/** discord-read.js run for real, in a folder holding a registration.yaml, against the stand-in. */
async function read(api: string, ...args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), "bb-dread-"));
  try {
    writeFileSync(path.join(dir, "registration.yaml"), JSON.stringify({ as_token: "x".repeat(40), ooye: { discord_token: TOKEN } }));
    const ooye = path.join(dir, "ooye");
    mkdirSync(ooye);
    writeFileSync(path.join(ooye, "addbot.js"), "module.exports.permissions = 2251801424568320n\n");
    const p = spawn(process.execPath, [READ_JS, ...args], { cwd: dir, env: { ...process.env, BB_DISCORD_API: api, BB_OOYE_ROOT: ooye } });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const code = await new Promise<number | null>((ok) => p.on("close", ok));
    return { code, out, err };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

let cached: DiscordGuild | null = null;
async function fixtureGuild(): Promise<DiscordGuild> {
  if (cached) return cached;
  const d = await standIn();
  try {
    const r = await read(d.url, "guild", G);
    assert.equal(r.code, 0, r.err);
    const g = guildFrom(JSON.parse(r.out));
    assert.ok(g, "the reader's line parses as a guild");
    cached = g;
    return g;
  } finally { await d.close(); }
}
const idOf = (name: string, type?: number) => RAW.channels.find((c) => c.name === name && (type === undefined || c.type === type))!.id;
const roleId = (name: string) => RAW.roles.find((r) => r.name === name)!.id;

test("readGuild: the bridge's reader sends only GETs with the bot token, and its line holds the server whole", async () => {
  const d = await standIn();
  try {
    const r = await read(d.url, "guild", G);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.split("\n").length, 2, "one line");
    assert.ok(d.seen.length === 4 && d.seen.every((s) => s.method === "GET" && s.auth === `Bot ${TOKEN}`), JSON.stringify(d.seen));
    const g = guildFrom(JSON.parse(r.out))!;
    assert.equal(g.categories.length, 3);
    assert.equal(g.channels.length, 11);
    assert.equal(g.roles.length, 36);
    assert.deepEqual(g.emoji, { static: 59, animated: 32 });
    assert.equal(g.premiumTier, 2);
    // the token never reaches the output
    assert.ok(!r.out.includes(TOKEN.split(".")[2]!));
  } finally { await d.close(); }
});

test("readGuild: who the bot is, its switches, its servers and OOYE's own add-the-bot link", async () => {
  const d = await standIn();
  try {
    const r = await read(d.url, "bot");
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out), {
      v: 1, ok: true, bot: { id: "100000000000000900", name: "Example Bridge" }, appId: "100000000000000900",
      intents: { presence: true, members: true, content: true },
      invite: "https://discord.com/oauth2/authorize?client_id=100000000000000900&scope=bot&permissions=2251801424568320",
      guilds: [{ id: G, name: "Example Stream" }, { id: "100000000000000102", name: "Test Server" }],
    });
  } finally { await d.close(); }
});

test("readGuild: a server the bot is not in, Discord down, a bad call: said in one line or refused, never a crash", async () => {
  const d = await standIn();
  try {
    const missing = await read(d.url, "guild", "100000000000000199");
    assert.equal(missing.code, 0);
    assert.deepEqual(JSON.parse(missing.out), { v: 1, ok: false, status: 404, error: "Unknown Guild" });
  } finally { await d.close(); }
  const down = await read("http://127.0.0.1:9", "bot");
  assert.deepEqual(JSON.parse(down.out), { v: 1, ok: false, status: null, error: "Discord did not answer" });
  for (const bad of [[], ["guild"], ["guild", "12"], ["guild", `${G};x`], ["bot", G], ["delete", G]]) {
    const b = await read("http://127.0.0.1:9", ...bad);
    assert.equal(b.code, 1, bad.join(" "));
    assert.equal(b.out, "");
  }
});

test("guildFrom: a line in another shape is no guild (null), never a partial one", async () => {
  const g = await fixtureGuild();
  assert.equal(guildFrom(null), null);
  assert.equal(guildFrom({ v: 1, ok: false, status: 404, error: "x" }), null);
  assert.equal(guildFrom({ v: 2, ok: true }), null);
  const line = JSON.parse(JSON.stringify({ v: 1, ok: true, guild: { id: g.id, name: g.name, premiumTier: 2 }, channels: [...g.categories, ...g.channels], roles: g.roles, emoji: g.emoji, readAt: "x" }));
  assert.ok(guildFrom(line));
  assert.equal(guildFrom({ ...line, roles: [{ ...line.roles[0], id: "nope" }] }), null);
  assert.equal(guildFrom({ ...line, channels: [{ ...line.channels[0], overwrites: [{ id: G, type: 0, allow: "x", deny: "0" }] }] }), null);
});

// ── the recorded server, reduced ────────────────────────────────────────────────────────────────

test("proposeCommunity on spike 0.3's server: 14 channels → 3 nested spaces, 7 rooms, 4 kept; nothing needs a choice", async () => {
  const p = await fixtureGuild().then((g) => proposeCommunity(g));
  const stream = idOf("Stream"), social = idOf("Social"), lodge = idOf("🔒 - 𝓜𝓸𝓭 𝓛𝓸𝓭𝓰𝓮");
  assert.deepEqual(p.guild, { id: G, name: "Example Stream" });
  assert.deepEqual(p.spaces, [
    { discordId: stream, name: "Stream" }, { discordId: social, name: "Social" }, { discordId: lodge, name: "🔒 - 𝓜𝓸𝓭 𝓛𝓸𝓭𝓰𝓮" },
  ]);
  const room = (name: string, space: string | null, see: string, post: string, extra: Partial<Proposal["rooms"][number]> = {}) => ({
    discordId: idOf(name, name === "alerts" ? 5 : 0), spaceDiscordId: space, name, kind: "text", topic: null, see, post, exact: true, note: null, ...extra,
  });
  assert.deepEqual(p.rooms, [
    room("rules", null, "everyone", "staff", { topic: "Read first." }),
    room("alerts", stream, "everyone", "mods", { kind: "announcement", note: "Discord lets everyone post here; an announcement channel takes Mods and above. Choose Everyone who can see to keep Discord's." }),
    room("general", social, "everyone", "everyone", { topic: "Anything goes." }),
    room("politics", social, "everyone", "everyone"),
    room("tech", social, "everyone", "everyone"),
    room("𝓶𝓸𝓭-𝓰𝓮𝓷𝓮𝓻𝓪𝓵", lodge, "mods", "everyone"),
    room("mods", lodge, "mods", "everyone"),
  ]);
  assert.deepEqual(p.kept.map((k) => [k.name, k.kind, k.spaceDiscordId]), [
    ["content-suggestions", "forum", stream], ["waiting-room", "voice", stream], ["VC", "voice", stream], ["general", "voice", social],
  ]);
  assert.match(p.kept[0]!.reason, /^Forums stay on Discord/);
  assert.deepEqual(p.needsChoice, []);
  assert.deepEqual(p.emoji, { static: 59, animated: 32, limit: 150, fits: true });
});

test("proposeCommunity on spike 0.3's server: 36 roles → the ladder, with each Supporter's source and the Mod offered Mod or Staff", async () => {
  const p = await fixtureGuild().then((g) => proposeCommunity(g));
  assert.equal(p.roleMap.length, 36);
  const S = (name: string, source: string) => [name, "supporter", source];
  assert.deepEqual(p.roleMap.map((r) => (r.tier === "supporter" ? [r.name, r.tier, r.source] : [r.name, r.tier])), [
    ["Admin", "admin"], ["Guard", "bot"], ["Mod", "mod"], ["Helper", "bot"], ["Bot", "bot"], S("Server Booster", "booster"),
    S("Twitch Subscriber", "twitch"), S("Twitch Subscriber: Tier 1", "twitch"), S("Twitch Subscriber: Tier 2", "twitch"), S("Twitch Subscriber: Tier 3", "twitch"),
    S("YouTube Member", "youtube"), S("YouTube Member: Level 1", "youtube"), S("YouTube Member: Level 2", "youtube"), S("YouTube Member: Level 3", "youtube"),
    S("Patreon: T1", "patreon"), S("Patreon: T2", "patreon"), S("Patreon: T3", "patreon"), S("Patreon: T4", "patreon"), S("Patreon: T5", "patreon"), S("Patron", "patreon"),
    S("Ko-Fi: Member", "ko-fi"), S("Ko-Fi: Supporter", "ko-fi"), S("VIP", "named"), S("VIP", "named"),
    ["Ko-fi Bot", "bot"], ["Patreon Bot", "bot"], ["Threads", "bot"], ["Craft", "bot"], ["Autodelete", "bot"], ["Embeds", "bot"],
    ["Regular", "member"], ["Dev", "member"], ["Miner", "member"], ["Suggestions Curator", "member"], ["Lurker", "member"], ["@everyone", "member"],
  ]);
  // A bot holding Administrator is a Bot, not an Admin; the Mod holding Manage Channels is asked about.
  assert.equal(p.roleMap.find((r) => r.name === "Guard")!.signal, "bot");
  assert.deepEqual(p.roleMap.filter((r) => r.ask).map((r) => r.name), ["Mod"]);
  assert.equal(p.roleMap.find((r) => r.name === "Admin")!.signal, "administrator");
});

test("proposeCommunity: choosing Staff for the Mod changes the sentences, and fails closed where nothing fits (needs a choice)", async () => {
  const g = await fixtureGuild();
  const p = proposeCommunity(g, { roleTiers: { [roleId("Mod")]: "staff" } });
  const r = (name: string) => p.rooms.find((x) => x.name === name)!;
  // No role is a Mod now: "Mods and above" and "Staff and above" are the same set, and the least restrictive reads.
  assert.deepEqual([r("mods").see, r("mods").exact], ["mods", true]);
  // rules: only Admins post on Discord; "Staff and above" would let the (now Staff) Mod post too.
  assert.equal(r("rules").post, "staff");
  assert.equal(r("rules").exact, false);
  assert.deepEqual(p.needsChoice.map((n) => n.name), ["rules"]);
  assert.match(p.needsChoice[0]!.words.join(" "), /Who can post: no sentence matches Discord.*also lets in Mod/);
  // @everyone and a bad tier are never taken from the choices.
  const q = proposeCommunity(g, { roleTiers: { [G]: "admin", [roleId("Dev")]: "owner" as never } });
  assert.equal(q.roleMap.find((x) => x.name === "@everyone")!.tier, "member");
  assert.equal(q.roleMap.find((x) => x.name === "Dev")!.tier, "member");
});

// ── the sentence matcher, one rule at a time ──────────────────────────────────────────────────────

const ADMIN = BigInt(1) << BigInt(3), VIEW = BigInt(1) << BigInt(10), SEND = BigInt(1) << BigInt(11), MANAGE_CH = BigInt(1) << BigInt(4);
let seq = 500;
const sid = () => String(BigInt(100000000000000000) + BigInt(seq++));
const GID = "100000000000000777";
type RoleIn = { name: string; perms?: bigint; tags?: Record<string, string | null> };
/** A small server: @everyone (view+send), the roles given, and one channel with the overwrites given. */
function server(roles: RoleIn[], overwrites: (ids: Record<string, string>) => { id: string; type?: 0 | 1; allow?: bigint; deny?: bigint }[], type = 0): DiscordGuild {
  const ids: Record<string, string> = { "@everyone": GID };
  const rs = roles.map((r, i) => { const id = sid(); ids[r.name] = id; return { id, name: r.name, position: roles.length - i, permissions: String(r.perms ?? BigInt(0)), managed: !!r.tags, tags: r.tags ?? {} }; });
  rs.push({ id: GID, name: "@everyone", position: 0, permissions: String(VIEW | SEND), managed: false, tags: {} });
  return {
    id: GID, name: "Small", premiumTier: 0, categories: [],
    channels: [{ id: sid(), name: "c", type, position: 0, parentId: null, topic: null,
      overwrites: overwrites(ids).map((o) => ({ id: o.id, type: o.type ?? 0, allow: String(o.allow ?? BigInt(0)), deny: String(o.deny ?? BigInt(0)) })) }],
    roles: rs, emoji: { static: 0, animated: 0 },
  };
}
const LADDER: RoleIn[] = [{ name: "Admin", perms: ADMIN }, { name: "Staff" }, { name: "Mod" }, { name: "Patron" }, { name: "Regular" }];
const one = (g: DiscordGuild) => { const p = proposeCommunity(g); return { room: p.rooms[0]!, needs: p.needsChoice }; };

test("sentence matcher, who can see: each of the five sentences when Discord's set is exactly its own", () => {
  const see = (allowed: string[]) => one(server(LADDER, (ids) => [{ id: GID, deny: VIEW }, ...allowed.map((n) => ({ id: ids[n]!, allow: VIEW }))])).room;
  assert.deepEqual([one(server(LADDER, () => [])).room.see, one(server(LADDER, () => [])).room.exact], ["everyone", true]);
  assert.deepEqual([see(["Staff", "Mod", "Patron"]).see, see(["Staff", "Mod", "Patron"]).exact], ["supporters", true]);
  assert.deepEqual([see(["Staff", "Mod"]).see, see(["Staff", "Mod"]).exact], ["mods", true]);
  assert.deepEqual([see(["Staff"]).see, see(["Staff"]).exact], ["staff", true]);
  // Admins alone (Administrator passes every overwrite): Invited people only.
  assert.deepEqual([see([]).see, see([]).exact], ["invited", true]);
});

test("sentence matcher, who can post: each of the four sentences when Discord's set is exactly its own", () => {
  const post = (allowed: string[]) => one(server(LADDER, (ids) => [{ id: GID, deny: SEND }, ...allowed.map((n) => ({ id: ids[n]!, allow: SEND }))])).room;
  assert.equal(one(server(LADDER, () => [])).room.post, "everyone");
  assert.equal(post(["Staff", "Mod", "Patron"]).post, "supporters");
  assert.equal(post(["Staff", "Mod"]).post, "mods");
  assert.equal(post(["Staff"]).post, "staff");
  assert.ok([post(["Staff", "Mod", "Patron"]), post(["Staff", "Mod"]), post(["Staff"])].every((r) => r.exact));
});

test("sentence matcher: an empty rung makes two sentences equal — the least restrictive wins, Admins alone take Invited", () => {
  // No Staff role: "Mods and above" and "Staff and above"… differ; with no Mod role either, a channel only
  // Admins see equals both "Staff and above" and "Invited people only": the narrowest reading is Discord's.
  const noMid: RoleIn[] = [{ name: "Admin", perms: ADMIN }, { name: "Patron" }];
  assert.equal(one(server(noMid, () => [{ id: GID, deny: VIEW }])).room.see, "invited");
  // Everyone but supporters can post: with no supporter… the exact match is the least restrictive one.
  const noSup: RoleIn[] = [{ name: "Admin", perms: ADMIN }, { name: "Mod" }];
  const r = one(server(noSup, (ids) => [{ id: GID, deny: SEND }, { id: ids.Mod!, allow: SEND }])).room;
  assert.deepEqual([r.post, r.exact], ["supporters", true]);
});

test("sentence matcher: no exact match fails closed (never wider than Discord) and goes on needsChoice with the overwrites", () => {
  // Mods and Patrons see it, Staff does not: no sentence is that set.
  const g = server(LADDER, (ids) => [{ id: GID, deny: VIEW }, { id: ids.Mod!, allow: VIEW }, { id: ids.Patron!, allow: VIEW }]);
  const { room, needs } = one(g);
  assert.equal(room.see, "invited", "the widest sentence that lets in nobody Discord keeps out");
  assert.equal(room.exact, false);
  assert.equal(needs.length, 1);
  assert.match(needs[0]!.words[0]!, /^Who can see: no sentence matches Discord\. "Invited people only" leaves out Mod \(Mod\), Patron \(Supporter\)\.$/);
  assert.ok(needs[0]!.overwrites.some((o) => /^@everyone: deny VIEW_CHANNEL$/.test(o)), needs[0]!.overwrites.join(" | "));
  assert.ok(needs[0]!.overwrites.some((o) => /^Mod: allow VIEW_CHANNEL$/.test(o)));
});

test("sentence matcher: a per-person overwrite cannot be a sentence, so the channel needs a choice", () => {
  const { room, needs } = one(server(LADDER, () => [{ id: "100000000000000888", type: 1, allow: VIEW }]));
  assert.deepEqual([room.see, room.exact], ["everyone", true]);
  assert.match(needs[0]!.words.join(" "), /1 overwrite for one person/);
});

test("sentence matcher: an announcement channel takes Mods and above, unless Discord explicitly lets a wider group post", () => {
  assert.equal(one(server(LADDER, () => [], 5)).room.post, "mods");
  const explicit = one(server(LADDER, (ids) => [{ id: ids.Patron!, allow: SEND }], 5)).room;
  assert.deepEqual([explicit.post, explicit.note], ["everyone", null]);
});

test("role signals in order: bot tag, Administrator, name, booster, linked platform, a bot-assigned name; Manage Channels asks", () => {
  const g = server([
    { name: "Owner" }, { name: "Admin Bot", perms: ADMIN, tags: { bot_id: "100000000000000999" } }, { name: "Head", perms: ADMIN },
    { name: "Staff" }, { name: "Moderators", perms: MANAGE_CH }, { name: "Booster", tags: { premium_subscriber: null } },
    { name: "Members", tags: { integration_id: "100000000000000998" } }, { name: "Tier 2" }, { name: "Tidy", perms: MANAGE_CH }, { name: "Kicker", perms: BigInt(1) << BigInt(1) }, { name: "Plain" },
  ], () => []);
  assert.deepEqual(proposeCommunity(g).roleMap.map((r) => [r.name, r.tier, r.signal, r.ask]), [
    ["Owner", "admin", "name", false], ["Admin Bot", "bot", "bot", false], ["Head", "admin", "administrator", false],
    ["Staff", "staff", "name", false], ["Moderators", "mod", "name", true], ["Booster", "supporter", "booster", false],
    ["Members", "supporter", "linked platform", false], ["Tier 2", "supporter", "name", false], ["Tidy", "staff", "manage permissions", false],
    ["Kicker", "mod", "mod permissions", false], ["Plain", "member", "none", false], ["@everyone", "member", "@everyone", false],
  ]);
});

test("emoji: counted against the server's boost tier (50 / 100 / 150 / 250 each)", () => {
  const g = { ...server([], () => []), premiumTier: 0, emoji: { static: 51, animated: 3 } };
  assert.deepEqual(proposeCommunity(g).emoji, { static: 51, animated: 3, limit: 50, fits: false });
  assert.equal(proposeCommunity({ ...g, premiumTier: 3 }).emoji.limit, 250);
});

// ── a second import: the diff ─────────────────────────────────────────────────────────────────────

function hereAfter(p: Proposal): ImportedHere {
  let id = 10;
  const spaceRow = new Map(p.spaces.map((s) => [s.discordId, id++]));
  return {
    hubId: 1,
    spaces: [{ id: 1, discordImportId: null, name: "Example" }, ...p.spaces.map((s) => ({ id: spaceRow.get(s.discordId)!, discordImportId: s.discordId, name: s.name }))],
    rooms: [
      { id: 2, discordImportId: null, spaceId: 1, name: "general", see: "everyone", post: "everyone", discordChannelId: null },
      ...p.rooms.map((r) => ({ id: id++, discordImportId: r.discordId, spaceId: r.spaceDiscordId ? spaceRow.get(r.spaceDiscordId)! : 1, name: r.name, see: r.see, post: r.post, discordChannelId: null })),
    ],
  };
}

test("first import: every space and room is new; a room named like one already in its space is flagged", async () => {
  const p = proposeCommunity(await fixtureGuild());
  const d = diffImport(p, { hubId: 1, spaces: [{ id: 1, discordImportId: null, name: "Example" }],
    rooms: [{ id: 2, discordImportId: null, spaceId: 1, name: "rules", see: "everyone", post: "mods", discordChannelId: null }] });
  assert.ok(d.spaces.every((s) => s.status === "new") && d.spaces.length === 3);
  assert.ok(d.rooms.every((r) => r.status === "new") && d.rooms.length === 7);
  assert.deepEqual(d.rooms.filter((r) => r.clash).map((r) => r.discordId), [idOf("rules")]);
  assert.deepEqual(d.gone, []);
});

test("retry: a second import of the same server proposes nothing new and never a second row", async () => {
  const p = proposeCommunity(await fixtureGuild());
  const d = diffImport(p, hereAfter(p));
  assert.ok(d.spaces.every((s) => s.status === "same"), JSON.stringify(d.spaces));
  assert.ok(d.rooms.every((r) => r.status === "same"), JSON.stringify(d.rooms));
  const plan = importPlan(p, d, { rooms: {}, spaces: {} });
  assert.ok(!("error" in plan));
  assert.deepEqual(plan, { newSpaces: [], newRooms: [], updates: [] });
});

test("second import after changes on both sides: Discord's changes are proposed, unchecked; a channel gone on Discord is kept here", async () => {
  const g = await fixtureGuild();
  const first = proposeCommunity(g);
  const h = hereAfter(first);
  // Here: the streamer renamed #tech. On Discord: politics renamed, a new channel, #mods gone.
  h.rooms.find((r) => r.name === "tech")!.name = "technology";
  const g2: DiscordGuild = {
    ...g,
    channels: [...g.channels.filter((c) => c.name !== "mods").map((c) => (c.name === "politics" ? { ...c, name: "news" } : c)),
      { id: "100000000000000666", name: "clips", type: 0, position: 9, parentId: idOf("Social"), topic: null, overwrites: [] }],
  };
  const p = proposeCommunity(g2);
  const d = diffImport(p, h);
  const st = (name: string) => d.rooms.find((r) => p.rooms.find((x) => x.discordId === r.discordId)!.name === name)!;
  assert.equal(st("clips").status, "new");
  assert.deepEqual([st("news").status, st("news").changes], ["changed", [{ field: "name", discord: "news", here: "politics" }]]);
  assert.deepEqual([st("tech").status, st("tech").changes], ["changed", [{ field: "name", discord: "tech", here: "technology" }]]);
  assert.deepEqual(d.gone.map((x) => x.name), ["mods"]);
  // Confirmed as proposed: the new room only; a change is applied only when ticked.
  const plain = importPlan(p, d, { rooms: {}, spaces: {} });
  assert.ok(!("error" in plain));
  assert.deepEqual(plain.newRooms.map((r) => [r.name, r.spaceRef]), [["clips", { rowId: h.spaces.find((s) => s.name === "Social")!.id }]]);
  assert.deepEqual(plain.updates, []);
  assert.deepEqual(plain.newSpaces, [], "a room in a category already here goes into that row: the category is never made twice");
  // retry: a tick whose edit the row already holds (the streamer's own name, kept) changes nothing.
  const kept = importPlan(p, d, { rooms: { [st("tech").discordId]: { include: true, name: "technology" } }, spaces: {} });
  assert.ok(!("error" in kept));
  assert.deepEqual(kept.updates, []);
  const ticked = importPlan(p, d, { rooms: { [st("news").discordId]: { include: true } }, spaces: {} });
  assert.ok(!("error" in ticked));
  assert.deepEqual(ticked.updates.map((u) => [u.rowId, u.name]), [[st("news").rowId, "news"]]);
});

test("importPlan: the streamer's edits are checked; a skipped room is not made; a space with no room left is not made", async () => {
  const p = proposeCommunity(await fixtureGuild());
  const d = diffImport(p, { hubId: 1, spaces: [{ id: 1, discordImportId: null, name: "Example" }], rooms: [] });
  const mg = idOf("𝓶𝓸𝓭-𝓰𝓮𝓷𝓮𝓻𝓪𝓵"), mods = idOf("mods"), gen = idOf("general", 0);
  const plan = importPlan(p, d, {
    rooms: { [mg]: { include: false }, [mods]: { include: false }, [gen]: { include: true, name: "#chat", see: "supporters", post: "mods" } },
    spaces: { [idOf("Social")]: { name: "Hangout" } },
  });
  assert.ok(!("error" in plan));
  assert.deepEqual(plan.newSpaces.map((s) => s.name), ["Stream", "Hangout"]);
  const chat = plan.newRooms.find((r) => r.discordId === gen)!;
  assert.deepEqual([chat.name, chat.see, chat.post, chat.published, chat.retentionDays], ["chat", "supporters", "mods", false, 30]);
  assert.equal(plan.newRooms.find((r) => r.name === "alerts")!.retentionDays, null, "an announcement channel keeps no limit of its own");
  assert.equal(plan.newRooms.length, 5);
  assert.deepEqual(importPlan(p, d, { rooms: { [gen]: { include: true, see: "nobody" as never } }, spaces: {} }), { error: "#general: Unknown rule for who can see." });
  assert.deepEqual(importPlan(p, d, { rooms: { [gen]: { include: true, name: "" } }, spaces: {} }), { error: "#general: A channel name is 1 to 100 characters." });
  assert.deepEqual(importPlan(p, d, { rooms: {}, spaces: { [idOf("Social")]: { name: "x".repeat(101) } } }), { error: "Social: A category name is 1 to 100 characters." });
});

test("importPlan: a change that would narrow a room linked to Discord is refused (unlink it first)", async () => {
  const g = await fixtureGuild();
  const first = proposeCommunity(g);
  const h = hereAfter(first);
  const gen = h.rooms.find((r) => r.discordImportId === idOf("general", 0))!;
  gen.discordChannelId = idOf("general", 0);
  gen.see = "everyone";
  const g2 = { ...g, channels: g.channels.map((c) => (c.name === "general" && c.type === 0 ? { ...c, overwrites: [{ id: g.id, type: 0 as const, allow: "0", deny: String(VIEW) }] } : c)) };
  const p = proposeCommunity(g2);
  const d = diffImport(p, h);
  assert.deepEqual(importPlan(p, d, { rooms: { [gen.discordImportId!]: { include: true } }, spaces: {} }),
    { error: "#general is linked to Discord: unlink it before it is narrowed." });
});
