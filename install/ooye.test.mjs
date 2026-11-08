// The Discord bridge in the bundle: Out Of Your Element (install/ooye/), the compose service `ooye`
// under the profile `discord`, and what the box and the doctor do with it. Run: node --test install/
//
// What they hold: the image is upstream v3.7 at its commit, checked while it builds, on base images
// pinned by digest; it runs as `node` with /data its own and Docker's init as the first process; the
// service is off unless COMPOSE_PROFILES names discord, and then `up` waits for its process only
// (Discord is outside the box); the doctor row reads "Discord bridge: off" until a bot token is set;
// the entrypoint never crash-loops (it waits for what is missing and tries again with a growing wait),
// never writes the registration, and stops at once. The entrypoint runs here for real, with
// stand-ins for OOYE's two scripts; the real image is built and run outside this suite (it
// clones upstream and installs its dependencies, minutes of network a test run should not need).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DOCTOR } from "../config/doctor.mjs";
import { fakeHome, runRender } from "./scratch-home.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, rel), "utf8");
const CI = process.env.CI === "true";
const dockerCompose = spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;

// Each scanned file's last meaningful line: an emptied or cut-short file fails here, not passes.
const ENDS = {
  "ooye/Dockerfile": /\nEXPOSE 6693\nCMD \["node", "\/opt\/blackbranch-ooye\/entrypoint\.js"\]\n$/,
  "ooye/entrypoint.js": /\nmain\(\)\.catch\([^\n]*\n$/,
  "ooye/init.js": /\n {2}process\.exit\(1\)\n\}\)\n$/,
};
test("vacuity anchors: the bridge's files end where they should", () => {
  for (const [f, end] of Object.entries(ENDS)) assert.match(read(f), end, `${f} does not end as expected`);
});

test("the image: OOYE's tag v3.7 AND its commit 2430d608, checked while it builds; every base image pinned by digest", () => {
  const d = read("ooye/Dockerfile");
  assert.match(d, /^ARG OOYE_REF=v3\.7$/m, "the upstream tag is v3.7 (not v3.7.0)");
  assert.match(d, /^ARG OOYE_COMMIT=2430d60809f6fb914258a64ba07c735831c729b0$/m);
  // The clone is of the tag, and the build stops when the tag names another commit.
  assert.match(d, /git clone --depth 1 --branch "\$OOYE_REF" "\$OOYE_REPO" \/opt\/ooye \\\n && actual="\$\(git -C \/opt\/ooye rev-parse HEAD\)" \\\n && if \[ "\$actual" != "\$OOYE_COMMIT" \]; then [^\n]*exit 1; fi/);
  const froms = [...d.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]);
  assert.equal(froms.length, 2, "a build stage and the image");
  for (const f of froms) assert.match(f, /^node:22\.\d+\.\d+-alpine[\d.]+@sha256:[0-9a-f]{64}$/, `${f}: a base image by digest, never a moving tag`);
  assert.match(d, /npm ci --omit=dev/, "production dependencies only");
  assert.doesNotMatch(d, /rm -rf[^\n]*\btest\b/, "test/ stays: OOYE's src/stdin.js requires test/data at start");
});

