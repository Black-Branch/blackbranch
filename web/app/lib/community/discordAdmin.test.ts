// Admin Panel › Site › Discord, server side (discordAdmin.ts): the Links table's presses, against a
// stand-in bridge (fetch), a logged pool, and a host that answers. The real bridge was asked too (task
// 2.4 report: OOYE 3.7 own code, Discord a stand-in). Run: env -u DATABASE_URL node --test app/lib/community/discordAdmin.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bridgeStateFrom, discordViewResponse, linkRoomResponse, linkServerResponse, unlinkRoomResponse, unlinkServerResponse, type DiscordDeps,
} from "./discordAdmin.ts";
import type { BridgeLinks } from "./discordLinks.ts";
import type { BridgeCall } from "./discordLink.ts";

const GUILD = "100000000000000101";
const CHANNEL = "100000000000000201";
const HUB = "!hub:example.test";
const ROOM = "!general:example.test";
const T0 = "2026-10-31T12:00:00Z";

type Row = { id: number; name: string; see_rule: string; post_rule: string; archived: boolean; matrix_room_id: string | null; discord_channel_id: string | null; encrypted: boolean };
const general = (over: Partial<Row> = {}): Row => ({ id: 1, name: "general", see_rule: "everyone", post_rule: "everyone", archived: false, matrix_room_id: ROOM, discord_channel_id: null, encrypted: false, ...over });

const refusal = (status: number, data: string) => new Response(JSON.stringify({ statusCode: status, data }), { status });
const ok = () => new Response(null, { status: 204 });

