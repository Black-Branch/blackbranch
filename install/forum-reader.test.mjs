// The forum reader: the Forums tab reads the forum rooms as a service account (web
// app/lib/forumReader.ts, MATRIX_READER_TOKEN). Run: node --test install/
//
// The defect these hold off: the installer never made that account or passed its token, so on a
// fresh install the Forums tab said forums were unavailable. Now `up` makes the account (once,
// before the site starts), keeps its sign-in in .env (mode 600, never printed, never on a command
// line), replaces a sign-in MAS no longer knows (a restore), and the account joins #forum when the
// rooms are made and at every start that finds it missing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, rmSync, statSync, symlinkSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeHome } from "./scratch-home.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const read = (rel) => readFileSync(path.join(here, rel), "utf8");
const TOKEN = "mct_ReaderTok3n9";

function readerHome() {
  const h = fakeHome();
  mkdirSync(path.join(h.home, "release")); mkdirSync(path.join(h.home, "bin")); mkdirSync(path.join(h.home, "systemd"));
  symlinkSync(here, path.join(h.home, "release/install"));
  symlinkSync(path.join(root, "config"), path.join(h.home, "release/config"));
  writeFileSync(path.join(h.fake, "mas-users-forum-reader"), "0\n");
  writeFileSync(path.join(h.fake, "mas-token-forum-reader"), `Issued token ${TOKEN}\n`);
  const env = { BB_BIN_DIR: path.join(h.home, "bin"), BB_SYSTEMD_DIR: path.join(h.home, "systemd"), BB_HEALTH_WAIT: "1", FAKE_RUN_STATUS: "0" };
  const go = (extra, ...args) => {
    const before = h.calls().length;
    const r = h.runWith({ ...env, ...extra }, ...args);
    return { ...r, calls: h.calls().slice(before) };
  };
  const token = () => h.env().match(/^MATRIX_READER_TOKEN=(.*)$/m)?.[1]?.replace(/^"(.*)"$/, "$1") ?? null;
  return { ...h, go, token };
}
const ISSUE = /mas-cli manage issue-compatibility-token forum-reader /;

test("compose hands the site the reader's sign-in; .env, install.sh and migration 004 hold the key, empty", () => {
  const compose = read("compose.yaml");
  const web = compose.slice(compose.indexOf("\n  web:\n"), compose.indexOf("\n  caddy:\n"));
  assert.match(web, /\n {6}MATRIX_READER_TOKEN: \$\{MATRIX_READER_TOKEN:-\}\n/);
  assert.equal((compose.match(/^ +MATRIX_READER_TOKEN:/gm) ?? []).length, 1, "only the site gets it");
  assert.match(read(".env.example"), /^MATRIX_READER_TOKEN=$/m);
  assert.match(read("install.sh"), /^MATRIX_READER_TOKEN=$/m);
  assert.match(read("migrations/004-forum-reader.sh"), /envm_add MATRIX_READER_TOKEN ""\n$/);
  assert.match(read(".env.example"), /^BB_ENV_VERSION=4$/m);
});

