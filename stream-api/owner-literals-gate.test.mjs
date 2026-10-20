// The literal gate (tools/check-owner-literals.mjs), tested against fixtures and against the real tree.
//
// The gate decides whether a commit may land, so it is held to the standard of the code it guards:
// every rule below has a fixture, including the tempting wrong versions —
// an `--update` that raises, a `config` exclusion that swallows web's paypal/config route, a comment
// stripper bolted on by habit from check-orphans, a private tree checked without its owner's list.
//
// The fixtures name a made-up owner ("acmecorp", acme.example, 10.20.30.0/24) through a pattern file
// CONSTRUCTED here, so this file holds no real install's names and runs the same in a public tree
// (which has no owner pattern file). The owner's own patterns are pinned in the owner folder.
//
// `.test.mjs`, not `.test.js`: it imports an ES module, and this package's deploy copies the
// top-level `*.js` (same reasoning as orphan-gate.test.mjs).
//
// Run: node --test owner-literals-gate.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync, mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import {
  REPO, CONFIG_PATH, OWNER_PATH, loadConfig, isScanned, countLiterals, findLiterals, compare, lowerBaseline,
  scanPackage, readBaseline, scanZeroPath, scanTree, requireOwnerPatterns, scanRatchets,
} from "../tools/check-owner-literals.mjs";

const cfg = loadConfig();

// A made-up owner's pattern file, beside the real structure + neutral patterns.
const FIX = mkdtempSync(join(tmpdir(), "literals-fixture-"));
const OWNER_FIXTURE = join(FIX, "owner.json");
writeFileSync(OWNER_FIXTURE, JSON.stringify({ patterns: [
  { name: "fixture owner name", re: "acmecorp", why: "the made-up owner's name" },
  { name: "fixture owner domain", re: "acme\\.example", why: "the made-up owner's domain" },
  { name: "fixture house LAN", re: "\\b10\\.20\\.30\\.\\d{1,3}\\b", why: "the made-up owner's subnet" },
] }));
const fx = loadConfig(CONFIG_PATH, { ownerPath: null, extra: [OWNER_FIXTURE] });
// This file is part of the whole tree the gate checks, so a fixture that SHOULD be caught is built
// from parts here rather than written out whole.
const ip = (...octets) => octets.join(".");
const at = (user, domain) => `${user}@${domain}`;
const home = (base, user) => `/${base}/${user}/`;
const neutral = loadConfig(CONFIG_PATH, { ownerPath: null });
test.after(() => rmSync(FIX, { recursive: true, force: true }));

test("comments are COUNTED — the inverse of check-orphans, on purpose", () => {
  // A public reader sees comments. Stripping them first (the check-orphans habit) would make this
  // gate blind to half of what it is for.
  assert.equal(countLiterals("// talk to acmecorp about this\n", fx), 1);
  assert.equal(countLiterals("/* see https://acme.example */", fx), 1);
  assert.equal(countLiterals("const a = 1;\n", fx), 0);
});

test("counted per occurrence, case-insensitively, across every pattern", () => {
  assert.equal(countLiterals('"AcmeCorp" @acmecorp:acme.example', fx), 3);
  // Each address matches two patterns — the owner's subnet and the neutral private-network one — and
  // counts once per pattern.
  assert.equal(countLiterals(`ws://${ip(10, 20, 30, 26)}:3001 and ${ip(10, 20, 30, 10)}`, fx), 4);
});

test("the neutral patterns: a private-network address, except the allowed examples", () => {
  for (const hit of [ip(10, 20, 30, 40), ip(192, 168, 50, 3), ip(172, 20, 0, 9), ip(100, 70, 1, 1), `http://${ip(10, 1, 2, 3)}:8080/`]) {
    assert.equal(countLiterals(hit, neutral), 1, hit);
  }
  for (const ok of ["10.0.0.0/8", "172.16.0.0", "192.168.1.1", "10.0.0.5", "172.29.83.250", "100.100.100.200", "127.0.0.1", "8.8.8.8", "192.0.2.10"]) {
    assert.equal(countLiterals(ok, neutral), 0, ok);
  }
});

