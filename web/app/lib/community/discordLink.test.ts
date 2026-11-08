// The panel's link calls to the Discord bridge. Two halves:
//   • install/ooye/link.js, which runs INSIDE the bridge's container (the only place its as_token is):
//     run here for real against a stand-in bridge, the session it sends opened with the bridge's own
//     reader — h3 1.15's unsealSession with OOYE 3.7's config (iron-webcrypto 1.2.1, password
//     reg.as_token, maxAge 365 days). The real bridge was asked too (the task 2.4 report).
//   • discordLink.ts, the site's side: the verb each call asks the host for, and the bridge's
//     answers in plain words.
// Run: env -u DATABASE_URL node --test app/lib/community/discordLink.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaults, unseal } from "iron-webcrypto";
import { isDiscordId, linkRoom, linkSpace, setPrivacy, unlinkRoom, unlinkSpace, wordsFor, type BridgeCall, type DiscordCallVerb } from "./discordLink.ts";

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, "../../..");
const LINK_JS = join(WEB, "../install/ooye/link.js");
const AS_TOKEN = "a".repeat(64);
const MXID = "@blackbranch:example.test";
const GUILD = "100000000000000101";
const CHANNEL = "100000000000000201";
const MAX_AGE_S = 365 * 24 * 60 * 60;

/** h3 1.15 unsealSession with OOYE's config: what the bridge does with the cookie. */
async function bridgeReads(sealed: string, password = AS_TOKEN) {
  const s = await unseal(webcrypto, sealed, password, { ...defaults, ttl: MAX_AGE_S * 1e3 }) as { id: string; createdAt: number; data: Record<string, unknown> };
  if (Date.now() - (s.createdAt || Number.NEGATIVE_INFINITY) > MAX_AGE_S * 1e3) throw new Error("Session expired!");
  return s;
}

type Ran = { code: number; out: string; err: string };
/** link.js run for real, in a folder holding a registration that names `port`. */
function runLink(port: number, ...args: string[]): Promise<Ran> {
  const dir = mkdtempSync(join(tmpdir(), "bb-link-"));
  writeFileSync(join(dir, "registration.yaml"), JSON.stringify({ as_token: AS_TOKEN, socket: port }));
  return new Promise<Ran>((resolve) => {
    const p = spawn(process.execPath, [LINK_JS, ...args], { cwd: dir, env: { ...process.env, BB_OOYE_ROOT: WEB } });
    let out = "", err = "";
    p.stdout.on("data", (c) => (out += c)); p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => { rmSync(dir, { recursive: true, force: true }); resolve({ code: code ?? -1, out, err }); });
  });
}

type Seen = { path: string; cookie: string; body: unknown };
/** A stand-in bridge on a free port, answering `answer`. */
async function withBridge(answer: (s: Seen) => { status: number; body?: unknown }, fn: (run: (...args: string[]) => Promise<Ran>, seen: Seen[]) => Promise<void>) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      const s = { path: req.url ?? "", cookie: String(req.headers.cookie ?? ""), body: JSON.parse(b || "null") as unknown };
      seen.push(s);
      const a = answer(s);
      res.writeHead(a.status, { "content-type": "application/json" });
      res.end(a.body === undefined ? "" : JSON.stringify(a.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try { await fn((...args) => runLink(port, ...args), seen); } finally { server.close(); }
}

test("link.js: the session it sends is one the bridge's own reader opens, for this server only, with no page password", async () => {
  await withBridge(() => ({ status: 204 }), async (run, seen) => {
    const r = await run("link", MXID, GUILD, "!general:example.test", CHANNEL);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out), { ok: true, status: 204, data: "" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.path, "/api/link");
    assert.deepEqual(seen[0]!.body, { guild_id: GUILD, matrix: "!general:example.test", discord: CHANNEL });
    const cookie = /^h3=(Fe26\.2\*\S+)$/.exec(seen[0]!.cookie);
    assert.ok(cookie, seen[0]!.cookie);
    const s = await bridgeReads(cookie[1]!);
    assert.deepEqual(s.data, { mxid: MXID, managedGuilds: [GUILD], userID: "0" });
    assert.ok(!("password" in s.data), "never the bridge page's password: it would unlock the add-the-bot buttons");
    // Sealed with the bridge's token and nothing else: another token cannot open it.
    await assert.rejects(bridgeReads(cookie[1]!, "b".repeat(64)));
    // It lives five minutes, not the bridge's year: the seal's own expiry says so.
    const exp = Number(cookie[1]!.split("*")[5]);
    assert.ok(exp - Date.now() <= 5 * 60_000 + 1000 && exp - Date.now() > 4 * 60_000, String(exp - Date.now()));
  });
});

test("link.js: each action is the bridge's own path and body; its refusal comes back as its own text", async () => {
  const unlinked = { statusCode: 400, statusMessage: "Bad Request", data: `Channel ID ${CHANNEL} is not currently bridged` };
  await withBridge((s) => (s.path === "/api/unlink" ? { status: 400, body: unlinked } : { status: 204 }), async (run, seen) => {
    for (const args of [["link-space", MXID, GUILD, "!hub:example.test"], ["privacy", MXID, GUILD], ["unlink-space", MXID, GUILD]]) {
      const r = await run(...args);
      assert.equal(r.code, 0, r.err);
      assert.equal(JSON.parse(r.out).ok, true);
    }
    const u = await run("unlink", MXID, GUILD, CHANNEL);
    assert.deepEqual(JSON.parse(u.out), { ok: false, status: 400, data: `Channel ID ${CHANNEL} is not currently bridged` });
    assert.deepEqual(seen.map((s) => [s.path, s.body]), [
      ["/api/link-space", { guild_id: GUILD, space_id: "!hub:example.test" }],
      ["/api/privacy-level", { guild_id: GUILD, privacy_level: "link" }],
      ["/api/unlink-space", { guild_id: GUILD }],
      ["/api/unlink", { guild_id: GUILD, channel_id: CHANNEL }],
    ]);
  });
});