test("up makes the reader before the site starts: one account, its sign-in in .env (600), never printed or on a command line", () => {
  const h = readerHome();
  try {
    const r = h.go({}, "up");
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(h.token(), TOKEN);
    assert.equal(statSync(path.join(h.home, ".env")).mode & 0o777, 0o600);
    assert.match(r.calls, /^compose exec -T mas mas-cli manage register-user --yes --no-admin forum-reader$/m, "the account was made");
    const issued = r.calls.search(ISSUE), site = r.calls.search(/^compose up -d$/m);
    assert.ok(issued >= 0 && site > issued, "the sign-in is in .env before the site starts");
    for (const where of [r.stdout, r.stderr, r.calls]) assert.ok(!where.includes(TOKEN), "the token was printed or put on a command line");
    assert.match(r.stdout, /forum reader: @forum-reader:example\.test made; its sign-in is in \.env/);
    assert.ok(existsSync(path.join(h.home, "state/forum-reader")), "this server's own account, recorded");
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("restart and re-run: a second start (the installer's re-run is one) keeps the sign-in that still works and makes nothing", () => {
  const h = readerHome();
  try {
    assert.equal(h.go({}, "up").status, 0);
    writeFileSync(path.join(h.fake, "mas-users-forum-reader"), "1\n");
    for (const n of [1, 2]) {
      const r = h.go({}, "up");
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.calls, ISSUE, `start ${n} issued a new sign-in`);
      assert.doesNotMatch(r.calls, /register-user/);
      assert.equal(h.token(), TOKEN);
    }
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("retry: a sign-in MAS no longer knows (a restore of an older snapshot) is replaced at the next start", () => {
  const h = readerHome();
  try {
    assert.equal(h.go({}, "up").status, 0);
    writeFileSync(path.join(h.fake, "mas-users-forum-reader"), "1\n");
    writeFileSync(path.join(h.fake, "reader-invalid"), "");
    writeFileSync(path.join(h.fake, "mas-token-forum-reader"), "Issued token mct_Second0ne\n");
    const r = h.go({}, "up");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.calls, ISSUE); assert.doesNotMatch(r.calls, /register-user/, "the account is kept");
    assert.equal(h.token(), "mct_Second0ne"); assert.match(r.stdout, /forum reader: @forum-reader:example\.test signed in again; its sign-in is in \.env/);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("an account named forum-reader this server did not make is never signed in as; the start still finishes", () => {
  const h = readerHome();
  try {
    writeFileSync(path.join(h.fake, "mas-users-forum-reader"), "1\n");
    const r = h.go({}, "up");
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.calls, ISSUE);
    assert.match(r.stderr, /an account named forum-reader exists and this server did not make it/);
    assert.equal(h.token(), "");
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("the reader joins #forum with the bootstrap and when a start finds it outside; its sign-in rides on stdin", () => {
  const h = readerHome();
  try {
    assert.equal(h.go({}, "up").status, 0);
    writeFileSync(path.join(h.fake, "cfg/streamer.matrixId"), "@casey:example.test\n");
    writeFileSync(path.join(h.fake, "mas-users-casey"), "1\n");
    writeFileSync(path.join(h.fake, "mas-token"), "Issued token mct_owner\n");
    writeFileSync(path.join(h.fake, "run-out"), '{"hub":"!h1:example.test","general":"!g1:example.test","forum":"!f1:example.test","created":[]}\n');
    const r = h.go({}, "matrix", "bootstrap");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.calls, /^compose exec -T synapse curl -fsS -o \/dev\/null -X POST -H @- -H Content-Type: application\/json -d \{\} http:\/\/localhost:8008\/_matrix\/client\/v3\/join\/%23forum%3Aexample\.test$/m);
    assert.match(readFileSync(path.join(h.fake, "join-stdin"), "utf8"), new RegExp(`^Authorization: Bearer ${TOKEN}$`, "m"));
    assert.ok(!r.calls.includes(TOKEN) && !r.stdout.includes(TOKEN));
    assert.match(r.stdout, /forum reader: in #forum/);
    // The rooms check counts the reader's membership: a start that finds it outside runs the bootstrap again.
    const bb = read("blackbranch");
    assert.match(bb, /type = 'm\.room\.member' AND state_key = :'reader' AND membership = 'join' AND room_id = \(SELECT room_id FROM f\)\) = 1/);
    assert.match(bb, /-v reader="@\$READER_LOCALPART:\$\(env_get BB_DOMAIN\)"/);
    // A join that fails is said; the bootstrap's own answer stands.
    const f = h.go({ FAKE_JOIN_STATUS: "22" }, "matrix", "bootstrap");
    assert.equal(f.status, 0, f.stderr);
    assert.match(f.stderr, /forum reader: could not join #forum; the Forums tab stays empty until it does\. The next start tries again/);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});