test("the neutral patterns: a home folder, a personal email address, a live key, a private key", () => {
  assert.equal(countLiterals(`WorkingDirectory=${home("home", "alice")}app`, neutral), 1);
  assert.equal(countLiterals(`open ${home("Users", "Alice")}Documents/x`, neutral), 1);
  assert.equal(countLiterals("fetch(`${base}/users/by-username/${u}`)", neutral), 0, "an API path is not a home folder");
  assert.equal(countLiterals("app/features/home/rank/route.ts", neutral), 0, "a relative path is not a home folder");
  assert.equal(countLiterals("FROM distroless WORKDIR /home/nonroot/app", neutral), 0);
  assert.equal(countLiterals(`mail ${at("alice.smith", "gmail.com")}`, neutral), 1);
  for (const ok of ["a@example.com", "ops@example.test", "p@matrix.example.tv", "x@host.invalid", "backup@nas.home.arpa",
    "security@blackbranch.app", "blackbranch-update@1.2.3.service", "git@github.com:x/y.git"]) {
    assert.equal(countLiterals(ok, neutral), 0, ok);
  }
  assert.equal(countLiterals("key: 'sk_live_" + "a1b2c3d4e5f6g7h8'", neutral), 1);
  assert.equal(countLiterals("key: 'sk_test_a1b2c3d4e5f6g7h8' and 'sk_live_FAKE'", neutral), 0,
    "a test-mode key is not live, and a short placeholder is not a key");
  const header = "-----BEGIN EC " + "PRIVATE KEY-----";
  assert.equal(countLiterals(`${header}\\n${"MHcCAQEEI".repeat(6)}`, neutral), 1, "a key's header and its material");
  assert.equal(countLiterals(`${header}\n      test-only\n`, neutral), 0, "a test's placeholder body is not key material");
});

test("the neutral patterns: an IPv6 host in someone's network, a signed token, a webhook URL", () => {
  const v6 = (...g) => g.join(":");
  // A whole private (ULA) or link-local HOST address — its interface id written out.
  assert.equal(countLiterals(`peer ${v6("fd7a", "115c", "a1e0", "ab12", "4843", "cd96", "6258", "b240")}`, neutral), 1);
  assert.equal(countLiterals(`via ${v6("fe80", "", "1c2b", "3cff", "fe4d", "5e6f")}%eth0`, neutral), 1);
  // …and written the way addresses usually are: compressed, `::` anywhere, any number of groups.
  for (const host of [v6("fd00", "", "1"), v6("fdab", "1234", "", "5678"), v6("fd7a", "115c", "", "b240"), v6("fc00", "", "a", "b"),
    v6("fdab", "1234", "5678", "9abc", "", "1"), `[${v6("fd00", "", "2")}]:443`, `${v6("fdab", "1234", "", "5678")}/64`,
    v6("fe80", "", "1c2b"), v6("fe80", "", "1c2b", "3cff"), v6("febf", "", "9"), v6("FD00", "", "BEEF")]) {
    assert.equal(countLiterals(`peer ${host}`, neutral), 1, host);
  }
  // Ranges and the short forms a guard or its tests name are not a host on anyone's LAN.
  for (const ok of ["fc00::/7", "fe80::/10", "fd00::/8", "fd12:3456::/64", "fd00:ec2::254", "fd12:3456::1", "fe80::1", "fc00::1", "fc00::5",
    "::ffff:127.0.0.1", "2001:db8::1", "64:ff9b::808:808", "::1", "feed::1", "fade:cafe::1", "fd::1"]) {
    assert.equal(countLiterals(ok, neutral), 0, ok);
  }
  // A signed JWT: three base64url parts, the first two JSON objects ("eyJ").
  const part = (s) => Buffer.from(s).toString("base64url");
  const jwt = [part('{"alg":"HS256","typ":"JWT"}'), part('{"sub":"1234567890","name":"x"}'), "Sfl" + "KxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"].join(".");
  assert.equal(countLiterals(`Authorization: Bearer ${jwt}`, neutral), 1);
  assert.equal(countLiterals("a.b.c and eyJ.short.x", neutral), 0, "not every dotted triple is a token");
  // A chat webhook URL is its own credential: whoever has it can post.
  assert.equal(countLiterals(`https://discord.com/api/webhooks/${"1234567890123456"}/${"aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW"}`, neutral), 1);
  assert.equal(countLiterals(`https://hooks.slack.com/services/${"T0000AAAA"}/${"B0000BBBB"}/${"XXXXXXXXXXXXXXXXXXXXXXXX"}`, neutral), 1);
  assert.equal(countLiterals("https://discord.com/api/webhooks/<id>/<token>", neutral), 0, "a documented shape is not a credential");
});

