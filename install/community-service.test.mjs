// The community service account: the install's own Matrix account that runs the community's rooms.
// Run: node --test install/
//
// It is an application service registration (rendered by install/matrix/render.sh; matrix.test.mjs
// holds the render), so the account exists the moment Synapse reads the file: nothing signs it up,
// and MAS never knows it. What these hold: its two tokens reach an existing install's .env through
// migration 005 (random, never printed, kept on a re-run); `up` gives it the site's name and icon
// after the homeserver is healthy, with the token on stdin and never on a command line, once — a
// second start changes nothing — and a failure never fails the start; `blackbranch community
// token-check` says whether the token answers as the account.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync, existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeHome } from "./scratch-home.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const read = (rel) => readFileSync(path.join(here, rel), "utf8");
const AS = "a1".repeat(32);
const USER = "@blackbranch:example.test";

// ── migration 005 ─────────────────────────────────────────────────────────────────────────────
// The runner itself, lifted out of blackbranch (as update.test.mjs does), over this checkout's migrations.
const migrate = (envFile) => spawnSync("bash", ["-c",
  `. <(sed -n '/^env_migrations() {/,/^}/p;/^env_get() {/,/^}/p;/^env_quote() {/p;/^replace_file() {/,/^}/p;/^env_set() {/,/^}/p;/^env_file_get() {/p;/^env_file_set() {/p' "$1") && env_migrations "$2" "$3"`,
  "_", path.join(here, "blackbranch"), root, envFile], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
// An .env as release 4 wrote it: the example without the keys 005, 006 and 007 bring, at BB_ENV_VERSION=4.
function envAt4() {
  const dir = mkdtempSync(path.join(tmpdir(), "bb-env-"));
  const f = path.join(dir, ".env");
  const lines = read(".env.example").split("\n").filter((l) => !/^(COMMUNITY_(LOCALPART|AS_TOKEN|HS_TOKEN|RECONCILER)|DISCORD_BOT_TOKEN|DISCORD_CLIENT_SECRET|OOYE_(AS|HS)_TOKEN)=/.test(l));
  writeFileSync(f, lines.join("\n").replace(/^BB_ENV_VERSION=.*$/m, "BB_ENV_VERSION=4"), { mode: 0o600 });
  return { dir, f };
}
const keyOf = (env, k) => env.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1];

