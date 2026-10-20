// The release-candidate rehearsal (install/ci/release-candidate.sh, run by
// .github/workflows/release-candidate.yml). Run: node --test install/
//
// The rehearsal itself needs a fresh machine (it installs into /opt/blackbranch as root), so it runs
// only in that workflow or by hand on a throwaway VM. What is held here, with stand-ins for the box:
// the versions it cuts; that release C is broken exactly where the update's health check looks (the
// real stream-api source — a moved line fails here, not on the runner after half an hour); that the
// verdicts cannot go green on a box that did not do what it said (an update to a broken release that
// exits 0, a "rolled back" box still on C, a health check that never signed anyone in, a release in use
// without B's file); the release tool's digest table; the script's lint; and the two workflows' shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..");
const SCRIPT = path.join(here, "release-candidate.sh");
const CI = process.env.CI === "true";
const has = (cmd) => spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;

const rc = (args, env = {}) => spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
const tmp = (name) => mkdtempSync(path.join(tmpdir(), `bb-rc-${name}-`));

test("versions: a tag's pre-releases, never the tag's own version; a run without a tag rehearses 0.0.0", () => {
  const v = (tag) => rc(["versions"], { RC_TAG: tag }).stdout.trim();
  assert.equal(v(""), "0.0.0-ci.1 0.0.0-ci.2 0.0.0-ci.3");
  assert.equal(v("v1.4.2"), "1.4.2-ci.1 1.4.2-ci.2 1.4.2-ci.3");
  assert.equal(v("v1.4.2-beta.1"), "1.4.2-beta.1.ci.1 1.4.2-beta.1.ci.2 1.4.2-beta.1.ci.3");
  assert.equal(v("main"), "0.0.0-ci.1 0.0.0-ci.2 0.0.0-ci.3", "a branch name is not a version");
  assert.equal(v("v1.4"), "0.0.0-ci.1 0.0.0-ci.2 0.0.0-ci.3");
});

test("🔴 release C is broken where the update's health check looks: the REAL stream-api socket server", () => {
  const w = tmp("trees");
  try {
    mkdirSync(path.join(w, "tree-A", "stream-api"), { recursive: true });
    mkdirSync(path.join(w, "tree-A", "install", "ci"), { recursive: true });
    cpSync(path.join(root, "stream-api", "ws-hub.js"), path.join(w, "tree-A", "stream-api", "ws-hub.js"));
    let r = rc(["tree", "C"], { RC_WORK: w });
    assert.equal(r.status, 0, r.stderr);
    const a = readFileSync(path.join(w, "tree-A", "stream-api", "ws-hub.js"), "utf8").split("\n");
    const c = readFileSync(path.join(w, "tree-C", "stream-api", "ws-hub.js"), "utf8").split("\n");
    const at = c.indexOf("    ws.internal = Boolean(req && req.headers && isInternalUpgrade(req.headers));");
    assert.ok(at > 0, "the anchor is in the real file");
    // A viewer's socket (the health probe's) closes before a frame; an internal one (stream-ingest's)
    // stays: closing that too stopped stream-ingest, and C then failed somewhere else.
    assert.match(c[at + 1], /^ {4}if \(!ws\.internal\) \{ ws\.close\(1011, .*\); return; \}$/);
    assert.deepEqual([...c.slice(0, at + 1), ...c.slice(at + 2)], a, "nothing else in the file changed");
    // B: A plus one changed file; C is made from B, so it holds B's file too.
    assert.match(readFileSync(path.join(w, "tree-B", "install", "ci", "RC-MARKER"), "utf8"), /tree B \(0\.0\.0-ci\.2\)/);
    assert.ok(existsSync(path.join(w, "tree-C", "install", "ci", "RC-MARKER")));
    assert.deepEqual(readFileSync(path.join(w, "tree-B", "stream-api", "ws-hub.js"), "utf8").split("\n"), a, "B's stream-api is A's");
    // The line moved (renamed, reindented): the cut stops and says what to update — never a C that still works.
    writeFileSync(path.join(w, "tree-A", "stream-api", "ws-hub.js"), a.join("\n").replace("    ws.internal = Boolean(", "    ws.isInternal = Boolean("));
    rmSync(path.join(w, "tree-B"), { recursive: true }); rmSync(path.join(w, "tree-C"), { recursive: true });
    r = rc(["tree", "C"], { RC_WORK: w });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /release C cannot be broken where the health check looks/);
  } finally { rmSync(w, { recursive: true, force: true }); }
});

