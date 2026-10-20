// The Matrix namespace, read both ways (product name first, legacy name second).
// The wire names are pinned as literals on purpose: they are stored on the homeserver, so a
// typo here is data nobody can read.
// Run: node --test app/lib/matrixNamespace.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { NamespacedName } from "./matrixNamespace.ts";
// Loaded at run time: the box's site build typechecks tests, and tools/ is not in a release.
type Literals = { loadConfig: () => { patterns: { name: string; re: string }[] } };
const { loadConfig } = (await import(new URL("../../../tools/check-owner-literals.mjs", import.meta.url).href)) as Literals;

// This suite is the read-both install: one whose homeserver holds data under a legacy prefix
// (the install key matrix.legacyNamespace, a build value — set before the module is loaded).
// The unset case (a fresh install) is matrixNamespaceFresh.test.ts.
process.env.INSTALL_VALUES = JSON.stringify({ "matrix.legacyNamespace": "net.prior" });
const {
  ROOM_TYPE, FORUM_TITLE, FORUM_TAGS, FORUM_BODY, USERNAME_COLOR, MUTE_RULE, HIDDEN_PEOPLE, IGNORED_BOTS, readFirst,
} = await import("./matrixNamespace.ts");

const NAMES: Array<[NamespacedName, string]> = [
  [ROOM_TYPE, "room_type"], [FORUM_TITLE, "forum.title"], [FORUM_TAGS, "forum.tags"],
  [FORUM_BODY, "forum.body"], [USERNAME_COLOR, "username_color"], [MUTE_RULE, "mute"],
  [HIDDEN_PEOPLE, "hidden_people"], [IGNORED_BOTS, "ignored_bots"],
];

test("every name reads the product name first, then the legacy one", () => {
  for (const [n, suffix] of NAMES) {
    assert.deepEqual(n.read, [`app.blackbranch.${suffix}`, `net.prior.${suffix}`]);
  }
});

test("write-new release: every writer writes the PRODUCT name (readers still accept the legacy one)", () => {
  for (const [n, suffix] of NAMES) assert.equal(n.write, `app.blackbranch.${suffix}`, suffix);
});

test("readFirst: product value wins; legacy is the fallback; null/undefined = absent", () => {
  const data: Record<string, unknown> = { "net.prior.room_type": "old" };
  assert.equal(readFirst(ROOM_TYPE, (k) => data[k] as string | undefined), "old");
  data["app.blackbranch.room_type"] = "new";
  assert.equal(readFirst(ROOM_TYPE, (k) => data[k] as string | undefined), "new");
  data["app.blackbranch.room_type"] = null;
  assert.equal(readFirst(ROOM_TYPE, (k) => data[k] as string | null), "old");
  assert.equal(readFirst(ROOM_TYPE, () => undefined), undefined);
  // A falsy-but-present value is a value (an empty tag list is a real "no tags").
  assert.deepEqual(readFirst(FORUM_TAGS, (k) => (k.startsWith("app.") ? [] : ["x"])), []);
});

// ── The legacy prefix lives in matrixNamespace.ts only ──────────────────────────────────────────
const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = join(WEB, "..");
const ROOTS = [join(WEB, "app"), join(WEB, "lib"), join(WEB, "scripts"), join(REPO, "stream-api"), join(REPO, "stream-ingest")];
const SKIP_DIR = new Set(["node_modules", ".next", "config", "vendor", "__fixtures__"]);

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name) && !/\.test\.|\.probe\./.test(name)) out.push(p);
  }
}

test("no product source file names the legacy prefix — it is install config (tests excepted: wire fixtures)", () => {
  const files: string[] = [];
  for (const r of ROOTS) walk(r, files);
  // Vacuity anchors: the walk read the tree, and the one reader of the install key is in it.
  assert.ok(files.length > 500, `walked only ${files.length} files`);
  const own = files.find((f) => f.endsWith(join("app", "lib", "matrixNamespace.ts")));
  assert.ok(own && readFileSync(own, "utf8").includes('installValue("matrix.legacyNamespace")'), "matrixNamespace.ts no longer reads the install key");
  // The legacy prefix itself is the owner's — a pattern in the literal gate's private list (a tree
  // without that list has no legacy prefix to find), so it is read from there, never spelled here.
  const legacy = loadConfig().patterns.find((p) => p.name === "legacy Matrix namespace");
  const re = legacy ? new RegExp(legacy.re, "gi") : null;
  const hits = re ? files.flatMap((f) => {
    const n = (readFileSync(f, "utf8").match(re) ?? []).length;
    return n ? [`${relative(REPO, f)}: ${n}`] : [];
  }) : [];
  assert.deepEqual(hits, []);
});

test("W7: CI boots the throwaway homeserver and runs the homeserver suite with HS_TEST_REQUIRED (no green-by-skip)", { skip: existsSync(join(REPO, "ops", "throwaway")) ? false : "the homeserver suite runs in the maintainers' CI, on the private throwaway" }, () => {
  const ci = readFileSync(join(REPO, ".github", "workflows", "ci.yml"), "utf8");
  const at = ci.indexOf("\n  matrix:");
  assert.ok(at > 0, "the workflow has no `matrix` job");
  const end = ci.indexOf("\n  web:", at);
  assert.ok(end > at, "the `matrix` job must sit before the `web` job (ciGates.test.ts slices web to the end of the file)");
  const job = ci.slice(at, end);
  assert.match(job, /throwaway\.sh services/);
  assert.match(job, /throwaway\.sh hs-test-env/);
  assert.match(job, /HS_TEST_REQUIRED=1 node --test "app\/\*\*\/\*\.hs\.test\.ts"/);
  assert.ok(readdirSync(dirname(fileURLToPath(import.meta.url))).some((f) => f.endsWith(".hs.test.ts")), "no homeserver suite to run");
});
