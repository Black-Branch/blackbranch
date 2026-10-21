// The update channel. Run: node --test install/
//
// What they hold: the feed verifies only with the box's own key and only over the exact signed
// bytes; the manifest's schema is strict; versions order as semver; a downgrade, a Postgres major
// change, an expired feed and another channel's feed are each refused; every third-party image is
// pinned by digest; the release tool cuts a reproducible, pinned, owner-free source tarball and a
// feed that verifies; and `blackbranch update` itself, run against a real HTTP feed with stub
// releases (their `blackbranch` logs what the updater asks of it) and a stand-in docker: the order
// of an update, the rollback when the next release's health check fails (the release, .env and the
// data's snapshot put back), the refusals that change nothing, the security release that waits
// while the stream is live, and the Admin Panel's request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  appendFileSync, closeSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync,
  writeFileSync, writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions, decide, manifestProblems, openFeed, pinProblems, pinWebImage, publicKeyString, signFeed, IMAGE_NAMES } from "./update/release.mjs";
import { DOCTOR } from "../config/doctor.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const read = (rel) => readFileSync(path.join(here, rel), "utf8");
const D = (c) => `sha256:${c.repeat(64).slice(0, 64)}`;

const keyPair = () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" });
  return { pem, pub: publicKeyString(pem) };
};
const KEY = keyPair();
const OTHER = keyPair();

const IMAGES = {
  postgres: `pgvector/pgvector:pg18@${D("1")}`, synapse: `ghcr.io/element-hq/synapse:v1.162.0@${D("2")}`,
  mas: `ghcr.io/element-hq/matrix-authentication-service:1.26.0@${D("3")}`, caddy: `caddy:2.10.2-alpine@${D("4")}`,
  cloudflared: `cloudflare/cloudflared:2025.9.1@${D("5")}`, "mautrix-discord": `dock.mau.dev/mautrix/discord:v0.7.7@${D("6")}`,
  restic: `restic/restic:0.19.1@${D("7")}`, node: `node:26.11.1-trixie-slim@${D("8")}`, dockerfile: `docker/dockerfile:1@${D("9")}`,
  // The site's prebuilt image: a test registry's repository, tagged with the release.
  web: `localhost/blackbranch/web:1.2.0@${D("a")}`,
};
const WEB_REPO = "localhost/blackbranch/web";
const manifest = (over = {}) => ({
  schema: 1, product: "blackbranch", version: "1.2.0", channel: "stable",
  published: "2026-10-01T00:00:00Z", expires: "2099-01-01T00:00:00Z", security: false, notes: "Fixes.",
  postgresMajor: 18, source: { url: "blackbranch-1.2.0.tar.gz", sha256: "a".repeat(64), size: 1000 }, images: { ...IMAGES }, ...over,
});

// ── the feed and the manifest ────────────────────────────────────────────────────────────────
test("the feed opens only with the box's key, over the exact bytes that were signed", () => {
  const feed = signFeed(manifest(), KEY.pem);
  const ok = openFeed(JSON.stringify(feed), KEY.pub);
  assert.equal(ok.ok, true); assert.equal(ok.manifest.version, "1.2.0");
  assert.equal(openFeed(JSON.stringify(feed), OTHER.pub).reason, "the feed is signed by a key this box does not trust");
  // One byte of the payload changed (the version), the signature kept.
  const body = Buffer.from(feed.payload, "base64").toString("utf8").replace('"1.2.0"', '"9.9.9"');
  const tampered = { ...feed, payload: Buffer.from(body).toString("base64") };
  assert.equal(openFeed(JSON.stringify(tampered), KEY.pub).reason, "the feed's signature does not verify");
  // A signature over the same bytes with another payload type (the PAE binds it).
  assert.equal(openFeed(JSON.stringify({ ...feed, payloadType: "application/json" }), KEY.pub).reason, "the feed is not a release feed");
  // Signed by another key, relabelled with this box's key id.
  const forged = signFeed(manifest(), OTHER.pem);
  forged.signatures[0].keyid = feed.signatures[0].keyid;
  assert.equal(openFeed(JSON.stringify(forged), KEY.pub).reason, "the feed's signature does not verify");
  assert.equal(openFeed("x".repeat(300_000), KEY.pub).reason, "the feed is not a release feed");
  assert.equal(openFeed(JSON.stringify(feed), "ed25519:short").reason, "this box has no usable release key (BB_RELEASE_KEY)");
  // A well-signed manifest that breaks the schema is still refused.
  assert.match(openFeed(JSON.stringify(signFeed(manifest({ version: "latest" }), KEY.pem)), KEY.pub).reason, /malformed \(version\)/);
  // A field (or an image) this box does not know is ignored: a later release can add one without
  // stranding older boxes; a change they must not miss bumps `schema`, which they refuse.
  assert.equal(openFeed(JSON.stringify(signFeed(manifest({ minimumFrom: "1.0.0", images: { ...IMAGES, valkey: `valkey/valkey:8@${D("a")}` } }), KEY.pem)), KEY.pub).ok, true);
  // A pilot's private registry with a port: the site's image from it is accepted.
  assert.equal(openFeed(JSON.stringify(signFeed(manifest({ images: { ...IMAGES, web: `localhost:5000/blackbranch/web:1.2.0@${D("a")}` } }), KEY.pem)), KEY.pub).ok, true);
  assert.match(openFeed(JSON.stringify(signFeed(manifest({ schema: 2 }), KEY.pem)), KEY.pub).reason, /malformed \(schema\)/);
});

test("the manifest's schema is strict: every field, and every image pinned by digest", () => {
  assert.deepEqual(manifestProblems(manifest()), []);
  const bad = [
    [{ schema: 2 }, "schema"], [{ product: "other" }, "product"], [{ version: "1.2" }, "version"], [{ version: "01.2.3" }, "version"],
    [{ version: "1.2.3+build" }, "version"], [{ channel: "nightly" }, "channel"], [{ published: "yesterday" }, "published"],
    [{ expires: "2026-09-01T00:00:00Z" }, "expires"], [{ security: "yes" }, "security"], [{ notes: "n".repeat(2001) }, "notes"],
    [{ postgresMajor: 18.5 }, "postgresMajor"], [{ source: { url: "../x.tar.gz", sha256: "a".repeat(64), size: 1 } }, "source.url"],
    [{ source: { url: "x.tar.gz", sha256: "A".repeat(64), size: 1 } }, "source.sha256"], [{ source: { url: "x.tar.gz", sha256: "a".repeat(64), size: 0 } }, "source.size"],
    [{ images: { ...IMAGES, synapse: "ghcr.io/element-hq/synapse:v1.162.0" } }, "images.synapse"],
    [{ images: Object.fromEntries(Object.entries(IMAGES).filter(([k]) => k !== "dockerfile")) }, "images: no dockerfile"],
    [{ images: { ...IMAGES, extra: "caddy:2" } }, "images.extra"],
    [{ images: { ...IMAGES, web: `localhost:99999x/blackbranch/web@${D("a")}` } }, "images.web"],
    [{ postgresMajor: 19 }, "images.postgres: not the release's Postgres major"],
    [{ ownerPlaybook: "main" }, "ownerPlaybook"],
  ];
  for (const [over, problem] of bad) assert.ok(manifestProblems(manifest(over)).includes(problem), `${JSON.stringify(over)} → ${problem}`);
  assert.deepEqual(IMAGE_NAMES.slice().sort(), Object.keys(IMAGES).sort());
});

