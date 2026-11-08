// The Discord bridge's registration and routing (community Slice 2 task 2.2). Run: node --test install/
//
// What they hold: `blackbranch render` writes OOYE's registration (JSON) from .env while the profile
// `discord` is on, with the two tokens, the bot token, the client secret and bridge_origin
// https://<domain>/bridge, and Synapse a copy without the bridge's block; Synapse lists it only while
// the profile is on, and the files go when it is switched off; the router's /bridge/ block is the one
// spike 0.2 ran over public HTTPS, byte for byte; the site's reconciler feed gets the bridge's
// accounts copied unchanged from the registration; MAS never lets anyone sign up with a bridge
// name; the doctor tells "waiting for the settings file" from "running" by the bridge's own word;
// the two tokens are made once (installer or .env migration 007) and never again on a re-run.
// Rendered files are proven against the real Caddy and Synapse outside this suite (docker; see the
// task report), as matrix.test.mjs does for the rest of the render.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DOCTOR } from "../config/doctor.mjs";
import { loadConfig, countLiterals } from "../tools/check-owner-literals.mjs";
import { planAll, planMembership } from "./matrix/reconcile-core.mjs";
import { fakeHome, renderHome, runRender } from "./scratch-home.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const read = (rel) => readFileSync(path.join(here, rel), "utf8");
const ON = "COMPOSE_PROFILES=tunnel,discord\nBB_TLS_MODE=tunnel\n";
const BOT_TOKEN = "MTAwMDAwMDAwMDAwMDAwMDAw.Gabcde.bot-token-for-the-test_0123";
const CLIENT_SECRET = "client-secret-for-the-test_0123";
const envOf = (home) => Object.fromEntries(readFileSync(path.join(home, ".env"), "utf8").split("\n")
  .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"(.*)"$/, "$1")]; }));
const file = (home, rel) => readFileSync(path.join(home, rel), "utf8");
const BRIDGE = "rendered/ooye/registration.yaml", SYNAPSE_COPY = "rendered/synapse/appservice-ooye.yaml";
const ACCOUNTS = "results/discord-bridge.json";

/** A scratch install with the bridge switched on (or not), rendered once. */
function home(extra = ON + `DISCORD_BOT_TOKEN=${BOT_TOKEN}\nDISCORD_CLIENT_SECRET=${CLIENT_SECRET}\n`) {
  const h = renderHome(extra);
  mkdirSync(path.join(h, "results"), { mode: 0o755 });
  const r = runRender(h);
  assert.equal(r.status, 0, r.stderr);
  return { h, out: r.stdout };
}

// The block spike 0.2 ran (its own Caddyfile, inside its :80
// site) — copied here once, so a change to the rendered block is a change to this pin. The last
// handle was the spike's stand-in for the site.
const SPIKE_BLOCK = [
  "\t# OOYE's pages link relatively; at /bridge (no slash) they would resolve against the site root.",
  "\tredir /bridge /bridge/ 308",
  "\thandle_path /bridge/* {",
  "\t\treverse_proxy ooye:6693 {",
  "\t\t\t# Four OOYE responses redirect to a root-absolute path (\"/guild?…\", \"/ok?…\", HX-Redirect \"/\")",
  "\t\t\t# and would land on the site. Put the prefix back on them.",
  "\t\t\theader_down Location \"^/\" \"/bridge/\"",
  "\t\t\theader_down HX-Redirect \"^/\" \"/bridge/\"",
  "\t\t}",
  "\t}",
  "\thandle {",
  "\t\trespond \"site (stand-in for web:3000)\" 200",
  "\t}",
].join("\n");