/** The deps with every outside thing recorded: the bridge's calls, the SQL, the host's verbs. */
function world(opts: { rows?: Row[]; links?: BridgeLinks | null; bridge?: (Response | Error)[]; runs?: boolean; reconciler?: boolean; token?: boolean; bridgeForgets?: boolean; freshRead?: BridgeLinks; spaceKeeps?: "links" | "guild" } = {}) {
  const rows = opts.rows ?? [general()];
  const bridgeAnswers = [...(opts.bridge ?? [])];
  const calls = { bridge: [] as string[], verbs: [] as string[], sql: [] as { sql: string; params: unknown[] }[], host: [] as string[], reconcile: 0 };
  let links: BridgeLinks | null = opts.links === undefined ? { guilds: [{ guildId: GUILD, spaceId: HUB, privacyLevel: 1 }], links: [] } : opts.links;
  let answerAt = "2026-10-31T11:00:00Z";
  const pool = {
    query: async <R extends object>(sql: string, params: unknown[] = []) => {
      calls.sql.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      if (/^\s*SELECT id, name, see_rule/.test(sql) && /WHERE id = \$1/.test(sql)) return { rows: rows.filter((r) => r.id === params[0]) as unknown as R[] };
      if (/^\s*SELECT id, name, see_rule/.test(sql)) return { rows: rows as unknown as R[] };
      if (/SELECT id FROM site\.community_rooms WHERE discord_channel_id = \$1/.test(sql)) return { rows: rows.filter((r) => r.discord_channel_id === params[0] && r.id !== params[1]) as unknown as R[] };
      if (/^\s*SELECT discord_channel_id FROM site\.community_rooms WHERE discord_channel_id IS NOT NULL/.test(sql)) {
        return { rows: rows.filter((r) => r.discord_channel_id !== null).map((r) => ({ discord_channel_id: r.discord_channel_id })) as unknown as R[] };
      }
      if (/WHERE discord_channel_id = ANY\(\$1::text\[\]\)/.test(sql)) {
        for (const r of rows) if ((params[0] as string[]).includes(r.discord_channel_id ?? "")) r.discord_channel_id = null;
        return { rows: [] as R[] };
      }
      const set = /^\s*UPDATE site\.community_rooms SET discord_channel_id = (\$2|NULL)/.exec(sql);
      if (set) {
        for (const r of rows) {
          if (/WHERE id = \$1/.test(sql) && r.id !== params[0]) continue;
          if (/AND discord_channel_id IS NULL/.test(sql) && r.discord_channel_id !== null) continue;
          if (/AND discord_channel_id = \$2/.test(sql) && r.discord_channel_id !== params[1]) continue;
          r.discord_channel_id = set[1] === "$2" ? (params[1] as string) : null;
        }
      }
      return { rows: [] as R[] };
    },
  };
  // The host's call into the bridge (install/ooye/link.js): logged as the bridge's own path and body,
  // the host reading the room from the row marked for the channel and the space from the hub.
  const call: BridgeCall = async (verb) => {
    calls.verbs.push(verb);
    let m: RegExpExecArray | null;
    let at = "", b: Record<string, string> = {};
    if ((m = /^discord-link-space-(\d+)$/.exec(verb))) { at = "/api/link-space"; b = { guild_id: m[1]!, space_id: HUB }; }
    else if ((m = /^discord-privacy-(\d+)$/.exec(verb))) { at = "/api/privacy-level"; b = { guild_id: m[1]!, privacy_level: "link" }; }
    else if ((m = /^discord-unlink-space-(\d+)$/.exec(verb))) { at = "/api/unlink-space"; b = { guild_id: m[1]! }; }
    else if ((m = /^discord-link-(\d+)-(\d+)$/.exec(verb))) {
      const row = rows.find((r) => r.discord_channel_id === m![2]);
      if (!row?.matrix_room_id) return { hostRefused: "no room the panel may link is marked for that channel" };
      at = "/api/link"; b = { guild_id: m[1]!, matrix: row.matrix_room_id, discord: m[2]! };
    } else if ((m = /^discord-unlink-(\d+)-(\d+)$/.exec(verb))) { at = "/api/unlink"; b = { guild_id: m[1]!, channel_id: m[2]! }; }
    calls.bridge.push(`${at} ${JSON.stringify(b)}`);
    const a = bridgeAnswers.shift() ?? ok();
    if (a instanceof Error) return { ok: false, status: null, data: "" };
    // What the bridge's own record holds after an answered unlink (unless this bridge "forgets" to).
    if (a.ok && links && !opts.bridgeForgets) {
      if (at === "/api/unlink") links = { ...links, links: links.links.filter((l) => l.channelId !== b.channel_id) };
      if (at === "/api/unlink-space") {
        links = { guilds: opts.spaceKeeps === "guild" ? links.guilds : links.guilds.filter((g) => g.guildId !== b.guild_id),
          links: opts.spaceKeeps === "links" ? links.links : links.links.filter((l) => l.guildId !== b.guild_id) };
      }
    }
    const text = await a.text();
    const data = text ? String((JSON.parse(text) as { data?: string }).data ?? "") : "";
    return { ok: a.ok, status: a.status, data: a.ok ? "" : data };
  };
  const deps: DiscordDeps = {
    pool,
    call, canCall: opts.token !== false,
    hubRoomId: async () => HUB,
    links: async () => links,
    askHost: async (verb) => {
      calls.host.push(verb); answerAt = "2026-10-31T12:00:05Z";
      // The host's first fresh read finds what the bridge really holds (the copy before it was stale).
      if (verb === "discord-links" && opts.freshRead) { links = opts.freshRead; opts.freshRead = undefined; }
      return { ok: true, requestedAt: T0 };
    },
    hostAnswer: async () => ({ ok: true, at: answerAt, message: "links read" }),
    reconcile: opts.reconciler === false ? null : async () => { calls.reconcile++; return { ok: true, requestedAt: T0 }; },
    runFinishedSince: async () => opts.runs !== false,
    bridgeState: async () => ({ state: "on", words: "on and running: Discord and the homeserver let it in" }),
    sleep: async () => {},
    waits: { hostMs: 3, runMs: 3, stepMs: 1 },
    log: { log: () => {}, error: () => {} },
  };
  return { deps, rows, calls };
}
const json = (body: unknown, method = "POST") => new Request("http://x/api/admin/community/discord", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });
const path = (c: string) => c.split(" ")[0];

test("the view: the linked server, and per room the site's wish beside what the bridge holds", async () => {
  const w = world({
    rows: [general({ discord_channel_id: CHANNEL }), general({ id: 2, name: "mods", see_rule: "mods" }), general({ id: 3, name: "secret", see_rule: "mods", encrypted: true })],
    links: { guilds: [{ guildId: GUILD, spaceId: HUB, privacyLevel: 1 }], links: [{ channelId: CHANNEL, roomId: ROOM, guildId: GUILD, name: "test" }] },
  });
  const r = await read(await discordViewResponse(w.deps));
  assert.equal(r.status, 200);
  assert.equal(r.body.guildId, GUILD);
  assert.equal(r.body.canCall, true);
  const rooms = r.body.rooms as { name: string; bridged: boolean; channelId: string | null }[];
  assert.deepEqual(rooms.map((x) => [x.name, x.channelId, x.bridged]), [["general", CHANNEL, true], ["mods", null, false]], "an encrypted room is never listed");
});