test("an allowed match is not counted, and every allow entry carries a reason", () => {
  const found = findLiterals(`10.0.0.5 and ${ip(10, 20, 30, 40)}`, neutral);
  assert.deepEqual(found.map((f) => f.match), [ip(10, 20, 30, 40)]);
  const bad = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  bad.patterns[0].allow["^1\\.2\\.3\\.4$"] = "";
  const path = join(FIX, "bad-allow.json");
  writeFileSync(path, JSON.stringify(bad));
  assert.throws(() => loadConfig(path, { ownerPath: null }), /allowed match .* has no reason/);
});

test("the neutral pattern file holds none of its own patterns — it ships, and the whole tree is checked", () => {
  assert.equal(countLiterals(readFileSync(CONFIG_PATH, "utf8"), neutral), 0);
  assert.ok(neutral.patterns.length >= 5 && neutral.patterns.every((p) => p.source === "neutral"));
});

test("tests, fixtures, docs, lockfiles and binaries are not scanned by the RATCHET — each by its stated rule", () => {
  for (const p of [
    "web/app/lib/x.test.ts", "stream-api/chat.test.js", "stream-api/orphan-gate.test.mjs",
    "web/app/api/billing/__fixtures__/stripe/refund.created.json", "web/README.md",
    "web/package-lock.json", "web/public/icon.webp", "stream-ingest/config/behavior.txt",
    "stream-ingest/vendor/socialstream/x.js", "web/.next/server/app.js",
  ]) assert.equal(isScanned(p, cfg), false, p);
});

test("a `config` directory is excluded by PREFIX, never by segment", () => {
  // stream-ingest/config/ is persona content; web's paypal/config route is CODE.
  // A segment rule — the obvious one to write — silently exempts the route.
  assert.equal(isScanned("stream-ingest/config/behavior.txt", cfg), false);
  assert.equal(isScanned("web/app/api/billing/paypal/config/route.ts", cfg), true);
});

test("owner/ folders are exempt, and only the three named roots", () => {
  for (const p of ["web/app/(owner)/jokes.ts", "stream-api/owner/radio.js", "stream-ingest/owner/bot/brain.js"]) {
    assert.equal(isScanned(p, cfg), false, p);
  }
  // A folder merely NAMED owner elsewhere is not the private build's home.
  assert.equal(isScanned("web/app/components/owner/Card.tsx", cfg), true);
  assert.equal(isScanned("stream-api/lib/owner/x.js", cfg), true);
});

test("every pattern and every exclusion carries a written reason", () => {
  for (const p of cfg.patterns) assert.ok(p.why.length >= 8, p.name);
  // loadConfig refuses a reasonless one; prove it does rather than assume it.
  const bad = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  bad.notScanned.files["\\.zzz$"] = "";
  const path = join(FIX, "bad.json");
  writeFileSync(path, JSON.stringify(bad));
  assert.throws(() => loadConfig(path, { ownerPath: null }), /no reason/);
});

// ── Two pattern files ───────────────────────────────────────────────────────

test("a tree with owner folders must have its owner pattern file — or the gate refuses to run", () => {
  const tree = mkdtempSync(join(FIX, "tree-"));
  mkdirSync(join(tree, "stream-api", "owner"), { recursive: true });
  assert.throws(() => requireOwnerPatterns(neutral, tree), /no tools\/owner-literals\.json/,
    "a private tree checked with the neutral patterns alone would pass every owner name");
  const withOwner = loadConfig(CONFIG_PATH, { ownerPath: OWNER_FIXTURE });
  assert.doesNotThrow(() => requireOwnerPatterns(withOwner, tree));
  rmSync(join(tree, "stream-api", "owner"), { recursive: true });
  assert.doesNotThrow(() => requireOwnerPatterns(neutral, tree), "a public tree has no owner folder and needs no owner list");
});

