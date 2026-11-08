// The Discord page's Bot step and the import read, server side (discordImportAdmin.ts), against a host
// that answers and a logged pool. The confirm against real tables: discordImportAdmin.db.test.ts.
// Run: env -u DATABASE_URL node --test app/lib/community/discordImportAdmin.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { botViewResponse, checkBotResponse, readImportResponse, setTokenResponse, type ImportDeps } from "./discordImportAdmin.ts";

const TOKEN = "MTAwMDAwMDAwMDAwMDAwOTAw.Hxyzab.the-new-token-for-this-test_456";
const G = "100000000000000101";

function world(opts: { canCall?: boolean; answers?: Record<string, { ok: boolean; message: string }>; file?: unknown; drop?: { ok: false; error: string } } = {}) {
  const calls = { verbs: [] as string[], drops: [] as string[], logs: [] as string[] };
  let at = "2026-11-04T00:00:00Z";
  const d: ImportDeps = {
    pool: { query: async () => ({ rows: [] }), connect: async () => { throw new Error("no transaction here"); } } as unknown as ImportDeps["pool"],
    canCall: opts.canCall ?? true,
    askHost: async (verb) => { calls.verbs.push(verb); at = new Date().toISOString(); return { ok: true, requestedAt: new Date(Date.now() - 1000).toISOString() }; },
    hostAnswer: async (name) => { const a = opts.answers?.[name]; return a ? { ...a, at } : null; },
    hostFile: async () => opts.file ?? null,
    dropToken: async (t) => { calls.drops.push(t); return opts.drop ?? { ok: true }; },
    reconcile: null,
    retentionCapDays: () => 365,
    waits: { hostMs: 2, stepMs: 1 },
    log: { log: (m: string) => calls.logs.push(m), error: (...m: unknown[]) => calls.logs.push(m.join(" ")) },
    admin: "@admin:example.test",
  };
  return { d, calls };
}
const req = (body: unknown) => new Request("http://site.test/x", { method: "POST", body: JSON.stringify(body) });

test("Bot: a pasted token goes to the host's drop and nowhere else; the answer, the log and the reply never repeat it", async () => {
  const { d, calls } = world({ answers: { "discord-token": { ok: true, message: "saved; the bridge restarts with it" }, "discord-bot": { ok: true, message: "read" } } });
  const r = await setTokenResponse(req({ token: `  ${TOKEN}\n` }), d);
  const text = await r.text();
  assert.equal(r.status, 200, text);
  assert.deepEqual(calls.drops, [TOKEN]);
  assert.deepEqual(calls.verbs, ["discord-token", "discord-bot"]);
  assert.match(JSON.parse(text).words, /^Saved\. the bridge restarts with it$/);
  assert.ok(!text.includes("the-new-token") && !calls.logs.join("\n").includes("the-new-token"), "the token is never echoed");
  assert.deepEqual(calls.logs, ["[community] @admin:example.test: set the Discord bot token"]);
});

test("Bot: what is not a bot token never reaches the host; an install that is not the bundle says so", async () => {
  for (const bad of [undefined, "", "abc", `${TOKEN} extra`, `${TOKEN}$(id)`, 42]) {
    const { d, calls } = world();
    const r = await setTokenResponse(req({ token: bad }), d);
    assert.equal(r.status, 400, String(bad));
    assert.deepEqual([calls.drops, calls.verbs], [[], []]);
  }
  const { d, calls } = world({ canCall: false });
  const r = await setTokenResponse(req({ token: TOKEN }), d);
  assert.equal(r.status, 409);
  assert.match((await r.json() as { error: string }).error, /not the bundle/);
  assert.deepEqual(calls.drops, []);
});

test("Bot: the host's refusal is said as its own words, and a lost answer is a retry, not a success", async () => {
  const refused = world({ answers: { "discord-token": { ok: false, message: "that is not a Discord bot token (…); nothing changed" } } });
  const r = await setTokenResponse(req({ token: TOKEN }), refused.d);
  assert.deepEqual([r.status, (await r.json() as { error: string }).error], [409, "Not saved: that is not a Discord bot token (…); nothing changed"]);
  // retry: no answer in time — not saved as far as the page knows; pressing again drops the token again.
  const lost = world();
  const l = await setTokenResponse(req({ token: TOKEN }), lost.d);
  assert.deepEqual([l.status, (await l.json() as { error: string }).error], [409, "Not saved: The server has not answered yet. Try again in a minute."]);
  const again = await setTokenResponse(req({ token: TOKEN }), lost.d);
  assert.equal(again.status, 409);
  assert.equal(lost.calls.drops.length, 2);
  const nodrop = world({ drop: { ok: false, error: "could not hand the token to the host: EACCES" } });
  assert.equal((await setTokenResponse(req({ token: TOKEN }), nodrop.d)).status, 409);
  assert.deepEqual(nodrop.calls.verbs, []);
});

test("Bot view: the bot as the host last read it, its link only in Discord's own shape", async () => {
  const file = { v: 1, ok: true, bot: { id: "100000000000000900", name: "Example Bridge" }, appId: "100000000000000900", intents: { members: true, content: false, presence: true },
    invite: "https://discord.com/oauth2/authorize?client_id=100000000000000900&scope=bot&permissions=2251801424568320", guilds: [{ id: G, name: "Example Stream" }, { id: "x", name: "bad" }] };
  const v = await (await botViewResponse(world({ file }).d)).json() as { bot: { ok: boolean; invite: string | null; guilds: unknown[]; intents: { content: boolean } }; imported: null };
  assert.deepEqual([v.bot.ok, v.bot.invite, v.bot.guilds, v.bot.intents.content, v.imported], [true, file.invite, [{ id: G, name: "Example Stream" }], false, null]);
  const evil = await (await botViewResponse(world({ file: { ...file, invite: "https://evil.example/oauth2" } }).d)).json() as { bot: { invite: string | null } };
  assert.equal(evil.bot.invite, null);
  const refusedFile = await (await botViewResponse(world({ file: { v: 1, ok: false, status: 401, error: "401: Unauthorized" } }).d)).json() as { bot: unknown };
  assert.deepEqual(refusedFile.bot, { ok: false, status: 401, error: "401: Unauthorized" });
  assert.equal((await (await botViewResponse(world().d)).json() as { bot: unknown }).bot, null);
  assert.equal((await checkBotResponse(world({ canCall: false }).d)).status, 409);
});

test("Import read: a server id in Discord's shape only; the host's refusal said; a read of another server never used", async () => {
  const bad = world();
  assert.equal((await readImportResponse(req({ guildId: "12" }), bad.d)).status, 400);
  assert.deepEqual(bad.calls.verbs, []);
  const refused = world({ answers: { "discord-read": { ok: false, message: "Discord did not give it: Missing Access" } } });
  const r = await readImportResponse(req({ guildId: G }), refused.d);
  assert.deepEqual([r.status, (await r.json() as { error: string }).error], [409, "Not read: Discord did not give it: Missing Access"]);
  assert.deepEqual(refused.calls.verbs, [`discord-read-${G}`]);
  const other = world({ answers: { "discord-read": { ok: true, message: "read" } }, file: { v: 1, ok: true, guild: { id: "100000000000000102", name: "x", premiumTier: 0 }, channels: [], roles: [], emoji: { static: 0, animated: 0 } } });
  const o = await readImportResponse(req({ guildId: G }), other.d);
  assert.deepEqual([o.status, (await o.json() as { error: string }).error], [409, "The server's copy of what it read cannot be used. Press Read again."]);
});