test("link the server: the host marks it, the bot is seated by one run when it was not, then the bridge links and keeps it open", async () => {
  const w = world({ links: { guilds: [], links: [] }, bridge: [refusal(403, "You personally must invite OOYE to that space on Matrix"), ok(), ok()] });
  const r = await read(await linkServerResponse(json({ guildId: GUILD }), w.deps));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(w.calls.host, [`discord-guild-${GUILD}`, "discord-links"]);
  assert.equal(w.calls.reconcile, 1, "one run to seat the bot");
  assert.deepEqual(w.calls.bridge.map(path), ["/api/link-space", "/api/link-space", "/api/privacy-level"]);
  assert.match(String(r.body.words), /^Linked\./);
});

test("link the server: refused without a token, with a bad id, or when another server is linked", async () => {
  assert.equal((await linkServerResponse(json({ guildId: "12" }), world().deps)).status, 400);
  assert.match(String((await read(await linkServerResponse(json({ guildId: GUILD }), world({ token: false }).deps))).body.error), /not the bundle/);
  const other = await read(await linkServerResponse(json({ guildId: "1111111111111111111" }), world().deps));
  assert.equal(other.status, 409);
  assert.match(String(other.body.error), /another Discord server/);
});

test("retry_link_server_after_a_lost_answer: the space already linked goes on to the privacy step", async () => {
  const w = world({ links: { guilds: [], links: [] }, bridge: [refusal(400, `Guild ID ${GUILD} or space ID ${HUB} are already bridged and cannot be reused`), ok()] });
  assert.equal((await linkServerResponse(json({ guildId: GUILD }), w.deps)).status, 200);
  assert.deepEqual(w.calls.bridge.map(path), ["/api/link-space", "/api/privacy-level"]);
});

test("link a room: only one everyone can see, never touching the bridge or the row otherwise", async () => {
  for (const row of [general({ see_rule: "supporters" }), general({ post_rule: "mods" }), general({ archived: true }), general({ matrix_room_id: null })]) {
    const w = world({ rows: [row] });
    const r = await read(await linkRoomResponse(json({ roomId: 1, channelId: CHANNEL }), w.deps));
    assert.equal(r.status, 409, JSON.stringify(row));
    assert.deepEqual(w.calls.bridge, []);
    assert.equal(w.rows[0]!.discord_channel_id, null);
  }
  const w = world({ rows: [general({ see_rule: "mods" })] });
  assert.match(String((await read(await linkRoomResponse(json({ roomId: 1, channelId: CHANNEL }), w.deps))).body.error), /everyone in the community can see/);
});

test("link a room: the row is marked first, the bridge links it, the host reads the links", async () => {
  const w = world();
  const r = await read(await linkRoomResponse(json({ roomId: 1, channelId: CHANNEL }), w.deps));
  assert.equal(r.status, 200);
  assert.equal(r.body.linked, true);
  assert.equal(w.rows[0]!.discord_channel_id, CHANNEL);
  const markAt = w.calls.sql.findIndex((c) => /^UPDATE site\.community_rooms SET discord_channel_id = \$2/.test(c.sql));
  assert.ok(markAt >= 0);
  assert.deepEqual(w.calls.bridge, [`/api/link {"guild_id":"${GUILD}","matrix":"${ROOM}","discord":"${CHANNEL}"}`]);
  assert.deepEqual(w.calls.host, ["discord-links"]);
});

