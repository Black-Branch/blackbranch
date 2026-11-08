// The Discord page's Bot and Import steps on the host (community plan, Slice 2 task 2.3): the bot
// token the site drops goes into .env and never stays anywhere else; the bridge's reader
// (install/ooye/discord-read.js) runs for real against a stand-in Discord through the host's own
// requests (`discord-bot`, `discord-read-<id>`); `discord on|off`; the doctor's bot row.
// Run: node --test install/
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DOCTOR } from "../config/doctor.mjs";
import { fakeHome } from "./scratch-home.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const READ_JS = path.join(here, "ooye/discord-read.js");
const RAW = JSON.parse(readFileSync(path.join(here, "fixtures/discord/guild.json"), "utf8"));
const G = RAW.guild.id;
const ON = "COMPOSE_PROFILES=tunnel,discord\nBB_TLS_MODE=tunnel\n";
const OLD = "MTAwMDAwMDAwMDAwMDAwMDAw.Gabcde.bot-token-for-the-test_0123";
const NEW = "MTAwMDAwMDAwMDAwMDAwOTAw.Hxyzab.the-new-token-for-this-test_456";

/** The stand-in Discord (fixtures/discord/stand-in.cjs): the only Discord these tests reach. */
async function discord() {
  const p = spawn(process.execPath, [path.join(here, "fixtures/discord/stand-in.cjs")], { stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  p.stderr.on("data", (d) => (log += d));
  const port = await new Promise((ok) => p.stdout.once("data", (d) => ok(String(d).trim())));
  return {
    api: `http://127.0.0.1:${port}`,
    get seen() { return log.split("\n").filter(Boolean); },
    /** The stand-in's log as far as it has written (this process was blocked while the host command ran). */
    flushed: () => new Promise((ok) => setTimeout(ok, 200)),
    close: () => new Promise((ok) => { p.once("close", ok); p.kill(); }),
  };
}

/** A bundle home: requests/ and results/, the bridge's registration (with its token) in fake/ as the reader finds it. */
function home(extra = ON + `DISCORD_BOT_TOKEN=${OLD}\n`) {
  const h = fakeHome(extra);
  mkdirSync(path.join(h.home, "requests")); mkdirSync(path.join(h.home, "results"), { mode: 0o755 });
  writeFileSync(path.join(h.fake, "registration.yaml"), JSON.stringify({ as_token: "a".repeat(64), ooye: { discord_token: OLD } }));
  mkdirSync(path.join(h.fake, "ooye-root"));
  writeFileSync(path.join(h.fake, "ooye-root/addbot.js"), "module.exports.permissions = 2251801424568320n\n");
  const ask = (verb, env = {}) => {
    writeFileSync(path.join(h.home, `requests/${verb}.req`), "");
    const r = h.runWith({ FAKE_NODE: process.execPath, FAKE_DISCORD_READ_JS: READ_JS, ...env }, "process-requests");
    assert.equal(r.status, 0, r.stderr);
  };
  const answer = (name) => JSON.parse(readFileSync(path.join(h.home, `results/${name}.json`), "utf8"));
  const drop = (text) => writeFileSync(path.join(h.home, "requests/discord-token.value"), text);
  return { ...h, ask, answer, drop };
}

test("discord-bot: who the bot is, its switches and servers, from Discord through the bridge; GET only, the token never in results/", async () => {
  const d = await discord();
  const h = home();
  try {
    h.ask("discord-bot", { BB_DISCORD_API: d.api });
    const a = h.answer("discord-bot");
    assert.equal(a.ok, true, a.message);
    const bot = h.answer("discord-bot-info");
    assert.deepEqual(bot.guilds.map((g) => g.id), [G, "100000000000000102"]);
    assert.equal(bot.invite, "https://discord.com/oauth2/authorize?client_id=100000000000000900&scope=bot&permissions=2251801424568320");
    await d.flushed();
    assert.ok(d.seen.length === 3 && d.seen.every((s) => s.startsWith("GET ") && s.endsWith(`Bot ${OLD}`)), d.seen.join("\n"));
    for (const f of ["discord-bot.json", "discord-bot-info.json"]) assert.ok(!readFileSync(path.join(h.home, "results", f), "utf8").includes("bot-token-for-the-test"));
  } finally { await d.close(); }
});

test("discord-read-<id>: one server whole into results/discord-guild.json; a bad id never reaches the bridge", async () => {
  const d = await discord();
  const h = home();
  try {
    h.ask(`discord-read-${G}`, { BB_DISCORD_API: d.api });
    const a = h.answer("discord-read");
    assert.deepEqual([a.ok, a.request, a.message], [true, `discord-read-${G}`, "read"]);
    const g = h.answer("discord-guild");
    assert.equal(g.guild.id, G);
    assert.equal(g.channels.length, 14);
    assert.equal(g.roles.length, 36);
    // a server the bot is not in: Discord's word, kept in the file for the page; the request is not ok.
    h.ask("discord-read-100000000000000199", { BB_DISCORD_API: d.api });
    assert.deepEqual([h.answer("discord-read").ok, h.answer("discord-read").message], [false, "Discord did not give it: Unknown Guild"]);
    assert.equal(h.answer("discord-guild").status, 404);
    await d.flushed();
    const before = d.seen.length;
    assert.ok(before >= 8, "vacuity: the stand-in's log is read");
    h.ask("discord-read-12", { BB_DISCORD_API: d.api });
    await d.flushed();
    assert.deepEqual([h.answer("discord-read").ok, h.answer("discord-read").message], [false, "a Discord server id is 17 to 20 digits"]);
    assert.equal(d.seen.length, before, "nothing was asked of Discord");
    assert.doesNotMatch(h.calls(), /discord-read\.js guild 12/);
  } finally { await d.close(); }
});

test("discord reads while the bridge is switched off: said, nothing asked, the old copy of what it read gone stale-free", () => {
  const h = home(`DISCORD_BOT_TOKEN=${OLD}\n`);
  h.ask("discord-bot");
  assert.deepEqual([h.answer("discord-bot").ok, h.answer("discord-bot").message], [false, "the Discord bridge is switched off"]);
  assert.doesNotMatch(h.calls(), /discord-read\.js/);
});

test("discord-token: the dropped token goes into .env and the drop is gone; the bridge's settings file is written again with it", () => {
  const h = home();
  h.drop(`${NEW}\n`);
  h.ask("discord-token");
  const a = h.answer("discord-token");
  assert.deepEqual([a.ok, a.message], [true, "saved; the bridge restarts with it"]);
  assert.match(h.env(), new RegExp(`^DISCORD_BOT_TOKEN="?${NEW}"?$`, "m"));
  assert.equal(h.env().match(/^DISCORD_BOT_TOKEN=/gm).length, 1);
  assert.ok(!existsSync(path.join(h.home, "requests/discord-token.value")), "the drop is removed");
  assert.deepEqual(readdirSync(path.join(h.home, "state")).filter((f) => f.startsWith("discord-token")), [], "no copy is kept in root's folder either");
  assert.match(readFileSync(path.join(h.home, "rendered/ooye/registration.yaml"), "utf8"), new RegExp(NEW.replaceAll(".", "\\.")));
  assert.ok(!readFileSync(path.join(h.home, "results/discord-token.json"), "utf8").includes(NEW.split(".")[2]), "the answer never repeats it");
  // retry: the same token again (a press whose answer was lost) changes nothing and says saved.
  h.drop(NEW);
  h.ask("discord-token");
  assert.equal(h.answer("discord-token").ok, true);
  assert.equal(h.env().match(/^DISCORD_BOT_TOKEN=/gm).length, 1);
});

test("discord-token with the bridge switched off: saved, and the answer names the one command that switches it on", () => {
  const h = home(`DISCORD_BOT_TOKEN=\n`);
  h.drop(NEW);
  h.ask("discord-token");
  assert.deepEqual([h.answer("discord-token").ok, h.answer("discord-token").message],
    [true, "saved. The Discord bridge is switched off on this server: run sudo blackbranch discord on"]);
  assert.match(h.env(), new RegExp(`^DISCORD_BOT_TOKEN="?${NEW}"?$`, "m"));
});

test("discord-token refuses what is not a bot token, a link planted in its place, and no drop at all; .env stays as it was", () => {
  const h = home();
  const env0 = h.env();
  for (const bad of ["", "not a token", `${NEW}$(id)`, `${NEW}\nEXTRA=1`, "a.b.c", `${"x".repeat(30)}.${"y".repeat(6)}.${"z".repeat(90)}`]) {
    h.drop(bad);
    h.ask("discord-token");
    assert.equal(h.answer("discord-token").ok, false, JSON.stringify(bad));
    assert.match(h.answer("discord-token").message, /not a Discord bot token/);
    assert.ok(!existsSync(path.join(h.home, "requests/discord-token.value")));
  }
  // A link to a root-only file shaped like a token: moved as a link, refused, its target never read.
  writeFileSync(path.join(h.fake, "secret"), NEW);
  symlinkSync(path.join(h.fake, "secret"), path.join(h.home, "requests/discord-token.value"));
  h.ask("discord-token");
  assert.deepEqual([h.answer("discord-token").ok, h.answer("discord-token").message], [false, "the dropped token is not a plain file; nothing changed"]);
  assert.ok(existsSync(path.join(h.fake, "secret")), "the link's target is left alone");
  h.ask("discord-token");
  assert.deepEqual([h.answer("discord-token").ok, h.answer("discord-token").message], [false, "no token was dropped"]);
  assert.equal(h.env(), env0);
});

test("discord on|off: the bridge's word in COMPOSE_PROFILES, the bundle brought to it; on needs a token first", () => {
  const h = home(`COMPOSE_PROFILES=tunnel\nBB_TLS_MODE=tunnel\nDISCORD_BOT_TOKEN=\n`);
  mkdirSync(path.join(h.home, "release")); mkdirSync(path.join(h.home, "bin")); mkdirSync(path.join(h.home, "systemd"));
  symlinkSync(here, path.join(h.home, "release/install"));
  symlinkSync(path.join(here, "../config"), path.join(h.home, "release/config"));
  const up = { BB_BIN_DIR: path.join(h.home, "bin"), BB_SYSTEMD_DIR: path.join(h.home, "systemd"), BB_HEALTH_WAIT: "1", FAKE_RUN_STATUS: "0" };
  const none = h.runWith(up, "discord", "on");
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /no Discord bot token is set: paste it on the Admin Panel's Discord page first/);
  assert.match(h.env(), /^COMPOSE_PROFILES=tunnel$/m);
  writeFileSync(path.join(h.home, ".env"), h.env().replace(/^DISCORD_BOT_TOKEN=.*$/m, `DISCORD_BOT_TOKEN=${NEW}`));
  const on = h.runWith(up, "discord", "on");
  assert.equal(on.status, 0, on.stderr);
  assert.match(h.env(), /^COMPOSE_PROFILES="?tunnel,discord"?$/m, on.stderr);
  assert.match(on.stdout + on.stderr, /COMPOSE_PROFILES=tunnel,discord; bringing the bundle to it/);
  assert.ok(existsSync(path.join(h.home, "rendered/ooye/registration.yaml")), "up rendered the bridge's settings");
  assert.match(h.runWith(up, "discord", "on").stdout + "", /already on/);
  h.runWith(up, "discord", "off");
  assert.match(h.env(), /^COMPOSE_PROFILES="?tunnel"?$/m);
  assert.match(h.calls(), /compose rm -sf ooye/);
  assert.ok(!existsSync(path.join(h.home, "rendered/ooye/registration.yaml")), "off: the settings file is gone");
  assert.equal(h.runWith(up, "discord", "sideways").status, 1);
});

// ── the doctor's bot row ──────────────────────────────────────────────────────────────────────────

const judge = (discordBot, discord = { profile: true, token: true }) => {
  const r = DOCTOR.evaluate({ host: { at: "2026-11-04T00:00:00Z", discord, discordBot }, hostState: "ok", site: {}, siteError: null }).find((x) => x.id === "discord.bot");
  return { status: r.status, detail: r.detail, fix: r.fix, area: r.area };
};
const sd = (r) => ({ status: r.status, detail: r.detail });

test("doctor discord.bot: the bot can see the server the community was imported from, or says why not", () => {
  assert.equal(judge(null).area, "Services");
  assert.deepEqual(sd(judge(null, { profile: false, token: false })), { status: "grey", detail: "off: the Discord bridge is off" });
  assert.equal(judge(undefined).status, "grey");
  assert.match(judge({ checked: false }).detail, /not checked: the bridge is not running/);
  const ok = { checked: true, ok: true, status: null, members: true, content: true };
  assert.deepEqual(sd(judge({ ...ok, guild: "present" })), { status: "ok", detail: "the bot sees the Discord server the community was imported from" });
  assert.match(judge({ ...ok, guild: null }).detail, /no Discord server imported yet/);
  const absent = judge({ ...ok, guild: "absent" });
  assert.equal(absent.status, "fail");
  assert.match(absent.fix, /Add it again with the link on Admin Panel → Site → Discord/);
  assert.equal(judge({ ...ok, guild: "present", members: false }).status, "warn");
  assert.match(judge({ ...ok, guild: "present", content: false }).detail, /Message Content/);
  assert.deepEqual([judge({ checked: true, ok: false, status: 401 }).status, judge({ checked: true, ok: false, status: 401 }).detail],
    ["fail", "Discord refused the bot token"]);
  assert.equal(judge({ checked: true, ok: false, status: null }).status, "warn");
});

test("doctor discord.bot facts: written by the host from the bridge's own read of Discord, no name or id in them", async () => {
  const d = await discord();
  const h = home();
  try {
    writeFileSync(path.join(h.fake, "import-guild"), `${G}\n`);
    const r = h.runWith({ FAKE_NODE: process.execPath, FAKE_DISCORD_READ_JS: READ_JS, BB_DISCORD_API: d.api }, "doctor");
    const facts = JSON.parse(readFileSync(path.join(h.home, "results/doctor-host.json"), "utf8"));
    assert.deepEqual(facts.discordBot, { checked: true, ok: true, status: null, members: true, content: true, guild: "present" }, r.stderr);
    assert.ok(!JSON.stringify(facts).includes(G) && !JSON.stringify(facts).includes("Example"));
    writeFileSync(path.join(h.fake, "import-guild"), "100000000000000199\n");
    h.runWith({ FAKE_NODE: process.execPath, FAKE_DISCORD_READ_JS: READ_JS, BB_DISCORD_API: d.api }, "doctor");
    assert.equal(JSON.parse(readFileSync(path.join(h.home, "results/doctor-host.json"), "utf8")).discordBot.guild, "absent");
  } finally { await d.close(); }
});