test("005 adds COMMUNITY_AS_TOKEN and COMMUNITY_HS_TOKEN as 64 hex chars and never prints them", () => {
  const { dir, f } = envAt4();
  try {
    const r = migrate(f);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "3", "005 and the two after it (006 the Discord bridge's token, 007 its registration's tokens) ran");
    const env = readFileSync(f, "utf8");
    const as = keyOf(env, "COMMUNITY_AS_TOKEN"), hs = keyOf(env, "COMMUNITY_HS_TOKEN");
    assert.match(as, /^[0-9a-f]{64}$/); assert.match(hs, /^[0-9a-f]{64}$/);
    assert.notEqual(as, hs, "two tokens, not one twice");
    assert.match(env, /^BB_ENV_VERSION="?7"?$/m);
    // The account's name, and the community keeper off: an install made before it keeps its rooms as they are.
    assert.equal(keyOf(env, "COMMUNITY_LOCALPART"), "blackbranch");
    assert.equal(keyOf(env, "COMMUNITY_RECONCILER"), "false");
    for (const out of [r.stdout, r.stderr]) { assert.ok(!out.includes(as) && !out.includes(hs), "a token was printed"); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("restart and retry: 005 run again keeps the tokens it made; an .env that has them is never given new ones", () => {
  const { dir, f } = envAt4();
  try {
    assert.equal(migrate(f).status, 0);
    const first = readFileSync(f, "utf8");
    // The same migration again (a run cut off after its writes, before its record).
    writeFileSync(f, first.replace(/^BB_ENV_VERSION=.*$/m, "BB_ENV_VERSION=4"), { mode: 0o600 });
    const again = migrate(f);
    assert.equal(again.status, 0, again.stderr);
    const second = readFileSync(f, "utf8");
    for (const k of ["COMMUNITY_AS_TOKEN", "COMMUNITY_HS_TOKEN", "COMMUNITY_LOCALPART", "COMMUNITY_RECONCILER"]) {
      assert.equal(keyOf(second, k), keyOf(first, k), `${k} changed on the re-run`);
      assert.equal(second.split("\n").filter((l) => l.startsWith(`${k}=`)).length, 1, `${k} twice`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a new install's .env holds the same keys: install.sh makes both tokens with the checked generator, and the keeper on", () => {
  const inst = read("install.sh"), example = read(".env.example");
  assert.match(inst, /^ {2}secret COMMUNITY_AS_TOKEN 32$/m); assert.match(inst, /^ {2}secret COMMUNITY_HS_TOKEN 32$/m);
  assert.match(inst, /^COMMUNITY_AS_TOKEN=\$SECRET_COMMUNITY_AS_TOKEN$/m); assert.match(inst, /^COMMUNITY_HS_TOKEN=\$SECRET_COMMUNITY_HS_TOKEN$/m);
  assert.match(inst, /^COMMUNITY_LOCALPART=blackbranch$/m); assert.match(inst, /^COMMUNITY_RECONCILER=true$/m);
  assert.match(example, /^COMMUNITY_AS_TOKEN=change-me$/m); assert.match(example, /^COMMUNITY_HS_TOKEN=change-me$/m);
  assert.match(example, /^BB_ENV_VERSION=7$/m);
  // Only the host reads the tokens (render, and the profile job's stdin): no service's environment holds them.
  assert.doesNotMatch(read("compose.yaml"), /COMMUNITY_(AS|HS)_TOKEN/);
});

// ── the profile job, against a fake homeserver ───────────────────────────────────────────────
function fakeHomeserver({ user = USER, token = AS } = {}) {
  const calls = []; const profile = { displayname: null, avatar_url: null }; const media = [];
  const state = { uploadStatus: 200 };
  const srv = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    calls.push(`${req.method} ${p}`);
    const send = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { errcode: "M_UNKNOWN_TOKEN" });
    if (p === "/_matrix/client/v3/account/whoami") return send(200, { user_id: user, is_guest: false });
    // Synapse answers 500 here once the sender's profile exists: the job must never ask.
    if (p.endsWith("/register")) return send(500, { errcode: "M_UNKNOWN" });
    const m = p.match(/^\/_matrix\/client\/v3\/profile\/([^/]+)\/(displayname|avatar_url)$/);
    if (m) {
      if (m[1] !== user) return send(403, { errcode: "M_FORBIDDEN" });
      if (req.method === "GET") return profile[m[2]] === null ? send(404, { errcode: "M_NOT_FOUND" }) : send(200, { [m[2]]: profile[m[2]] });
      profile[m[2]] = JSON.parse(body.toString())[m[2]]; return send(200, {});
    }
    if (p === "/_matrix/media/v3/upload" && req.method === "POST") {
      if (state.uploadStatus !== 200) return send(state.uploadStatus, { errcode: "M_UNKNOWN" });
      media.push(body); return send(200, { content_uri: `mxc://example.test/m${media.length}` });
    }
    return send(404, { errcode: "M_UNRECOGNIZED" });
  });
  return { srv, calls, profile, media, state };
}
function job(base, env = {}, token = AS) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(here, "matrix/community-service.mjs")],
      { env: { PATH: process.env.PATH, MX_BASE: base, MX_USER_ID: USER, MX_DISPLAY_NAME: "Example Stream", ...env } });
    let out = "", err = "";
    p.stdout.on("data", (c) => (out += c)); p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => resolve({ code, out, err, line: (() => { try { return JSON.parse(out.trim().split("\n").pop()); } catch { return null; } })() }));
    p.stdin.end(`${token}\n`);
  });
}
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("an icon, for the test")]);
async function withHomeserver(opts, fn) {
  const hs = fakeHomeserver(opts);
  await new Promise((r) => hs.srv.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(path.join(tmpdir(), "bb-icon-"));
  try { await fn({ ...hs, base: `http://127.0.0.1:${hs.srv.address().port}`, dir }); }
  finally { hs.srv.close(); rmSync(dir, { recursive: true, force: true }); }
}

test("the profile job: the site's name and icon, set once; restart and retry — a second run only reads", async () => {
  await withHomeserver({}, async ({ base, calls, profile, media, dir }) => {
    const icon = path.join(dir, "icon-512.png"); writeFileSync(icon, PNG);
    const first = await job(base, { MX_AVATAR: icon });
    assert.equal(first.code, 0, first.err);
    const sha = createHash("sha256").update(PNG).digest("hex");
    assert.deepEqual(first.line, { user: USER, name: "set", avatar: "set", avatarStamp: `${sha} mxc://example.test/m1` });
    assert.equal(profile.displayname, "Example Stream"); assert.equal(profile.avatar_url, "mxc://example.test/m1");
    assert.deepEqual(media, [PNG]);
    assert.ok(!calls.some((c) => c.endsWith("/register")), "the job never registers the account");
    assert.ok(calls.indexOf("GET /_matrix/client/v3/account/whoami") === 0, "it asks who the token is first");
    // The next start: what the last run set comes back as the stamp; nothing is written.
    const n = calls.length;
    const second = await job(base, { MX_AVATAR: icon, MX_AVATAR_STAMP: first.line.avatarStamp });
    assert.equal(second.code, 0, second.err);
    assert.deepEqual(second.line, { user: USER, name: "kept", avatar: "kept", avatarStamp: first.line.avatarStamp });
    assert.ok(calls.slice(n).length >= 3 && calls.slice(n).every((c) => c.startsWith("GET ")), `a second run wrote: ${calls.slice(n).join(", ")}`);
    // The site renamed: only the name is written. A new icon: uploaded again.
    const renamed = await job(base, { MX_AVATAR: icon, MX_AVATAR_STAMP: first.line.avatarStamp, MX_DISPLAY_NAME: "Another Name" });
    assert.equal(renamed.line.name, "set"); assert.equal(renamed.line.avatar, "kept"); assert.equal(profile.displayname, "Another Name");
    writeFileSync(icon, Buffer.concat([PNG, Buffer.from("v2")]));
    const reiconed = await job(base, { MX_AVATAR: icon, MX_AVATAR_STAMP: first.line.avatarStamp, MX_DISPLAY_NAME: "Another Name" });
    assert.equal(reiconed.line.avatar, "set"); assert.equal(profile.avatar_url, "mxc://example.test/m2");
    // Someone changed the picture by hand: the stamp no longer matches what the homeserver shows, so it is put back.
    profile.avatar_url = "mxc://example.test/elsewhere";
    const back = await job(base, { MX_AVATAR: icon, MX_AVATAR_STAMP: reiconed.line.avatarStamp, MX_DISPLAY_NAME: "Another Name" });
    assert.equal(back.line.avatar, "set");
    // No icon at all: the picture is left alone.
    const none = await job(base, { MX_DISPLAY_NAME: "Another Name" });
    assert.equal(none.line.avatar, "none"); assert.equal(none.line.avatarStamp, null);
  });
});

test("the profile job refuses a token that is refused, or that answers as another account — writing nothing", async () => {
  await withHomeserver({}, async ({ base, calls, profile }) => {
    const refused = await job(base, {}, "b2".repeat(32));
    assert.equal(refused.code, 1); assert.match(refused.err, /^community: the homeserver refused the token \(401 M_UNKNOWN_TOKEN\)$/m);
    const other = await job(base, { MX_USER_ID: "@someone:example.test" });
    assert.equal(other.code, 1); assert.match(other.err, /the token answers as @blackbranch:example\.test, not @someone:example\.test/);
    const empty = await job(base, {}, "");
    assert.equal(empty.code, 1); assert.match(empty.err, /no token on stdin/);
    // One rule with the registration's (render.sh): 32-128 hex characters, and the message says which part is wrong.
    const short = await job(base, {}, "ab".repeat(8));
    assert.equal(short.code, 1); assert.match(short.err, /the token on stdin must be 32-128 hex characters \(it is 16 characters\)/);
    const nothex = await job(base, {}, "Z".repeat(40));
    assert.match(nothex.err, /\(it is 40 characters, not all hex\)/);
    assert.match(read("matrix/render.sh"), /\^\[0-9a-f\]\{32,128\}\$/, "render.sh holds the same rule");
    assert.ok(calls.every((c) => c.startsWith("GET ")), "nothing was written");
    assert.equal(profile.displayname, null);
  });
  const down = await job("http://127.0.0.1:9");
  assert.equal(down.code, 1); assert.match(down.err, /the homeserver did not answer/);
});

test("the profile job: an icon that cannot be uploaded, or is not a PNG, is reported and never fatal", async () => {
  await withHomeserver({}, async ({ base, profile, state, dir }) => {
    const icon = path.join(dir, "icon-512.png"); writeFileSync(icon, PNG);
    state.uploadStatus = 500;
    const r = await job(base, { MX_AVATAR: icon });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.line, { user: USER, name: "set", avatar: "failed", avatarStamp: null });
    assert.equal(profile.displayname, "Example Stream", "the name is set all the same");
    writeFileSync(icon, "not a png");
    state.uploadStatus = 200;
    assert.equal((await job(base, { MX_AVATAR: icon })).line.avatar, "failed");
    assert.equal((await job(base, { MX_AVATAR: path.join(dir, "missing.png") })).line.avatar, "failed");
    assert.equal(profile.avatar_url, null);
  });
});