test("versions order as semver, and the box refuses a downgrade, a Postgres major change, an expired or another channel's feed", () => {
  const order = ["0.0.1", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.1.0", "2.0.0"];
  for (let i = 0; i < order.length; i++) for (let j = 0; j < order.length; j++) {
    assert.equal(compareVersions(order[i], order[j]), Math.sign(i - j), `${order[i]} vs ${order[j]}`);
  }
  assert.equal(compareVersions("not-a-version", "0.0.1"), -1, "a box with no version (a checkout) takes any release");
  const at = { channel: "stable", postgresMajor: 18, now: new Date("2026-10-11T00:00:00Z") };
  assert.equal(decide(manifest(), { ...at, current: "1.1.9" }).decision, "newer");
  assert.equal(decide(manifest(), { ...at, current: "1.2.0" }).decision, "same");
  assert.equal(decide(manifest(), { ...at, current: "1.3.0" }).decision, "older", "a downgrade is never applied");
  assert.equal(decide(manifest(), { ...at, current: "1.2.0-beta.1" }).decision, "newer");
  const pg = decide(manifest({ postgresMajor: 19, images: { ...IMAGES, postgres: `pgvector/pgvector:pg19@${D("1")}` } }), { ...at, current: "1.1.0" });
  assert.equal(pg.decision, "refused"); assert.match(pg.refuse, /Postgres 19 and this box runs Postgres 18: a Postgres major upgrade is never part of a normal update/);
  const exp = decide(manifest({ expires: "2026-10-05T00:00:00Z" }), { ...at, current: "1.1.0" });
  assert.equal(exp.unread, true); assert.match(exp.refuse, /expired/);
  const beta = decide(manifest({ channel: "beta" }), { ...at, current: "1.1.0" });
  assert.equal(beta.unread, true); assert.match(beta.refuse, /the feed for stable carries a beta release/);
});

test("pins: every third-party image in the Compose file and the Dockerfile is the manifest's, by digest", () => {
  const pinnedCompose = (c) => c.replace(/^(\s+image:\s*)(\S+)$/gm, (m, a, ref) => {
    const hit = Object.values(IMAGES).find((r) => r.startsWith(`${ref}@`)); return hit ? `${a}${hit}` : m;
  });
  const pinnedDocker = (d) => d.replace(/^(FROM\s+|# syntax=)(\S+)/gm, (m, a, ref) => { const hit = Object.values(IMAGES).find((r) => r.startsWith(`${ref}@`)); return hit ? `${a}${hit}` : m; })
    .replace(/^ARG NODE_IMAGE=(\S+)$/m, (m, ref) => `ARG NODE_IMAGE=${Object.values(IMAGES).find((r) => r.startsWith(`${ref}@`)) ?? ref}`);
  const compose = pinWebImage(pinnedCompose(read("compose.yaml")), IMAGES.web), docker = pinnedDocker(read("Dockerfile"));
  assert.ok(compose, "the repo's web service has the shape the release pins");
  assert.doesNotMatch(compose.split("\n  web:\n")[1].split(/\n {2}[a-z]/)[0], /\n {4}build:/, "a release's site is pulled, never built on the box");
  assert.deepEqual(pinProblems(compose, docker, IMAGES), [], "the repo's own files, pinned, are consistent (stage names are not images)");
  assert.match(pinProblems(read("compose.yaml"), docker, IMAGES).join("\n"), /ghcr\.io\/element-hq\/synapse:v1\.162\.0 is not pinned by digest/, "the repo itself pins tags only");
  assert.match(pinProblems(compose, docker, { ...IMAGES, caddy: `caddy:2.10.2-alpine@${D("b")}` }).join("\n"), /is not in the manifest/);
  assert.match(pinProblems(compose, docker.replace(/^# syntax=.*$/m, "# syntax=docker/dockerfile:1"), IMAGES).join("\n"), /docker\/dockerfile:1 is not pinned by digest/, "the build's frontend is pinned too");
  assert.match(pinProblems(pinnedCompose(read("compose.yaml")), docker, IMAGES).join("\n"), /localhost\/blackbranch\/web:1\.2\.0@\S+ \(manifest\) is used by neither file/, "the site's image must be the one compose names");
});

// ── the release tool ─────────────────────────────────────────────────────────────────────────
// A small tree in the shape release-copy.sh takes; `stub` replaces install/blackbranch. Its trust
// root (install/release-key.pub) is the test key's, `trust` another — never the project's own.
function miniTree(dir, { stub = null, envExample = null, migrations = {}, trust = KEY.pub } = {}) {
  mkdirSync(dir, { recursive: true });
  cpSync(path.join(root, "install"), path.join(dir, "install"), { recursive: true });
  writeFileSync(path.join(dir, "install/release-key.pub"), `${trust}\n`);
  cpSync(path.join(root, "config"), path.join(dir, "config"), { recursive: true });
  mkdirSync(path.join(dir, "migrations/baseline"), { recursive: true });
  writeFileSync(path.join(dir, "migrations/baseline/schema.sql"), "-- baseline: the schema up to v144\n");
  writeFileSync(path.join(dir, "migrations/baseline/seed.sql"), "\n");
  mkdirSync(path.join(dir, "stream-api/owner"), { recursive: true });
  writeFileSync(path.join(dir, "stream-api/index.js"), "// app\n");
  writeFileSync(path.join(dir, "stream-api/owner/secret.js"), "// owner-only\n");
  writeFileSync(path.join(dir, "install/.env.local"), "NOT_SHIPPED=1\n");
  if (stub !== null) writeFileSync(path.join(dir, "install/blackbranch"), stub, { mode: 0o755 });
  if (envExample !== null) writeFileSync(path.join(dir, "install/.env.example"), envExample);
  for (const [name, body] of Object.entries(migrations)) writeFileSync(path.join(dir, "install/migrations", name), body, { mode: 0o755 });
  return dir;
}
// The site's image is tagged with each release's version: the table names it for the one cut.
// An option in `extra` comes first, so it wins over the defaults below (e.g. "--channel", "beta").
const digestTable = (version) => ({ ...Object.fromEntries(Object.values(IMAGES).map((r) => r.split("@")).map(([ref, d]) => [ref, d])), [`${WEB_REPO}:${version}`]: D("a") });
function cut(tree, out, version, extra = []) {
  const work = mkdtempSync(path.join(tmpdir(), "bb-cut-"));
  const keyFile = path.join(work, "k.pem"), digests = path.join(work, "d.json");
  writeFileSync(keyFile, KEY.pem, { mode: 0o600 }); writeFileSync(digests, JSON.stringify(digestTable(version)));
  try {
    return execFileSync(process.execPath, [path.join(root, "tools/release.mjs"), "cut", ...extra, "--version", version, "--channel", "stable", "--key", keyFile,
      "--out", out, "--tree", tree, "--digests", digests, "--web-image", WEB_REPO, "--notes", `Release ${version}.`], { encoding: "utf8" });
  } finally { rmSync(work, { recursive: true, force: true }); }
}

test("the release tool cuts a reproducible tarball in the public cut's shape, pinned, with a feed that verifies", () => {
  const work = mkdtempSync(path.join(tmpdir(), "bb-tool-"));
  try {
    const tree = miniTree(path.join(work, "tree"));
    const out1 = path.join(work, "o1"), out2 = path.join(work, "o2");
    cut(tree, out1, "1.2.0"); cut(tree, out2, "1.2.0");
    const tar = (o) => readFileSync(path.join(o, "blackbranch-1.2.0.tar.gz"));
    assert.equal(createHash("sha256").update(tar(out1)).digest("hex"), createHash("sha256").update(tar(out2)).digest("hex"), "reproducible");
    const opened = openFeed(read(path.relative(here, path.join(out1, "stable.json"))), KEY.pub);
    assert.equal(opened.ok, true, opened.reason);
    assert.equal(opened.manifest.source.sha256, createHash("sha256").update(tar(out1)).digest("hex"));
    assert.equal(opened.manifest.source.size, tar(out1).length);
    assert.deepEqual(opened.manifest.images, IMAGES);
    const names = execFileSync("tar", ["-tzf", path.join(out1, "blackbranch-1.2.0.tar.gz")], { encoding: "utf8" }).split("\n").filter(Boolean);
    assert.ok(names.every((n) => n.startsWith("blackbranch-1.2.0/")), "one top folder");
    assert.ok(names.includes("blackbranch-1.2.0/RELEASE") && names.includes("blackbranch-1.2.0/install/update/release.mjs"));
    assert.ok(!names.some((n) => /\/owner\//.test(n)), "no owner folder");
    assert.ok(!names.some((n) => /\.env(\.|$)/.test(n.split("/").pop()) && !n.endsWith(".env.example")), "no .env file but the example");
    const x = path.join(work, "x"); mkdirSync(x);
    execFileSync("tar", ["-xzf", path.join(out1, "blackbranch-1.2.0.tar.gz"), "-C", x, "--strip-components=1"]);
    assert.equal(readFileSync(path.join(x, "RELEASE"), "utf8"), "1.2.0\n");
    assert.deepEqual(pinProblems(readFileSync(path.join(x, "install/compose.yaml"), "utf8"), readFileSync(path.join(x, "install/Dockerfile"), "utf8"), IMAGES), []);
    // A digest the registry (here: the table) does not give is a refusal, not an unpinned release.
    const bad = spawnSync(process.execPath, [path.join(root, "tools/release.mjs"), "cut", "--version", "1.2.1", "--channel", "stable", "--key", "/nonexistent", "--out", out1, "--tree", tree], { encoding: "utf8" });
    assert.notEqual(bad.status, 0);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("the release tool signs only with the key the release itself trusts (install/release-key.pub), and refuses before publishing otherwise", () => {
  const work = mkdtempSync(path.join(tmpdir(), "bb-trust-"));
  try {
    // The staged trust root is OTHER's; the cut is signed with KEY: refused, nothing written.
    const wrong = miniTree(path.join(work, "wrong"), { trust: OTHER.pub });
    const out = path.join(work, "out");
    assert.throws(() => cut(wrong, out, "1.2.0"), (e) => /the signing key is not the one this release trusts/.test(String(e.stderr)));
    assert.ok(!existsSync(out) || readdirSync(out).length === 0, `nothing published: ${existsSync(out) ? readdirSync(out) : ""}`);
    // The positive case: the feed verifies with the key inside the tarball it names.
    cut(miniTree(path.join(work, "right")), out, "1.2.0");
    const x = path.join(work, "x"); mkdirSync(x);
    execFileSync("tar", ["-xzf", path.join(out, "blackbranch-1.2.0.tar.gz"), "-C", x, "--strip-components=1"]);
    const trusted = readFileSync(path.join(x, "install/release-key.pub"), "utf8").trim();
    assert.equal(trusted, KEY.pub);
    const opened = openFeed(readFileSync(path.join(out, "stable.json"), "utf8"), trusted);
    assert.equal(opened.ok, true, opened.reason);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

// The licence travels with every copy of the source (AGPL-3.0): a release copy and its tarball carry
// LICENSE at the root — from a public tree or release (LICENSE at its root) and from the private
// checkout (public-root/LICENSE) — and so does every image that holds product code.
const AGPL_SHA256 = "0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0";
const licenceSource = () => [path.join(root, "LICENSE"), path.join(root, "public-root/LICENSE")].find((f) => existsSync(f));
const sha256Of = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
test("🔴 a release copy and its tarball carry the AGPL-3.0 LICENSE at the root, from either tree shape", () => {
  assert.ok(licenceSource(), "this tree has no LICENSE (root or public-root/)");
  assert.equal(sha256Of(licenceSource()), AGPL_SHA256, "the licence is the FSF's text, byte for byte");
  const work = mkdtempSync(path.join(tmpdir(), "bb-licence-"));
  try {
    // The private checkout's shape: the public root's files sit in public-root/.
    const checkout = miniTree(path.join(work, "checkout"));
    mkdirSync(path.join(checkout, "public-root"));
    cpSync(licenceSource(), path.join(checkout, "public-root/LICENSE"));
    // A public tree or an unpacked release: LICENSE at the root.
    const pub = miniTree(path.join(work, "public"));
    cpSync(licenceSource(), path.join(pub, "LICENSE"));
    for (const [name, tree] of [["checkout", checkout], ["public", pub]]) {
      const out = path.join(work, `copy-${name}`);
      const r = spawnSync("bash", [path.join(here, "release-copy.sh"), tree, out], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(sha256Of(path.join(out, "LICENSE")), AGPL_SHA256, `${name}: the copy's LICENSE`);
      assert.ok(!existsSync(path.join(out, "public-root")), `${name}: public-root/ itself never ships`);
    }
    const o = path.join(work, "release");
    cut(checkout, o, "1.2.0");
    const x = path.join(work, "x"); mkdirSync(x);
    execFileSync("tar", ["-xzf", path.join(o, "blackbranch-1.2.0.tar.gz"), "-C", x, "--strip-components=1"]);
    assert.equal(sha256Of(path.join(x, "LICENSE")), AGPL_SHA256, "the release tarball's LICENSE");
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("retry: copying the same tree again leaves the release's LICENSE as it was, and changes nothing", () => {
  const work = mkdtempSync(path.join(tmpdir(), "bb-licence-retry-"));
  try {
    const checkout = miniTree(path.join(work, "checkout"));
    mkdirSync(path.join(checkout, "public-root"));
    cpSync(licenceSource(), path.join(checkout, "public-root/LICENSE"));
    const out = path.join(work, "copy");
    const first = spawnSync("bash", [path.join(here, "release-copy.sh"), checkout, out], { encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    assert.notEqual(first.stdout.trim(), "0 file(s) changed");
    const again = spawnSync("bash", [path.join(here, "release-copy.sh"), checkout, out], { encoding: "utf8" });
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout.trim(), "0 file(s) changed", "a second copy of the same tree is no change, the licence included");
    assert.equal(sha256Of(path.join(out, "LICENSE")), AGPL_SHA256);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("🔴 every image that ships product code carries the LICENSE (stream-api, stream-ingest, web)", () => {
  const docker = read("Dockerfile");
  assert.match(docker, /\nCMD \["node", "server\.js"\]\n$/, "read to the end of the file");
  const stages = Object.fromEntries(docker.split(/^(?=FROM )/m).map((s) => [s.match(/^FROM \S+ AS (\S+)/)?.[1], s]));
  for (const target of ["stream-api", "stream-ingest", "web"]) {
    assert.ok(stages[target], `no ${target} stage`);
    assert.match(stages[target], /^COPY LICENSE \/app\/LICENSE$/m, `the ${target} image has no LICENSE`);
  }
});

test("a nested agent or editor folder never reaches a release: left out at any depth, by the list the public cut uses", () => {
  const work = mkdtempSync(path.join(tmpdir(), "bb-private-"));
  try {
    const leaks = ["web/.claude/notes.md", "stream-api/lib/.vscode/settings.json", "install/.superpowers/x.md", "config/.playwright-mcp/page.yml",
      "stream-api/.codex/config.toml", "web/app/.cursor/rules.md", "stream-ingest/.idea/workspace.xml", "web/.github/workflows/x.yml"];
    const tree = miniTree(path.join(work, "tree"));
    for (const leak of leaks) {
      mkdirSync(path.join(tree, path.dirname(leak)), { recursive: true });
      writeFileSync(path.join(tree, leak), "private\n");
    }
    const out = path.join(work, "copy");
    const r = spawnSync("bash", [path.join(here, "release-copy.sh"), tree, out], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    for (const leak of leaks) assert.ok(!existsSync(path.join(out, leak)), `${leak} reached the copy`);
    assert.ok(existsSync(path.join(out, "install/compose.yaml")), "the rest of the release is there");
    // The list still holds the copy afterwards: a private path that slipped the selection refuses it.
    const refused = spawnSync("bash", [path.join(here, "release-copy.sh"), "--forbidden"], { encoding: "utf8", input: `${leaks.join("\n")}\nweb/app/page.tsx\n` });
    assert.deepEqual(refused.stdout.trim().split("\n").sort(), [...leaks].sort(), "every one of them is on the forbidden list");
  } finally { rmSync(work, { recursive: true, force: true }); }
  assert.match(read("release-copy.sh"), /release-forbidden\.txt/);
  assert.doesNotMatch(read("release-copy.sh").replace(/^#.*$/gm, ""), /playwright-mcp|\.cursor/, "release-copy.sh keeps no list of its own");
});

// ONE list: the public cut reads the same file as the release copy, and neither script keeps a copy
// of its own. tools/public-export.sh is the private cutting tool and is not part of the cut, so in a
// public tree this half of the invariant has nothing to read and is skipped, not failed.
const publicExport = path.join(root, "tools/public-export.sh");
test("the public cut reads the release's forbidden list, not a copy", { skip: !existsSync(publicExport) && "tools/public-export.sh does not ship: a public tree holds only release-copy.sh" }, () => {
  const exp = readFileSync(publicExport, "utf8");
  assert.match(exp, /install\/release-forbidden\.txt/);
  assert.doesNotMatch(exp, /playwright-mcp/, "public-export.sh keeps no list of its own");
});

test("install verification pass: the one-line form fetches the release its stamp names, checks it, unpacks it and runs it", async () => {
  const work = mkdtempSync(path.join(tmpdir(), "bb-boot-"));
  const serve = path.join(work, "srv");
  const server = createServer((req, res) => {
    const f = path.join(serve, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, ""));
    if (!f.startsWith(serve) || !existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200); res.end(readFileSync(f));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const tree = miniTree(path.join(work, "tree"));
    cut(tree, serve, "1.2.0", ["--base-url", base]);
    const stamped = readFileSync(path.join(serve, "install.sh"), "utf8");
    assert.match(stamped, new RegExp(`^BOOTSTRAP_VERSION="1\\.2\\.0"\nBOOTSTRAP_SHA256="[0-9a-f]{64}"\nBOOTSTRAP_SIZE="\\d+"\nBOOTSTRAP_BASE="${base.replace(/[.:/]/g, "\\$&")}"$`, "m"));
    assert.match(read("install.sh"), /^BOOTSTRAP_VERSION=""$/m, "the repo's own copy is unstamped");
    mkdirSync(path.join(work, "bin"));
    writeFileSync(path.join(work, "bin/id"), "#!/bin/sh\necho 0\n", { mode: 0o755 });   // "root"
    writeFileSync(path.join(work, "bin/chown"), `#!/bin/sh\necho "$*" >> "${work}/chown-calls"\n`, { mode: 0o755 });   // root's chown, logged
    // Async: the feed is served from this process, so the child must not block its event loop.
    const pipe = (text, home, args = []) => new Promise((resolve) => {
      const c = spawn("setsid", ["bash", "-s", "--", ...args], { cwd: work, stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, BB_HOME: home, BB_BOOTSTRAP_NO_EXEC: "1", PATH: `${path.join(work, "bin")}:/usr/bin:/bin` } });
      let stdout = "", stderr = "";
      c.stdout.on("data", (d) => { stdout += d; }); c.stderr.on("data", (d) => { stderr += d; });
      c.on("close", (status) => resolve({ status, stdout, stderr }));
      c.stdin.end(text);
    });
    // Piped, stamped: fetched, checked, unpacked where an update puts a release, then run with the feed it came from.
    const home = path.join(work, "opt");
    let r = await pipe(stamped, home, ["--domain", "example.test"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, new RegExp(`would run ${home}/releases/1\\.2\\.0/install/install\\.sh --update-feed ${base.replace(/[.:/]/g, "\\$&")} --update-channel stable --domain example\\.test`));
    assert.equal(readFileSync(path.join(home, "releases/1.2.0/RELEASE"), "utf8"), "1.2.0\n");
    assert.deepEqual(readdirSync(path.join(home, "releases")), ["1.2.0"], "no partial folder or download left");
    assert.match(readFileSync(path.join(work, "chown-calls"), "utf8"), new RegExp(`^root:root ${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"), "the home is root's, group too");
    // A second run fetches nothing (the release is already there).
    const tarball = path.join(serve, "blackbranch-1.2.0.tar.gz");
    const bytes = readFileSync(tarball);
    rmSync(tarball);
    r = await pipe(stamped, home); assert.equal(r.status, 0, r.stderr);
    // A tarball that is not the stamped one (same size, one byte changed): refused, nothing unpacked.
    const bad = Buffer.from(bytes); bad[bad.length - 10] ^= 0xff; writeFileSync(tarball, bad);
    const home2 = path.join(work, "opt2");
    r = await pipe(stamped, home2);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /is not the one this installer names \(size or sha256\) — nothing was installed/);
    assert.deepEqual(readdirSync(path.join(home2, "releases")), []);
    // The repo's own (unstamped) copy, piped: says how to run it instead.
    r = await pipe(read("install.sh"), path.join(work, "opt3"));
    assert.notEqual(r.status, 0); assert.match(r.stderr, /run this from a release or checkout/);
    // A damaged stamp is refused before anything is fetched.
    r = await pipe(stamped.replace(/^BOOTSTRAP_SIZE=.*$/m, 'BOOTSTRAP_SIZE="x"'), path.join(work, "opt4"));
    assert.notEqual(r.status, 0); assert.match(r.stderr, /its release stamp does not read/);
  } finally { server.close(); rmSync(work, { recursive: true, force: true }); }
});

test("the box's verifier is the installed release's, run with no network; the real public key is in the bundle", () => {
  const bb = read("blackbranch");
  assert.match(bb, /docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 0:0 \\\n {4}-v "\$BB_HOME\/release\/install\/update:\/bbu:ro"/);
  assert.match(read("release-key.pub"), /^ed25519:[A-Za-z0-9+/]{43}=\n$/);
  assert.equal(read(".env.example").match(/^BB_RELEASE_KEY=(.*)$/m)?.[1], read("release-key.pub").trim(), "the example shows the bundle's key");
  assert.match(read("install.sh"), /\[ -n "\$release_key" \] \|\| release_key=\$\(head -1 "\$BB_HOME\/release\/install\/release-key\.pub"/);
  assert.match(read("install.sh"), /die "this box already trusts another release key; a box keeps the key it was installed with — nothing was changed"/);
  // An update writes .env only through its migrations and BB_RELEASE: never the key.
  assert.doesNotMatch(bb.replace(/^\s*#.*$/gm, ""), /env_(file_)?set[^\n]*BB_RELEASE_KEY/);
});

// ── `blackbranch update`, end to end against a real feed ─────────────────────────────────────
const STUB = (rel) => `#!/usr/bin/env bash
# a release's blackbranch, as the updater calls it (test stub)
echo "${rel} $*" >> "$FAKE/stub-calls"
case "$1" in
  health)
    code=$(cat "$FAKE/health-${rel}" 2>/dev/null || echo 0)
    if [ "$code" = 0 ]; then echo 'BBHEALTH {"ok":true,"services":true,"failed":[],"probes":{"ws":{"ok":true,"detail":"a timerState frame on connect"}}}'
    else echo 'BBHEALTH {"ok":false,"services":true,"failed":[],"probes":{"ws":{"ok":false,"detail":"no frame within 15 s"}}}'; fi
    exit "$code" ;;
  up) if [ -f "$FAKE/up-hang" ]; then echo $$ > "$FAKE/hang.pid"; exec sleep 60 </dev/null >/dev/null 2>&1; fi
      exit "$(cat "$FAKE/up-${rel}" 2>/dev/null || echo 0)" ;;
  restore) exit "$(cat "$FAKE/restore-${rel}" 2>/dev/null || echo 0)" ;;
esac
exit 0
`;
const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" >> "$FAKE/calls"
case "$*" in
  "inspect -f {{.State.Status}}"*) echo running ;;
  "inspect -f {{if .State.Health}}"*) if [ -f "$FAKE/unhealthy" ]; then echo unhealthy; else echo healthy; fi ;;
  # Starting the stopped site again fails: compose itself, or (unhealthy) the services it starts.
  "compose up -d") if [ -f "$FAKE/up-fails" ]; then echo "compose up failed" >&2; exit 1; fi ;;
  "compose ps -a -q "*|"compose ps -q "*) echo "id-\${@: -1}" ;;
  *"SHOW server_version_num"*) echo "\${FAKE_PG:-180006}" ;;
  "compose exec -T postgres psql"*) cat >/dev/null; for a in "$@"; do case "$a" in k=*) key="\${a#k=}" ;; esac; done; cat "$FAKE/cfg/$key" 2>/dev/null; exit 0 ;;
  "compose exec -T stream-api node"*) cat "$FAKE/live" 2>/dev/null || printf offline ;;
  # stream-ingest's readers (GET /health, as blackbranch's snippet prints them): fake/readers holds one
  # answer per line, each ask takes the next and the last one stays. No file: it does not answer.
  "compose exec -T stream-ingest node"*) f="$FAKE/readers"; [ -s "$f" ] || exit 0; echo x >> "$FAKE/readers-asked"; head -n 1 "$f"
    if [ "$(wc -l < "$f")" -gt 1 ]; then tail -n +2 "$f" > "$f.n" && mv "$f.n" "$f"; fi ;;
  "compose run --rm --no-deps -T -e BK_TARGET"*)
    # A backup that never ends (the update is stopped meanwhile): it says it started, then waits.
    if [ -f "$FAKE/backup-hang" ]; then echo $$ > "$FAKE/hang.pid"; exec sleep 60 </dev/null >/dev/null 2>&1; fi
    # A write the update makes after the backup fails, as on a disk the backup just filled.
    if [ -f "$FAKE/block-progress" ]; then mkdir -p "$BB_HOME/state/update/progress.new"; fi
    if [ -f "$FAKE/lose-env-next" ]; then rm -f "$BB_HOME/state/update/env.next"; fi
    if [ -f "$FAKE/unhealthy-after-backup" ]; then : > "$FAKE/unhealthy"; fi
    if [ -f "$FAKE/backup-fails" ]; then echo 'BBRESULT {"ok":false,"message":"the target is full"}'; else echo 'BBRESULT {"ok":true,"snapshot":"5eed5eed5eed5eed","message":"kept 7 daily"}'; fi ;;
esac
exit 0
`;
const FAKE_SYSTEMCTL = `#!/usr/bin/env bash
echo "systemctl $*" >> "$FAKE/calls"
`;

// A box on release `from`, its feed served from `feedDir` over HTTP; returns helpers.
async function box({ from = "1.1.0", envExtra = "", tls = null } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "bb-upd-"));
  const fake = path.join(home, "fake"), feedDir = path.join(home, "feed");
  for (const d of ["fake/bin", "fake/cfg", "feed", "results", "state", "releases", "bin", "systemd", "matrix"]) mkdirSync(path.join(home, d), { recursive: true });
  writeFileSync(path.join(fake, "bin/docker"), FAKE_DOCKER, { mode: 0o755 });
  writeFileSync(path.join(fake, "bin/systemctl"), FAKE_SYSTEMCTL, { mode: 0o755 });
  const server = createServer((req, res) => {
    const f = path.join(feedDir, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, ""));
    if (!f.startsWith(feedDir) || !existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200); res.end(readFileSync(f));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  // The installed release: a mini tree whose blackbranch is a stub (the updater under test is the
  // repo's own script, run with BB_HOME here — the installed release's role).
  const installRelease = (v) => {
    const t = miniTree(path.join(home, `tree-${v}`), { stub: STUB(v) });
    execFileSync("bash", [path.join(here, "release-copy.sh"), t, path.join(home, "releases", v)]);
    writeFileSync(path.join(home, "releases", v, "RELEASE"), `${v}\n`);
  };
  installRelease(from);
  symlinkSync(`releases/${from}`, path.join(home, "release"));
  let env = read(".env.example").replace(/example\.com/g, "example.test").replace(/=change-me$/gm, () => `=${"f".repeat(48)}`)
    .replace(/^BB_HOME=.*$/m, `BB_HOME=${home}`).replace(/^COMPOSE_FILE=.*$/m, `COMPOSE_FILE=${home}/compose.yaml`)
    .replace(/^BB_RELEASE=.*$/m, `BB_RELEASE=${from}`).replace(/^BB_RELEASE_KEY=.*$/m, `BB_RELEASE_KEY=${KEY.pub}`)
    .replace(/^BB_UPDATE_FEED=.*$/m, `BB_UPDATE_FEED=http://127.0.0.1:${port}`);
  if (tls) env = env.replace(/^BB_TLS_MODE=.*$/m, `BB_TLS_MODE=${tls}`).replace(/^COMPOSE_PROFILES=.*$/m, "COMPOSE_PROFILES=");
  env += envExtra;
  writeFileSync(path.join(home, ".env"), env, { mode: 0o600 });
  writeFileSync(path.join(home, "matrix/mas-keys.yaml"), "  keys: []\n", { mode: 0o600 });
  for (const f of ["compose.yaml", "compose.public.yaml", "compose.lab.yaml"]) cpSync(path.join(home, "releases", from, "install", f), path.join(home, f));
  writeFileSync(path.join(home, "bin/blackbranch"), STUB(from), { mode: 0o755 });
  writeFileSync(path.join(fake, "target.env"), "BK_TARGET=local\n");
  const publish = (version, opts = {}) => {
    const t = miniTree(path.join(home, `tree-${version}`), { stub: STUB(version), ...opts });
    cut(t, feedDir, version, opts.security ? ["--security"] : []);
  };
  const run = (args, extraEnv = {}) => new Promise((resolve) => {
    execFile("bash", [path.join(here, "blackbranch"), ...args], {
      encoding: "utf8", timeout: 120_000,
      env: { ...process.env, BB_HOME: home, FAKE: fake, PATH: `${path.join(fake, "bin")}:/usr/bin:/bin`, BB_UPDATE_NODE: process.execPath,
        BB_BIN_DIR: path.join(home, "bin"), BB_SYSTEMD_DIR: path.join(home, "systemd"), BB_BACKUP_TARGET_FILE: path.join(fake, "target.env"),
        BB_LIVE_POLL: "1", ...extraEnv },
    }, (err, stdout, stderr) => resolve({ status: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }));
  });
  // The same run as a child the test can signal (a unit stopped mid-update, a reboot).
  const spawnRun = (args, extraEnv = {}) => {
    const child = spawn("bash", [path.join(here, "blackbranch"), ...args], {
      env: { ...process.env, BB_HOME: home, FAKE: fake, PATH: `${path.join(fake, "bin")}:/usr/bin:/bin`, BB_UPDATE_NODE: process.execPath,
        BB_BIN_DIR: path.join(home, "bin"), BB_SYSTEMD_DIR: path.join(home, "systemd"), BB_BACKUP_TARGET_FILE: path.join(fake, "target.env"),
        BB_LIVE_POLL: "1", ...extraEnv },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; }); child.stderr.on("data", (d) => { stderr += d; });
    const done = new Promise((resolve) => child.on("close", (code, signal) => resolve({ status: code, signal, stdout, stderr })));
    return { child, done };
  };
  const file = (rel) => { try { return readFileSync(path.join(home, rel), "utf8"); } catch { return ""; } };
  const json = (rel) => { const t = file(rel); return t ? JSON.parse(t) : null; };
  const calls = () => file("fake/calls");
  const stub = () => file("fake/stub-calls");
  const release = () => readlinkSync(path.join(home, "release"));
  const close = () => { server.close(); rmSync(home, { recursive: true, force: true }); };
  return { home, fake, feedDir, port, publish, run, spawnRun, file, json, calls, stub, release, close, installRelease, env: () => file(".env") };
}

test("update --check: the signed feed is read and recorded; a feed signed by another key is refused and the last good read kept", async () => {
  const b = await box();
  try {
    b.publish("1.2.0");
    let r = await b.run(["update", "--check"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1\.2\.0 is available — a feature release/);
    const c = b.json("results/update-feed.json");
    assert.equal(c.ok, true); assert.equal(c.current, "1.1.0"); assert.equal(c.channel, "stable");
    assert.equal(c.available.version, "1.2.0"); assert.equal(c.available.security, false); assert.equal(c.available.notes, "Release 1.2.0.");
    const readAt = c.readAt;
    // The same feed re-signed by a key this box does not trust.
    const feed = JSON.parse(readFileSync(path.join(b.feedDir, "stable.json"), "utf8"));
    const m = JSON.parse(Buffer.from(feed.payload, "base64").toString("utf8"));
    writeFileSync(path.join(b.feedDir, "stable.json"), JSON.stringify(signFeed(m, OTHER.pem)));
    r = await b.run(["update", "--check"]);
    assert.notEqual(r.status, 0);
    const c2 = b.json("results/update-feed.json");
    assert.equal(c2.ok, false); assert.equal(c2.error, "the feed is signed by a key this box does not trust"); assert.equal(c2.readAt, readAt, "the last good read is kept");
    // The feed gone (404): said, not crashed.
    rmSync(path.join(b.feedDir, "stable.json"));
    r = await b.run(["update", "--check"]);
    assert.notEqual(r.status, 0); assert.equal(b.json("results/update-feed.json").error, "the feed did not answer");
    assert.doesNotMatch(b.calls(), /compose stop|BK_TARGET/, "a check changes nothing");
  } finally { b.close(); }
});

test("an update, in order: fetched and checked, .env migrated on a copy, built, stopped, backed up, switched, started, healthy twice; two releases back dropped", async () => {
  const b = await box();
  try {
    b.installRelease("1.0.0"); // an older release still on disk: two back after this update
    writeFileSync(path.join(b.home, "releases/1.0.0/MANIFEST.json"), JSON.stringify({ images: { caddy: `caddy:2.9.0-alpine@${D("e")}` } }));
    // 1.2.0 renames a key with a migration (and its .env.example says so).
    const example = read(".env.example").replace(/^LEGAL_OPERATOR=/m, "LEGAL_OPERATOR_NAME=");
    b.publish("1.2.0", { envExample: example, migrations: { "003-legal-operator-name.sh": '#!/usr/bin/env bash\n. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"\nenvm_rename LEGAL_OPERATOR LEGAL_OPERATOR_NAME\n' } });
    const before = b.env();
    const r = await b.run(["update", "--apply", "1.2.0"]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(b.release(), "releases/1.2.0");
    const env = b.env();
    assert.match(env, /^BB_RELEASE="?1\.2\.0"?$/m); assert.match(env, /^BB_ENV_VERSION="?3"?$/m);
    assert.match(env, /^LEGAL_OPERATOR_NAME=/m); assert.doesNotMatch(env, /^LEGAL_OPERATOR=/m);
    assert.equal(env.match(/^BB_RELEASE_KEY=.*$/m)[0], before.match(/^BB_RELEASE_KEY=.*$/m)[0], "the key is never changed by an update");
    assert.equal(readFileSync(path.join(b.home, "releases/1.2.0/RELEASE"), "utf8"), "1.2.0\n");
    assert.ok(existsSync(path.join(b.home, "releases/1.2.0/MANIFEST.json")));
    // The order, in the stand-in docker's log: images by digest, the next release's build, then
    // stop → backup → (switch) → the next release's own up and health; two restarts; then health again.
    const calls = b.calls();
    const at = (re) => { const m = re.exec(calls); assert.ok(m, `no ${re}`); return m.index; };
    const pull = at(/^pull -q pgvector\/pgvector:pg18@sha256:1{64}$/m);
    const webPull = at(/^pull -q localhost\/blackbranch\/web:1\.2\.0@sha256:a{64}$/m);
    const build = at(/^compose --project-directory \S+ --env-file \S+env\.next -f \S+releases\/1\.2\.0\/install\/compose\.yaml.* build stream-api stream-ingest backup$/m);
    const tryWeb = at(/^compose --project-directory .*env\.next.* run -d --no-deps --name bb-web-candidate web$/m);
    const stop = at(/^compose stop web stream-ingest stream-api mas synapse$/m);
    const backup = at(/^compose run --rm --no-deps -T -e BK_TARGET/m);
    const restart = at(/^compose restart stream-api stream-ingest web$/m);
    assert.ok(pull < build && webPull < build && build < tryWeb && tryWeb < stop && stop < backup && backup < restart, "fetch → build → try the site → stop → backup → restart");
    assert.doesNotMatch(calls, /web-build|BB_BUILD_ID| build [^\n]*\bweb\b/, "the site's image is pulled by digest — never built on the box");
    assert.equal((calls.match(/^compose restart stream-api stream-ingest web$/gm) ?? []).length, 2, "restarted twice");
    assert.deepEqual(b.stub().trim().split("\n"), ["1.2.0 render --check", "1.2.0 up", "1.2.0 health", "1.2.0 health"],
      "the next release renders its own templates first, then starts itself and runs its own health check, twice");
    // Two releases back: 1.0.0's images and folder gone; 1.1.0 (the rollback target) kept.
    assert.match(calls, /^image rm blackbranch\/stream-api:1\.0\.0$/m); assert.match(calls, /^image rm caddy:2\.9\.0-alpine@sha256:e{64}$/m);
    assert.doesNotMatch(calls, /^image rm blackbranch\/[a-z-]+:1\.1\.0$/m);
    assert.deepEqual(readdirSync(path.join(b.home, "releases")).sort(), ["1.1.0", "1.2.0"]);
    const last = b.json("results/update-last.json");
    assert.equal(last.result, "updated"); assert.equal(last.from, "1.1.0"); assert.equal(last.to, "1.2.0"); assert.equal(last.snapshot, "5eed5eed5eed5eed");
    assert.equal(last.health.ok, true);
    assert.equal(b.json("results/update-state.json").state, "idle");
    const feed = b.json("results/update-feed.json");
    assert.equal(feed.current, "1.2.0"); assert.equal(feed.available, null, "after a good update the page says up to date, not 'available'");
    assert.ok(!existsSync(path.join(b.home, "state/update/env.next")) && !existsSync(path.join(b.home, "state/update/env.before")), "no copy of .env is left behind");
    // The next release's host files are in place (its units too).
    assert.ok(existsSync(path.join(b.home, "systemd/blackbranch-update@.service")));
    assert.match(b.file("bin/blackbranch"), /^echo "1\.2\.0 \$\*"/m, "the command is the new release's");
  } finally { b.close(); }
});

test("a release that fails its health check: the box goes back to the previous release, its .env and its data — and says so", async () => {
  const b = await box();
  try {
    const example = read(".env.example").replace(/^LEGAL_OPERATOR=/m, "LEGAL_OPERATOR_NAME=");
    b.publish("1.2.0", { envExample: example, migrations: { "003-x.sh": '#!/usr/bin/env bash\n. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"\nenvm_rename LEGAL_OPERATOR LEGAL_OPERATOR_NAME\n' } });
    writeFileSync(path.join(b.fake, "health-1.2.0"), "1");
    const before = b.env();
    const r = await b.run(["update", "--apply", "1.2.0"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /ROLLED BACK: 1\.2\.0 failed its health check; back on 1\.1\.0 with its data from just before the update/);
    assert.equal(b.release(), "releases/1.1.0");
    assert.equal(b.env(), before, ".env is exactly as it was");
    assert.match(b.file("bin/blackbranch"), /^echo "1\.1\.0 \$\*"/m, "the previous release's command is back");
    // The next release ran once and failed; the previous one restored the snapshot made just before, then passed.
    assert.deepEqual(b.stub().trim().split("\n"), ["1.2.0 render --check", "1.2.0 up", "1.2.0 health", "1.1.0 restore 5eed5eed5eed5eed --yes", "1.1.0 health"]);
    assert.doesNotMatch(b.calls(), /^compose restart/m, "no restart round on a release that already failed");
    assert.doesNotMatch(b.calls(), /^image rm blackbranch\/[a-z-]+:1\.1\.0$/m, "the release gone back to keeps its images");
    const last = b.json("results/update-last.json");
    assert.equal(last.result, "rolled-back"); assert.equal(last.ok, false);
    assert.equal(last.health.ok, false); assert.equal(last.health.probes.ws.detail, "no frame within 15 s");
    assert.equal(last.rollbackHealth.ok, true);
    const st = await b.run(["status"]);
    assert.match(st.stdout, /last update {2}\S+: 1\.2\.0 FAILED \(failed its health check; the box is back on 1\.1\.0 [^)]*\) — ROLLED BACK to 1\.1\.0; health after the rollback: passed/);
    // The restore failing too: said loudly, as its own result.
    writeFileSync(path.join(b.fake, "restore-1.1.0"), "1"); rmSync(path.join(b.fake, "stub-calls"));
    const r2 = await b.run(["update", "--apply", "1.2.0"]);
    assert.notEqual(r2.status, 0); assert.match(r2.stderr, /ROLLBACK FAILED: 1\.2\.0 failed its health check, and restoring snapshot 5eed5eed did not finish — run: blackbranch restore 5eed5eed --yes/);
    assert.equal(b.json("results/update-last.json").result, "rollback-failed");
  } finally { b.close(); }
});

test("refusals change nothing: a downgrade, another version than the feed's, a Postgres major, an unexplained .env key, a backup that fails, a damaged download", async () => {
  const b = await box({ from: "1.3.0" });
  try {
    const nothingChanged = (why) => {
      assert.equal(b.release(), "releases/1.3.0", why);
      assert.doesNotMatch(b.calls(), /^compose stop/m, `${why}: the site was not stopped`);
      assert.equal(b.stub(), "", `${why}: no release was started`);
    };
    b.publish("1.2.0");
    let r = await b.run(["update", "--apply", "1.2.0"]);
    assert.equal(r.status, 0); assert.match(r.stdout, /up to date: 1\.3\.0 is the newest/); nothingChanged("a downgrade");
    b.publish("1.4.0");
    r = await b.run(["update", "--apply", "1.5.0"]);
    assert.notEqual(r.status, 0); assert.match(b.json("results/update-last.json").message, /the newest release on the stable channel is now 1\.4\.0, not 1\.5\.0/); nothingChanged("another version");
    r = await b.run(["update", "--apply", "1.4.0"], { FAKE_PG: "170004" });
    assert.notEqual(r.status, 0); assert.match(b.json("results/update-last.json").message, /a Postgres major upgrade is never part of a normal update/); nothingChanged("Postgres 17 → 18");
    writeFileSync(path.join(b.home, ".env"), `${b.env()}MYSTERY_KEY=1\n`, { mode: 0o600 });
    const env = b.env();
    r = await b.run(["update", "--apply", "1.4.0"]);
    assert.notEqual(r.status, 0);
    assert.match(b.json("results/update-last.json").message, /1\.4\.0 cannot start with this \.env: a key no migration explains: MYSTERY_KEY/); nothingChanged("an unexplained key");
    assert.equal(b.env(), env, ".env untouched by the dry run");
    writeFileSync(path.join(b.home, ".env"), env.replace("MYSTERY_KEY=1\n", ""), { mode: 0o600 });
    writeFileSync(path.join(b.fake, "backup-fails"), "");
    r = await b.run(["update", "--apply", "1.4.0"]);
    assert.notEqual(r.status, 0); assert.match(b.json("results/update-last.json").message, /the backup before the update failed, so nothing was changed/);
    assert.equal(b.release(), "releases/1.3.0"); assert.match(b.calls(), /^compose stop[^\n]*\n(?:[^\n]*\n)*compose up -d$/m, "stopped for the backup, started again");
    rmSync(path.join(b.fake, "backup-fails")); writeFileSync(path.join(b.fake, "calls"), ""); writeFileSync(path.join(b.fake, "stub-calls"), "");
    // Not enough disk for the next release's images and build: said before anything is fetched.
    r = await b.run(["update", "--apply", "1.4.0"], { BB_UPDATE_MIN_FREE_GB: "9999" });
    assert.notEqual(r.status, 0); assert.match(b.json("results/update-last.json").message, /^only \d+ GB free where Docker keeps its data; an update needs about 9999 GB/);
    assert.doesNotMatch(b.calls(), /^pull /m, "nothing fetched"); nothingChanged("a full disk");
    // The download does not match the signed hash: one byte changed, the size the same.
    const tarFile = path.join(b.feedDir, "blackbranch-1.4.0.tar.gz");
    const bytes = readFileSync(tarFile); bytes[bytes.length - 20] ^= 0xff; writeFileSync(tarFile, bytes);
    r = await b.run(["update", "--apply", "1.4.0"]);
    assert.notEqual(r.status, 0); assert.match(b.json("results/update-last.json").message, /does not match the signed manifest/); nothingChanged("a damaged download");
    assert.equal(b.json("results/update-last.json").result, "not-applied");
  } finally { b.close(); }
});

test("a release whose source holds a link is refused even when its hash is signed", async () => {
  const b = await box();
  try {
    const work = mkdtempSync(path.join(tmpdir(), "bb-evil-"));
    const top = path.join(work, "blackbranch-1.2.0");
    miniTree(top); writeFileSync(path.join(top, "RELEASE"), "1.2.0\n");
    symlinkSync("/etc/passwd", path.join(top, "install/evil"));
    const tarPath = path.join(b.feedDir, "blackbranch-1.2.0.tar.gz");
    execFileSync("tar", ["-czf", tarPath, "-C", work, "blackbranch-1.2.0"]);
    const bytes = readFileSync(tarPath);
    const m = manifest({ source: { url: "blackbranch-1.2.0.tar.gz", sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length } });
    writeFileSync(path.join(b.feedDir, "stable.json"), JSON.stringify(signFeed(m, KEY.pem)));
    const r = await b.run(["update", "--apply", "1.2.0"]);
    assert.notEqual(r.status, 0);
    assert.match(b.json("results/update-last.json").message, /holds an entry a release may not hold/);
    assert.ok(!existsSync(path.join(b.home, "releases/1.2.0")));
    rmSync(work, { recursive: true, force: true });
  } finally { b.close(); }
});

test("the nightly timer: a feature release waits for the operator; a security release waits while the stream is live, then applies", async () => {
  const b = await box();
  try {
    b.publish("1.2.0");
    let r = await b.run(["update", "--auto"]);
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /a feature release: apply it from the Admin Panel/);
    assert.equal(b.release(), "releases/1.1.0"); assert.equal(b.stub(), "");
    b.publish("1.2.1", { security: true });
    // Live for a while, then over: the release waits, then applies.
    writeFileSync(path.join(b.fake, "live"), "live");
    const ended = setTimeout(() => writeFileSync(path.join(b.fake, "live"), "offline"), 2500);
    let sawWaiting = false;
    const watch = setInterval(() => { if (b.file("results/update-state.json").includes('"state":"waiting"')) sawWaiting = true; }, 200);
    r = await b.run(["update", "--auto"]);
    clearTimeout(ended); clearInterval(watch);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.ok(sawWaiting, "it said it was waiting for the stream");
    assert.match(r.stdout, /the stream is live: 1\.2\.1 waits/);
    const waitedAt = r.stdout.indexOf("the stream is live"), appliedAt = r.stdout.indexOf("[2/8]");
    assert.ok(waitedAt >= 0 && appliedAt > waitedAt, "nothing was fetched while live");
    assert.equal(b.release(), "releases/1.2.1");
    // A security release that already failed here is not tried again by the timer.
    b.publish("1.2.5", { security: true });
    writeFileSync(path.join(b.fake, "live"), "offline"); writeFileSync(path.join(b.fake, "health-1.2.5"), "1");
    r = await b.run(["update", "--auto"]);
    assert.notEqual(r.status, 0); assert.equal(b.json("results/update-last.json").result, "rolled-back");
    writeFileSync(path.join(b.fake, "stub-calls"), "");
    r = await b.run(["update", "--auto"]);
    assert.equal(r.status, 0); assert.match(r.stdout, /1\.2\.5 failed its health check here before: the timer does not try it again/);
    assert.equal(b.stub(), "", "not tried again"); assert.equal(b.release(), "releases/1.2.1");
    // Live past the longest wait: it gives up until the next quiet hour.
    b.publish("1.2.6", { security: true });
    writeFileSync(path.join(b.fake, "live"), "live");
    r = await b.run(["update", "--auto"], { BB_LIVE_WAIT: "2" });
    assert.equal(r.status, 0); assert.match(r.stdout, /waits for the next quiet hour/); assert.equal(b.release(), "releases/1.2.1");
    assert.equal(b.json("results/update-state.json").state, "idle");
  } finally { b.close(); }
});

test("the Admin Panel's request: the version in the request's name, checked; the update runs as its own unit", async () => {
  const b = await box();
  try {
    mkdirSync(path.join(b.home, "requests"));
    writeFileSync(path.join(b.home, "requests/update-v1.2.0.req"), "");
    writeFileSync(path.join(b.home, "requests/update-v1.2.req"), "");
    writeFileSync(path.join(b.home, "requests/update-v1.2.0;reboot.req"), "");
    let r = await b.run(["process-requests"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(b.calls(), /^systemctl start --no-block blackbranch-update@1\.2\.0\.service$/m);
    assert.equal((b.calls().match(/^systemctl start/gm) ?? []).length, 1, "only the well-formed version starts anything");
    // The last request processed (glob order) was the malformed one; the answer is under the fixed name.
    const res = b.json("results/update.json");
    assert.equal(res.request, "update-v1.2"); assert.equal(res.ok, false); assert.equal(res.message, "not a release version");
    assert.deepEqual(readdirSync(path.join(b.home, "requests")), []);
    assert.ok(!existsSync(path.join(b.home, "results/update-v1.2.0.json")), "the answer is under the fixed name");
    // update-check: the feed read now.
    b.publish("1.2.0");
    writeFileSync(path.join(b.home, "requests/update-check.req"), "");
    r = await b.run(["process-requests"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(b.file("results/update-feed.json"), /"version":"1\.2\.0"/);
    assert.match(b.file("results/update-check.json"), /"verb":"update check","ok":true,.*"message":"1\.2\.0 is available/, "the request's own answer, beside the record");
    assert.match(read("systemd/blackbranch-update@.service"), /^ExecStart=\/usr\/local\/bin\/blackbranch update --apply %i$/m);
    assert.match(read("systemd/blackbranch-update.service"), /^ExecStart=\/usr\/local\/bin\/blackbranch update --auto$/m);
  } finally { b.close(); }
});

test("security: requests cannot overwrite root's records, nothing that changes runs during an update, a replayed feed is not a read", async () => {
  const b = await box();
  try {
    mkdirSync(path.join(b.home, "requests"));
    // (1) A request named after a record is answered by nothing — the records stay root's.
    const last = `${JSON.stringify({ v: 1, at: "2026-10-11T00:00:00Z", from: "1.0.0", to: "1.2.0", result: "rolled-back", ok: false, message: "m" })}\n`;
    writeFileSync(path.join(b.home, "results/update-last.json"), last);
    writeFileSync(path.join(b.home, "results/backup-last.json"), '{"v":1,"ok":true}\n');
    for (const n of ["update-last", "update-state", "update-feed", "backup-last", "doctor-host", "backup-verify-last"]) writeFileSync(path.join(b.home, `requests/${n}.req`), "");
    let r = await b.run(["process-requests"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(b.file("results/update-last.json"), last); assert.equal(b.file("results/backup-last.json"), '{"v":1,"ok":true}\n');
    assert.deepEqual(readdirSync(path.join(b.home, "results")).sort(), ["backup-last.json", "update-last.json"]);
    // (2) While an update holds its lock, a request that changes something is refused; a read is not.
    writeFileSync(path.join(b.home, "state/update.lock"), "");
    const holder = execFile("flock", [path.join(b.home, "state/update.lock"), "sleep", "20"]);
    await new Promise((res) => setTimeout(res, 300));
    try {
      for (const n of ["restart-web", "render", "backup", "apply-install", "update-v1.2.0", "update-last", "backup-last", "rebuild"]) writeFileSync(path.join(b.home, `requests/${n}.req`), "");
      const lastBefore = b.file("results/update-last.json"), backupBefore = b.file("results/backup-last.json");
      writeFileSync(path.join(b.fake, "calls"), "");
      r = await b.run(["process-requests"]);
      assert.equal(r.status, 0, r.stderr);
      for (const n of ["restart-web", "render", "backup", "apply-install"]) {
        assert.match(b.file(`results/${n}.json`), /"ok":false,.*"message":"an update is running; try again when it has finished"/, n);
      }
      // An unknown name is answered by nothing during an update too: root's records stay its own
      // (`rebuild` is not a request).
      assert.equal(b.file("results/update-last.json"), lastBefore, "update-last.json not overwritten by a request");
      assert.equal(b.file("results/backup-last.json"), backupBefore, "backup-last.json not overwritten by a request");
      assert.equal(b.file("results/rebuild.json"), "");
      assert.match(r.stderr, /refused an unknown request \(update-last\)/);
      assert.match(b.file("results/update.json"), /an update is running/);
      assert.doesNotMatch(b.calls(), /compose (restart|run|up)|systemctl start/, "nothing ran");
      // The nightly backup and the weekly verify stand aside too (the update made its own backup).
      r = await b.run(["backup", "--scheduled"]);
      assert.equal(r.status, 0); assert.match(r.stdout, /an update is running \(it makes its own backup\): skipped/);
      r = await b.run(["restore", "latest", "--verify", "--scheduled"]);
      assert.equal(r.status, 0); assert.match(r.stdout, /the weekly check waits for next week/);
    } finally { holder.kill(); }
    assert.match(read("systemd/blackbranch-verify.service"), /^ExecStart=\/usr\/local\/bin\/blackbranch restore latest --verify --scheduled$/m);
    // (3) A validly signed feed older than one already read is a replay, not a read.
    b.publish("1.2.0");
    r = await b.run(["update", "--check"]);
    assert.equal(r.status, 0, r.stderr);
    const readAt = b.json("results/update-feed.json").readAt;
    const feed = JSON.parse(readFileSync(path.join(b.feedDir, "stable.json"), "utf8"));
    const m = JSON.parse(Buffer.from(feed.payload, "base64").toString("utf8"));
    writeFileSync(path.join(b.feedDir, "stable.json"), JSON.stringify(signFeed({ ...m, published: "2026-01-01T00:00:00Z" }, KEY.pem)));
    r = await b.run(["update", "--check"]);
    assert.notEqual(r.status, 0);
    const c = b.json("results/update-feed.json");
    assert.equal(c.ok, false); assert.match(c.error, /older than one this box read before .*a replayed feed/); assert.equal(c.readAt, readAt, "a replay is not a read");
    assert.equal(c.plainHttp, true, "the lab feed is plain http, and the record says so");
  } finally { b.close(); }
});

test("an update needs the backup's snapshot id from root's own state; a step-3 refusal leaves no copy of .env", async () => {
  const b = await box();
  try {
    b.publish("1.2.0");
    // The backup container answers ok but names no snapshot: refuse to switch, start the site again.
    writeFileSync(path.join(b.fake, "bin/docker"), FAKE_DOCKER.replace('"snapshot":"5eed5eed5eed5eed",', ""), { mode: 0o755 });
    let r = await b.run(["update", "--apply", "1.2.0"]);
    assert.notEqual(r.status, 0);
    assert.match(b.json("results/update-last.json").message, /gave no snapshot id, so nothing was changed/);
    assert.equal(b.release(), "releases/1.1.0"); assert.match(b.calls(), /^compose up -d$/m);
    writeFileSync(path.join(b.fake, "bin/docker"), FAKE_DOCKER, { mode: 0o755 });
    writeFileSync(path.join(b.home, ".env"), `${b.env()}MYSTERY_KEY=1\n`, { mode: 0o600 });
    r = await b.run(["update", "--apply", "1.2.0"]);
    assert.notEqual(r.status, 0);
    assert.ok(!existsSync(path.join(b.home, "state/update/env.next")), "the migrated copy of .env is gone after a refusal");
  } finally { b.close(); }
});

test("a dry run while an update is under way stages on its own: the update's release, .env and its copy are untouched", async () => {
  const b = await box();
  let upd = null;
  try {
    b.publish("1.2.0");
    // The real update waits at a barrier while its next release's site is tried (step 5): its
    // release folder is fetched, its .env copy written, its lock held.
    const barrier = `"compose "*"run -d --no-deps --name bb-web-candidate web") touch "$FAKE/at-barrier"; while [ ! -f "$FAKE/go" ]; do sleep 0.1; done ;;\n`;
    writeFileSync(path.join(b.fake, "bin/docker"), FAKE_DOCKER.replace('case "$*" in\n', `case "$*" in\n  ${barrier}`), { mode: 0o755 });
    upd = b.run(["update", "--apply", "1.2.0"]);
    for (let i = 0; i < 300 && !existsSync(path.join(b.fake, "at-barrier")); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(existsSync(path.join(b.fake, "at-barrier")), "the update reached its barrier");
    const next = path.join(b.home, "releases/1.2.0");
    const envNext = b.file("state/update/env.next"), env = b.env(), nextFiles = readdirSync(next).sort();
    assert.ok(envNext.length > 0 && nextFiles.includes("install"));
    const dry = await b.run(["update", "--dry-run"]);
    assert.equal(dry.status, 0, `${dry.stdout}\n${dry.stderr}`);
    assert.match(dry.stdout, /dry run: 1\.2\.0 can be applied — nothing was changed/);
    assert.ok(existsSync(path.join(next, "install/blackbranch")), "the update's release folder is still there");
    assert.deepEqual(readdirSync(next).sort(), nextFiles);
    assert.equal(b.file("state/update/env.next"), envNext, "the update's .env copy is its own");
    assert.equal(b.env(), env, ".env untouched");
    assert.deepEqual(readdirSync(path.join(b.home, "state/update")).filter((f) => !/^(env\.next|feed\.json)$/.test(f)), [], "the dry run leaves nothing of its own behind");
    writeFileSync(path.join(b.fake, "go"), "");
    const r = await upd;
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(b.release(), "releases/1.2.0");
    assert.ok(existsSync(path.join(b.home, "release/install/blackbranch")), "the release switched to is whole");
    assert.equal(b.json("results/update-last.json").result, "updated");
  } finally { writeFileSync(path.join(b.fake, "go"), ""); await upd; b.close(); }
});

test("a second update refused by the lock leaves the running update's snapshot record alone", async () => {
  const b = await box();
  try {
    b.publish("1.2.0");
    writeFileSync(path.join(b.home, "state/update.lock"), "");
    writeFileSync(path.join(b.home, "state/backup-snapshot-last"), "5eed5eed5eed5eed\n");
    const holder = execFile("flock", [path.join(b.home, "state/update.lock"), "sleep", "20"]);
    await new Promise((res) => setTimeout(res, 300));
    try {
      const r = await b.run(["update", "--apply", "1.2.0"]);
      assert.notEqual(r.status, 0); assert.match(r.stderr, /an update is already running/);
      assert.equal(b.file("state/backup-snapshot-last"), "5eed5eed5eed5eed\n", "the running update's snapshot id is still there for its rollback");
    } finally { holder.kill(); }
  } finally { b.close(); }
});

// ── install.sh over an existing install ──────────────────────────────────────────────────────
// install.sh run as "root" (a stand-in `id`) against a box made by box(). The test hook
// BB_INSTALL_TEST_STOP=preflight stops it where it would start on the host (section 1), so nothing
// here ever reaches apt, Docker or /usr/local/bin.
const runInstaller = (b, script, args = [], extraEnv = {}, input = null) => new Promise((resolve) => {
  const bin = path.join(b.fake, "root-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "id"), "#!/bin/sh\necho 0\n", { mode: 0o755 });
  const c = spawn("setsid", input === null ? ["bash", script, ...args] : ["bash", "-s", "--", ...args], { cwd: b.home, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, BB_HOME: b.home, PATH: `${bin}:/usr/bin:/bin`, ...extraEnv } });
  let stdout = "", stderr = "";
  c.stdout.on("data", (d) => { stdout += d; }); c.stderr.on("data", (d) => { stderr += d; });
  c.on("close", (status) => resolve({ status, stdout, stderr }));
  c.stdin.end(input ?? "");
});

test("install.sh over an existing install: the same release re-runs (a repair); another release, an older one or another key is refused before anything changes", async () => {
  const b = await box();
  try {
    const base = `http://127.0.0.1:${b.port}`;
    cut(miniTree(path.join(b.home, "tree-1.2.0"), { stub: STUB("1.2.0") }), b.feedDir, "1.2.0", ["--base-url", base]);
    const unpack = (v) => {
      const x = mkdtempSync(path.join(tmpdir(), "bb-inst-"));
      execFileSync("tar", ["-xzf", path.join(b.feedDir, `blackbranch-${v}.tar.gz`), "-C", x, "--strip-components=1"]);
      return x;
    };
    const B = unpack("1.2.0");
    const env = b.env(), releases = readdirSync(path.join(b.home, "releases")).sort();
    const unchanged = (r, why) => {
      assert.notEqual(r.status, 0, `${why}: refused`);
      assert.doesNotMatch(r.stdout, /Checking the box|Copying the release/, `${why}: refused before the host or the release was touched`);
      assert.match(r.stderr, /nothing was changed/, why);
      assert.equal(b.release(), "releases/1.1.0", `${why}: the release in use is the same`);
      assert.deepEqual(readdirSync(path.join(b.home, "releases")).sort(), releases, `${why}: no release added`);
      assert.equal(b.env(), env, `${why}: .env untouched`);
    };
    try {
      // A newer release's installer: the update is the way (backup, candidate, health, rollback, lock).
      let r = await runInstaller(b, path.join(B, "install/install.sh"), ["--domain", "example.test"]);
      unchanged(r, "a newer installer");
      assert.match(r.stderr, /this box runs release 1\.1\.0; this installer is 1\.2\.0\..*sudo blackbranch update/s);
      // The one-line form of a newer release: refused before it fetches anything.
      r = await runInstaller(b, null, [], { BB_BOOTSTRAP_NO_EXEC: "1" }, readFileSync(path.join(b.feedDir, "install.sh"), "utf8"));
      unchanged(r, "the one-line form of a newer release");
      assert.doesNotMatch(r.stdout, /Fetching release/);
      // An older release's installer.
      const A0 = mkdtempSync(path.join(tmpdir(), "bb-inst-"));
      cpSync(B, A0, { recursive: true }); writeFileSync(path.join(A0, "RELEASE"), "1.0.0\n");
      r = await runInstaller(b, path.join(A0, "install/install.sh"));
      unchanged(r, "an older installer"); assert.match(r.stderr, /never install an older release over a newer one/);
      rmSync(A0, { recursive: true, force: true });
      // The release the box runs: a repair, allowed through.
      const A = path.join(b.home, "releases/1.1.0/install/install.sh");
      r = await runInstaller(b, A, [], { BB_INSTALL_TEST_STOP: "preflight" });
      assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /preflight passed/);
      // …but not with a key other than the one the box trusts.
      const other = path.join(b.home, "other.pub"); writeFileSync(other, `${OTHER.pub}\n`);
      r = await runInstaller(b, A, ["--release-key", other], { BB_INSTALL_TEST_STOP: "preflight" });
      unchanged(r, "another key"); assert.match(r.stderr, /this box already trusts another release key/);
      r = await runInstaller(b, path.join(B, "install/install.sh"), ["--release-key", other]);
      unchanged(r, "a newer installer with another key");
    } finally { rmSync(B, { recursive: true, force: true }); }
  } finally { b.close(); }
});

test("install.sh shares the updater's lock: a repair while an update runs says so and stops; a release moved under it is never switched back", async () => {
  const b = await box();
  try {
    // A repair of the running release, with `chown root:` stood in (it needs root).
    mkdirSync(path.join(b.fake, "root-bin"), { recursive: true });
    writeFileSync(path.join(b.fake, "root-bin/chown"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const A = path.join(b.home, "releases/1.1.0/install/install.sh");
    // An update holds the lock: the installer waits a bounded time, then stops before its first check.
    writeFileSync(path.join(b.home, "state/update.lock"), "");
    // -o: the lock is flock's own, not its sleep's, so killing the holder releases it.
    const holder = execFile("flock", ["-o", path.join(b.home, "state/update.lock"), "sleep", "20"]);
    await new Promise((res) => setTimeout(res, 300));
    try {
      const r = await runInstaller(b, A, [], { BB_INSTALL_TEST_STOP: "preflight", BB_INSTALL_LOCK_WAIT: "1" });
      assert.notEqual(r.status, 0, "refused while the update holds the lock");
      assert.match(r.stderr, /blackbranch update is running/);
      assert.doesNotMatch(r.stdout, /preflight passed/);
    } finally { holder.kill(); }
    await new Promise((res) => setTimeout(res, 300));
    // A release moved by something that does not take the lock, between the first check and the
    // switch (the hold hook pauses the installer there): refused, the pointer left where it was moved.
    b.installRelease("1.2.0");
    const fifo = path.join(b.home, "hold");
    execFileSync("mkfifo", [fifo]);
    const running = runInstaller(b, A, [], { BB_INSTALL_TEST_STOP: "env", BB_INSTALL_TEST_HOLD: fifo });
    let fd = null;
    for (let i = 0; i < 200 && fd === null; i++) {   // the installer opens the FIFO once it reaches the hold
      try { fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK); } catch { await new Promise((res) => setTimeout(res, 50)); }
    }
    if (fd === null) { const r = await running; assert.fail(`the installer never reached the hold before the pointer switch (exit ${r.status}):\n${r.stdout}\n${r.stderr}`); }
    rmSync(path.join(b.home, "release")); symlinkSync("releases/1.2.0", path.join(b.home, "release"));
    writeSync(fd, "go\n"); closeSync(fd);
    const r = await running;
    assert.notEqual(r.status, 0, "refused");
    assert.match(r.stderr, /the release this box runs changed while this installer ran \(1\.1\.0 → 1\.2\.0\)/);
    assert.equal(b.release(), "releases/1.2.0", "the newer release is not switched back to the older one");
  } finally { b.close(); }
});

test("a dashboard tunnel's token never rides on the command line: read from a file (or typed), checked, written to .env", async () => {
  const b = await box();
  const fresh = mkdtempSync(path.join(tmpdir(), "bb-fresh-"));
  try {
    mkdirSync(path.join(b.fake, "root-bin"), { recursive: true });
    writeFileSync(path.join(b.fake, "root-bin/chown"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const tree = miniTree(path.join(b.home, "tree-token"));
    const token = `eyJ${"a1B2".repeat(40)}`;
    const install = (...args) => runInstaller(b, path.join(tree, "install/install.sh"), ["--domain", "site.test", "--mode", "tunnel", ...args],
      { BB_HOME: fresh, BB_INSTALL_TEST_STOP: "env" });
    // The old form — the token as an argument, readable in `ps` and kept in sudo's log — is refused.
    let r = await install("--tunnel-token", token);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--tunnel-token takes no value: a token on the command line is visible to every account on the box/);
    assert.ok(!existsSync(path.join(fresh, ".env")));
    // Not a token (a line break, a quote): refused before .env is written.
    const bad = path.join(b.home, "bad-token");
    writeFileSync(bad, 'abc" X=1\n');
    r = await install("--tunnel-token-file", bad);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /is not a Cloudflare tunnel token/);
    assert.ok(!existsSync(path.join(fresh, ".env")));
    const file = path.join(b.home, "token");
    writeFileSync(file, `${token}\n`, { mode: 0o600 });
    r = await install("--tunnel-token-file", file);
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(path.join(fresh, ".env"), "utf8"), new RegExp(`^CLOUDFLARE_TUNNEL_TOKEN=${token}$`, "m"));
    // Install verification pass, item 8b: a token given again on a re-run was silently ignored once
    // .env existed — a wrong token could only be fixed by editing .env by hand. Given explicitly, it
    // replaces the old one (checked the same way), and the installer says so.
    const envOf = () => readFileSync(path.join(fresh, ".env"), "utf8");
    const token2 = `eyJ${"z9Y8".repeat(40)}`;
    writeFileSync(file, `${token2}\n`, { mode: 0o600 });
    r = await install("--tunnel-token-file", file);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /tunnel token replaced in .*\.env/);
    assert.match(envOf(), new RegExp(`^CLOUDFLARE_TUNNEL_TOKEN=${token2}$`, "m"));
    assert.doesNotMatch(envOf(), new RegExp(token), "the old token is gone");
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(token2), "the token is never printed");
    // The same token again: nothing to do, said.
    r = await install("--tunnel-token-file", file);
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /tunnel token unchanged/);
    // Not a token: refused, .env as it was.
    const before = envOf();
    r = await install("--tunnel-token-file", bad);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /is not a Cloudflare tunnel token/);
    assert.equal(envOf(), before);
    // No token given: kept.
    r = await install();
    assert.equal(r.status, 0, r.stderr); assert.equal(envOf(), before);
    // A box whose tunnel was made by signing in (no token in .env) — R1.6: after a move whose old
    // tunnel was deleted this was a dead end, refused. Now the dashboard tunnel takes over: the token
    // is written, and the signed-in tunnel's config is set aside so the token's is written instead.
    writeFileSync(path.join(fresh, ".env"), before.replace(/^CLOUDFLARE_TUNNEL_TOKEN=.*$/m, "CLOUDFLARE_TUNNEL_TOKEN="), { mode: 0o600 });
    mkdirSync(path.join(fresh, "cloudflared"), { recursive: true });
    writeFileSync(path.join(fresh, "cloudflared/config.yml"), "tunnel: 11111111-2222-3333-4444-555555555555\ncredentials-file: /etc/cloudflared/11111111-2222-3333-4444-555555555555.json\n");
    r = await install("--tunnel-token-file", file);
    assert.equal(r.status, 0, r.stderr);
    assert.match(envOf(), new RegExp(`^CLOUDFLARE_TUNNEL_TOKEN=${token2}$`, "m"));
    assert.match(r.stdout, /the tunnel made by signing in is replaced by the dashboard tunnel whose token you gave/);
    assert.ok(!existsSync(path.join(fresh, "cloudflared/config.yml")), "the signed-in tunnel's config is set aside");
    assert.equal(readdirSync(path.join(fresh, "cloudflared")).filter((f) => f.startsWith("config.yml.signed-in-")).length, 1, "kept beside it, not deleted");
  } finally { rmSync(fresh, { recursive: true, force: true }); b.close(); }
  for (const doc of [read("README.md"), readFileSync(path.join(root, "docs/public/install.md"), "utf8")]) {
    assert.doesNotMatch(doc, /--tunnel-token <token>/, "the docs never show the token as an argument");
    assert.match(doc, /--tunnel-token-file/);
  }
  // The roles' passwords reach psql from its environment (\getenv), never its command line.
  const init = read("postgres/init-databases.sh");
  assert.doesNotMatch(init, /-v [a-z_]+_pw=/);
  for (const [v, e] of [["stream_pw", "STREAM_DB_PASSWORD"], ["synapse_pw", "SYNAPSE_DB_PASSWORD"], ["mas_pw", "MAS_DB_PASSWORD"]]) {
    assert.match(init, new RegExp(`\\n\\\\getenv ${v} ${e}\\n`));
  }
});

test("a secret the generator could not make stops the installer: .env is never written with an empty one", async () => {
  const b = await box();
  const fresh = mkdtempSync(path.join(tmpdir(), "bb-fresh-"));
  try {
    const bin = path.join(b.fake, "root-bin");
    mkdirSync(bin, { recursive: true });
    // root's chown, logged: what the installer hands to whom.
    writeFileSync(path.join(bin, "chown"), `#!/bin/sh\necho "$*" >> "${b.fake}/chown-calls"\nexit 0\n`, { mode: 0o755 });
    // openssl fails on its fifth call (one secret part-way down the list), as a broken RNG or a full /tmp would.
    writeFileSync(path.join(bin, "openssl"), `#!/bin/sh\nn=$(cat "${b.fake}/openssl-n" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > "${b.fake}/openssl-n"\n[ "$n" -ge 5 ] && exit 1\nexec /usr/bin/openssl "$@"\n`, { mode: 0o755 });
    const tree = miniTree(path.join(b.home, "tree-rng"));
    const r = await runInstaller(b, path.join(tree, "install/install.sh"), ["--domain", "site.test", "--mode", "direct"],
      { BB_HOME: fresh, BB_INSTALL_TEST_STOP: "env" });
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stderr, /could not generate .* — nothing was written/);
    assert.ok(!existsSync(path.join(fresh, ".env")), "no .env with an empty secret");
    assert.deepEqual(readdirSync(fresh).filter((f) => f.startsWith(".env")), [], "no half-written copy");
    assert.ok(!existsSync(path.join(fresh, "state/recovery-sheet-due")), "no install, so no recovery sheet due");
    // A generator that works: every secret is there, at its full length. (And the box already has an
    // account with Synapse's uid: said, since that uid owns the homeserver's config.)
    rmSync(path.join(bin, "openssl"));
    writeFileSync(path.join(bin, "getent"), '#!/bin/sh\n[ "$1 $2" = "passwd 991" ] && { echo "casey:x:991:991::/home/casey:/bin/sh"; exit 0; }\n[ "$1 $2" = "passwd 1000" ] && { echo "robin:x:1000:1000::/home/robin:/bin/sh"; exit 0; }\nexit 2\n', { mode: 0o755 });
    const ok = await runInstaller(b, path.join(tree, "install/install.sh"), ["--domain", "site.test", "--mode", "direct"],
      { BB_HOME: fresh, BB_INSTALL_TEST_STOP: "env" });
    assert.equal(ok.status, 0, ok.stderr);
    const env = readFileSync(path.join(fresh, ".env"), "utf8");
    for (const [k, n] of [["POSTGRES_PASSWORD", 48], ["AUTH_SECRET", 64], ["BACKUP_PASSPHRASE", 48], ["SYNAPSE_FORM_SECRET", 64]]) {
      assert.match(env, new RegExp(`^${k}=[0-9a-f]{${n}}$`, "m"), k);
    }
    assert.match(env, /^MATRIX_OAUTH_CLIENT_ID=[0-9A-Z]{26}$/m);
    // A new install's recovery sheet is due (root's own record); a re-run over it never makes it due again.
    assert.ok(existsSync(path.join(fresh, "state/recovery-sheet-due")), "the new install's sheet is due");
    rmSync(path.join(fresh, "state/recovery-sheet-due"));
    const again = await runInstaller(b, path.join(tree, "install/install.sh"), ["--domain", "site.test", "--mode", "direct"],
      { BB_HOME: fresh, BB_INSTALL_TEST_STOP: "env" });
    assert.equal(again.status, 0, again.stderr);
    assert.ok(!existsSync(path.join(fresh, "state/recovery-sheet-due")), "an existing install's sheet is not made due again");
    assert.match(ok.stdout, /the host account casey has uid 991, the one Synapse runs as/);
    // uid 1000 is the site's (the image's `node`), and on most hosts the first person's account too.
    assert.match(ok.stdout, /the host account robin has uid 1000, the one the site runs as/);
    // The install's home is root's and its group's alone: an account that shares a service's uid cannot
    // walk into it (the tunnel's credentials, the site's drop box, the recovery sheet).
    assert.equal(statSync(fresh).mode & 0o777, 0o750, "the install's home is 750");
    // ... and its group is root's, even for a home that existed before with another group.
    assert.match(readFileSync(path.join(b.fake, "chown-calls"), "utf8"), new RegExp(`^root:root ${fresh.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    assert.match(read("blackbranch"), /\n {2}if \[ "\$\(id -u\)" = 0 \]; then chown root:root "\$BB_HOME"; fi\n {2}chmod 750 "\$BB_HOME"\n/, "`up` puts the group back on a box made before");
    assert.doesNotMatch(ok.stdout, /uid 65532/, "only the uids that are taken");
  } finally { rmSync(fresh, { recursive: true, force: true }); b.close(); }
});

test("install.sh stops when the release copy refuses a private file: no release selected, no partial copy left, nothing written", async () => {
  const b = await box();
  const fresh = mkdtempSync(path.join(tmpdir(), "bb-fresh-"));
  try {
    mkdirSync(path.join(b.fake, "root-bin"), { recursive: true });
    writeFileSync(path.join(b.fake, "root-bin/chown"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    // A file the copy's selection lets through and the forbidden list refuses (a pattern this tree's
    // list holds; nested agent folders the copy now leaves out before the list sees them).
    const tree = miniTree(path.join(b.home, "tree-leaky"));
    appendFileSync(path.join(tree, "install/release-forbidden.txt"), "^stream-api/private-notes\\.txt$\n");
    writeFileSync(path.join(tree, "stream-api/private-notes.txt"), "private\n");
    const r = await runInstaller(b, path.join(tree, "install/install.sh"), ["--domain", "example.test", "--mode", "tunnel"],
      { BB_HOME: fresh, BB_INSTALL_TEST_STOP: "env" });
    assert.notEqual(r.status, 0, `refused:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /private files in the release:\nstream-api\/private-notes\.txt/);
    assert.ok(!existsSync(path.join(fresh, "release")), "no release selected");
    assert.ok(!existsSync(path.join(fresh, "releases/local")), "the partial copy this run made is removed");
    assert.ok(!existsSync(path.join(fresh, ".env")), "stopped before .env");
  } finally { rmSync(fresh, { recursive: true, force: true }); b.close(); }
});

// A stand-in cloudflared (as `docker run … cloudflare/cloudflared … tunnel <cmd>`), its account in
// $FAKE/cf: the tunnels made (cf/tunnels: "<name> <uuid>"), the routes (cf/routes), the names whose
// route fails (cf/route-fail: one per line — a record the name already has).
const FAKE_CLOUDFLARED = `#!/usr/bin/env bash
echo "$*" >> "$FAKE/cf/calls"
dir=""; prev=""; for a in "$@"; do [ "$prev" = -v ] && dir="\${a%%:*}"; prev="$a"; done
while [ $# -gt 0 ] && [ "$1" != tunnel ]; do shift; done; shift
case "$1" in
  login) echo "cert" > "$dir/cert.pem" ;;
  list) n="$3"; u=$(awk -v n="$n" '$1 == n { print $2 }' "$FAKE/cf/tunnels" 2>/dev/null)
        if [ -n "$u" ]; then printf '[{"id":"%s","name":"%s","connections":[]}]\\n' "$u" "$n"; else echo '[]'; fi ;;
  create) n="$2"
          if grep -q "^$n " "$FAKE/cf/tunnels" 2>/dev/null; then echo "failed to create tunnel: tunnel with name already exists" >&2; exit 1; fi
          u=$(cat /proc/sys/kernel/random/uuid); echo "$n $u" >> "$FAKE/cf/tunnels"; echo '{"creds":1}' > "$dir/$u.json"
          echo "Created tunnel $n with id $u" ;;
  route) h="$4"
         if grep -qx "$h" "$FAKE/cf/route-fail" 2>/dev/null; then echo "Failed to add route: code: 1003, reason: An A, AAAA, or CNAME record with that host already exists." >&2; exit 1; fi
         echo "$h" >> "$FAKE/cf/routes"; echo "Added CNAME $h which will route to this tunnel" ;;
  *) exit 2 ;;
esac
`;

test("install verification pass: direct mode with a name that does not lead to this box says so plainly, and still finishes", async () => {
  const b = await box();
  const fresh = mkdtempSync(path.join(tmpdir(), "bb-fresh-"));
  try {
    const bin = path.join(b.fake, "root-bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "chown"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    // This box's own addresses (TEST-NET ranges), and what each name resolves to (fake/dns: "<name> <address>").
    // Docker's default bridge (a private address, assembled here: the tree holds no literal one).
    const bridge = [172, 17, 0, 1].join(".");
    writeFileSync(path.join(bin, "ip"), `#!/bin/sh\necho '2: eth0    inet 198.51.100.7/24 brd 198.51.100.255 scope global eth0'\necho '2: eth0    inet6 2001:db8::7/64 scope global'\necho '3: docker0    inet ${bridge}/16 scope global docker0'\n`, { mode: 0o755 });
    writeFileSync(path.join(bin, "getent"), `#!/bin/sh\nawk -v n="$2" '$1 == n { print $2 "  STREAM " n }' "${b.fake}/dns"\n`, { mode: 0o755 });
    const tree = miniTree(path.join(b.home, "tree-direct"));
    const install = (...args) => runInstaller(b, path.join(tree, "install/install.sh"), ["--domain", "site.test", "--mode", "direct", ...args],
      { BB_HOME: fresh, BB_INSTALL_TEST_STOP: "front-door" });
    // Every name on this box: no warning.
    writeFileSync(path.join(b.fake, "dns"), "site.test 198.51.100.7\napi.site.test 198.51.100.7\nmatrix.site.test 2001:db8::7\n");
    let r = await install();
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout + r.stderr, /not an address of this server/);
    // Before: a name pointing elsewhere passed ("site.test → 203.0.113.9"), the install finished
    // "healthy" and printed a setup link that could not open. Now it is said, and the install goes on.
    writeFileSync(path.join(b.fake, "dns"), "site.test 203.0.113.9\napi.site.test 198.51.100.7\nmatrix.site.test 203.0.113.9\n");
    r = await install();
    assert.equal(r.status, 0, `still finishes:\n${r.stderr}`);
    assert.match(r.stderr, /site\.test and matrix\.site\.test resolve to 203\.0\.113\.9, which is not an address of this server \(198\.51\.100\.7 2001:db8::7\)/);
    assert.match(r.stderr, /certificates will not issue and the setup link will not open/);
    assert.match(r.stderr, /router that forwards ports 80 and 443/, "the one case where that is fine is named");
    // --skip-dns-check skips this too (the operator said the names are not ready yet).
    r = await install("--skip-dns-check");
    assert.equal(r.status, 0); assert.doesNotMatch(r.stderr, /not an address of this server/);
  } finally { rmSync(fresh, { recursive: true, force: true }); b.close(); }
  // Said again at the very end, beside the setup link, where it is read.
  assert.match(read("install.sh"), /\n\[ -z "\$NAME_WARNING" \] \|\| printf '\\n   ⚠ %s\\n\\n' "\$NAME_WARNING" >&2\n# The one setup link/);
});

test("tunnel mode: a route that fails stops the installer before config.yml; the re-run uses the same tunnel and routes every name", async () => {
  const b = await box();
  const fresh = mkdtempSync(path.join(tmpdir(), "bb-fresh-"));
  try {
    const bin = path.join(b.fake, "root-bin"), cf = path.join(b.fake, "cf");
    mkdirSync(bin, { recursive: true }); mkdirSync(cf);
    writeFileSync(path.join(bin, "chown"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(path.join(bin, "docker"), FAKE_CLOUDFLARED, { mode: 0o755 });
    const tree = miniTree(path.join(b.home, "tree-tunnel"));
    const install = () => runInstaller(b, path.join(tree, "install/install.sh"), ["--domain", "site.test", "--mode", "tunnel"],
      { BB_HOME: fresh, BB_INSTALL_TEST_STOP: "front-door", FAKE: b.fake });
    const cfdir = path.join(fresh, "cloudflared"), config = path.join(cfdir, "config.yml");
    // The bare domain already has a record: its route fails.
    writeFileSync(path.join(cf, "route-fail"), "site.test\n");
    let r = await install();
    assert.notEqual(r.status, 0, `stopped:\n${r.stdout}`);
    assert.match(r.stderr, /routing site\.test to the tunnel failed: .*record with that host already exists.*remove it in Cloudflare's dashboard, then run this again/s);
    assert.ok(!existsSync(config), "config.yml is not written while a route is missing");
    const tunnels = () => readFileSync(path.join(cf, "tunnels"), "utf8").trim().split("\n");
    assert.equal(tunnels().length, 1);
    // The record removed: the re-run finds the tunnel it made (a second create would fail on its name) and routes all three.
    rmSync(path.join(cf, "route-fail"));
    r = await install();
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /using the tunnel an earlier run made \(blackbranch-site\.test\)/);
    assert.equal(tunnels().length, 1, "one tunnel, made once");
    assert.deepEqual(readFileSync(path.join(cf, "routes"), "utf8").trim().split("\n"), ["site.test", "api.site.test", "matrix.site.test"]);
    const uuid = tunnels()[0].split(" ")[1];
    assert.equal(readFileSync(config, "utf8"), `tunnel: ${uuid}\ncredentials-file: /etc/cloudflared/${uuid}.json\nno-autoupdate: true\ningress:\n  - service: http://caddy:80\n`);
    // The account-wide sign-in certificate is gone once the routes are in: the running tunnel needs
    // only its own credentials, and this folder is mounted into cloudflared and backed up.
    assert.ok(!existsSync(path.join(cfdir, "cert.pem")), "cert.pem removed after the routes");
    assert.ok(existsSync(path.join(cfdir, `${uuid}.json`)), "the tunnel's own credentials stay");
    // Configured: a third run changes nothing — but takes away a certificate an older install left.
    const calls = readFileSync(path.join(cf, "calls"), "utf8");
    writeFileSync(path.join(cfdir, "cert.pem"), "left by an older installer\n");
    r = await install();
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /tunnel already configured/);
    assert.equal(readFileSync(path.join(cf, "calls"), "utf8"), calls);
    assert.ok(!existsSync(path.join(cfdir, "cert.pem")));
    assert.match(read("backup/run.sh"), /--exclude \/bb\/home\/cloudflared\/cert\.pem/, "and a backup never takes one");
    // A tunnel of that name whose credentials are not on this box: said, never a second tunnel.
    rmSync(config); rmSync(path.join(cfdir, `${uuid}.json`));
    r = await install();
    assert.notEqual(r.status, 0); assert.match(r.stderr, /the tunnel blackbranch-site\.test exists in Cloudflare, but its credentials are not on this server/);
    // R1.6: that is exactly what a move looks like. The refusal names the way through, and --moving
    // takes it: no sign-in, no tunnel made, nothing written for one — the restore brings the site's own.
    assert.match(r.stderr, /Moving the site here from another server\? Run this again with --moving: the restore brings the tunnel back/);
    const before = readFileSync(path.join(cf, "calls"), "utf8");
    r = await runInstaller(b, path.join(tree, "install/install.sh"), ["--domain", "site.test", "--mode", "tunnel", "--moving"],
      { BB_HOME: fresh, BB_INSTALL_TEST_STOP: "front-door", FAKE: b.fake });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /moving: no tunnel is made here — the restore brings back the site's own tunnel/);
    assert.equal(readFileSync(path.join(cf, "calls"), "utf8"), before, "no Cloudflare call at all");
    assert.ok(!existsSync(config), "no tunnel config: the snapshot's goes here");
    assert.equal(tunnels().length, 1);
  } finally { rmSync(fresh, { recursive: true, force: true }); b.close(); }
  // A move starts nothing and prints no setup link: the restore does the rest (and starts the site).
  const inst = read("install.sh");
  const moving = inst.indexOf('if [ "$MOVING" = 1 ]; then\n  exec 9>&-'), up = inst.indexOf("/usr/local/bin/blackbranch up");
  assert.ok(moving > 0 && moving < up, "the move's stop comes before `up`");
  assert.match(inst.slice(moving, up), /sudo blackbranch restore latest --with-env/);
  assert.match(inst.slice(moving, up), /\n {2}exit 0\nfi\n/);
});

// Every path's type, mode, size and mtime, then every file's content hash: equal means the tree is
// byte-for-byte (and stat-for-stat) what it was.
const treeState = (dir) => execFileSync("bash", ["-c",
  'cd "$1" && find . -printf "%p %y %m %s %T@\\n" | LC_ALL=C sort && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum', "_", dir], { encoding: "utf8" });

test("a refused repair of the selected release leaves it byte-for-byte as it was, the pointer where it was, no copy beside it", async () => {
  const b = await box();
  const src = mkdtempSync(path.join(tmpdir(), "bb-repair-"));
  try {
    mkdirSync(path.join(b.fake, "root-bin"), { recursive: true });
    writeFileSync(path.join(b.fake, "root-bin/chown"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const rel = path.join(b.home, "releases/1.1.0");
    const before = treeState(rel), listing = readdirSync(path.join(b.home, "releases")).sort();
    // The same release (so a repair), changed AND carrying a file the forbidden list refuses.
    cpSync(rel, src, { recursive: true });
    writeFileSync(path.join(src, "stream-api/index.js"), "// replaced\n");
    appendFileSync(path.join(src, "install/release-forbidden.txt"), "^stream-api/private-notes\\.txt$\n");
    writeFileSync(path.join(src, "stream-api/private-notes.txt"), "private\n");
    const r = await runInstaller(b, path.join(src, "install/install.sh"), [], { BB_INSTALL_TEST_STOP: "env" });
    assert.notEqual(r.status, 0, `refused:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /Copying the release \(1\.1\.0\)/, "it got as far as the copy");
    assert.match(r.stderr, /private files in the release:\nstream-api\/private-notes\.txt/);
    assert.match(r.stderr, /no release was selected; .*releases\/1\.1\.0 is as it was/);
    assert.equal(treeState(rel), before, "neither the replacement source nor the private file reached the release in use");
    assert.equal(b.release(), "releases/1.1.0", "the pointer is unchanged");
    assert.deepEqual(readdirSync(path.join(b.home, "releases")).sort(), listing, "no staging copy left beside it");
  } finally { rmSync(src, { recursive: true, force: true }); b.close(); }
});

test("an interrupted release copy leaves the destination as it was or complete, never half; the next run cleans up and succeeds", () => {
  const work = mkdtempSync(path.join(tmpdir(), "bb-copy-"));
  try {
    const script = path.join(here, "release-copy.sh");
    const tree = miniTree(path.join(work, "tree"));
    const releases = path.join(work, "releases"), dest = path.join(releases, "1.1.0");
    execFileSync("bash", [script, tree, dest]);
    writeFileSync(path.join(dest, "RELEASE"), "1.1.0\n");   // outside the selection: a copy keeps it
    const before = treeState(dest);
    writeFileSync(path.join(tree, "stream-api/index.js"), "// next\n");
    // Stand-ins that do the real work, then kill the copy at one point: rsync once it has copied
    // part of the tree, mv right after the old release was moved aside (before the new one is in).
    const fake = path.join(work, "fake");
    mkdirSync(fake);
    writeFileSync(path.join(fake, "rsync"), '#!/bin/bash\nPATH=/usr/bin:/bin rsync --exclude=/stream-api/ "$@"\nkill -KILL $PPID\n', { mode: 0o755 });
    writeFileSync(path.join(fake, "mv"), '#!/bin/bash\nPATH=/usr/bin:/bin mv "$@"; rc=$?\n[ "$2" = "$FAKE_MV_AT" ] && kill -"$FAKE_MV_SIG" $PPID\nexit $rc\n', { mode: 0o755 });
    const copy = (env = {}, withFakes = true) => spawnSync("bash", [script, tree, dest], { encoding: "utf8",
      env: { ...process.env, PATH: withFakes ? `${fake}:/usr/bin:/bin` : process.env.PATH, ...env } });
    const others = () => readdirSync(releases).filter((f) => f !== "1.1.0");
    // 1. Killed mid-copy (SIGKILL: no trap runs). The release is untouched; a hidden staging folder may remain.
    let r = copy({ FAKE_MV_AT: "-" });
    assert.notEqual(r.status, 0, "the copy died");
    assert.equal(treeState(dest), before, "killed mid-copy: the release is as it was");
    assert.ok(others().every((f) => f.startsWith(".")), `nothing that looks like a release: ${others()}`);
    rmSync(path.join(fake, "rsync"));
    // 2. Terminated between the two renames: the exit trap puts the old release back.
    r = copy({ FAKE_MV_AT: dest, FAKE_MV_SIG: "TERM" });
    assert.notEqual(r.status, 0, "the copy was terminated");
    assert.equal(treeState(dest), before, "terminated mid-swap: the old release is back");
    assert.deepEqual(others(), [], "the trap cleaned up");
    // 3. Killed between the two renames (no trap): the old release waits beside it, under a hidden
    // name, and the next run puts it back before it copies.
    r = copy({ FAKE_MV_AT: dest, FAKE_MV_SIG: "KILL" });
    assert.notEqual(r.status, 0, "the copy was killed");
    assert.ok(!existsSync(dest), "the one window a directory swap has: between two renames");
    assert.ok(others().length > 0 && others().every((f) => f.startsWith(".")));
    r = copy({ FAKE_MV_AT: "-" }, false);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^1 file\(s\) changed\n$/, "counted against the release that was put back");
    assert.equal(readFileSync(path.join(dest, "stream-api/index.js"), "utf8"), "// next\n");
    assert.equal(readFileSync(path.join(dest, "RELEASE"), "utf8"), "1.1.0\n");
    assert.deepEqual(others(), [], "no leftovers after a good run");
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("a repair copy counts the real changes against the release it replaces, and swaps in only once complete", () => {
  const work = mkdtempSync(path.join(tmpdir(), "bb-copy-"));
  try {
    const script = path.join(here, "release-copy.sh");
    const tree = miniTree(path.join(work, "tree"));
    const dest = path.join(work, "releases/1.1.0");
    const first = execFileSync("bash", [script, tree, dest], { encoding: "utf8" });
    assert.match(first, /^[1-9]\d* file\(s\) changed\n$/, "a new copy counts every file");
    assert.equal(execFileSync("bash", [script, tree, dest], { encoding: "utf8" }), "0 file(s) changed\n", "an unchanged repair changes nothing");
    // One file changed, one removed: two changes. While rsync runs, the release in use still holds the
    // old content (the copy goes into a staging folder, not into it).
    writeFileSync(path.join(tree, "stream-api/index.js"), "// next\n");
    rmSync(path.join(tree, "migrations/baseline/seed.sql"));
    const fake = path.join(work, "fake"); mkdirSync(fake);
    writeFileSync(path.join(fake, "rsync"), `#!/bin/bash\nPATH=/usr/bin:/bin rsync "$@"; rc=$?\ncat ${JSON.stringify(path.join(dest, "stream-api/index.js"))} > ${JSON.stringify(path.join(work, "seen"))}\nexit $rc\n`, { mode: 0o755 });
    const r = spawnSync("bash", [script, tree, dest], { encoding: "utf8", env: { ...process.env, PATH: `${fake}:/usr/bin:/bin` } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "2 file(s) changed\n");
    assert.equal(readFileSync(path.join(work, "seen"), "utf8"), "// app\n", "after rsync has run, the release in use still holds the old content");
    assert.equal(readFileSync(path.join(dest, "stream-api/index.js"), "utf8"), "// next\n");
    assert.ok(!existsSync(path.join(dest, "migrations/baseline/seed.sql")));
    assert.deepEqual(readdirSync(path.join(work, "releases")), ["1.1.0"], "no staging folder left");
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("the beta one-line installer makes a box that follows the beta feed; a box's own channel choice is kept", async () => {
  const b = await box();
  const fresh = mkdtempSync(path.join(tmpdir(), "bb-fresh-"));
  try {
    const base = `http://127.0.0.1:${b.port}`;
    cut(miniTree(path.join(b.home, "tree-beta"), { stub: STUB("1.2.0-beta.1") }), b.feedDir, "1.2.0-beta.1", ["--channel", "beta", "--base-url", base]);
    assert.ok(existsSync(path.join(b.feedDir, "install-beta.sh")) && !existsSync(path.join(b.feedDir, "stable.json")));
    const beta = readFileSync(path.join(b.feedDir, "install-beta.sh"), "utf8");
    assert.match(beta, /^BOOTSTRAP_CHANNEL="beta"$/m, "the beta installer is stamped with its channel");
    const keyFile = path.join(b.home, "key.pub"); writeFileSync(keyFile, `${KEY.pub}\n`);
    // `chown root:` needs root; everything else runs as is. The hook stops after .env (section 4).
    mkdirSync(path.join(b.fake, "root-bin"), { recursive: true });
    writeFileSync(path.join(b.fake, "root-bin/chown"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const install = () => runInstaller(b, null, ["--domain", "example.test", "--mode", "tunnel", "--release-key", keyFile],
      { BB_HOME: fresh, BB_INSTALL_TEST_STOP: "env" }, beta);
    let r = await install();
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const envOf = () => readFileSync(path.join(fresh, ".env"), "utf8");
    assert.match(envOf(), /^BB_UPDATE_CHANNEL=beta$/m);
    assert.match(envOf(), new RegExp(`^BB_UPDATE_FEED=${base.replace(/[.:/]/g, "\\$&")}$`, "m"));
    // The box's first read of its feed is the beta one (there is no stable feed to read).
    mkdirSync(path.join(fresh, "results"));   // section 5's, which the hook stops before
    r = await b.run(["update", "--check"], { BB_HOME: fresh });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const feed = JSON.parse(readFileSync(path.join(fresh, "results/update-feed.json"), "utf8"));
    assert.equal(feed.ok, true); assert.equal(feed.channel, "beta"); assert.equal(feed.current, "1.2.0-beta.1");
    // The operator moves the box to stable; the beta installer run again (a repair) keeps that choice.
    writeFileSync(path.join(fresh, ".env"), envOf().replace(/^BB_UPDATE_CHANNEL=beta$/m, "BB_UPDATE_CHANNEL=stable"));
    r = await install();
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(envOf(), /^BB_UPDATE_CHANNEL=stable$/m, "the box's own choice is kept");
    assert.match(r.stdout, /this box follows the stable channel/);
  } finally { rmSync(fresh, { recursive: true, force: true }); b.close(); }
});

test("an update cut off without finishing says so, instead of 'running' for ever", async () => {
  const b = await box();
  try {
    writeFileSync(path.join(b.home, "results/update-state.json"), `${JSON.stringify({ v: 1, state: "running", from: "1.1.0", to: "1.2.0", step: 7, steps: 8, words: "switching", since: "2026-10-11T00:00:00Z", at: "2026-10-11T00:01:00Z" })}\n`);
    const r = await b.run(["status"]);
    assert.match(r.stdout, /\n {2}last update {2}\S+: the update to 1\.2\.0 STOPPED WITHOUT FINISHING — the update to 1\.2\.0 stopped at step 7 of 8 without finishing/);
    assert.doesNotMatch(r.stdout, /UPDATING/);
    const last = b.json("results/update-last.json");
    assert.equal(last.result, "interrupted"); assert.match(last.message, /stopped at step 7 of 8 without finishing/);
    assert.equal(b.json("results/update-state.json").state, "idle");
  } finally { b.close(); }
});

test("the replay floor is the channel's own: switching channel reads the other channel's feed, and each keeps its floor", async () => {
  const b = await box();
  try {
    b.publish("1.2.0");
    let r = await b.run(["update", "--check"]);
    assert.equal(r.status, 0, r.stderr);
    const feed = JSON.parse(readFileSync(path.join(b.feedDir, "stable.json"), "utf8"));
    const m = JSON.parse(Buffer.from(feed.payload, "base64").toString("utf8"));
    // The beta channel last published before stable did: not a replay of anything this box read on beta.
    writeFileSync(path.join(b.feedDir, "beta.json"), JSON.stringify(signFeed({ ...m, channel: "beta", published: "2026-01-01T00:00:00Z" }, KEY.pem)));
    r = await b.run(["update", "--channel", "beta"]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(b.json("results/update-feed.json").ok, true);
    assert.equal(b.json("results/update-feed.json").channel, "beta");
    // Back on stable, an older stable feed is still a replay: stable's floor was kept.
    writeFileSync(path.join(b.feedDir, "stable.json"), JSON.stringify(signFeed({ ...m, published: "2026-01-01T00:00:00Z" }, KEY.pem)));
    r = await b.run(["update", "--channel", "stable"]);
    assert.notEqual(r.status, 0);
    assert.match(b.json("results/update-feed.json").error, /a replayed feed/);
  } finally { b.close(); }
  // A box from before: its one floor is the channel it is on.
  const c = await box();
  try {
    c.publish("1.2.0");
    writeFileSync(path.join(c.home, "state/update-feed-published"), "2099-01-01T00:00:00Z\n");
    const r = await c.run(["update", "--check"]);
    assert.notEqual(r.status, 0);
    assert.match(c.json("results/update-feed.json").error, /before 2099-01-01T00:00:00Z\): a replayed feed/);
    assert.ok(existsSync(path.join(c.home, "state/update-feed-published.stable")));
  } finally { c.close(); }
  // A box from before whose first command switches channel: its one floor is the channel it WAS on,
  // never the one it switches to — beta's own (older) feed is not a replay of stable's.
  const d = await box();
  try {
    d.publish("1.2.0");
    const feed = JSON.parse(readFileSync(path.join(d.feedDir, "stable.json"), "utf8"));
    const m = JSON.parse(Buffer.from(feed.payload, "base64").toString("utf8"));
    writeFileSync(path.join(d.feedDir, "beta.json"), JSON.stringify(signFeed({ ...m, channel: "beta", published: "2026-01-01T00:00:00Z" }, KEY.pem)));
    writeFileSync(path.join(d.home, "state/update-feed-published"), "2026-06-01T00:00:00Z\n");
    const r = await d.run(["update", "--channel", "beta"]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(d.json("results/update-feed.json").ok, true, "beta's feed is read, not refused as replayed");
    assert.equal(readFileSync(path.join(d.home, "state/update-feed-published.stable"), "utf8"), "2026-06-01T00:00:00Z\n", "stable keeps its floor");
    assert.equal(readFileSync(path.join(d.home, "state/update-feed-published.beta"), "utf8"), "2026-01-01T00:00:00Z\n", "beta's floor is beta's own");
    assert.ok(!existsSync(path.join(d.home, "state/update-feed-published")));
  } finally { d.close(); }
});

// The stand-in step is hanging: its pid is written. Wait for that, then stop the update as systemd would.
async function stopMidStep(b, run) {
  const pidFile = path.join(b.fake, "hang.pid");
  for (let i = 0; i < 600 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(pidFile), "the step never started");
  run.child.kill("SIGTERM");
  const r = await run.done;
  try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* already gone */ }
  return r;
}

test("an update stopped while the site is down for its backup starts the site again, and says so", async () => {
  const b = await box();
  try {
    b.publish("1.2.0");
    writeFileSync(path.join(b.fake, "backup-hang"), "");
    const before = b.env();
    const r = await stopMidStep(b, b.spawnRun(["update", "--apply", "1.2.0"]));
    assert.notEqual(r.status, 0, r.stdout);
    const calls = b.calls();
    const stop = calls.search(/^compose stop web stream-ingest stream-api mas synapse$/m);
    const up = calls.search(/^compose up -d$/m);
    assert.ok(stop >= 0, "the update got as far as stopping the site");
    assert.ok(up > stop, `the site was started again after the stop:\n${calls}`);
    assert.equal(b.release(), "releases/1.1.0"); assert.equal(b.env(), before, "nothing switched");
    const last = b.json("results/update-last.json");
    assert.equal(last.result, "interrupted"); assert.match(last.message, /stopped before it switched; 1\.1\.0 was started again/);
    assert.equal(b.json("results/update-state.json").state, "idle");
    assert.ok(!existsSync(path.join(b.home, "state/update/progress")), "nothing left for a reconcile to redo");
  } finally { b.close(); }
});

test("an update stopped after switching goes back to the previous release and its data, and says so", async () => {
  const b = await box();
  try {
    b.publish("1.2.0");
    writeFileSync(path.join(b.fake, "up-hang"), "");
    const before = b.env();
    const r = await stopMidStep(b, b.spawnRun(["update", "--apply", "1.2.0"]));
    assert.notEqual(r.status, 0, r.stdout);
    assert.equal(b.release(), "releases/1.1.0", "the previous release is back");
    assert.equal(b.env(), before, ".env is exactly as it was");
    assert.deepEqual(b.stub().trim().split("\n"), ["1.2.0 render --check", "1.2.0 up", "1.1.0 restore 5eed5eed5eed5eed --yes", "1.1.0 health"]);
    const last = b.json("results/update-last.json");
    assert.equal(last.result, "rolled-back"); assert.match(last.message, /was stopped before it finished/);
    assert.ok(!existsSync(path.join(b.home, "state/update/progress")));
  } finally { b.close(); }
});

test("an update that stops on an error while the site is down starts the site again, and says so (not 'running' until the next boot)", async () => {
  const b = await box();
  try {
    b.publish("1.2.0");
    writeFileSync(path.join(b.fake, "block-progress"), "");
    const before = b.env();
    const r = await b.run(["update", "--apply", "1.2.0"]);
    assert.notEqual(r.status, 0, r.stdout);
    const calls = b.calls();
    const stop = calls.search(/^compose stop web stream-ingest stream-api mas synapse$/m);
    const up = calls.search(/^compose up -d$/m);
    assert.ok(stop >= 0, "the update got as far as stopping the site");
    assert.ok(up > stop, `the site was started again after the stop:\n${calls}`);
    assert.equal(b.release(), "releases/1.1.0"); assert.equal(b.env(), before, "nothing switched");
    assert.doesNotMatch(b.stub(), /restore/, "nothing switched, so no data is restored");
    const last = b.json("results/update-last.json");
    assert.equal(last.result, "interrupted"); assert.match(last.message, /stopped on an error \(exit \d+\) before it switched; 1\.1\.0 was started again/);
    assert.equal(b.json("results/update-state.json").state, "idle");
    assert.ok(!existsSync(path.join(b.home, "state/update/progress")), "nothing left for a reconcile to redo");
  } finally { b.close(); }
});

test("an update that stops on an error after switching goes back to the previous release and its data", async () => {
  const b = await box();
  try {
    b.publish("1.2.0");
    writeFileSync(path.join(b.fake, "lose-env-next"), "");
    const before = b.env();
    const r = await b.run(["update", "--apply", "1.2.0"]);
    assert.notEqual(r.status, 0, r.stdout);
    assert.equal(b.release(), "releases/1.1.0", "the previous release is back");
    assert.equal(b.env(), before, ".env is exactly as it was");
    assert.doesNotMatch(b.stub(), /^1\.2\.0 up$/m, "the next release never started on the old .env");
    assert.match(b.stub(), /^1\.1\.0 restore 5eed5eed5eed5eed --yes$/m);
    const last = b.json("results/update-last.json");
    assert.equal(last.result, "rolled-back"); assert.match(last.message, /could not put \.env in place/);
    assert.equal(b.json("results/update-state.json").state, "idle");
    assert.ok(!existsSync(path.join(b.home, "state/update/progress")));
  } finally { b.close(); }
});

test("an update cut off by a power loss: the next update command starts the stopped site again, or finishes going back", async () => {
  // At the stop step: the site is down (restart: unless-stopped keeps it down across a reboot).
  let b = await box();
  try {
    b.publish("1.2.0");
    writeFileSync(path.join(b.home, "results/update-state.json"), `${JSON.stringify({ v: 1, state: "running", from: "1.1.0", to: "1.2.0", step: 6, steps: 8, words: "stopping the site and backing up", since: "2026-10-11T00:00:00Z", at: "2026-10-11T00:01:00Z" })}\n`);
    mkdirSync(path.join(b.home, "state/update"), { recursive: true });
    writeFileSync(path.join(b.home, "state/update/progress"), "phase=stopped\nprev=\nsnap=\n");
    const r = await b.run(["update", "--check"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(b.calls(), /^compose up -d$/m, "the stopped site is started again");
    assert.equal(b.json("results/update-last.json").result, "interrupted");
    assert.match(b.json("results/update-last.json").message, /1\.1\.0 was started again/);
    assert.equal(b.json("results/update-state.json").state, "idle");
    assert.ok(!existsSync(path.join(b.home, "state/update/progress")));
  } finally { b.close(); }
  // After the switch: release/ already names the new version, so "up to date" would hide it — go back.
  b = await box();
  try {
    b.installRelease("1.2.0");
    rmSync(path.join(b.home, "release")); symlinkSync("releases/1.2.0", path.join(b.home, "release"));
    const before = b.env();
    writeFileSync(path.join(b.home, ".env"), before.replace(/^BB_RELEASE=.*$/m, "BB_RELEASE=1.2.0"), { mode: 0o600 });
    mkdirSync(path.join(b.home, "state/update"), { recursive: true });
    writeFileSync(path.join(b.home, "state/update/env.before"), before, { mode: 0o600 });
    writeFileSync(path.join(b.home, "state/update/progress"), "phase=switched\nprev=releases/1.1.0\nsnap=5eed5eed5eed5eed\n");
    writeFileSync(path.join(b.home, "results/update-state.json"), `${JSON.stringify({ v: 1, state: "running", from: "1.1.0", to: "1.2.0", step: 7, steps: 8, words: "switching", since: "2026-10-11T00:00:00Z", at: "2026-10-11T00:01:00Z" })}\n`);
    // `status` only reads: it says what a reconcile would do and changes nothing.
    const st = await b.run(["status"]);
    assert.match(st.stdout, /blackbranch update --reconcile/);
    assert.equal(b.release(), "releases/1.2.0");
    const r = await b.run(["update", "--reconcile"]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(b.release(), "releases/1.1.0");
    assert.equal(b.env(), before);
    assert.match(b.stub(), /^1\.1\.0 restore 5eed5eed5eed5eed --yes$/m);
    assert.equal(b.json("results/update-last.json").result, "rolled-back");
    assert.equal(b.json("results/update-state.json").state, "idle");
  } finally { b.close(); }
  // The boot unit runs the reconcile; the update units give the cleanup time and the signal.
  const boot = read("systemd/blackbranch-reconcile.service");
  assert.match(boot, /\nExecStart=\/usr\/local\/bin\/blackbranch update --reconcile\n/); assert.match(boot, /\nWantedBy=multi-user\.target\n/);
  assert.match(boot, /\nAfter=docker\.service network-online\.target\n/);
  for (const u of ["blackbranch-update@.service", "blackbranch-update.service"]) {
    assert.match(read(`systemd/${u}`), /\nKillMode=mixed\n/, u); assert.match(read(`systemd/${u}`), /\nTimeoutStopSec=\d+min\n/, u);
  }
  assert.match(read("blackbranch"), /\nBUNDLE_UNITS=\([^)]*blackbranch-reconcile\.service/);
});

// ── when putting the box back itself fails ───────────────────────────────────────────────────
// The site stopped for the backup is only "started again" once compose started it AND every
// service is healthy. Until then the record says the site is DOWN, and the progress marker stays,
// so the boot unit (and the next update command) try again.
const FAILED_RESTART = /starting 1\.1\.0 again FAILED \([^)]+\): the site is down/;
const progress = (b) => b.file("state/update/progress");

test("an update stopped while the site is down, whose restart fails: the record says the site is down, and the marker stays for the reconcile", async () => {
  const b = await box();
  try {
    b.publish("1.2.0");
    writeFileSync(path.join(b.fake, "backup-hang"), "");
    writeFileSync(path.join(b.fake, "up-fails"), "");
    const r = await stopMidStep(b, b.spawnRun(["update", "--apply", "1.2.0"]));
    assert.notEqual(r.status, 0, r.stdout);
    const last = b.json("results/update-last.json");
    assert.equal(last.result, "interrupted"); assert.equal(last.ok, false);
    assert.match(last.message, FAILED_RESTART);
    assert.doesNotMatch(last.message, /was started again/, "never reported as started when it was not");
    assert.match(progress(b), /^phase=stopped$/m, "the marker stays for the boot's reconcile");
    assert.equal(b.json("results/update-state.json").state, "idle");
    assert.equal((b.calls().match(/^compose up -d$/gm) ?? []).length, 1, "put back once, not again by the exit trap");
    // The cause goes away; the boot unit's reconcile starts the site and only then clears the marker.
    rmSync(path.join(b.fake, "up-fails"));
    const rc = await b.run(["update", "--reconcile"]);
    assert.equal(rc.status, 0, `${rc.stdout}\n${rc.stderr}`);
    assert.match(b.json("results/update-last.json").message, /1\.1\.0 was started again/);
    assert.equal(progress(b), "", "cleared once the site is up and healthy");
  } finally { b.close(); }
});

test("an update that stops on an error while the site is down, whose services do not come back healthy: not reported as started", async () => {
  const b = await box();
  try {
    b.publish("1.2.0");
    writeFileSync(path.join(b.fake, "block-progress"), "");
    writeFileSync(path.join(b.fake, "unhealthy-after-backup"), "");
    const r = await b.run(["update", "--apply", "1.2.0"], { BB_HEALTH_WAIT: "1" });
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(b.calls(), /^compose up -d$/m, "it tried");
    const last = b.json("results/update-last.json");
    assert.equal(last.result, "interrupted"); assert.match(last.message, FAILED_RESTART);
    // Named (install verification pass, item 9c): which services, in which state.
    assert.match(last.message, /not every service became healthy: postgres:unhealthy .*web:unhealthy/);
    assert.match(progress(b), /^phase=stopped$/m);
    assert.match(r.stderr, /the site is down/, "said on the terminal too");
  } finally { b.close(); }
});

test("a backup that fails and a site that will not start again: 'site down', never 'nothing was changed' alone", async () => {
  const b = await box();
  try {
    b.publish("1.2.0");
    writeFileSync(path.join(b.fake, "backup-fails"), "");
    writeFileSync(path.join(b.fake, "up-fails"), "");
    const r = await b.run(["update", "--apply", "1.2.0"]);
    assert.notEqual(r.status, 0, r.stdout);
    const last = b.json("results/update-last.json");
    assert.equal(last.result, "interrupted"); assert.match(last.message, FAILED_RESTART);
    assert.match(last.message, /the backup before the update failed/);
    assert.match(progress(b), /^phase=stopped$/m);
    assert.equal(b.release(), "releases/1.1.0");
  } finally { b.close(); }
});

test("a reconcile whose restart fails keeps the marker, says so, and fails the boot unit; an update will not start on top of it", async () => {
  const b = await box();
  try {
    b.publish("1.2.0");
    writeFileSync(path.join(b.home, "results/update-state.json"), `${JSON.stringify({ v: 1, state: "running", from: "1.1.0", to: "1.2.0", step: 6, steps: 8, words: "stopping the site and backing up", since: "2026-10-11T00:00:00Z", at: "2026-10-11T00:01:00Z" })}\n`);
    mkdirSync(path.join(b.home, "state/update"), { recursive: true });
    writeFileSync(path.join(b.home, "state/update/progress"), "phase=stopped\nprev=\nsnap=\n");
    writeFileSync(path.join(b.fake, "up-fails"), "");
    let r = await b.run(["update", "--reconcile"]);
    assert.notEqual(r.status, 0, "the boot unit shows failed");
    assert.match(b.json("results/update-last.json").message, FAILED_RESTART);
    assert.match(progress(b), /^phase=stopped$/m);
    r = await b.run(["update", "--apply", "1.2.0"]);
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(b.calls(), /^compose stop /m, "no update starts while the last one's site is still down");
    assert.equal(b.release(), "releases/1.1.0");
    // `status` reads, retries the start, and still prints the rest.
    r = await b.run(["status"]);
    assert.match(r.stdout, /SERVICE/);
  } finally { b.close(); }
});

test("an update whose release is healthy but whose clean-up afterwards fails is recorded as updated, never as 'not applied'", async () => {
  const b = await box();
  const locked = () => path.join(b.home, "releases/1.0.0/locked");
  try {
    b.installRelease("1.0.0");
    mkdirSync(locked()); writeFileSync(path.join(locked(), "f"), "x"); execFileSync("chmod", ["555", locked()]);
    b.publish("1.2.0");
    const r = await b.run(["update", "--apply", "1.2.0"]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(b.release(), "releases/1.2.0");
    const last = b.json("results/update-last.json");
    assert.equal(last.result, "updated"); assert.equal(last.ok, true);
    assert.match(last.message, /dropping older releases did not finish/);
    assert.equal(b.json("results/update-state.json").state, "idle");
    assert.ok(!existsSync(path.join(b.home, "state/update/env.before")), "no copy of .env is left behind");
  } finally { try { execFileSync("chmod", ["755", locked()]); } catch { /* gone */ } b.close(); }
});

test(".env migration 002: a box from before gets caddy's address beside cloudflared's, in its own subnet", () => {
  const home = mkdtempSync(path.join(tmpdir(), "bb-envm2-"));
  try {
    const f = path.join(home, ".env");
    const run = () => spawnSync("bash", [path.join(here, "migrations/002-caddy-address.sh")], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", BB_ENV_FILE: f } });
    for (const [cf, want] of [["198.51.100.250", "198.51.100.249"], ["172.29.83.250", "172.29.83.249"], ["", "172.29.83.249"]]) {
      writeFileSync(f, `BB_SUBNET=x\n${cf ? `BB_CLOUDFLARED_IP=${cf}\n` : ""}`, { mode: 0o600 });
      const r = run(); assert.equal(r.status, 0, r.stderr);
      assert.match(readFileSync(f, "utf8"), new RegExp(`^BB_CADDY_IP=${want.replace(/\./g, "\\.")}$`, "m"), cf);
    }
    writeFileSync(f, "BB_CLOUDFLARED_IP=198.51.100.250\nBB_CADDY_IP=198.51.100.7\n", { mode: 0o600 });
    assert.equal(run().status, 0);
    assert.equal(readFileSync(f, "utf8"), "BB_CLOUDFLARED_IP=198.51.100.250\nBB_CADDY_IP=198.51.100.7\n", "a box's own choice is kept");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test(".env migrations: run in number order, each once; the dry run touches only its copy", () => {
  const home = mkdtempSync(path.join(tmpdir(), "bb-envm-"));
  try {
    const rel = path.join(home, "rel");
    mkdirSync(path.join(rel, "install/migrations"), { recursive: true });
    cpSync(path.join(here, "migrations/lib.sh"), path.join(rel, "install/migrations/lib.sh"));
    cpSync(path.join(here, "migrations/001-update-channel.sh"), path.join(rel, "install/migrations/001-update-channel.sh"));
    writeFileSync(path.join(rel, "install/migrations/002-r.sh"), '. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"\nenvm_rename OLD_NAME NEW_NAME\nenvm_drop GONE\n');
    writeFileSync(path.join(rel, "install/migrations/010-a.sh"), '. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"\nenvm_add ADDED "x y"\nenvm_add NEW_NAME ignored\n');
    writeFileSync(path.join(home, ".env"), 'BB_DOMAIN=example.test\nOLD_NAME="kept value"\nGONE=1\n', { mode: 0o600 });
    const bb = (...a) => spawnSync("bash", ["-c", `. <(sed -n '/^env_migrations() {/,/^}/p;/^env_get() {/,/^}/p;/^env_quote() {/p;/^replace_file() {/,/^}/p;/^env_set() {/,/^}/p;/^env_file_get() {/p;/^env_file_set() {/p' "$1") && env_migrations "$2" "$3"`, "_", path.join(here, "blackbranch"), ...a],
      { encoding: "utf8", env: { ...process.env, BB_HOME: home, ENV_FILE: path.join(home, ".env") } });
    let r = bb(rel, path.join(home, ".env"));
    assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), "3");
    const env = readFileSync(path.join(home, ".env"), "utf8");
    assert.match(env, /^NEW_NAME="kept value"$/m, "a rename keeps the value as written"); assert.doesNotMatch(env, /^OLD_NAME=|^GONE=/m);
    assert.match(env, /^ADDED=x y$/m); assert.match(env, /^BB_UPDATE_CHANNEL=stable$/m); assert.match(env, /^BB_ENV_VERSION="10"$/m);
    assert.equal(statSync(path.join(home, ".env")).mode & 0o777, 0o600);
    r = bb(rel, path.join(home, ".env"));
    assert.equal(r.stdout.trim(), "0", "each runs once");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// A homeserver, an account server, a site and stream-api's socket in one small server: what the
// probes ask of each, answered the way the real ones answer (or not, per `mode`).
async function probeServer(mode = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url.split("?")[0]}`);
    const send = (code, body, headers = {}) => { res.writeHead(code, { "Content-Type": "application/json", ...headers }); res.end(body ? JSON.stringify(body) : ""); };
    if (req.method === "POST" && req.url === "/api/auth/mas-initiate") return send(200, { authorizationUrl: `${base}/auth/authorize?client_id=c&redirect_uri=x` });
    if (req.url.startsWith("/auth/authorize")) return mode.authorize ? send(mode.authorize, { error: "invalid_redirect_uri" }) : send(303, null, { Location: "/auth/login" });
    if (req.url === "/_matrix/client/v3/account/whoami") return req.headers.authorization === "Bearer mct_good" && !mode.whoami ? send(200, { user_id: "@op:example.test" }) : send(401, { errcode: "M_UNKNOWN_TOKEN" });
    if (req.url === "/_matrix/client/v3/logout") return send(200, {});
    send(404, {});
  });
  server.on("upgrade", (req, socket) => {
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    if (mode.silentSocket) return;
    const payload = Buffer.from(JSON.stringify({ type: "timerState" }));
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const probe = (stdin) => new Promise((resolve) => {
    const c = execFile(process.execPath, [path.join(here, "update/probe.mjs")], {
      encoding: "utf8", timeout: 30_000,
      env: { ...process.env, BB_PROBE_WS: `${base.replace("http", "ws")}/`, BB_PROBE_SITE: base, MATRIX_OAUTH_ISSUER: `${base}/auth/`, MATRIX_HOMESERVER_URL: base, BB_PROBE_WAIT_MS: "1500" },
    }, (err, stdout) => resolve({ status: err ? err.code : 0, out: JSON.parse(stdout) }));
    c.stdin.end(stdin);
  });
  return { probe, seen, base, close: () => server.close() };
}

test("the probes: a WebSocket frame, the site's sign-in start accepted by the account server, a token it issued working — each failing on its own", async () => {
  let s = await probeServer();
  try {
    const r = await s.probe("mct_good @op:example.test\n");
    assert.equal(r.status, 0, JSON.stringify(r.out));
    assert.deepEqual(Object.fromEntries(Object.entries(r.out).map(([k, v]) => [k, v.ok])), { ws: true, signin: true, whoami: true });
    assert.equal(r.out.ws.detail, "a timerState frame on connect");
    assert.ok(s.seen.includes("POST /_matrix/client/v3/logout"), "the token is ended after use");
    const none = await s.probe("\n");
    assert.equal(none.status, 0); assert.equal(none.out.whoami.ok, null, "no account yet: not checked, not failed");
  } finally { s.close(); }
  for (const [mode, key, says] of [[{ silentSocket: true }, "ws", /no frame within 1\.5 s/], [{ authorize: 400 }, "signin", /answered the site's sign-in request with 400/], [{ whoami: true }, "whoami", /refused by the homeserver \(401\)/]]) {
    s = await probeServer(mode);
    try {
      const r = await s.probe("mct_good @op:example.test\n");
      assert.equal(r.status, 1, key); assert.equal(r.out[key].ok, false, key); assert.match(r.out[key].detail, says);
      for (const other of ["ws", "signin", "whoami"].filter((k) => k !== key)) assert.equal(r.out[other].ok, true, `${key}'s failure left ${other} alone`);
    } finally { s.close(); }
  }
});

test("blackbranch health: the release's own doctor verdict and probes, one BBHEALTH line; red when the router does not answer", async () => {
  const b = await box();
  const s = await probeServer();
  try {
    const site = path.join(b.fake, "site.json");
    writeFileSync(site, JSON.stringify({ v: 1, at: "2026-10-11T00:00:00Z", db: { reachable: true, version: 144, baseline: true, vector: "0.8.0" },
      matrix: { versions: 200, mas: 200, issuer: true, wellKnownClient: true, wellKnownServer: true, federation: { switch: false, reachable: false } },
      secrets: { missing: [], token: "none", stored: { total: 0, unreadable: 0 } }, modules: [], skipped: [], heldOn: [] }));
    const r = await b.run(["health"], { BB_DOCTOR_NODE: process.execPath, BB_DOCTOR_SITE_FACTS: site, BB_PROBE_NODE: process.execPath, BB_PROBE_WAIT_MS: "1000" });
    assert.notEqual(r.status, 0);
    const line = r.stdout.split("\n").find((l) => l.startsWith("BBHEALTH "));
    assert.ok(line, r.stdout);
    const h = JSON.parse(line.slice(9));
    assert.equal(h.ok, false); assert.ok(h.failed.includes("door.answers"), "this box's router does not answer here");
    assert.match(r.stdout, /\[FAIL\] The site, api\. and matrix\. answer by name/);
  } finally { s.close(); b.close(); }
});

// R1.1 — a direct-mode box behind a home router with no NAT hairpin: its public names do not reach
// it from inside. A stand-in curl answers 200 only when it is pointed at this box's own port 443
// (--resolve <name>:443:127.0.0.1) and verifies the real certificate (no -k, no lab CA); asked by
// the public name it gets nothing, as such a box does.
const NO_HAIRPIN_CURL = `#!/usr/bin/env bash
case "$*" in *example.test*) ;; *) exec /usr/bin/curl "$@" ;; esac   # the update feed: the real curl
echo "curl $*" >> "$FAKE/curl-calls"
box=0; for a in "$@"; do case "$a" in *:443:127.0.0.1) box=1 ;; -k|--insecure|--cacert) box=0; break ;; esac; done
if [ "$box" = 1 ]; then printf 200; exit 0; fi
printf 000; exit 7
`;
const healthySite = (b) => {
  const site = path.join(b.fake, "site.json");
  writeFileSync(site, JSON.stringify({ v: 1, at: "2026-10-11T00:00:00Z", db: { reachable: true, version: DOCTOR.SCHEMA_VERSION, baseline: true, vector: "0.8.0" },
    matrix: { versions: 200, mas: 200, issuer: true, wellKnownClient: true, wellKnownServer: true, federation: { switch: false, reachable: false } },
    secrets: { missing: [], token: "none", stored: { total: 0, unreadable: 0 } }, modules: [], skipped: [], heldOn: [] }));
  return site;
};
// A direct-mode box whose config renders (MAS's key is 32 bytes of hex), rendered once — so the
// doctor's "rendered files match" row is judged on real files, as on a box.
const renderedDirect = async (b) => {
  writeFileSync(path.join(b.home, ".env"), b.env().replace(/^MAS_ENCRYPTION_SECRET=.*$/m, `MAS_ENCRYPTION_SECRET=${"e".repeat(64)}`), { mode: 0o600 });
  writeFileSync(path.join(b.home, "matrix/mas-keys.yaml"), "  keys:\n  - key: |\n      -----BEGIN EC PRIVATE KEY-----\n      test-only\n      -----END EC PRIVATE KEY-----\n", { mode: 0o600 });
  const r = await b.run(["render"]);
  assert.equal(r.status, 0, r.stderr);
  // No certificate to read here (the certificates row is the doctor's, not the update's): say so at once.
  writeFileSync(path.join(b.fake, "bin/openssl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  // The public names do not resolve here at all — the brief's case: they do not lead to this box.
  writeFileSync(path.join(b.fake, "bin/getent"), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
};
const probeEnv = (s) => ({ BB_PROBE_NODE: process.execPath, BB_PROBE_WAIT_MS: "1500", BB_PROBE_WS: `${s.base.replace("http", "ws")}/`, BB_PROBE_SITE: s.base,
  MATRIX_OAUTH_ISSUER: `${s.base}/auth/`, MATRIX_HOMESERVER_URL: s.base });

test("direct mode without a NAT hairpin: blackbranch health asks caddy on this box by name and passes; the public names are not asked", async () => {
  const b = await box({ tls: "direct" });
  const s = await probeServer();
  try {
    writeFileSync(path.join(b.fake, "bin/curl"), NO_HAIRPIN_CURL, { mode: 0o755 });
    await renderedDirect(b);
    const r = await b.run(["health"], { BB_DOCTOR_NODE: process.execPath, BB_DOCTOR_SITE_FACTS: healthySite(b), ...probeEnv(s) });
    const line = r.stdout.split("\n").find((l) => l.startsWith("BBHEALTH "));
    assert.ok(line, r.stdout + r.stderr);
    const h = JSON.parse(line.slice(9));
    assert.deepEqual(h.failed, [], r.stdout);
    assert.equal(h.ok, true, r.stdout);
    assert.equal(r.status, 0);
    const curls = b.file("fake/curl-calls").trim().split("\n");
    assert.equal(curls.length, 3, "one request per name, all to the box itself");
    for (const c of curls) {
      assert.match(c, /--resolve (api\.|matrix\.)?example\.test:443:127\.0\.0\.1 /, c);
      assert.doesNotMatch(c, / -k | --cacert /, "the real certificate is verified");
    }
    // The doctor (not the update) also asks by the public names, and says so as a warning.
    const d = await b.run(["doctor"], { BB_DOCTOR_NODE: process.execPath, BB_DOCTOR_SITE_FACTS: healthySite(b) });
    assert.match(d.stdout, /\[ok {2}\] The site, api\. and matrix\. answer by name — all three answer \(asked at this box's own router\)/, d.stdout);
    assert.match(d.stdout, /\[warn\] Reachable from outside by the public names — the site, api\. and matrix\. did not answer this box by their public names/);
    assert.equal(b.file("fake/curl-calls").trim().split("\n").filter((c) => !c.includes(":443:127.0.0.1")).length, 3, "the doctor asked each public name once");
  } finally { s.close(); b.close(); }
});

test("an update on a direct-mode box whose public names do not reach it completes: the next release's real health check passes", async () => {
  const b = await box({ tls: "direct" });
  const s = await probeServer();
  try {
    writeFileSync(path.join(b.fake, "bin/curl"), NO_HAIRPIN_CURL, { mode: 0o755 });
    await renderedDirect(b);
    // The next release's command: the stub for everything but its health check, which is this repo's own.
    b.publish("1.2.0", { stub: STUB("1.2.0").replace('case "$1" in\n  health)', `case "$1" in\n  health) exec bash ${JSON.stringify(path.join(here, "blackbranch"))} health ;;\n  health-stub)`) });
    const r = await b.run(["update", "--apply", "1.2.0"], { BB_DOCTOR_NODE: process.execPath, BB_DOCTOR_SITE_FACTS: healthySite(b), ...probeEnv(s) });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(b.release(), "releases/1.2.0");
    const last = b.json("results/update-last.json");
    assert.equal(last.result, "updated", JSON.stringify(last));
    assert.equal(last.health.ok, true);
    assert.deepEqual(last.health.failed, []);
    assert.ok(b.file("fake/curl-calls").trim().split("\n").every((c) => c.includes(":443:127.0.0.1")), "the update never asked by the public names");
  } finally { s.close(); b.close(); }
});

// The owner's security review: a chat reader that RAN before an update and has FAILED after it fails
// the update's health check (a browser missing from the new image, say), and the box goes back. A
// reader already failed before never blocks; one still starting is waited for; no answer before the
// update means nothing to compare.
const readers = (r) => JSON.stringify({ answered: true, ok: Object.values(r).every((x) => x.state === "running"),
  readers: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { state: v.state, since: null, error: v.error ?? "" }])) });
const updateWithReaders = async (lines, extra = {}) => {
  const b = await box();
  b.publish("1.2.0");
  if (lines) writeFileSync(path.join(b.fake, "readers"), `${lines.join("\n")}\n`);
  const r = await b.run(["update", "--apply", "1.2.0"], { BB_READERS_POLL: "0", BB_READERS_WAIT: "30", ...extra });
  return { b, r, last: b.json("results/update-last.json"), asked: b.file("fake/readers-asked").split("\n").filter(Boolean).length };
};

test("chat readers: a reader running before the update and failed after it rolls the update back, and the reason names the reader", async () => {
  const { b, r, last } = await updateWithReaders([
    readers({ twitch: { state: "running" }, youtube: { state: "running" } }),
    readers({ twitch: { state: "running" }, youtube: { state: "failed", error: "browserType.launch: Executable doesn't exist" } }),
  ]);
  try {
    assert.notEqual(r.status, 0, r.stdout);
    assert.equal(last.result, "rolled-back", JSON.stringify(last));
    assert.match(last.message, /failed its health check: a chat reader that ran before the update failed after it — YouTube: browserType\.launch: Executable doesn't exist/);
    assert.doesNotMatch(last.message, /Twitch/, "the reader that still runs is not blamed");
    assert.equal(last.health.ok, false); assert.match(last.health.failed[0], /YouTube: browserType\.launch/);
    assert.equal(b.release(), "releases/1.1.0", "back on the release before");
  } finally { b.close(); }
});

test("chat readers: a reader failed before the update and after it does not block — the update completes", async () => {
  const { b, r, last } = await updateWithReaders([
    readers({ twitch: { state: "running" }, kick: { state: "failed", error: "Forbidden" } }),
    readers({ twitch: { state: "running" }, kick: { state: "failed", error: "Forbidden" } }),
  ]);
  try {
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(last.result, "updated"); assert.equal(b.release(), "releases/1.2.0");
    assert.match(r.stderr, /chat readers: every one that ran before the update runs \(twitch\)/);
  } finally { b.close(); }
  // Nor does one the settings no longer switch on (off after the update).
  const off = await updateWithReaders([readers({ youtube: { state: "running" } }), readers({ youtube: { state: "off" } })]);
  try { assert.equal(off.last.result, "updated", JSON.stringify(off.last)); } finally { off.b.close(); }
});

test("chat readers: a reader still starting after the update is waited for within its start period, then judged", async () => {
  // Starting twice, then running: waited for, and the update completes.
  const ok = await updateWithReaders([
    readers({ youtube: { state: "running" } }),
    readers({ youtube: { state: "starting" } }), readers({ youtube: { state: "starting" } }), readers({ youtube: { state: "running" } }),
  ]);
  try {
    assert.equal(ok.last.result, "updated", JSON.stringify(ok.last));
    assert.equal(ok.asked, 4, "asked before, then until the reader left `starting`");
  } finally { ok.b.close(); }
  // Starting, then failed: the wait ends on the verdict, which rolls back.
  const bad = await updateWithReaders([
    readers({ youtube: { state: "running" } }), readers({ youtube: { state: "starting" } }), readers({ youtube: { state: "failed", error: "the chat page did not load" } }),
  ]);
  try {
    assert.equal(bad.last.result, "rolled-back");
    assert.match(bad.last.message, /YouTube: the chat page did not load/);
  } finally { bad.b.close(); }
});

test("chat readers: stream-ingest not answering before the update skips the comparison, says so, and the update completes", async () => {
  const { b, r, last } = await updateWithReaders(null);
  try {
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(last.result, "updated");
    assert.match(r.stderr, /chat readers: stream-ingest did not answer before the update — nothing to compare, not checked/);
  } finally { b.close(); }
  // `blackbranch health` alone has no before: it never compares readers (its host facts do not ask them).
  assert.match(read("blackbranch"), /\n {2}if \[ "\$\{1:-\}" = health \]; then printf '"ingest":null,"tts":null,"setup":null,'\n/);
  assert.doesNotMatch(read("blackbranch").slice(read("blackbranch").indexOf("cmd_health() {"), read("blackbranch").indexOf("cmd=\"${1:-}\"")), /readers_check/);
});

// The owner's reviewer: a reader regression is judged once, and the nightly timer never retried a
// rolled-back version — so one platform blip during the nightly update skipped that release for
// good. Now the reason is recorded, and a release whose ONLY failure was a reader is tried again,
// three nights in all; a real health failure keeps the old rule.
const RUNNING = readers({ youtube: { state: "running" } });
const FAILED = readers({ youtube: { state: "failed", error: "the chat page did not load" } });
const night = (b, lines) => {
  if (lines) writeFileSync(path.join(b.fake, "readers"), `${lines.join("\n")}\n`);
  return b.run(["update", "--auto"], { BB_READERS_POLL: "0", BB_READERS_WAIT: "5" });
};

test("reader retry: a reader blip during the nightly update rolls back as reader-regression; the next night's --auto retries it and succeeds", async () => {
  const b = await box();
  try {
    b.publish("1.2.0", { security: true });
    let r = await night(b, [RUNNING, FAILED]);
    let last = b.json("results/update-last.json");
    assert.equal(last.result, "rolled-back", `${r.stdout}\n${r.stderr}`);
    assert.equal(last.reason, "reader-regression"); assert.equal(last.attempts, 1);
    assert.match(last.message, /YouTube: the chat page did not load/, "the reader is named");
    assert.equal(b.release(), "releases/1.1.0");
    // The platform is back the next night.
    r = await night(b, [RUNNING, RUNNING]);
    assert.match(r.stdout, /1\.2\.0 went back last time only because a chat reader failed: trying it again \(attempt 2 of 3\)/);
    last = b.json("results/update-last.json");
    assert.equal(last.result, "updated", `${r.stdout}\n${r.stderr}`); assert.equal(b.release(), "releases/1.2.0");
  } finally { b.close(); }
});

test("reader retry: a reader that fails every night is rolled back each night, then parked after 3 attempts with the reason in blackbranch status", async () => {
  const b = await box();
  try {
    b.publish("1.2.0", { security: true });
    for (const n of [1, 2, 3]) {
      await night(b, [RUNNING, FAILED]);
      const last = b.json("results/update-last.json");
      assert.equal(last.result, "rolled-back"); assert.equal(last.reason, "reader-regression"); assert.equal(last.attempts, n, `night ${n}`);
    }
    const stops = (b.calls().match(/^compose stop web stream-ingest stream-api mas synapse$/gm) ?? []).length;
    const r = await night(b, [RUNNING, FAILED]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /1\.2\.0 is parked: 3 nights in a row a chat reader that ran before it failed after it — the timer does not try it again/);
    assert.equal((b.calls().match(/^compose stop web stream-ingest stream-api mas synapse$/gm) ?? []).length, stops, "the fourth night changes nothing");
    assert.equal(b.json("results/update-last.json").attempts, 3);
    const st = await b.run(["status"]);
    assert.match(st.stdout, /1\.2\.0 FAILED .*YouTube: the chat page did not load.* — PARKED after 3 attempts, each failed only by a chat reader: the timer does not try it again/);
  } finally { b.close(); }
});

test("reader retry: a health failure that is not a reader is not retried by the timer, as before", async () => {
  const b = await box();
  try {
    b.publish("1.2.0", { security: true });
    writeFileSync(path.join(b.fake, "health-1.2.0"), "1");
    await night(b, [RUNNING, RUNNING]);
    const last = b.json("results/update-last.json");
    assert.equal(last.result, "rolled-back"); assert.equal(last.reason, "health"); assert.equal(last.attempts, 1);
    const stops = (b.calls().match(/^compose stop web stream-ingest stream-api mas synapse$/gm) ?? []).length;
    rmSync(path.join(b.fake, "health-1.2.0"));
    const r = await night(b, [RUNNING, RUNNING]);
    assert.match(r.stdout, /1\.2\.0 failed its health check here before: the timer does not try it again/);
    assert.equal((b.calls().match(/^compose stop web stream-ingest stream-api mas synapse$/gm) ?? []).length, stops, "not tried again");
  } finally { b.close(); }
});

test("reader retry: the attempt count survives a host restart — it lives in results/update-last.json", async () => {
  const b = await box();
  try {
    b.publish("1.2.0", { security: true });
    await night(b, [RUNNING, FAILED]);
    await night(b, [RUNNING, FAILED]);
    assert.equal(b.json("results/update-last.json").attempts, 2);
    // A reboot: the boot unit's reconcile runs, and nothing of the update's own working state is left.
    const rc = await b.run(["update", "--reconcile"]);
    assert.equal(rc.status, 0, rc.stderr);
    rmSync(path.join(b.home, "state/update"), { recursive: true, force: true });
    assert.equal(b.json("results/update-last.json").attempts, 2, "the reconcile kept the count");
    await night(b, [RUNNING, FAILED]);
    assert.equal(b.json("results/update-last.json").attempts, 3, "counted on from the results file");
    const r = await night(b, [RUNNING, FAILED]);
    assert.match(r.stdout, /is parked: 3 nights in a row/);
  } finally { b.close(); }
});

test("vacuity anchors: the updater's files end where they should", () => {
  assert.match(read("update/release.mjs"), /\nif \(process\.argv\[1\] && isMain\(\)\) process\.exit\(cli\(\)\);\n$/);
  assert.match(read("update/probe.mjs"), /process\.exit\(Object\.values\(result\)\.some\(\(r\) => r\.ok === false\) \? 1 : 0\);\n$/);
  assert.match(read("release-copy.sh"), /file\(s\) changed"\n$/);
  assert.match(read("blackbranch"), /\n {2}update\) {11}cmd_update "\$@" ;;\n/);
});