// A stand-in box: an install folder (.env, the release pointer, results/) and a `blackbranch` and a
// `docker` that answer from it. SCENARIO picks what the stand-in update does.
function standIn(w) {
  const box = path.join(w, "box"), bin = path.join(w, "bin");
  for (const v of ["0.0.0-ci.1", "0.0.0-ci.2", "0.0.0-ci.3"]) {
    mkdirSync(path.join(box, "releases", v, "install", "ci"), { recursive: true });
    writeFileSync(path.join(box, "releases", v, "RELEASE"), `${v}\n`);
  }
  mkdirSync(path.join(box, "results"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(path.join(w, "work", "tree-B", "install", "ci"), { recursive: true });
  writeFileSync(path.join(w, "work", "tree-B", "install", "ci", "RC-MARKER"), "release candidate rehearsal: tree B (0.0.0-ci.2)\n");
  const on = (v) => {
    rmSync(path.join(box, "release"), { force: true });
    symlinkSync(`releases/${v}`, path.join(box, "release"));
    writeFileSync(path.join(box, ".env"), `BB_DOMAIN="bb.test"\nBB_RELEASE="${v}"\n`);
  };
  writeFileSync(path.join(bin, "blackbranch"), `#!/usr/bin/env bash
set -u
B="$RC_BOX"
on() { ln -sfn "releases/$1" "$B/release"; sed -i "s/^BB_RELEASE=.*/BB_RELEASE=\\"$1\\"/" "$B/.env"; }
last() { printf '{"v":1,"from":"%s","to":"%s","result":"%s","message":"stand-in"}\\n' "$1" "$2" "$3" > "$B/results/update-last.json"; }
case "$1 \${2:-}" in
  "update --check") echo "newer: \${3:-?}" ;;
  "update --apply")
    v="$3"; cur=$(head -1 "$B/release/RELEASE")
    case "$SCENARIO" in
      good|no-signin) on "$v"; cp "$RC_WORK/tree-B/install/ci/RC-MARKER" "$B/release/install/ci/RC-MARKER"; last "$cur" "$v" updated; echo "Updated: $cur → $v" ;;
      good-without-file) on "$v"; last "$cur" "$v" updated; echo "Updated: $cur → $v" ;;
      rollback|rollback-exit0|rollback-still-on-c)
        echo "   [FAIL] ws — the socket closed before a frame"
        [ "$SCENARIO" = rollback-still-on-c ] && on "$v"
        last "$cur" "$v" rolled-back; echo "ROLLED BACK: $v failed its health check; back on $cur"
        [ "$SCENARIO" = rollback-exit0 ] && exit 0; exit 1 ;;
    esac ;;
  "status "*) printf '  release      %s (channel stable)\\n  setup        in progress (first admin: @rcadmin:bb.test) — continue at https://bb.test/setup\\n' "$(head -1 "$B/release/RELEASE")" ;;
  "health "*)
    if [ "$SCENARIO" = no-signin ]; then w='{"ok":null,"detail":"no account"}'; else w='{"ok":true,"detail":"works"}'; fi
    echo "BBHEALTH {\\"ok\\":true,\\"services\\":true,\\"failed\\":[],\\"probes\\":{\\"ws\\":{\\"ok\\":true,\\"detail\\":\\"x\\"},\\"whoami\\":$w}}" ;;
  *) echo "stand-in blackbranch: $*" >&2; exit 9 ;;
esac
`);
  writeFileSync(path.join(bin, "docker"), `#!/usr/bin/env bash
case "$*" in
  *" ps -q stream-api") echo cid-api ;;
  "inspect -f {{.Config.Image}} cid-api") echo "blackbranch/stream-api:$(head -1 "$RC_BOX/release/RELEASE")" ;;
  *) echo "stand-in docker: $*" >&2; exit 9 ;;
esac
`);
  chmodSync(path.join(bin, "blackbranch"), 0o755); chmodSync(path.join(bin, "docker"), 0o755);
  return { box, bin, on };
}
const runStep = (w, s, step, scenario) => rc([step], {
  RC_WORK: path.join(w, "work"), RC_BOX: s.box, RC_SUDO: "", RC_TAG: "", SCENARIO: scenario, PATH: `${s.bin}:${process.env.PATH}`,
});

test("🔴 the rollback verdict: green only when the box says it rolled back AND runs B, healthy, with an account signed in", () => {
  const w = tmp("verdict");
  try {
    const s = standIn(w);
    s.on("0.0.0-ci.2");
    let r = runStep(w, s, "update-bad", "rollback");
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /the update recorded: rolled-back, 0\.0\.0-ci\.2 → 0\.0\.0-ci\.3/);
    assert.match(r.stdout, /the box runs 0\.0\.0-ci\.2/);
    const fails = {
      "rollback-exit0": /must not report success/,
      "rollback-still-on-c": /BB_RELEASE is "0\.0\.0-ci\.3", expected 0\.0\.0-ci\.2/,
    };
    for (const [scenario, why] of Object.entries(fails)) {
      s.on("0.0.0-ci.2");
      r = runStep(w, s, "update-bad", scenario);
      assert.notEqual(r.status, 0, `${scenario} went green`);
      assert.match(r.stderr, why, scenario);
    }
  } finally { rmSync(w, { recursive: true, force: true }); }
});

test("🔴 the update verdict: the box runs B with B's changed file, its record says so, and the first admin signs in", () => {
  const w = tmp("update");
  try {
    const s = standIn(w);
    s.on("0.0.0-ci.1");
    let r = runStep(w, s, "update-good", "good");
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /the update recorded: updated, 0\.0\.0-ci\.1 → 0\.0\.0-ci\.2/);
    assert.match(r.stdout, /B's changed file is in the release in use/);
    s.on("0.0.0-ci.1");
    rmSync(path.join(s.box, "releases", "0.0.0-ci.2", "install", "ci", "RC-MARKER"));
    r = runStep(w, s, "update-good", "good-without-file");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /does not hold B's changed file/);
    // A health check that passed without signing anyone in ("not checked") is a hole, not a pass.
    s.on("0.0.0-ci.1");
    r = runStep(w, s, "update-good", "no-signin");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /did not sign the first admin in/);
  } finally { rmSync(w, { recursive: true, force: true }); }
});