test("the image runs as node, owns /data (its working directory and volume), and starts the bundle's entrypoint", () => {
  const d = read("ooye/Dockerfile");
  const final = d.slice(d.lastIndexOf("\nFROM "));
  assert.match(final, /\nRUN mkdir -p \/data && chown node:node \/data\nUSER node\nWORKDIR \/data\nVOLUME \/data\n/);
  assert.match(final, /COPY entrypoint\.js init\.js links\.js link\.js discord-read\.js \/opt\/blackbranch-ooye\//);
  assert.match(final, /LABEL [^\n]*\n[\s\S]*org\.opencontainers\.image\.licenses="AGPL-3\.0-or-later"/, "the licence is on the image");
  assert.doesNotMatch(final, /\nUSER root/);
});

// The compose block, read from the file (and from Compose itself where it is installed).
const block = (svc) => read("compose.yaml").match(new RegExp(`\\n  ${svc}:\\n([\\s\\S]*?)(?=\\n  [a-z-]+:\\n|\\n# ──|\\n  # ──|\\nnetworks:)`))?.[1] ?? "";
test("compose: ooye replaces mautrix-discord, under the profile discord, with init, its volume and the renderer's folder read-only", (t) => {
  const b = block("ooye");
  assert.ok(b, "an ooye service");
  assert.equal(block("mautrix-discord"), "", "mautrix-discord is gone from the bundle");
  assert.match(b, /\n {4}profiles: \["discord"\]\n/);
  assert.match(b, /\n {4}init: true\n/, "Docker's init: node as PID 1 would ignore SIGTERM and be killed after 10 s");
  assert.match(b, /\n {6}- bridge-data:\/data\n/);
  assert.match(b, /\n {6}- \.\/rendered\/ooye:\/config:ro\n/, "the registration is the renderer's, read-only");
  assert.doesNotMatch(b, /\n {4}user:/, "it runs as the image's node, the owner of a new bridge-data volume");
  assert.doesNotMatch(b, /\n {4}(ports|environment|env_file):/, "no port leaves the network; no secret in its environment (OOYE reads only its registration)");
  assert.match(b, /\n {4}image: blackbranch\/ooye:\$\{BB_RELEASE:-local\}\n {4}build: \{ context: "\$\{BB_RELEASE_DIR:-\.\/release\}\/install\/ooye" \}\n/);
  if (!dockerCompose) return CI ? assert.fail("docker compose is required in CI") : t.skip("docker compose not installed");
  const dir = mkdtempSync(path.join(tmpdir(), "bb-compose-"));
  try {
    const cfg = (profiles) => JSON.parse(execFileSync("docker", ["compose", "-f", path.join(here, "compose.yaml"), "--project-directory", dir,
      "--env-file", path.join(here, ".env.example"), ...profiles.flatMap((p) => ["--profile", p]), "config", "--format", "json"],
    { encoding: "utf8", env: { ...process.env, COMPOSE_PROFILES: "", COMPOSE_FILE: "" } }));
    assert.equal(cfg(["tunnel"]).services.ooye, undefined, "off unless the profile is named");
    const s = cfg(["tunnel", "discord"]).services.ooye;
    assert.equal(s.init, true);
    assert.equal(s.user, undefined);
    assert.equal(s.ports, undefined);
    assert.deepEqual(s.volumes.map((v) => `${v.type}:${v.source.replace(/^.*\/rendered\//, "./rendered/")}:${v.target}${v.read_only ? ":ro" : ""}`).sort(),
      ["bind:./rendered/ooye:/config:ro", "volume:bridge-data:/data"]);
    assert.match(s.build.context, /\/install\/ooye$/);
    assert.ok(s.healthcheck?.test?.join(" ").includes("127.0.0.1:6693"), "healthy = OOYE answers on its port");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the profile is off by default: neither .env.example nor install.sh's .env names discord, and a new key holds the token empty", () => {
  for (const [what, text] of [[".env.example", read(".env.example")], ["install.sh", read("install.sh")]]) {
    const line = text.match(/^COMPOSE_PROFILES=(.*)$/m)?.[1];
    assert.ok(line !== undefined, `${what} writes COMPOSE_PROFILES`);
    assert.doesNotMatch(line, /discord/, `${what}: the bridge is off on a new install`);
    assert.match(text, /^DISCORD_BOT_TOKEN=$/m, `${what}: the token key, empty`);
  }
  // An install made before it gets the key, empty, once.
  const dir = mkdtempSync(path.join(tmpdir(), "bb-envm-"));
  try {
    const env = path.join(dir, ".env");
    writeFileSync(env, "COMPOSE_PROFILES=tunnel\nBB_ENV_VERSION=5\n", { mode: 0o600 });
    for (let i = 0; i < 2; i++) execFileSync("bash", [path.join(here, "migrations/006-discord-bridge.sh")], { env: { ...process.env, BB_ENV_FILE: env } });
    assert.equal(readFileSync(env, "utf8"), "COMPOSE_PROFILES=tunnel\nBB_ENV_VERSION=5\nDISCORD_BOT_TOKEN=\n");
    writeFileSync(env, "DISCORD_BOT_TOKEN=kept\n", { mode: 0o600 });
    execFileSync("bash", [path.join(here, "migrations/006-discord-bridge.sh")], { env: { ...process.env, BB_ENV_FILE: env } });
    assert.equal(readFileSync(env, "utf8"), "DISCORD_BOT_TOKEN=kept\n", "a token already there is kept");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the box knows the profile: status lists ooye only when it is on, and `up` never waits for Discord", () => {
  const off = fakeHome("BB_TLS_MODE=tunnel");
  const on = fakeHome("BB_TLS_MODE=tunnel\nCOMPOSE_PROFILES=tunnel,discord");
  try {
    assert.doesNotMatch(off.run("status").stdout, /\n {2}ooye /, "off: not a service the box expects");
    let r = on.run("status");
    assert.match(r.stdout, /\n {2}ooye {12}healthy\n/, "on: listed with its health");
    // Unhealthy = Discord or the homeserver has not let it in: the wait passes, and says so.
    r = on.runWith({ FAKE_UNHEALTHY: "ooye", BB_HEALTH_WAIT: "1" }, "set", "CURRENCY_NAME", "coin");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /the Discord bridge runs, but does not answer yet — blackbranch doctor says why \(blackbranch logs ooye\)/);
    r = on.runWith({ FAKE_UNHEALTHY: "ooye" }, "status");
    assert.match(r.stdout, /\n {2}ooye {12}running, but Discord or the homeserver has not let it in — blackbranch logs ooye\n/);
    // A bridge whose container is gone is still waited for (that is the box's, not Discord's).
    r = on.runWith({ FAKE_STATE: "exited", BB_HEALTH_WAIT: "1" }, "set", "CURRENCY_NAME", "coins");
    assert.notEqual(r.status, 0);
  } finally { for (const h of [off, on]) rmSync(h.home, { recursive: true, force: true }); }
});

test("the box builds the bridge's image only where it runs, at `up` and in an update", () => {
  const bb = read("blackbranch");
  assert.match(bb, /\n {2}if discord_on; then targets\+=\(ooye\); fi\n {2}docker_step "the images of release \$\(release_tag\) did not build" compose --profile backup build "\$\{targets\[@\]\}"\n/);
  assert.match(bb, /\n {2}if discord_on "\$ENVN"; then targets\+=\(ooye\); fi\n {2}if ! compose_next --profile backup build "\$\{targets\[@\]\}"/, "an update reads the NEXT .env's profile");
  assert.match(bb, /\n {2}if discord_on; then docker image inspect "blackbranch\/ooye:\$\(release_tag\)" >\/dev\/null 2>&1 \|\| return 1; fi\n/);
});

// ── the doctor ───────────────────────────────────────────────────────────────────────────────
const row = (discord) => DOCTOR.evaluate({ host: { at: "2026-10-31T00:00:00Z", discord }, hostState: "ok", site: {}, siteError: null }).find((r) => r.id === "discord.bridge");
test("the doctor row reads 'Discord bridge: off' until DISCORD_BOT_TOKEN is set", () => {
  const off = row({ profile: false, token: false, state: null });
  assert.equal(off.title, "Discord bridge");
  assert.equal(off.status, "grey");
  assert.equal(off.detail, "off: no Discord bot token is set");
  const set = row({ profile: false, token: true, state: null });
  assert.equal(set.status, "warn"); assert.match(set.detail, /a Discord bot token is set, but the bridge is not switched on/); assert.match(set.fix, /COMPOSE_PROFILES=tunnel,discord/);
  const noToken = row({ profile: true, token: false, state: "unhealthy" });
  assert.equal(noToken.status, "fail"); assert.match(noToken.fix, /DISCORD_BOT_TOKEN/);
  assert.equal(row({ profile: true, token: true, state: "healthy" }).status, "ok");
  assert.equal(row({ profile: true, token: true, state: "starting" }).status, "grey");
  const out = row({ profile: true, token: true, state: "unhealthy" });
  assert.equal(out.status, "fail"); assert.match(out.detail, /has not let it in yet \(it keeps trying\)/); assert.match(out.fix, /sudo blackbranch logs ooye/);
  assert.match(row({ profile: true, token: true, state: "exited" }).detail, /its container is exited/);
  assert.match(row({ profile: true, token: true, state: "<b>" }).detail, /its container is not running/, "only a plain word reaches the page");
  assert.equal(row(undefined).status, "grey", "an older host's facts: not checked");
  assert.ok(!DOCTOR.UPDATE_CHECKS.includes("discord.bridge"), "Discord is outside the box: never an update check");
});

test("the host's facts: the profile, whether a token is set (never the token) and the container's state", () => {
  const h = fakeHome("BB_TLS_MODE=tunnel\nCOMPOSE_PROFILES=tunnel,discord\nDISCORD_BOT_TOKEN=MTAw.secret-token-value");
  try {
    const bb = read("blackbranch");
    assert.match(bb, /\n {2}if discord_on; then dprof=true; dstate="\\"\$\(service_health ooye\)\\""; fi\n {2}\[ -n "\$\(env_get DISCORD_BOT_TOKEN\)" \] && dtok=true\n/);
    assert.match(bb, /printf '"discord":\{"profile":%s,"token":%s,"state":%s,"registration":%s,"answer":%s\},' "\$dprof" "\$dtok" "\$dstate" "\$dreg" "\$danswer"/);
    mkdirSync(path.join(h.home, "results"), { mode: 0o755 });
    assert.equal(runRender(h.home).status, 0);
    writeFileSync(path.join(h.fake, "ooye-state"), "running\n");
    // `doctor` exits 1 here (no router answers in a scratch home); the facts are written all the same.
    const r = h.runWith({ BB_DOCTOR_NODE: process.execPath }, "doctor");
    assert.match(r.stdout, /\[ok {2}\] Discord bridge — on and running: Discord and the homeserver let it in/, r.stderr);
    const facts = JSON.parse(readFileSync(path.join(h.home, "results/doctor-host.json"), "utf8"));
    assert.deepEqual(facts.discord, { profile: true, token: true, state: "healthy", registration: "match", answer: "running" });
    assert.ok(!JSON.stringify(facts).includes("secret-token-value"), "the token never reaches the facts");
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

// ── the entrypoint, run for real with stand-ins for OOYE's scripts ───────────────────────────
const REG = { id: "ooye", as_token: "a".repeat(64), hs_token: "b".repeat(64), url: "http://ooye:6693", sender_localpart: "_ooye_bot",
  ooye: { namespace_prefix: "_ooye_", server_name: "example.test", server_origin: "http://synapse:8008", discord_token: "MTAw.x.y", max_file_size: 5000000 } };
function bridge() {
  const dir = mkdtempSync(path.join(tmpdir(), "bb-ooye-"));
  const data = path.join(dir, "data"), config = path.join(dir, "config");
  mkdirSync(data); mkdirSync(config);
  // init: fails while fake/init-fail holds a number above 0 (one less each run); start: stays up,
  // unless fake/start-exit says to exit with that code once.
  const init = path.join(dir, "init.js"), start = path.join(dir, "start.js");
  writeFileSync(init, `const fs=require("fs");fs.appendFileSync("${dir}/runs","init\\n");
let n=0;try{n=+fs.readFileSync("${dir}/init-fail","utf8")}catch{}
if(n>0){fs.writeFileSync("${dir}/init-fail",String(n-1));console.error("setup did not finish: Discord did not answer");process.exit(1)}`);
  writeFileSync(start, `const fs=require("fs");fs.appendFileSync("${dir}/runs","start\\n");
fs.writeFileSync("${dir}/start-pid",String(process.pid));
let c=null;try{c=fs.readFileSync("${dir}/start-exit","utf8");fs.rmSync("${dir}/start-exit")}catch{}
if(c!==null)process.exit(+c);setInterval(()=>{},1000)`);
  let out = "";
  const p = spawn(process.execPath, [path.join(here, "ooye/entrypoint.js")], { cwd: data, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, BB_OOYE_CONFIG: config, BB_OOYE_INIT: init, BB_OOYE_START: start, BB_OOYE_POLL_MS: "50", BB_OOYE_FIRST_DELAY_MS: "100" } });
  p.stdout.on("data", (b) => { out += b; }); p.stderr.on("data", (b) => { out += b; });
  const exited = new Promise((resolve) => p.on("exit", (code) => resolve(code)));
  const runs = () => { try { return readFileSync(path.join(dir, "runs"), "utf8").trim().split("\n"); } catch { return []; } };
  const until = async (cond, what, ms = 8000) => {
    const end = Date.now() + ms;
    while (!cond()) { if (Date.now() > end) assert.fail(`${what} (runs: ${runs().join(",")}; output: ${out})`); await new Promise((r) => setTimeout(r, 25)); }
  };
  return { dir, data, config, p, exited, runs, until, out: () => out, writeReg: (reg = REG) => writeFileSync(path.join(config, "registration.yaml"), JSON.stringify(reg)) };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("entrypoint: without a registration it waits (no exit, no crash loop), says why once, and starts once the renderer writes it", async () => {
  const b = bridge();
  try {
    await b.until(() => /waiting: .*registration\.yaml is not there yet/.test(b.out()), "said why it waits");
    b.writeReg({ ...REG, ooye: { ...REG.ooye, discord_token: "" } });
    await b.until(() => /names no Discord bot token/.test(b.out()), "a registration with no token is waited on too");
    assert.deepEqual(b.runs(), [], "nothing of OOYE ran without a token");
    b.writeReg();
    await b.until(() => b.runs().includes("start"), "started once the registration was there");
    assert.deepEqual(b.runs(), ["init", "start"], "setup's half first, then OOYE");
    assert.equal(b.out().match(/is not there yet/g).length, 1, "each reason said once, not once per poll");
    b.p.kill("SIGTERM");
    assert.equal(await b.exited, 0);
  } finally { b.p.kill("SIGKILL"); rmSync(b.dir, { recursive: true, force: true }); }
});

test("entrypoint retry: a setup that fails (Discord down) is tried again after a growing wait; a bridge that stops is started again", async () => {
  const b = bridge();
  try {
    writeFileSync(path.join(b.dir, "init-fail"), "2");
    writeFileSync(path.join(b.dir, "start-exit"), "3");
    b.writeReg();
    await b.until(() => b.runs().filter((x) => x === "start").length === 2, "the bridge started again after it stopped");
    assert.deepEqual(b.runs(), ["init", "init", "init", "start", "init", "start"]);
    assert.match(b.out(), /its setup stopped \(exit 1\); starting again in 0 s[\s\S]*its setup stopped \(exit 1\); starting again in 0 s[\s\S]*the bridge stopped \(exit 3\); starting again in 0 s/);
    assert.equal(b.p.exitCode, null, "the container's process never exited");
    b.p.kill("SIGTERM");
    assert.equal(await b.exited, 0);
  } finally { b.p.kill("SIGKILL"); rmSync(b.dir, { recursive: true, force: true }); }
});

test("entrypoint: the growing wait doubles to 5 minutes, and a run of 10 minutes starts it over (constants read from the file)", () => {
  const src = read("ooye/entrypoint.js");
  assert.match(src, /\nconst MAX_DELAY_MS = 300_000\n/);
  assert.match(src, /\nconst LONG_RUN_MS = 600_000\n/);
  assert.match(src, /\n {4}if \(Date\.now\(\) - began >= LONG_RUN_MS\) delay = FIRST_DELAY_MS\n[\s\S]*\n {4}delay = Math\.min\(delay \* 2, MAX_DELAY_MS\)\n/);
});

test("entrypoint restart: a second start keeps the link; a copy left in /data is replaced by the link and never written", async () => {
  const b = bridge();
  try {
    writeFileSync(path.join(b.data, "registration.yaml"), "an old copy\n");
    b.writeReg();
    await b.until(() => b.runs().includes("start"), "started");
    const link = path.join(b.data, "registration.yaml");
    assert.ok(lstatSync(link).isSymbolicLink(), "a link, not a copy of the secrets in the volume");
    assert.equal(readlinkSync(link), path.join(b.config, "registration.yaml"));
    assert.equal(readFileSync(link, "utf8"), JSON.stringify(REG), "the renderer's text, unchanged");
    b.p.kill("SIGTERM"); assert.equal(await b.exited, 0);
    // The second start (a restart): the same link, OOYE started again.
    const p2 = spawn(process.execPath, [path.join(here, "ooye/entrypoint.js")], { cwd: b.data, stdio: "ignore",
      env: { ...process.env, BB_OOYE_CONFIG: b.config, BB_OOYE_INIT: path.join(b.dir, "init.js"), BB_OOYE_START: path.join(b.dir, "start.js"), BB_OOYE_POLL_MS: "50" } });
    try {
      await b.until(() => b.runs().filter((x) => x === "start").length === 2, "started again after the restart");
      assert.equal(readlinkSync(link), path.join(b.config, "registration.yaml"));
    } finally { p2.kill("SIGTERM"); }
  } finally { b.p.kill("SIGKILL"); rmSync(b.dir, { recursive: true, force: true }); }
});

test("entrypoint: a stop while OOYE runs stops OOYE with it and exits 0 at once", async () => {
  const b = bridge();
  try {
    b.writeReg();
    await b.until(() => existsSync(path.join(b.dir, "start-pid")), "OOYE running");
    const pid = Number(readFileSync(path.join(b.dir, "start-pid"), "utf8"));
    assert.ok(alive(pid));
    const t0 = Date.now();
    b.p.kill("SIGTERM");
    assert.equal(await b.exited, 0);
    assert.ok(Date.now() - t0 < 2000, `stopped at once (${Date.now() - t0} ms)`);
    await b.until(() => !alive(pid), "OOYE stopped too", 2000);
  } finally { b.p.kill("SIGKILL"); rmSync(b.dir, { recursive: true, force: true }); }
});

test("entrypoint: a data folder it cannot write is said and waited on, never a crash loop", { skip: process.getuid?.() === 0 && "run as root: every folder is writable" }, async () => {
  const b = bridge();
  try {
    // The registration comes second, so the folder is already unwritable when it is checked.
    chmodSync(b.data, 0o555);
    b.writeReg();
    await b.until(() => /waiting: the bridge's data folder .* belongs to uid \d+ and this container runs as uid \d+: it cannot keep its database there/.test(b.out()), "said why");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(b.p.exitCode, null, "still waiting: no exit, so no restart loop");
    assert.deepEqual(b.runs(), [], "OOYE never started on a folder it cannot write");
    chmodSync(b.data, 0o755);
    await b.until(() => b.runs().includes("start"), "started once the folder was writable");
    b.p.kill("SIGTERM");
    assert.equal(await b.exited, 0);
  } finally { chmodSync(b.data, 0o755); b.p.kill("SIGKILL"); rmSync(b.dir, { recursive: true, force: true }); }
});