// ── on the host: `up`, and token-check ─────────────────────────────────────────────────────────
function upHome(extra = "") {
  const h = fakeHome(extra);
  // Never checked: every test here runs the name check itself, against the stand-in database.
  rmSync(path.join(h.home, "state/community-name"));
  mkdirSync(path.join(h.home, "release")); mkdirSync(path.join(h.home, "bin")); mkdirSync(path.join(h.home, "systemd"));
  symlinkSync(here, path.join(h.home, "release/install"));
  symlinkSync(path.join(root, "config"), path.join(h.home, "release/config"));
  writeFileSync(path.join(h.fake, "mas-users-forum-reader"), "0\n");
  writeFileSync(path.join(h.fake, "mas-token-forum-reader"), "Issued token mct_ReaderTok3n9\n");
  const env = { BB_BIN_DIR: path.join(h.home, "bin"), BB_SYSTEMD_DIR: path.join(h.home, "systemd"), BB_HEALTH_WAIT: "1", FAKE_RUN_STATUS: "0" };
  const go = (extraEnv, ...args) => {
    const before = h.calls().length;
    const r = h.runWith({ ...env, ...extraEnv }, ...args);
    return { ...r, calls: h.calls().slice(before) };
  };
  const token = () => keyOf(h.env(), "COMMUNITY_AS_TOKEN");
  return { ...h, go, token };
}
const JOB = /^compose run --rm --no-deps -T -v (\S+)\/release\/install\/matrix:\/bb-matrix:ro (.*)--entrypoint node stream-api \/bb-matrix\/community-service\.mjs$/m;
const STAMP = `${"c3".repeat(32)} mxc://example.test/abc`;
const answer = (avatar = "set") => `{"user":"${USER}","name":"set","avatar":"${avatar}","avatarStamp":${avatar === "none" ? "null" : `"${STAMP}"`}}\n`;