test("this tree: the owner pattern file is loaded exactly when the owner folders exist", () => {
  const hasRoots = cfg.ownerRoots.paths.some((p) => existsSync(join(REPO, p)));
  assert.equal(existsSync(OWNER_PATH), hasRoots, "the private repo has both; the public cut has neither");
  assert.equal(cfg.patterns.some((p) => p.source === "owner"), hasRoots);
});

// ── The ratchet ─────────────────────────────────────────────────────────────

const BASE = { "web/a.ts": 3, "web/b.ts": 1, "stream-api/c.js": 2 };

test("equal counts pass", () => {
  const r = compare("web", { "web/a.ts": 3, "web/b.ts": 1 }, BASE);
  assert.deepEqual([r.raised, r.added, r.lowered, r.stale], [[], [], [], []]);
  assert.equal(r.total, r.baseTotal);
});

test("a raised count fails, and a NEW file with any literal fails", () => {
  const r = compare("web", { "web/a.ts": 4, "web/b.ts": 1, "web/new.ts": 1 }, BASE);
  assert.deepEqual(r.raised, [{ path: "web/a.ts", base: 3, now: 4 }]);
  assert.deepEqual(r.added, [{ path: "web/new.ts", now: 1 }]);
});

test("a lowered count and a cleaned-out file are reported, so they get locked in", () => {
  const r = compare("web", { "web/a.ts": 1 }, BASE);
  assert.deepEqual(r.lowered, [{ path: "web/a.ts", base: 3, now: 1 }]);
  assert.deepEqual(r.stale, [{ path: "web/b.ts", base: 1, now: 0 }]);
});

test("another package's entries are not this package's business", () => {
  const r = compare("web", { "web/a.ts": 3, "web/b.ts": 1 }, BASE);
  assert.equal(r.stale.length, 0, "stream-api/c.js is not stale for a web run");
});

test("--update only ever LOWERS: never raises, never adds, never touches another package", () => {
  const next = lowerBaseline("web", { "web/a.ts": 9, "web/b.ts": 0, "web/new.ts": 5 }, BASE);
  assert.deepEqual(next, { "web/a.ts": 3, "stream-api/c.js": 2 },
    "a.ts keeps its old ceiling, b.ts (now 0) is dropped, new.ts is NOT added");
  const lowered = lowerBaseline("web", { "web/a.ts": 1, "web/b.ts": 1 }, BASE);
  assert.equal(lowered["web/a.ts"], 1);
});

// ── Ratchet patterns ────────────────────────────────────────────────────────
// A pattern too widespread to clear in one change (an owner's word in hundreds of comments) carries
// its own per-file ceilings, in its private pattern file: a count may only go down there, a file
// not listed must hold none, and --tree forgives exactly the ceiling — the rest of the gate (the
// baseline, --zero) never sees the pattern.

function ratchetFixture(ceilings) {
  const file = join(mkdtempSync(join(FIX, "ratchet-")), "owner.json");
  writeFileSync(file, JSON.stringify({ patterns: [
    { name: "fixture owner name", re: "acmecorp", why: "the made-up owner's name" },
    { name: "fixture owner word", re: "\\bwidget", why: "the made-up owner's currency word", ratchet: ceilings },
  ] }, null, 2) + "\n");
  return file;
}

test("a ratchet pattern needs whole-number ceilings, each for a path", () => {
  assert.throws(() => loadConfig(CONFIG_PATH, { ownerPath: null, extra: [ratchetFixture({ "web/a.ts": 0 })] }), /ceiling/);
  assert.throws(() => loadConfig(CONFIG_PATH, { ownerPath: null, extra: [ratchetFixture({ "web/a.ts": 1.5 })] }), /ceiling/);
  assert.doesNotThrow(() => loadConfig(CONFIG_PATH, { ownerPath: null, extra: [ratchetFixture({ "web/a.ts": 2 })] }));
});