test("vacuity anchors: the generator's bridge renderer and the files these tests read are there", () => {
  assert.match(read("matrix/render.sh"), /^mx_render_appservice_ooye\(\) \{ # mx_render_appservice_ooye \[synapse\]$/m);
  assert.match(read("blackbranch"), /^OOYE_REGISTRATION=appservice-ooye\.yaml$/m);
  assert.match(read("migrations/007-discord-bridge-registration.sh"), /\nenvm_add DISCORD_CLIENT_SECRET ""\n$/);
  assert.match(read("ooye/entrypoint.js"), /\nmain\(\)\.catch\([^\n]*\n$/);
});

test("the rendered registration is JSON with the two tokens, the bot token, the client secret and bridge_origin https://<domain>/bridge", () => {
  const { h, out } = home();
  try {
    const env = envOf(h);
    const reg = JSON.parse(file(h, BRIDGE));
    assert.equal(reg.id, "ooye");
    assert.equal(reg.as_token, env.OOYE_AS_TOKEN); assert.equal(reg.hs_token, env.OOYE_HS_TOKEN);
    assert.match(reg.as_token, /^[0-9a-f]{64}$/); assert.notEqual(reg.as_token, reg.hs_token);
    assert.equal(reg.ooye.discord_token, BOT_TOKEN);
    assert.equal(reg.ooye.discord_client_secret, CLIENT_SECRET);
    assert.equal(reg.ooye.bridge_origin, "https://example.test/bridge");
    // What OOYE's own checkRegistration asserts (src/matrix/read-registration.js), and receive_ephemeral
    // true: false would make OOYE rewrite a file it may only read.
    assert.equal(reg.url, "http://ooye:6693"); assert.equal(reg.ooye.server_origin, "http://synapse:8008");
    assert.equal(reg.sender_localpart, "_ooye_bot"); assert.ok(reg.sender_localpart.startsWith(reg.ooye.namespace_prefix));
    assert.equal(reg.ooye.server_name, "example.test"); assert.equal(reg.receive_ephemeral, true);
    assert.ok(reg.ooye.max_file_size > 0); assert.deepEqual(reg.ooye.invite, []);
    // The bridge page's own "add the bot" actions are locked by a password nobody is shown.
    assert.equal(reg.ooye.web_password, createHash("sha256").update(`ooye web_password\n${env.OOYE_AS_TOKEN}`).digest("hex"));
    // The namespace: the bridge's accounts on this server, a dot a dot.
    const users = new RegExp(`^(?:${reg.namespaces.users[0].regex})$`);
    assert.equal(reg.namespaces.users[0].regex, "@_ooye_.*:example\\.test");
    assert.ok(users.test("@_ooye_bot:example.test") && users.test("@_ooye_123456:example.test"));
    for (const other of ["@ooye_x:example.test", "@_ooye_x:exampleXtest", "@_ooye_x:example.test.evil", "@someone:example.test"]) assert.ok(!users.test(other), other);
    assert.equal(reg.namespaces.users[0].exclusive, true); assert.equal(reg.namespaces.aliases[0].regex, "#_ooye_.*:example\\.test");
    // Synapse's copy: the same file without the bridge's block (no bot token, no client secret).
    const syn = JSON.parse(file(h, SYNAPSE_COPY));
    const { ooye, ...rest } = reg;
    assert.ok(ooye);
    assert.deepEqual(syn, rest);
    assert.ok(!file(h, SYNAPSE_COPY).includes(BOT_TOKEN) && !file(h, SYNAPSE_COPY).includes(CLIENT_SECRET));
    // Both hold secrets: readable by their own service alone.
    for (const f of [BRIDGE, SYNAPSE_COPY]) assert.equal(statSync(path.join(h, f)).mode & 0o777, 0o600, f);
    assert.equal(statSync(path.join(h, "rendered/ooye")).mode & 0o777, 0o700);
    assert.match(out, /rendered\/ooye\/registration\.yaml: written · rendered\/synapse\/appservice-ooye\.yaml: written/);
    for (const f of [BRIDGE, SYNAPSE_COPY]) assert.equal(countLiterals(file(h, f), loadConfig()), 0, `${f}: an owner literal`);
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("Synapse lists the bridge's registration only while the profile is on; switched off, both files and the listing go", () => {
  const { h } = home();
  try {
    const hs = () => file(h, "rendered/synapse/homeserver.yaml");
    assert.match(hs(), /\napp_service_config_files:\n {2}- "\/config\/appservice-community\.yaml"\n {2}- "\/config\/appservice-ooye\.yaml"\n/, "both registrations");
    // Off: the profile goes from .env, and the next render takes the bridge away.
    const env0 = file(h, ".env");
    writeFileSync(path.join(h, ".env"), env0.replace(/^COMPOSE_PROFILES=.*$/m, "COMPOSE_PROFILES=tunnel"));
    const r = runRender(h);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /rendered\/ooye\/registration\.yaml: removed · rendered\/synapse\/appservice-ooye\.yaml: removed/);
    assert.ok(!existsSync(path.join(h, BRIDGE)) && !existsSync(path.join(h, SYNAPSE_COPY)));
    assert.doesNotMatch(hs(), /appservice-ooye/);
    assert.match(hs(), /\napp_service_config_files:\n {2}- "\/config\/appservice-community\.yaml"\n(?! {2}-)/);
    assert.ok(!existsSync(path.join(h, ACCOUNTS)), "the feed's bridge accounts go with it");
    // Restart and retry: on again, the same files come back; a second render changes nothing.
    writeFileSync(path.join(h, ".env"), env0);
    assert.equal(runRender(h).status, 0);
    const again = runRender(h);
    assert.match(again.stdout, /rendered\/ooye\/registration\.yaml: unchanged · rendered\/synapse\/appservice-ooye\.yaml: unchanged/);
    assert.match(hs(), /- "\/config\/appservice-ooye\.yaml"/);
  } finally { rmSync(h, { recursive: true, force: true }); }
  // Never switched on: no file, no listing, no route.
  const off = home("COMPOSE_PROFILES=tunnel\nBB_TLS_MODE=tunnel\n");
  try {
    assert.ok(!existsSync(path.join(off.h, BRIDGE)) && !existsSync(path.join(off.h, SYNAPSE_COPY)) && !existsSync(path.join(off.h, ACCOUNTS)));
    assert.doesNotMatch(file(off.h, "rendered/synapse/homeserver.yaml"), /ooye/);
    assert.doesNotMatch(file(off.h, "rendered/caddy/Caddyfile"), /bridge|ooye/);
  } finally { rmSync(off.h, { recursive: true, force: true }); }
});

test("the router's /bridge/ block is spike 0.2's, byte for byte, with the site in its last handle", () => {
  const { h } = home();
  try {
    const caddy = file(h, "rendered/caddy/Caddyfile");
    const site = /\n# The site, and the Matrix discovery files it serves itself \(\/\.well-known\/matrix\/\*\)\.\nhttp:\/\/example\.test \{\n([\s\S]*?)\n\}\n/.exec(caddy);
    assert.ok(site, caddy);
    assert.equal(site[1], SPIKE_BLOCK.replace('\t\trespond "site (stand-in for web:3000)" 200', "\t\timport upstream web:3000"));
    // Only the site's host carries it; the api and the homeserver are as they were.
    assert.equal(caddy.match(/ooye:6693/g).length, 1);
    assert.match(caddy, /\nhttp:\/\/api\.example\.test \{\n\timport upstream stream-api:3001\n\}\n/);
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("the site's reconciler feed gets the bridge's accounts copied unchanged from the registration, and the core uses them", async () => {
  const { h } = home();
  try {
    const reg = JSON.parse(file(h, BRIDGE));
    const raw = JSON.parse(file(h, ACCOUNTS));
    assert.deepEqual(raw, { v: 1, bot: "@_ooye_bot:example.test", userPatterns: [reg.namespaces.users[0].regex] }, "the registration's own regex, unchanged");
    assert.equal(statSync(path.join(h, ACCOUNTS)).mode & 0o777, 0o644, "the site reads it");
    // The site's feed passes them on as they are (web desiredServer.test.ts holds that side).
    const bridge = { bot: raw.bot, userPatterns: raw.userPatterns };
    assert.deepEqual(bridge.userPatterns, ["@_ooye_.*:example\\.test"]);
    // What the reconciler then does with the feed: in a Discord-linked room the bridge's accounts stay
    // and a native without the rung goes; in a room the bridge was invited to at 100 before linking,
    // its bot keeps 100 (puppets keep a grant only below a mod's).
    const load = (f) => JSON.parse(readFileSync(path.join(here, "fixtures/community", f), "utf8"));
    const desired = load("feed.json"), actual = load("actual.json");
    desired.bridgeUserPatterns = bridge.userPatterns;
    desired.bridgeBots = [...(desired.bridgeBots ?? []), bridge.bot];
    const S = "example.test", id = (x) => `!${x}:${S}`, u = (x) => `@${x}:${S}`;
    desired.rooms.find((r) => r.name === "mods").discordChannelId = "100000000000000002";
    const mods = actual.rooms[id("mods")];
    for (const m of ["_ooye_bot", "_ooye_someone", "bob"]) mods.members[u(m)] = "join";
    const kicks = planMembership(desired, actual).filter((o) => o.op === "kick" && o.roomId === id("mods")).map((o) => o.userId);
    assert.deepEqual(kicks, [u("bob")]);
    const g = actual.rooms[id("general")];
    g.members[u("_ooye_bot")] = "join";
    g.powerLevels = { ...g.powerLevels, users: { ...g.powerLevels.users, [u("_ooye_bot")]: 100 } };
    const pl = planAll(desired, actual, { mode: "apply" }).ops.find((o) => o.op === "setPowerLevels" && o.roomId === id("general"))?.content;
    assert.equal((pl ?? g.powerLevels).users[u("_ooye_bot")], 100);
    // Without the bot among the bridge accounts, the pattern alone would not keep a grant at a mod's or above.
    desired.bridgeBots = desired.bridgeBots.filter((x) => x !== bridge.bot);
    const without = planAll(desired, actual, { mode: "apply" }).ops.find((o) => o.op === "setPowerLevels" && o.roomId === id("general"))?.content;
    assert.ok(without && without.users[u("_ooye_bot")] === undefined, "the bot's 100 is kept only because the feed lists it");
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("MAS refuses every bridge name at sign-up, switched on or not", () => {
  for (const extra of [ON, "COMPOSE_PROFILES=tunnel\nBB_TLS_MODE=tunnel\n"]) {
    const { h } = home(extra);
    try {
      assert.match(file(h, "rendered/mas/config.yaml"), /\n {6}banned_usernames:\n {8}literals:\n {10}- "blackbranch"\n {8}prefixes:\n {10}- "_ooye_"\nsecrets:\n/);
    } finally { rmSync(h, { recursive: true, force: true }); }
  }
});

test("retry: a bot token or client secret that is not Discord's fails the render and changes nothing; fixed, it renders", () => {
  const { h } = home();
  try {
    const before = [BRIDGE, SYNAPSE_COPY, "rendered/synapse/homeserver.yaml", "rendered/caddy/Caddyfile"].map((f) => file(h, f));
    const env0 = file(h, ".env");
    for (const [line, said] of [[`DISCORD_BOT_TOKEN=has space`, /DISCORD_BOT_TOKEN is not a Discord bot token/], [`DISCORD_BOT_TOKEN=a"b${"x".repeat(30)}`, /DISCORD_BOT_TOKEN|quote/],
      [`DISCORD_CLIENT_SECRET=bad.secret.with.dots`, /DISCORD_CLIENT_SECRET is not a Discord client secret/], ["OOYE_AS_TOKEN=abcd", /OOYE_AS_TOKEN must be 16-64 random bytes as hex/]]) {
      const key = line.split("=")[0];
      writeFileSync(path.join(h, ".env"), env0.replace(new RegExp(`^${key}=.*$`, "m"), line));
      const r = runRender(h);
      assert.notEqual(r.status, 0, line);
      assert.match(r.stderr, said, line);
      assert.deepEqual([BRIDGE, SYNAPSE_COPY, "rendered/synapse/homeserver.yaml", "rendered/caddy/Caddyfile"].map((f) => file(h, f)), before, `${line}: a failed render changed a file`);
    }
    writeFileSync(path.join(h, ".env"), env0);
    const ok = runRender(h);
    assert.equal(ok.status, 0, ok.stderr);
    // No bot token yet (the panel sets it later): the file is written all the same, and the bridge waits.
    writeFileSync(path.join(h, ".env"), env0.replace(/^DISCORD_BOT_TOKEN=.*$/m, "DISCORD_BOT_TOKEN="));
    assert.equal(runRender(h).status, 0);
    assert.equal(JSON.parse(file(h, BRIDGE)).ooye.discord_token, "");
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("restart: a new bot token restarts the bridge (and Synapse only when its copy changed); an unchanged render restarts nothing", () => {
  const h = fakeHome(ON + `DISCORD_BOT_TOKEN=${BOT_TOKEN}`);
  try {
    assert.equal(h.run("render").status, 0);
    rmSync(path.join(h.fake, "calls"), { force: true });
    assert.equal(h.run("render").status, 0);
    assert.doesNotMatch(h.calls(), /compose restart (ooye|synapse)/, "nothing changed, nothing restarted");
    writeFileSync(path.join(h.home, ".env"), h.env().replace(/^DISCORD_BOT_TOKEN=.*$/m, `DISCORD_BOT_TOKEN=${BOT_TOKEN}x`));
    const r = h.run("render");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /rendered\/ooye\/registration\.yaml: written · rendered\/synapse\/appservice-ooye\.yaml: unchanged/);
    assert.match(h.calls(), /^compose restart ooye$/m);
    assert.doesNotMatch(h.calls(), /^compose restart synapse$/m, "Synapse's copy holds no bot token");
    assert.match(r.stdout, /the Discord bridge restarted/);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

// ── the doctor: the bridge's own word ─────────────────────────────────────────────────────────
const row = (discord) => DOCTOR.evaluate({ host: { at: "2026-10-31T00:00:00Z", discord }, hostState: "ok", site: {}, siteError: null }).find((r) => r.id === "discord.bridge");
const on = (more) => ({ profile: true, token: true, state: "unhealthy", registration: "match", answer: null, ...more });

test("the doctor says 'waiting for the settings file' or 'running' from the bridge's own answer", () => {
  const waiting = row(on({ answer: "waiting-settings" }));
  assert.equal(waiting.status, "fail"); assert.equal(waiting.detail, "switched on, but waiting for its settings file"); assert.match(waiting.fix, /sudo blackbranch up/);
  assert.equal(row(on({ registration: "missing", state: "starting" })).detail, "switched on, but waiting for its settings file", "no file on the host says it too");
  assert.equal(row(on({ registration: "differs" })).detail, "switched on, but its settings file differs from a fresh render");
  const storage = row(on({ answer: "waiting-storage" }));
  assert.equal(storage.status, "fail"); assert.match(storage.detail, /cannot keep its database/); assert.match(storage.fix, /uid 1000/);
  const running = row(on({ state: "healthy", answer: "running" }));
  assert.equal(running.status, "ok"); assert.equal(running.detail, "on and running: Discord and the homeserver let it in");
  assert.match(row(on({ answer: "retrying" })).detail, /has not let it in yet \(it keeps trying\)/);
  assert.match(row(on({ answer: "<b>" })).detail, /has not let it in yet/, "an unknown word is only the container's health");
  // An older host's facts (no registration, no answer): as before.
  assert.equal(row({ profile: true, token: true, state: "healthy" }).status, "ok");
  assert.equal(row({ profile: true, token: false, state: "unhealthy", registration: "match", answer: "waiting-settings" }).detail, "switched on, but no Discord bot token is set", "the missing token is said first");
});

test("the host asks the bridge's container for its word, and compares both copies of its file", () => {
  const h = fakeHome(ON + `DISCORD_BOT_TOKEN=${BOT_TOKEN}`);
  try {
    mkdirSync(path.join(h.home, "results"), { mode: 0o755 });
    assert.equal(h.run("render").status, 0);
    const facts = () => {
      h.runWith({ BB_DOCTOR_NODE: process.execPath, FAKE_UNHEALTHY: "ooye" }, "doctor");
      return JSON.parse(readFileSync(path.join(h.home, "results/doctor-host.json"), "utf8"));
    };
    writeFileSync(path.join(h.fake, "ooye-state"), "waiting-settings\n");
    let f = facts();
    assert.deepEqual(f.discord, { profile: true, token: true, state: "unhealthy", registration: "match", answer: "waiting-settings" });
    assert.ok(f.rendered.some((x) => x.file === "ooye/registration.yaml" && x.match) && f.rendered.some((x) => x.file === "synapse/appservice-ooye.yaml" && x.match));
    writeFileSync(path.join(h.fake, "ooye-state"), "<script>\n");
    assert.equal(facts().discord.answer, null, "only a plain word");
    // A hand edit of the bridge's file is a difference.
    writeFileSync(path.join(h.home, BRIDGE), `${file(h.home, BRIDGE).trim()} \n`);
    f = facts();
    assert.equal(f.discord.registration, "differs");
    rmSync(path.join(h.home, BRIDGE));
    assert.equal(facts().discord.registration, "missing");
    assert.ok(!JSON.stringify(facts()).includes(BOT_TOKEN), "the token never reaches the facts");
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

// ── the entrypoint's word, run for real with stand-ins for OOYE's scripts ─────────────────────
test("the entrypoint says its word: waiting-settings, then setup, running, and retrying after a stop", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bb-ooye-state-"));
  const data = path.join(dir, "data"), config = path.join(dir, "config"), stateFile = path.join(dir, "state");
  mkdirSync(data); mkdirSync(config);
  writeFileSync(path.join(dir, "init.js"), "");
  writeFileSync(path.join(dir, "start.js"), `const fs=require("fs");if(!fs.existsSync("${dir}/ran")){fs.writeFileSync("${dir}/ran","");process.exit(2)}setInterval(()=>{},1000)`);
  const p = spawn(process.execPath, [path.join(here, "ooye/entrypoint.js")], { cwd: data, stdio: "ignore",
    env: { ...process.env, BB_OOYE_CONFIG: config, BB_OOYE_INIT: path.join(dir, "init.js"), BB_OOYE_START: path.join(dir, "start.js"),
      BB_OOYE_STATE_FILE: stateFile, BB_OOYE_POLL_MS: "50", BB_OOYE_FIRST_DELAY_MS: "400" } });
  const word = () => { try { return readFileSync(stateFile, "utf8"); } catch { return ""; } };
  const until = async (w) => { const end = Date.now() + 8000; while (word() !== `${w}\n`) { if (Date.now() > end) assert.fail(`never said ${w} (said ${JSON.stringify(word())})`); await new Promise((r) => setTimeout(r, 10)); } };
  try {
    await until("waiting-settings");
    writeFileSync(path.join(config, "registration.yaml"), JSON.stringify({ ooye: { discord_token: "MTAw.x.y" } }));
    await until("retrying"); // the stand-in OOYE stopped once
    await until("running"); // and was started again
    p.kill("SIGTERM");
    assert.equal(await new Promise((r) => p.on("exit", r)), 0);
  } finally { p.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); }
});

// ── the two tokens: made once ─────────────────────────────────────────────────────────────────
const migrate = (envFile) => spawnSync("bash", [path.join(here, "migrations/007-discord-bridge-registration.sh")], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", BB_ENV_FILE: envFile } });
const keyOf = (env, k) => env.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1];

test("a missing OOYE token is made once by the installer or migration 007 (64 hex, never printed), and kept on a re-run", () => {
  const inst = read("install.sh"), example = read(".env.example");
  assert.match(inst, /^ {2}secret OOYE_AS_TOKEN 32$/m); assert.match(inst, /^ {2}secret OOYE_HS_TOKEN 32$/m);
  assert.match(inst, /^OOYE_AS_TOKEN=\$SECRET_OOYE_AS_TOKEN$/m); assert.match(inst, /^OOYE_HS_TOKEN=\$SECRET_OOYE_HS_TOKEN$/m);
  assert.match(inst, /^DISCORD_CLIENT_SECRET=$/m);
  // The installer writes .env only when there is none: a re-run never makes new tokens.
  assert.match(inst, /\nif \[ ! -f "\$ENV_FILE" \]; then\n[\s\S]*?\n {2}secret OOYE_AS_TOKEN 32\n[\s\S]*?\n {2}mv -f "\$tmp" "\$ENV_FILE"\nfi\n/);
  assert.match(example, /^OOYE_AS_TOKEN=change-me$/m); assert.match(example, /^OOYE_HS_TOKEN=change-me$/m); assert.match(example, /^DISCORD_CLIENT_SECRET=$/m);
  // The render reads them, and nothing else: the panel's link calls are made inside the bridge by the
  // host (install/ooye/link.js), so the site never holds the bridge's appservice token.
  // (A whole name: SIGNIN_DISCORD_CLIENT_SECRET is the sign-in provider's, another app's secret.)
  assert.doesNotMatch(read("compose.yaml"), /(?<![A-Z_])(OOYE_(AS|HS)_TOKEN|DISCORD_CLIENT_SECRET)/, "only the host reads them (the render)");
  const dir = mkdtempSync(path.join(tmpdir(), "bb-env7-"));
  const f = path.join(dir, ".env");
  try {
    writeFileSync(f, "BB_DOMAIN=example.test\nDISCORD_BOT_TOKEN=\n", { mode: 0o600 });
    const r = migrate(f);
    assert.equal(r.status, 0, r.stderr);
    const first = readFileSync(f, "utf8");
    const as = keyOf(first, "OOYE_AS_TOKEN"), hs = keyOf(first, "OOYE_HS_TOKEN");
    assert.match(as, /^[0-9a-f]{64}$/); assert.match(hs, /^[0-9a-f]{64}$/); assert.notEqual(as, hs);
    assert.equal(keyOf(first, "DISCORD_CLIENT_SECRET"), "");
    assert.ok(!r.stdout.includes(as) && !r.stderr.includes(as) && !r.stdout.includes(hs) && !r.stderr.includes(hs), "a token was printed");
    // Retry (a run cut off before its record): the same tokens, each key once.
    assert.equal(migrate(f).status, 0);
    assert.equal(readFileSync(f, "utf8"), first);
    // A client secret already set is kept.
    writeFileSync(f, first.replace(/^DISCORD_CLIENT_SECRET=$/m, "DISCORD_CLIENT_SECRET=kept"));
    assert.equal(migrate(f).status, 0);
    assert.equal(keyOf(readFileSync(f, "utf8"), "DISCORD_CLIENT_SECRET"), "kept");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the release's .env example is at the newest migration, 007", () => {
  assert.match(read(".env.example"), /^BB_ENV_VERSION=7$/m);
  assert.ok(existsSync(path.join(root, "install/migrations/007-discord-bridge-registration.sh")));
  assert.ok((statSync(path.join(here, "migrations/007-discord-bridge-registration.sh")).mode & 0o111) !== 0, "executable like the others");
});