test("up gives the community service account its name once the homeserver is healthy, before stream-api; the token rides on stdin", () => {
  const h = upHome("SITE_ICON_SET=/site-files\n");
  try {
    mkdirSync(path.join(h.home, "site-files")); writeFileSync(path.join(h.home, "site-files/icon-512.png"), PNG);
    writeFileSync(path.join(h.fake, "community-out"), answer());
    const r = h.go({}, "up");
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const m = r.calls.match(JOB);
    assert.ok(m, `the profile job did not run:\n${r.calls}`);
    assert.equal(m[1], h.home);
    assert.match(m[2], /-e MX_BASE=http:\/\/synapse:8008 /);
    assert.match(m[2], /-e MX_USER_ID=@blackbranch:example\.test /);
    assert.match(m[2], /-e MX_DISPLAY_NAME=Example Stream /);
    assert.match(m[2], new RegExp(`-v ${h.home.replace(/[.]/g, "\\.")}/site-files:/bb-icon:ro -e MX_AVATAR=/bb-icon/icon-512\\.png `));
    const job = r.calls.search(JOB), homeserver = r.calls.search(/^compose up -d mas synapse$/m), apps = r.calls.search(/^compose up -d stream-api stream-ingest$/m);
    assert.ok(homeserver >= 0 && job > homeserver && apps > job, "after the homeserver, before stream-api");
    assert.equal(readFileSync(path.join(h.fake, "community-stdin"), "utf8"), `${h.token()}\n`, "the token arrives on stdin");
    for (const where of [r.stdout, r.stderr, r.calls]) assert.ok(!where.includes(h.token()), "the token was printed or put on a command line");
    assert.match(r.stdout, /community service account: @blackbranch:example\.test ready \(name set, picture set\)/);
    assert.equal(readFileSync(path.join(h.home, "state/community-service"), "utf8"), "made\n");
    assert.equal(readFileSync(path.join(h.home, "state/community-service-avatar"), "utf8"), `${STAMP}\n`);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("restart and retry: the next start hands the last picture back and says nothing new; a failed job never fails the start and is tried again", () => {
  const h = upHome();
  try {
    writeFileSync(path.join(h.fake, "community-out"), answer("none"));
    assert.equal(h.go({}, "up").status, 0);
    // No icon of the install's own and none in the release: no picture is asked for.
    writeFileSync(path.join(h.fake, "community-out"), `{"user":"${USER}","name":"kept","avatar":"none","avatarStamp":null}\n`);
    const again = h.go({}, "up");
    assert.equal(again.status, 0, again.stderr);
    assert.doesNotMatch(again.calls.match(JOB)?.[2] ?? "missing", /MX_AVATAR/);
    assert.doesNotMatch(again.stdout, /community service account:/, "a second start that changed nothing says nothing");
    // A picture set earlier: its stamp goes back to the job.
    writeFileSync(path.join(h.home, "state/community-service-avatar"), `${STAMP}\n`);
    // An icon at web/public/ itself is not the product's (the owner's, never in a release): only public/brand is.
    mkdirSync(path.join(h.home, "release/web/public/brand"), { recursive: true });
    writeFileSync(path.join(h.home, "release/web/public/icon-512.png"), PNG);
    assert.doesNotMatch(h.go({}, "up").calls.match(JOB)[2], /MX_AVATAR/);
    writeFileSync(path.join(h.home, "release/web/public/brand/icon-512.png"), PNG);
    writeFileSync(path.join(h.fake, "community-out"), answer("kept").replace('"name":"set"', '"name":"kept"'));
    const third = h.go({}, "up");
    assert.match(third.calls.match(JOB)[2], new RegExp(`-v ${h.home.replace(/[.]/g, "\\.")}/release/web/public/brand:/bb-icon:ro -e MX_AVATAR=/bb-icon/icon-512\\.png -e MX_AVATAR_STAMP=${STAMP.replace(/[.]/g, "\\.")} `));
    // The job fails (Synapse not taking the token yet): said, with the command; the start finishes.
    writeFileSync(path.join(h.fake, "community-out"), "community: the homeserver refused the token (401 M_UNKNOWN_TOKEN)\n");
    const failed = h.go({ FAKE_COMMUNITY_STATUS: "1" }, "up");
    assert.equal(failed.status, 0, failed.stderr);
    assert.match(failed.stderr, /community service account: the homeserver refused the token \(401 M_UNKNOWN_TOKEN\)\. Run: sudo blackbranch community token-check/);
    assert.match(failed.stdout, /all services healthy/);
    writeFileSync(path.join(h.fake, "community-out"), answer("kept"));
    const retry = h.go({}, "up");
    assert.equal(retry.status, 0); assert.match(retry.calls, JOB, "the next start tries again");
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

// An upgraded install may already have a PERSON named like the service account (made through MAS
// before this release). An exclusive namespace over their id would let the token act as them, so
// the registration is rendered only while the name is nobody's.
const REGFILE = "rendered/synapse/appservice-community.yaml";
const hsYaml = (h) => readFileSync(path.join(h.home, "rendered/synapse/homeserver.yaml"), "utf8");

test("the service account's name is free: up renders the registration and lists it", () => {
  const h = upHome();
  try {
    writeFileSync(path.join(h.fake, "community-out"), answer("none"));
    const r = h.go({}, "up");
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.ok(existsSync(path.join(h.home, REGFILE)));
    assert.match(hsYaml(h), /\napp_service_config_files:\n {2}- "\/config\/appservice-community\.yaml"\n/);
    assert.match(r.calls, /^compose exec -T postgres psql -U postgres -d mas -qAt -v ON_ERROR_STOP=1 -v u=blackbranch$/m, "MAS's accounts were asked for the name");
    assert.match(r.calls, /^compose exec -T postgres psql -U postgres -d synapse -qAt -v ON_ERROR_STOP=1 -v n=@blackbranch:example\.test$/m, "Synapse's users were asked for the id");
    const asked = r.calls.search(/-v u=blackbranch$/m), rendered = r.calls.search(/^compose up -d mas synapse$/m);
    assert.ok(asked >= 0 && rendered > asked, "asked before the homeserver starts on the new config");
    assert.equal(readFileSync(path.join(h.home, "state/community-name"), "utf8"), "free blackbranch\n", "the answer is recorded");
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("the service account's name is a person's (MAS, or a Synapse user that is not the app service): nothing is registered, the doctor and token-check say so", () => {
  for (const [who, setup] of [
    ["a MAS account", (h) => writeFileSync(path.join(h.fake, "mas-users-blackbranch"), "1\n")],
    ["a Synapse user", (h) => writeFileSync(path.join(h.fake, "synapse-person"), "1\n")],
  ]) {
    const h = upHome();
    try {
      // First a box where the name was free and the registration was written…
      writeFileSync(path.join(h.fake, "community-out"), answer("none"));
      assert.equal(h.go({}, "up").status, 0);
      assert.ok(existsSync(path.join(h.home, REGFILE)));
      // …then the name turns out to be someone's: the next start takes the registration away.
      setup(h);
      const r = h.go({}, "up");
      assert.equal(r.status, 0, `${who}: ${r.stdout}\n${r.stderr}`);
      assert.ok(!existsSync(path.join(h.home, REGFILE)), `${who}: the registration is still on disk`);
      assert.doesNotMatch(hsYaml(h), /app_service_config_files|user_id:/, `${who}: homeserver.yaml still lists it`);
      const mas = readFileSync(path.join(h.home, "rendered/mas/config.yaml"), "utf8");
      assert.doesNotMatch(mas, /literals:|- "blackbranch"/, `${who}: MAS still bans the person's own name`);
      assert.match(mas, /\n {6}banned_usernames:\n {8}prefixes:\n {10}- "_ooye_"\nsecrets:\n/, `${who}: only the Discord bridge's names stay banned`);
      assert.doesNotMatch(r.calls, JOB, `${who}: the profile job ran for a person's account`);
      assert.match(r.stderr, /Someone already uses the name @blackbranch on this server/);
      assert.equal(readFileSync(path.join(h.home, "state/community-name"), "utf8"), "taken blackbranch\n");
      // A render from the site (or by hand) keeps it out too.
      assert.equal(h.go({}, "render").status, 0);
      assert.ok(!existsSync(path.join(h.home, REGFILE)));
      const tc = h.go({}, "community", "token-check");
      assert.equal(tc.status, 1); assert.match(tc.stdout, /name: someone already uses @blackbranch on this server/);
      // Another name in .env: free again, registered at the next start. (The stand-in answers for
      // any name: the person keeps theirs, so the new one is nobody's.)
      rmSync(path.join(h.fake, "synapse-person"), { force: true });
      writeFileSync(path.join(h.home, ".env"), h.env().replace(/^COMMUNITY_LOCALPART=.*$/m, "COMMUNITY_LOCALPART=community-keeper"));
      assert.equal(h.go({}, "up").status, 0);
      assert.match(readFileSync(path.join(h.home, REGFILE), "utf8"), /sender_localpart: "community-keeper"/);
      assert.equal(readFileSync(path.join(h.home, "state/community-name"), "utf8"), "free community-keeper\n");
    } finally { rmSync(h.home, { recursive: true, force: true }); }
  }
});

test("a database that cannot answer never reads as \"free\": a name recorded as taken stays taken, and one never answered for is not registered", () => {
  // A box where a person's name was found taken earlier…
  const h = upHome();
  try {
    writeFileSync(path.join(h.fake, "mas-users-blackbranch"), "1\n");
    writeFileSync(path.join(h.fake, "community-out"), answer("none"));
    assert.equal(h.go({}, "up").status, 0);
    assert.equal(readFileSync(path.join(h.home, "state/community-name"), "utf8"), "taken blackbranch\n");
    // …then the probes fail (no answer, status 2) — and the count, too, would now read "free".
    rmSync(path.join(h.fake, "mas-users-blackbranch"));
    writeFileSync(path.join(h.fake, "psql-broken"), "");
    for (const n of [1, 2]) {
      const r = h.go({}, "up");
      assert.equal(r.status, 0, `start ${n}: ${r.stderr}`);
      assert.ok(!existsSync(path.join(h.home, REGFILE)), `start ${n}: the registration was rendered over the person's name`);
      assert.doesNotMatch(hsYaml(h), /app_service_config_files/);
      assert.equal(readFileSync(path.join(h.home, "state/community-name"), "utf8"), "taken blackbranch\n", `start ${n}: the record changed`);
      assert.match(r.stderr, /Someone already uses the name @blackbranch on this server/);
    }
    // A probe that answers something other than t or f is no answer either.
    rmSync(path.join(h.fake, "psql-broken"));
    writeFileSync(path.join(h.fake, "regclass"), "maybe\n");
    assert.equal(h.go({}, "up").status, 0);
    assert.ok(!existsSync(path.join(h.home, REGFILE)));
    assert.equal(readFileSync(path.join(h.home, "state/community-name"), "utf8"), "taken blackbranch\n");
  } finally { rmSync(h.home, { recursive: true, force: true }); }
  // A box never answered for (the first start of this release) whose database runs but cannot answer.
  const g = upHome();
  try {
    writeFileSync(path.join(g.fake, "psql-broken"), "");
    writeFileSync(path.join(g.fake, "community-out"), answer("none"));
    const r = g.go({}, "up");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(path.join(g.home, REGFILE)), "registered without an answer");
    assert.doesNotMatch(r.calls, JOB);
    assert.match(r.stderr, /could not check whether the name @blackbranch is free, so nothing is registered for it\. Run sudo blackbranch up again once the database answers/);
    assert.ok(!existsSync(path.join(g.home, "state/community-name")), "nothing recorded without an answer");
    const tc = g.go({}, "community", "token-check");
    assert.equal(tc.status, 1); assert.match(tc.stdout, /name: could not check whether the name @blackbranch is free/);
    // The database answers again: free, registered at that start.
    rmSync(path.join(g.fake, "psql-broken"));
    assert.equal(g.go({}, "up").status, 0);
    assert.ok(existsSync(path.join(g.home, REGFILE)));
    assert.equal(readFileSync(path.join(g.home, "state/community-name"), "utf8"), "free blackbranch\n");
  } finally { rmSync(g.home, { recursive: true, force: true }); }
});

test("never checked and the database is down: nothing is registered, and the start says to run up again once it answers", () => {
  const h = upHome();
  try {
    const r = h.go({ FAKE_STATE: "exited" }, "render");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(path.join(h.home, REGFILE)), "registered without ever checking the name");
    assert.doesNotMatch(hsYaml(h), /app_service_config_files|user_id:/);
    assert.match(r.stderr, /could not check whether the name @blackbranch is free, so nothing is registered for it\. Run sudo blackbranch up again once the database answers/);
    assert.ok(!existsSync(path.join(h.home, "state/community-name")), "nothing recorded without an answer");
    // The doctor says the same (read only: no record written).
    writeFileSync(path.join(h.fake, "none.json"), "{}\n");
    const d = h.go({ FAKE_STATE: "exited", BB_DOCTOR_NODE: process.execPath, BB_DOCTOR_SITE_FACTS: path.join(h.fake, "none.json") }, "doctor");
    assert.match(d.stdout, /\[FAIL\] The community service account answers — Could not check whether the name @blackbranch is free, so nothing is registered for it/);
    assert.match(d.stdout, /fix: Run sudo blackbranch up again once the database answers\./);
    // The next render with the database running checks it: free, registered.
    assert.equal(h.go({}, "render").status, 0);
    assert.ok(existsSync(path.join(h.home, REGFILE)));
    assert.equal(readFileSync(path.join(h.home, "state/community-name"), "utf8"), "free blackbranch\n");
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("the first form of the record (state/community-name-taken) is read as taken and rewritten in the new form", () => {
  const h = upHome();
  try {
    writeFileSync(path.join(h.home, "state/community-name-taken"), "blackbranch\n");
    const r = h.go({ FAKE_STATE: "exited" }, "render");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(path.join(h.home, REGFILE)), "the old record's taken name was registered");
    assert.match(r.stderr, /Someone already uses the name @blackbranch on this server/);
    assert.equal(readFileSync(path.join(h.home, "state/community-name"), "utf8"), "taken blackbranch\n");
    assert.ok(!existsSync(path.join(h.home, "state/community-name-taken")), "the old form was not removed");
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("blackbranch community token-check: the registration as rendered, and the token answering as the account", () => {
  const h = upHome();
  try {
    assert.equal(h.go({}, "render").status, 0);
    writeFileSync(path.join(h.fake, "community-whoami"), `{"user_id":"${USER}","is_guest":false}`);
    const ok = h.go({}, "community", "token-check");
    assert.equal(ok.status, 0, `${ok.stdout}\n${ok.stderr}`);
    assert.match(ok.stdout, /registration: as rendered/);
    assert.match(ok.stdout, /token: answers as @blackbranch:example\.test/);
    assert.match(readFileSync(path.join(h.fake, "community-whoami-stdin"), "utf8"), new RegExp(`^Authorization: Bearer ${h.token()}$`, "m"));
    assert.ok(!ok.calls.includes(h.token()) && !ok.stdout.includes(h.token()));
    writeFileSync(path.join(h.fake, "community-whoami"), '{"user_id":"@someone:example.test"}');
    const wrong = h.go({}, "community", "token-check");
    assert.equal(wrong.status, 1); assert.match(wrong.stdout, /token: answers as another account/);
    writeFileSync(path.join(h.fake, "community-whoami"), '{"errcode":"M_UNKNOWN_TOKEN"}');
    const refused = h.go({}, "community", "token-check");
    assert.equal(refused.status, 1); assert.match(refused.stdout, /token: refused by the homeserver/);
    rmSync(path.join(h.home, "rendered/synapse/appservice-community.yaml"));
    const missing = h.go({}, "community", "token-check");
    assert.equal(missing.status, 1); assert.match(missing.stdout, /registration: missing\. Run sudo blackbranch render/);
    assert.ok(existsSync(path.join(h.home, ".env")));
    // Vacuity anchor: the end of the command's own verb list.
    assert.match(read("blackbranch"), /\n {4}token-check\) need_root community; need_install; community_token_check ;;\n/);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});