test("link.js: a bad call never reaches the bridge; a bridge that does not answer is status null", async () => {
  await withBridge(() => ({ status: 204 }), async (run, seen) => {
    for (const bad of [[], ["drop", MXID, GUILD], ["link", MXID, GUILD, "general", CHANNEL], ["link", MXID, "12", "!r:x", CHANNEL],
      ["privacy", "blackbranch", GUILD], ["unlink", MXID, GUILD], ["privacy", MXID, `${GUILD}; rm`]]) {
      const r = await run(...bad);
      assert.equal(r.code, 1, bad.join(" "));
      assert.equal(r.out, "");
    }
    assert.equal(seen.length, 0);
  });
  // Nothing listening on the bridge's port.
  const r = await runLink(1, "privacy", MXID, GUILD);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { ok: false, status: null, data: "" });
});

test("restart_a_session_needs_no_state: link.js seals a new one per call, and both open", async () => {
  await withBridge(() => ({ status: 204 }), async (run, seen) => {
    await run("privacy", MXID, GUILD);
    await run("privacy", MXID, GUILD);
    const [a, b] = seen.map((s) => s.cookie.slice(3));
    assert.notEqual(a, b);
    assert.notEqual((await bridgeReads(a!)).id, (await bridgeReads(b!)).id);
  });
});

type HostAnswer = Awaited<ReturnType<BridgeCall>>;
/** The site's side: a host that answers each verb from `answers`, logging what was asked. */
function host(answers: HostAnswer[]) {
  const asked: DiscordCallVerb[] = [];
  const call: BridgeCall = async (verb) => { asked.push(verb); return answers.length ? answers.shift()! : { ok: true, status: 204, data: "" }; };
  return { call, asked };
}

test("each call asks the host for its own verb, the ids in the name", async () => {
  const h = host([]);
  assert.deepEqual(await linkSpace(h.call, GUILD), { ok: true });
  assert.deepEqual(await setPrivacy(h.call, GUILD), { ok: true });
  assert.deepEqual(await linkRoom(h.call, GUILD, CHANNEL), { ok: true });
  assert.deepEqual(await unlinkRoom(h.call, GUILD, CHANNEL), { ok: true });
  assert.deepEqual(await unlinkSpace(h.call, GUILD), { ok: true });
  assert.deepEqual(h.asked, [`discord-link-space-${GUILD}`, `discord-privacy-${GUILD}`, `discord-link-${GUILD}-${CHANNEL}`, `discord-unlink-${GUILD}-${CHANNEL}`, `discord-unlink-space-${GUILD}`]);
});

test("the bridge's refusals in plain words; no answer, or the host's own refusal, said as that", async () => {
  const cases: [HostAnswer, RegExp][] = [
    [{ ok: false, status: 400, data: "OOYE needs power level 100 (admin) in the target Matrix room" }, /full power there yet.*next run/],
    [{ ok: false, status: 403, data: "You personally must invite OOYE to that space on Matrix" }, /not been invited to the community yet/],
    [{ ok: false, status: 400, data: "Channel ID 1 or room ID !r:x are already bridged and cannot be reused" }, /already linked\. Unlink it first/],
    [{ ok: false, status: 400, data: "Discord guild does not exist or bot has not joined it" }, /not in that Discord server/],
    [{ ok: false, status: 403, data: "Can't edit a guild you don't have Manage Server permissions in" }, /did not accept the server's sign-in/],
    [{ ok: false, status: null, data: "" }, /did not answer/],
    [{ ok: false, status: 418, data: "teapot" }, /^The Discord bridge answered 418: teapot\.$/],
    [{ hostRefused: "no room the panel may link is marked for that channel" }, /^The server could not make the call: no room the panel may link/],
    [null, /has not answered yet/],
  ];
  for (const [answer, words] of cases) {
    const o = await linkRoom(host([answer]).call, GUILD, CHANNEL);
    assert.equal(o.ok, false);
    if (!o.ok) assert.match(o.words, words);
  }
  assert.equal(wordsFor(null, ""), "The Discord bridge did not answer. It may be switched off or still starting: see its line at the top of this page.");
});

test("retry_after_not_seated_links: the same call again, once the server seated the bot, succeeds", async () => {
  const h = host([{ ok: false, status: 400, data: "OOYE needs power level 100 (admin) in the target Matrix room" }, { ok: true, status: 204, data: "" }]);
  assert.equal((await linkRoom(h.call, GUILD, CHANNEL)).ok, false);
  assert.deepEqual(await linkRoom(h.call, GUILD, CHANNEL), { ok: true });
});

test("retry_unlink_after_a_lost_answer: a channel already unlinked counts as done; a link refused so is not", async () => {
  const notBridged = { ok: false, status: 400, data: `Channel ID ${CHANNEL} is not currently bridged` };
  assert.deepEqual(await unlinkRoom(host([notBridged]).call, GUILD, CHANNEL), { ok: true });
  assert.equal((await linkRoom(host([notBridged]).call, GUILD, CHANNEL)).ok, false);
});

test("Discord ids: 17 to 20 digits, nothing else", () => {
  for (const ok of ["112760669178241024", "12345678901234567", "12345678901234567890"]) assert.ok(isDiscordId(ok), ok);
  for (const bad of ["1234567890123456", "123456789012345678901", "12a456789012345678", "", 112760669178241024, null]) assert.ok(!isDiscordId(bad), String(bad));
});