test("the package scan and the baseline never see a ratchet pattern; its own counts cover tests too", () => {
  const rc = loadConfig(CONFIG_PATH, { ownerPath: null, extra: [ratchetFixture({ "web/a.ts": 2 })] });
  assert.equal(countLiterals("widget widget acmecorp", rc), 3, "a whole-text count (render checks, zero paths) sees every pattern");
  const files = ["web/a.ts", "web/a.test.ts", "web/app/(owner)/x.ts"];
  const text = { "web/a.ts": "// widget widget\n", "web/a.test.ts": "widgets\n", "web/app/(owner)/x.ts": "widget\n" };
  const read = (p) => text[p];
  const counts = scanRatchets("web", rc, files, read)["fixture owner word"];
  assert.deepEqual(counts, { "web/a.ts": 2, "web/a.test.ts": 1 }, "tests count; owner folders do not");
  const r = compare("web", counts, rc.patterns.find((p) => p.ratchet).ratchet);
  assert.deepEqual(r.added, [{ path: "web/a.test.ts", now: 1 }], "a file without a ceiling must hold none");
});

test("the same pattern file passed twice (the cut passes the tag's and the checkout's) counts once, at the stricter ceiling", () => {
  const a = ratchetFixture({ "web/a.ts": 3, "web/b.ts": 1 }), b = ratchetFixture({ "web/a.ts": 2 });
  const twice = loadConfig(CONFIG_PATH, { ownerPath: null, extra: [a, b] });
  assert.equal(countLiterals("acmecorp widget", twice), 2, "one match each, not two");
  assert.deepEqual(twice.patterns.find((p) => p.ratchet).ratchet, { "web/a.ts": 2 });
  const tree = fixtureTree({ "web/app/a.ts": "// widget\n" });
  const r = runTree(tree, "--patterns", ratchetFixture({ "web/app/a.ts": 1 }), "--patterns", ratchetFixture({ "web/app/a.ts": 1 }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /; 1 held under a ratchet/);
});

test("--tree forgives a ratchet pattern up to its ceiling — not one more, and not in another file", () => {
  const owner = ratchetFixture({ "web/app/a.ts": 2 });
  const ok = runTree(fixtureTree({ "web/app/a.ts": "// widget, widget\n" }), "--patterns", owner);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /2 held under a ratchet \(may only go down\)/);
  const over = runTree(fixtureTree({ "web/app/a.ts": "// widget, widget, widget\n" }), "--patterns", owner);
  assert.equal(over.status, 1);
  assert.match(over.stderr, /web\/app\/a\.ts:1 {2}fixture owner word \(3, ceiling 2\)/);
  const elsewhere = runTree(fixtureTree({ "web/app/b.ts": "// widget\n" }), "--patterns", owner);
  assert.equal(elsewhere.status, 1);
  assert.match(elsewhere.stderr, /web\/app\/b\.ts:1 {2}fixture owner word \(1, ceiling 0\)/);
});

// ── The real tree ───────────────────────────────────────────────────────────

const { files: baseline } = readBaseline();

// Floors well under today's walk (web ~944, stream-api ~59, stream-ingest ~38) — a broken listing
// reads a handful of files or none.
const FLOOR = { web: 600, "stream-api": 40, "stream-ingest": 25 };

for (const pkg of cfg.packages) {
  test(`${pkg}: the walk reads the package, and finds EXACTLY the baseline`, () => {
    const { scanned, counts } = scanPackage(pkg, cfg);
    assert.ok(scanned >= FLOOR[pkg], `${pkg}: scanned only ${scanned} files — the walk is blind`);
    const r = compare(pkg, counts, baseline);
    // Every package's baseline is ZERO, so there is no count to anchor on: the anchor is the file
    // floor above — the walk read the package — and the pattern fixtures at the top of this file.
    assert.equal(r.total, 0, `${pkg}: held at zero — a literal belongs in the owner folder or settings`);
    assert.deepEqual({ raised: r.raised, added: r.added, lowered: r.lowered, stale: r.stale },
      { raised: [], added: [], lowered: [], stale: [] },
      `${pkg}: the tree disagrees with tools/owner-literals.baseline.json — run the gate for details`);
    assert.equal(r.total, r.baseTotal);
  });
}