test("release.mjs digests: every third-party image the tree names by tag, looked up once, as the table cut reads", () => {
  const w = tmp("digests");
  try {
    // A stand-in docker whose registry answers sha256(<ref>) for each reference.
    const bin = path.join(w, "bin"); mkdirSync(bin);
    writeFileSync(path.join(bin, "docker"), `#!/usr/bin/env bash
[ "$1 $2 $3" = "buildx imagetools inspect" ] || exit 1
printf '{"digest":"sha256:%s"}\\n' "$(printf '%s' "$4" | sha256sum | cut -d' ' -f1)"
`, { mode: 0o755 });
    const out = path.join(w, "d.json");
    const r = spawnSync(process.execPath, [path.join(root, "tools", "release.mjs"), "digests", "--tree", root, "--out", out],
      { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(r.status, 0, r.stderr);
    const table = JSON.parse(readFileSync(out, "utf8"));
    const compose = readFileSync(path.join(root, "install", "compose.yaml"), "utf8");
    const docker = readFileSync(path.join(root, "install", "Dockerfile"), "utf8");
    assert.equal(Object.keys(table).length, 9, Object.keys(table).join(" "));
    for (const [ref, d] of Object.entries(table)) {
      assert.ok(compose.includes(`image: ${ref}`) || docker.includes(ref), `${ref} is not how the repo writes it`);
      assert.equal(d, `sha256:${createHash("sha256").update(ref).digest("hex")}`);
    }
    // A registry that does not answer is a refusal, never a table with a hole in it.
    writeFileSync(path.join(bin, "docker"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
    const bad = spawnSync(process.execPath, [path.join(root, "tools", "release.mjs"), "digests", "--tree", root, "--out", path.join(w, "bad.json")],
      { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.notEqual(bad.status, 0);
    assert.ok(!existsSync(path.join(w, "bad.json")));
  } finally { rmSync(w, { recursive: true, force: true }); }
});

test("the script passes bash -n, and shellcheck with no finding", (t) => {
  assert.equal(spawnSync("bash", ["-n", SCRIPT]).status, 0);
  if (!has("shellcheck")) { if (CI) assert.fail("shellcheck is required in CI"); return t.skip("shellcheck not installed"); }
  const r = spawnSync("shellcheck", ["-x", SCRIPT], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout);
});

// The private repo runs it on its public cut; the public repo (public-root/ becomes its root) on its own
// checkout. Both: by hand or on a v* tag only (paid minutes), actions pinned by commit, read-only token,
// and the same steps of the script in the same order.
test("the release-candidate workflows: not on every push, pinned, and the same steps in both repos", () => {
  const files = [path.join(root, ".github", "workflows", "release-candidate.yml"), path.join(root, "public-root", ".github", "workflows", "release-candidate.yml")]
    .filter((f, i) => i === 0 || existsSync(path.join(root, "public-root")));
  const steps = [];
  for (const f of files) {
    const y = readFileSync(f, "utf8");
    assert.match(y, /^on:\n {2}workflow_dispatch:\n {2}push:\n {4}tags: \["v\*"\]\n/m, `${f}: by hand and on v* tags only`);
    assert.doesNotMatch(y, /^ {2}(pull_request|schedule):/m, f);
    assert.match(y, /^permissions:\n {2}contents: read\n/m, f);
    for (const u of y.match(/uses: \S+/g) ?? []) assert.match(u, /@[0-9a-f]{40}$/, `${f}: ${u} is not pinned by commit`);
    assert.match(y, /timeout-minutes: \d+/);
    assert.doesNotMatch(y, /ops\//, `${f} reaches into ops/`);
    // prepare's argument is the one difference: the private repo's public cut, the public repo's checkout.
    steps.push((y.match(/release-candidate\.sh [^\n]+/g) ?? []).map((l) => l.replace(/ prepare .*/, " prepare")).join(" | "));
  }
  assert.match(steps[0], /prepare .*cut A.*install.*check-install.*cut B.*update-good.*cut C.*update-bad.*usage report.*logs/);
  for (const s of steps) assert.equal(s, steps[0], "the two workflows run different steps");
  assert.match(readFileSync(files[0], "utf8"), existsSync(path.join(root, "public-root")) ? /CHECKS=0 tools\/public-export\.sh/ : /prepare \./);
});

test("vacuity anchor: the script ends where it should", () => {
  assert.match(readFileSync(SCRIPT, "utf8"), /\n {2}\*\) awk .*\n esac\n$|\nesac\n$/);
});