test("retry_link_room: not seated and the run not done keeps the wish (202); the next press links", async () => {
  const notSeated = refusal(400, "OOYE needs power level 100 (admin) in the target Matrix room");
  const w = world({ bridge: [notSeated], runs: false });
  const r = await read(await linkRoomResponse(json({ roomId: 1, channelId: CHANNEL }), w.deps));
  assert.equal(r.status, 202);
  assert.equal(r.body.waiting, true);
  assert.match(String(r.body.words), /still seating the bridge's bot/);
  assert.equal(w.rows[0]!.discord_channel_id, CHANNEL, "the wish is kept, so the reconciler seats the bot");
  assert.equal(w.calls.reconcile, 1);
  // The press again, now that the run has seated it.
  const again = world({ rows: w.rows, bridge: [ok()] });
  assert.equal((await linkRoomResponse(json({ roomId: 1, channelId: CHANNEL }), again.deps)).status, 200);
  // No answer at all: kept too.
  const silent = world({ bridge: [new TypeError("fetch failed")] });
  assert.equal((await linkRoomResponse(json({ roomId: 1, channelId: CHANNEL }), silent.deps)).status, 202);
  assert.equal(silent.rows[0]!.discord_channel_id, CHANNEL);
});

test("link a room: a refusal no wait can fix takes the mark off again", async () => {
  const w = world({ bridge: [refusal(400, `Channel ID ${CHANNEL} is not part of guild ${GUILD}`)] });
  const r = await read(await linkRoomResponse(json({ roomId: 1, channelId: CHANNEL }), w.deps));
  assert.equal(r.status, 409);
  assert.match(String(r.body.words), /another Discord server/);
  assert.equal(w.rows[0]!.discord_channel_id, null);
  assert.equal(w.calls.reconcile, 0);
});

test("restart_link_room_after_a_lost_answer: the bridge already holds exactly this link, so it is done", async () => {
  const w = world({
    rows: [general({ discord_channel_id: CHANNEL })],
    links: { guilds: [{ guildId: GUILD, spaceId: HUB, privacyLevel: 1 }], links: [{ channelId: CHANNEL, roomId: ROOM, guildId: GUILD, name: "test" }] },
    bridge: [refusal(400, `Channel ID ${CHANNEL} or room ID ${ROOM} are already bridged and cannot be reused`)],
  });
  assert.equal((await linkRoomResponse(json({ roomId: 1, channelId: CHANNEL }), w.deps)).status, 200);
  assert.equal(w.rows[0]!.discord_channel_id, CHANNEL);
});

test("link a room: the server must be linked first; another room's channel is refused", async () => {
  assert.match(String((await read(await linkRoomResponse(json({ roomId: 1, channelId: CHANNEL }), world({ links: { guilds: [], links: [] } }).deps))).body.error), /Link the Discord server first/);
  const w = world({ rows: [general(), general({ id: 2, name: "other", discord_channel_id: CHANNEL })] });
  assert.match(String((await read(await linkRoomResponse(json({ roomId: 1, channelId: CHANNEL }), w.deps))).body.error), /linked to another room/);
  assert.deepEqual(w.calls.bridge, []);
});

const HELD: BridgeLinks = { guilds: [{ guildId: GUILD, spaceId: HUB, privacyLevel: 1 }], links: [{ channelId: CHANNEL, roomId: ROOM, guildId: GUILD, name: "test" }] };
const held = (): BridgeLinks => JSON.parse(JSON.stringify(HELD)) as BridgeLinks;

test("unlink a room: the bridge first, then the row, then a run gives it back its own settings", async () => {
  const w = world({ rows: [general({ discord_channel_id: CHANNEL })], links: held() });
  assert.equal((await unlinkRoomResponse(json({ roomId: 1 }, "DELETE"), w.deps)).status, 200);
  assert.deepEqual(w.calls.bridge.map(path), ["/api/unlink"]);
  assert.equal(w.rows[0]!.discord_channel_id, null);
  assert.equal(w.calls.reconcile, 1);
  // The bridge not answering changes nothing.
  const silent = world({ rows: [general({ discord_channel_id: CHANNEL })], links: held(), bridge: [new TypeError("fetch failed")] });
  assert.equal((await unlinkRoomResponse(json({ roomId: 1 }, "DELETE"), silent.deps)).status, 409);
  assert.equal(silent.rows[0]!.discord_channel_id, CHANNEL);
});

test("unlink the server: the bridge unlinks it, every row's channel goes, a run follows", async () => {
  const w = world({ rows: [general({ discord_channel_id: CHANNEL }), general({ id: 2, name: "two", discord_channel_id: "100000000000000202" })], links: held() });
  const r = await read(await unlinkServerResponse(w.deps));
  assert.equal(r.status, 200);
  assert.match(String(r.body.words), /left the Discord server/);
  assert.deepEqual(w.calls.bridge.map(path), ["/api/unlink-space"]);
  assert.deepEqual(w.rows.map((x) => x.discord_channel_id), [null, null]);
  assert.equal(w.calls.reconcile, 1);
});

test("with the community keeper off, a press says why nothing can seat the bot", async () => {
  const w = world({ bridge: [refusal(400, "OOYE needs power level 100 (admin) in the target Matrix room")], reconciler: false });
  const r = await read(await linkRoomResponse(json({ roomId: 1, channelId: CHANNEL }), w.deps));
  assert.match(String(r.body.words), /community keeper is off/);
});

test("links unreadable: every press that writes refuses in plain words, and no row or bridge is touched", async () => {
  for (const press of [
    (d: DiscordDeps) => unlinkRoomResponse(json({ roomId: 1 }, "DELETE"), d),
    (d: DiscordDeps) => unlinkServerResponse(d),
    (d: DiscordDeps) => linkRoomResponse(json({ roomId: 1, channelId: CHANNEL }), d),
    (d: DiscordDeps) => linkServerResponse(json({ guildId: GUILD }), d),
  ]) {
    const w = world({ rows: [general({ discord_channel_id: CHANNEL })], links: null });
    const r = await read(await press(w.deps));
    assert.equal(r.status, 409);
    assert.match(String(r.body.error), /cannot read what the Discord bridge has linked/);
    assert.deepEqual(w.calls.bridge, []);
    assert.equal(w.rows[0]!.discord_channel_id, CHANNEL, "the row is untouched");
    assert.ok(!w.calls.sql.some((c) => /^UPDATE/.test(c.sql)));
  }
  // The page says it does not know, rather than showing every room as not linked.
  const v = await read(await discordViewResponse(world({ rows: [general({ discord_channel_id: CHANNEL })], links: null }).deps));
  assert.equal(v.body.linksKnown, false);
});

test("unlink that the bridge's record does not confirm keeps the row, and says so", async () => {
  const w = world({ rows: [general({ discord_channel_id: CHANNEL })], links: held(), bridgeForgets: true });
  const r = await read(await unlinkRoomResponse(json({ roomId: 1 }, "DELETE"), w.deps));
  assert.equal(r.status, 409);
  assert.match(String(r.body.error), /could not read that back yet/);
  assert.equal(w.rows[0]!.discord_channel_id, CHANNEL);
  assert.deepEqual(w.calls.host, ["discord-links", "discord-links"], "read fresh before, and again after");
  // A channel the bridge's record does not hold: the bridge is still asked (for the hub's server), and
  // its "not linked" counts as done; the mark goes once a fresh read agrees.
  const stale = world({ rows: [general({ discord_channel_id: CHANNEL })], bridge: [refusal(400, `Channel ID ${CHANNEL} is not currently bridged`)] });
  assert.equal((await unlinkRoomResponse(json({ roomId: 1 }, "DELETE"), stale.deps)).status, 200);
  assert.deepEqual(stale.calls.bridge, [`/api/unlink {"guild_id":"${GUILD}","channel_id":"${CHANNEL}"}`]);
  assert.equal(stale.rows[0]!.discord_channel_id, null);
  // The unlink goes to the server the bridge says holds the channel, not to whatever the hub is linked to now.
  const moved = world({ rows: [general({ discord_channel_id: CHANNEL })], links: { guilds: [], links: [{ channelId: CHANNEL, roomId: ROOM, guildId: "100000000000000909", name: "test" }] } });
  assert.equal((await unlinkRoomResponse(json({ roomId: 1 }, "DELETE"), moved.deps)).status, 200);
  assert.deepEqual(moved.calls.bridge, [`/api/unlink {"guild_id":"100000000000000909","channel_id":"${CHANNEL}"}`]);
});

test("a stale copy without the link: the fresh read finds the bridge holding it, so the bridge is asked and the row goes only after", async () => {
  const w = world({ rows: [general({ discord_channel_id: CHANNEL })], links: { guilds: [], links: [] },
    freshRead: { guilds: [], links: [{ channelId: CHANNEL, roomId: ROOM, guildId: "100000000000000909", name: "test" }] } });
  const r = await read(await unlinkRoomResponse(json({ roomId: 1 }, "DELETE"), w.deps));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(w.calls.bridge, [`/api/unlink {"guild_id":"100000000000000909","channel_id":"${CHANNEL}"}`]);
  const clearAt = w.calls.sql.findIndex((c) => /^UPDATE site\.community_rooms SET discord_channel_id = NULL/.test(c.sql));
  assert.ok(clearAt >= 0);
  assert.equal(w.rows[0]!.discord_channel_id, null);
  // The fresh read failing: nothing is decided, nothing is cleared.
  const down = world({ rows: [general({ discord_channel_id: CHANNEL })] });
  down.deps.askHost = async () => ({ ok: false, error: "no drop box" });
  assert.equal((await unlinkRoomResponse(json({ roomId: 1 }, "DELETE"), down.deps)).status, 409);
  assert.equal(down.rows[0]!.discord_channel_id, CHANNEL);
  assert.deepEqual(down.calls.bridge, []);
  // The server: a stale copy with no server linked, the fresh one with it → the bridge unlinks it first.
  const srv = world({ rows: [general({ discord_channel_id: CHANNEL })], links: { guilds: [], links: [] }, freshRead: held() });
  assert.equal((await unlinkServerResponse(srv.deps)).status, 200);
  assert.deepEqual(srv.calls.bridge.map(path), ["/api/unlink-space"]);
  assert.equal(srv.rows[0]!.discord_channel_id, null);
});

test("a room whose posting is narrower than everyone is never linked: who posts follows Discord there", async () => {
  const w = world({ rows: [general({ post_rule: "supporters" })] });
  const r = await read(await linkRoomResponse(json({ roomId: 1, channelId: CHANNEL }), w.deps));
  assert.equal(r.status, 409);
  assert.match(String(r.body.error), /everyone in the community can post in/);
  assert.deepEqual(w.calls.verbs, []);
});

test("unlink the server: known links but no server linked to the community → refused, rows untouched, nothing claimed", async () => {
  const w = world({ rows: [general({ discord_channel_id: CHANNEL })], links: { guilds: [{ guildId: GUILD, spaceId: "!elsewhere:example.test", privacyLevel: 1 }], links: [] } });
  const r = await read(await unlinkServerResponse(w.deps));
  assert.equal(r.status, 409);
  assert.match(String(r.body.error), /nothing was unlinked/);
  assert.deepEqual(w.calls.verbs, []);
  assert.equal(w.rows[0]!.discord_channel_id, CHANNEL);
  assert.ok(!w.calls.sql.some((c) => /^UPDATE/.test(c.sql)));
  // A server the hub is not linked to but that still holds one of the community's channels is unlinked too.
  const other = world({ rows: [general({ discord_channel_id: CHANNEL })],
    links: { guilds: [{ guildId: "100000000000000909", spaceId: null, privacyLevel: null }], links: [{ channelId: CHANNEL, roomId: ROOM, guildId: "100000000000000909", name: "test" }] } });
  assert.equal((await unlinkServerResponse(other.deps)).status, 200);
  assert.deepEqual(other.calls.verbs, ["discord-unlink-space-100000000000000909"]);
  assert.equal(other.rows[0]!.discord_channel_id, null);
  // A bridge that does not let go: nothing claimed, the row kept.
  const stuck = world({ rows: [general({ discord_channel_id: CHANNEL })], links: held(), bridgeForgets: true });
  assert.equal((await unlinkServerResponse(stuck.deps)).status, 409);
  assert.equal(stuck.rows[0]!.discord_channel_id, CHANNEL);
});

test("unlink the server: the rows go only when the fresh record shows both the server and every channel gone", async () => {
  for (const keeps of ["links", "guild"] as const) {
    const w = world({ rows: [general({ discord_channel_id: CHANNEL })], links: held(), spaceKeeps: keeps });
    const r = await read(await unlinkServerResponse(w.deps));
    assert.equal(r.status, 409, keeps);
    assert.match(String(r.body.error), /could not read that back yet/);
    assert.equal(w.rows[0]!.discord_channel_id, CHANNEL, `${keeps}: the row is kept`);
  }
});

test("the bridge line: on, off (not set up, or not a bundle install), waiting (starting, or red)", () => {
  assert.equal(bridgeStateFrom({ status: "ok", detail: "on and running: Discord and the homeserver let it in" }).state, "on");
  for (const detail of ["off: no Discord bot token is set", "not a bundle install", "not checked"]) assert.equal(bridgeStateFrom({ status: "grey", detail }).state, "off", detail);
  assert.equal(bridgeStateFrom(undefined).state, "off");
  assert.equal(bridgeStateFrom({ status: "grey", detail: "on: starting" }).state, "waiting");
  assert.equal(bridgeStateFrom({ status: "fail", detail: "switched on, but waiting for its settings file" }).state, "waiting");
  assert.equal(bridgeStateFrom({ status: "warn", detail: "off: a Discord bot token is set, but the bridge is not switched on" }).state, "waiting");
});