test("the baseline is empty — every package is held at zero — and any entry would belong to a scanned package", () => {
  const raw = JSON.parse(readFileSync(join(REPO, "tools", "owner-literals.baseline.json"), "utf8"));
  assert.ok(raw.files && typeof raw.files === "object", "no `files` map — wrong file?");
  const entries = Object.entries(baseline);
  assert.deepEqual(entries, [], "every package is locked at zero; an entry is a raised count");
  assert.equal(countLiterals(JSON.stringify(raw), cfg), 0, "the baseline ships: its own text holds no literal");
});

test("--zero (the package at zero, whatever the baseline) exits 0 only at zero", () => {
  for (const pkg of cfg.packages) {
    const r = spawnSync("node", ["tools/check-owner-literals.mjs", "--zero", pkg], { cwd: REPO, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ok — 0 \(\d+ scanned\)/);
  }
});

// ── Zero paths ──────────────────────────────────────────────────────────────
// Folders outside the packages that ship as they are. No baseline, no ratchet — zero, on every run.

test("zero paths are declared with reasons, and cover every folder that ships whole", () => {
  const keys = Object.keys(cfg.zeroPaths).filter((k) => k !== "//");
  for (const k of ["migrations/baseline/", "install/", "config/", "docs/public/", "public-root/"]) {
    assert.ok(keys.includes(k), `${k} is not held at zero`);
  }
  const bad = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  bad.zeroPaths["docs/other/"] = "";
  const path = join(FIX, "bad-zero.json");
  writeFileSync(path, JSON.stringify(bad));
  assert.throws(() => loadConfig(path, { ownerPath: null }), /zero path "docs\/other\/" has no reason/);
});

test("inside a zero path NO exclusion applies — a README or a test there is published as-is", () => {
  // The package rules skip *.md and *.test.* — reused here, they would let an owner name into
  // every install through the baseline's own README.
  const files = ["migrations/baseline/README.md", "migrations/baseline/x.test.mjs",
    "migrations/baseline/seed.sql", "migrations/other.sql"];
  const text = { "migrations/baseline/README.md": "see acme.example", "migrations/baseline/x.test.mjs": "// acmecorp",
    "migrations/baseline/seed.sql": "INSERT INTO t (id) VALUES (1);", "migrations/other.sql": "acmecorp" };
  const r = scanZeroPath("migrations/baseline/", fx, files, (p) => text[p]);
  assert.deepEqual(r.counts, { "migrations/baseline/README.md": 1, "migrations/baseline/x.test.mjs": 1 });
  assert.equal(r.scanned, 3, "a file outside the prefix is not this zero path's business");
  assert.equal(r.present, true);
  assert.equal(scanZeroPath("install/", fx, [], () => "").present, false);
});

test("the real migrations/baseline/ is scanned and holds ZERO literals", () => {
  const r = scanZeroPath("migrations/baseline/", cfg);
  // Vacuity anchor: schema.sql, seed.sql and README.md. A blind listing reads none.
  assert.ok(r.scanned >= 3, `scanned only ${r.scanned} files in migrations/baseline/ — the walk is blind`);
  assert.deepEqual(r.counts, {}, "a literal in the baseline is a literal in every install");
});

test("every package run also checks the zero paths, so no package script can forget them", () => {
  for (const args of [["stream-api"], ["--zero", "stream-ingest"]]) {
    const r = spawnSync("node", ["tools/check-owner-literals.mjs", ...args], { cwd: REPO, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /check-owner-literals \(migrations\/baseline\/\): ok — 0, held at zero \(\d+ scanned\)/, args.join(" "));
  }
});

// ── --tree: the whole public tree ───────────────────────────────────────────

/** A small git tree with the three packages, a doc, a test, a fixture and a binary. */
function fixtureTree(extra = {}) {
  const tree = mkdtempSync(join(FIX, "cut-"));
  const files = {
    "web/app/a.ts": "export const a = 1;\n", "stream-api/b.js": "module.exports = {};\n",
    "stream-ingest/c.js": "export {};\n", "docs/public/x.md": "# hello\n", "web/app/a.test.ts": "// ok\n",
    "web/app/api/__fixtures__/p.json": "{}\n", ...extra,
  };
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(join(tree, p, ".."), { recursive: true });
    writeFileSync(join(tree, p), t);
  }
  writeFileSync(join(tree, "web/icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0x61, 0x63, 0x6d, 0x65]));
  execFileSync("git", ["init", "-q"], { cwd: tree });
  execFileSync("git", ["add", "-A"], { cwd: tree });
  return tree;
}
const runTree = (tree, ...args) => spawnSync("node", [join(REPO, "tools", "check-owner-literals.mjs"), "--tree", tree, ...args], { encoding: "utf8" });

test("--tree counts EVERY file — docs, tests and fixtures included — and never prints what it matched", () => {
  const secret = "sk_live_" + "Zq9Xw8Vu7Ts6Rq5P";
  const tree = fixtureTree({
    "docs/public/x.md": "Ask acmecorp.\n", "web/app/a.test.ts": "const k = 'x';\nconst live = '" + secret + "';\n",
    "web/app/api/__fixtures__/p.json": `{"host":"${ip(10, 20, 30, 4)}"}\n`,
  });
  const r = runTree(tree, "--patterns", OWNER_FIXTURE);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /docs\/public\/x\.md:1 {2}fixture owner name/);
  assert.match(r.stderr, /web\/app\/a\.test\.ts:2 {2}live payment key/, "a test is published too");
  assert.match(r.stderr, /web\/app\/api\/__fixtures__\/p\.json:1 {2}(fixture house LAN|private-network address)/);
  assert.ok(!r.stderr.includes(secret) && !r.stdout.includes(secret), "the matched text — here a live key — is never printed");
  assert.doesNotMatch(r.stderr, /icon\.png/, "a binary file has no text to read");
});

test("--tree reads file PATHS too: a name in a file or folder name ships as plainly as one inside", () => {
  // An owner's file whose CONTENT holds no pattern but whose name does (an owner-named output file,
  // a folder named after a member) used to pass the cut's scan at zero.
  const tree = fixtureTree({ "stream-api/acmecorp-proposals.json": "{}\n", "web/app/acmecorp/page.ts": "export {};\n" });
  const r = runTree(tree, "--patterns", OWNER_FIXTURE);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /stream-api\/acmecorp-proposals\.json:0 {2}fixture owner name \(in the path\)/);
  assert.match(r.stderr, /web\/app\/acmecorp\/page\.ts:0 {2}fixture owner name \(in the path\)/);
  const found = scanTree(tree, fx).found;
  assert.deepEqual(found["stream-api/acmecorp-proposals.json"], [{ name: "fixture owner name (in the path)", line: 0 }]);
  // A binary file's NAME is text even when its content is not.
  const bin = fixtureTree({ "web/public/acmecorp.png": "" });
  writeFileSync(join(bin, "web/public/acmecorp.png"), Buffer.from([0x89, 0x50, 0, 0]));
  assert.match(runTree(bin, "--patterns", OWNER_FIXTURE).stderr, /web\/public\/acmecorp\.png:0 {2}fixture owner name \(in the path\)/);
});

test("--tree: a NUL byte in a file that should be text is a finding, not a skip", () => {
  const tree = fixtureTree({ "web/app/hidden.ts": "export const a = 1;\u0000" });
  const r = runTree(tree);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /web\/app\/hidden\.ts:1 {2}binary content in a file that should be text/);
});

test("--tree: a clean tree passes, names its pattern sets, and a blind walk fails", () => {
  const tree = fixtureTree();
  const ok = runTree(tree, "--patterns", OWNER_FIXTURE);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /ok — 0 in \d+ files \(1 binary skipped; patterns: neutral( \+ owner)? \+ extra, \d+\)/);
  rmSync(join(tree, "stream-ingest"), { recursive: true });
  execFileSync("git", ["add", "-A"], { cwd: tree });
  const blind = runTree(tree);
  assert.equal(blind.status, 1);
  assert.match(blind.stderr, /read no file of stream-ingest/);
  const r = scanTree(fixtureTree(), neutral);
  assert.ok(r.scanned >= 6 && r.binary === 1, JSON.stringify(r));
});
