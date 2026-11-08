// The homeserver's retention block follows the install's cap (spec 2026-10-23 §4.5, ADR 0139).
// Run: node --test install/
//
// Why: the bundle rendered a fixed 180-day default and a one-year longest into every install's
// homeserver.yaml. On Synapse 1.162 a room policy without `max_lifetime` takes the server's default
// (it does NOT mean forever), and a room value above `allowed_lifetime_max` is accepted and then cut
// to it by the purge job (Task 1.6 proof). So the Community page's "Forever" and any choice above a
// year were untrue on every bundle. The block is now rendered from community.retentionCapDays:
//   cap N > 0  default_policy max_lifetime Nd, allowed_lifetime_max Nd (min stays 1d)
//   cap 0      enabled, with no default policy and no longest
// The host reads the cap at render (config_get; the stamp the last render saw while the database
// is down; the schema's own default when unset), so a change applies at the next start.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderHome, runRender, fakeHome } from "./scratch-home.mjs";
import { INSTANCE_KEYS } from "../config/instance-schema.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const read = (rel) => readFileSync(path.join(here, rel), "utf8");
const hsOf = (home) => readFileSync(path.join(home, "rendered/synapse/homeserver.yaml"), "utf8");
/** The retention block exactly: from `retention:` to the next top-level key. */
const block = (hs) => {
  const m = hs.match(/\nretention:\n((?: {2}.*\n)+)/);
  assert.ok(m, "the homeserver config has a retention block");
  return `retention:\n${m[1]}`;
};
const CAPPED = (n) => `retention:\n  enabled: true\n  default_policy:\n    max_lifetime: ${n}d\n  allowed_lifetime_min: 1d\n  allowed_lifetime_max: ${n}d\n`;
const UNCAPPED = "retention:\n  enabled: true\n  allowed_lifetime_min: 1d\n";
const SCHEMA_DEFAULT = INSTANCE_KEYS.find((k) => k.key === "community.retentionCapDays")?.default;

/** mx_render_homeserver alone, with the inputs the maintainers' disposable install gives it. */
function renderDirect(extraEnv) {
  return spawnSync("bash", ["-c", `. "$1"; mx_render_homeserver`, "_", path.join(here, "matrix/render.sh")], { encoding: "utf8", env: {
    PATH: "/usr/bin:/bin", MX_SERVER_NAME: "example.test", MX_PUBLIC_BASEURL: "https://matrix.example.test/", MX_CONFIG_DIR: "/data", MX_DATA_DIR: "/data",
    MX_DB_HOST: "db", MX_DB_NAME: "synapse", MX_DB_USER: "u", MX_DB_PASSWORD: "p", MX_REGISTRATION_SECRET: "a", MX_MACAROON_SECRET: "b", MX_FORM_SECRET: "c",
    MX_MAS_ENDPOINT: "http://mas:8080/", MX_MAS_SECRET: "d", MX_FEDERATION: "off", ...extraEnv } });
}

test("the schema's default is the one the host reads (one source: the render never repeats the number)", () => {
  assert.equal(SCHEMA_DEFAULT, 365, "vacuity: the schema entry was found");
  const r = spawnSync("bash", ["-c", `. "$1"; mx_retention_cap_default "$2"`, "_", path.join(here, "matrix/render.sh"), path.join(root, "config/instance-schema.mjs")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), String(SCHEMA_DEFAULT));
  // A schema it cannot read is said, never guessed.
  const bad = spawnSync("bash", ["-c", `. "$1"; mx_retention_cap_default /nonexistent`, "_", path.join(here, "matrix/render.sh")], { encoding: "utf8" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /could not read community\.retentionCapDays's default/);
});

test("cap N > 0: the server's default policy and its longest are both N days; the shortest stays one day", () => {
  for (const n of [1, 30, 365, 3650]) {
    const r = renderDirect({ MX_RETENTION_CAP_DAYS: String(n) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(block(r.stdout), CAPPED(n), `cap ${n}`);
  }
});

test("cap 0 (no limit): enabled, with no default policy and no longest — a room that says nothing keeps forever", () => {
  const r = renderDirect({ MX_RETENTION_CAP_DAYS: "0" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(block(r.stdout), UNCAPPED);
  assert.doesNotMatch(r.stdout, /default_policy|allowed_lifetime_max|max_lifetime/);
});

test("the render refuses a cap that is not whole days from 0 to 3650, and a missing one", () => {
  for (const bad of ["", "-1", "3651", "1y", "30d", "07", " 30", "1.5"]) {
    const r = renderDirect(bad === "" ? {} : { MX_RETENTION_CAP_DAYS: bad });
    assert.notEqual(r.status, 0, `cap ${JSON.stringify(bad)} was rendered`);
    assert.match(r.stderr, /MX_RETENTION_CAP_DAYS must be whole days from 0 \(no limit\) to 3650/, JSON.stringify(bad));
  }
});

test("blackbranch render passes the install's cap through (config_get), in both shapes", () => {
  const h = fakeHome();
  try {
    writeFileSync(path.join(h.fake, "cfg/community.retentionCapDays"), "30\n");
    let r = h.run("render");
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(block(hsOf(h.home)), CAPPED(30));
    assert.match(h.calls(), /compose exec -T postgres psql/, "the cap was asked of the database");
    writeFileSync(path.join(h.fake, "cfg/community.retentionCapDays"), "0\n");
    r = h.run("render");
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(block(hsOf(h.home)), UNCAPPED);
    assert.match(r.stdout, /homeserver\.yaml: written/, "a cap change is a new homeserver config");
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("unset: the schema's default (365 days), never a number of the host's own", () => {
  const h = fakeHome();
  try {
    const r = h.run("render");
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(block(hsOf(h.home)), CAPPED(SCHEMA_DEFAULT));
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("retention restart: with the database down, the cap the last render read is kept (not the default)", () => {
  const h = fakeHome();
  try {
    writeFileSync(path.join(h.fake, "cfg/community.retentionCapDays"), "0\n");
    assert.equal(h.run("render").status, 0);
    assert.equal(readFileSync(path.join(h.home, "state/retention-cap"), "utf8"), "0\n", "the cap the render read is recorded");
    // The database is down at the next start: the recorded cap is rendered again, not 365.
    const r = h.runWith({ FAKE_STATE: "exited" }, "render");
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(block(hsOf(h.home)), UNCAPPED);
    assert.match(r.stdout, /homeserver\.yaml: unchanged/);
    // A box that never recorded one (the first render ran with the database down): the default.
    const fresh = renderHome();
    try {
      assert.equal(runRender(fresh).status, 0);
      assert.equal(block(hsOf(fresh)), CAPPED(SCHEMA_DEFAULT));
      assert.ok(!existsSync(path.join(fresh, "state/retention-cap")), "nothing read, nothing recorded");
    } finally { rmSync(fresh, { recursive: true, force: true }); }
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("retention retry: a second render with the same cap changes nothing and restarts nothing", () => {
  const h = fakeHome();
  try {
    writeFileSync(path.join(h.fake, "cfg/community.retentionCapDays"), "90\n");
    assert.equal(h.run("render").status, 0);
    const first = hsOf(h.home);
    const again = h.run("render");
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /homeserver\.yaml: unchanged/);
    assert.equal(hsOf(h.home), first);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("the doctor's host facts: the rendered block as days, read only — the doctor records no cap", () => {
  const home = renderHome("BB_TLS_MODE=internal");
  try {
    mkdirSync(path.join(home, "results"), { mode: 0o755 });
    // The database is down here: the render takes the cap the last one recorded.
    writeFileSync(path.join(home, "state/retention-cap"), "30\n");
    assert.equal(runRender(home).status, 0);
    const facts = () => {
      const r = spawnSync("bash", [path.join(here, "blackbranch"), "doctor"], { encoding: "utf8",
        env: { ...process.env, BB_HOME: home, BB_DOCTOR_NODE: process.execPath, PATH: "/usr/bin:/bin" } });
      assert.match(r.stdout, /Black Branch doctor/, r.stderr);
      return JSON.parse(readFileSync(path.join(home, "results/doctor-host.json"), "utf8")).retention;
    };
    assert.deepEqual(facts(), { rendered: true, defaultDays: 30, maxDays: 30 });
    writeFileSync(path.join(home, "state/retention-cap"), "0\n");
    assert.equal(runRender(home).status, 0);
    assert.deepEqual(facts(), { rendered: true, defaultDays: null, maxDays: null });
    assert.equal(readFileSync(path.join(home, "state/retention-cap"), "utf8"), "0\n", "the doctor wrote no stamp");
    rmSync(path.join(home, "rendered/synapse/homeserver.yaml"));
    assert.deepEqual(facts(), { rendered: false });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("render publishes the cap it rendered for the site (results/retention-cap.json): the privacy page states what the server applies", () => {
  const h = fakeHome();
  try {
    mkdirSync(path.join(h.home, "results"), { mode: 0o755 });
    writeFileSync(path.join(h.fake, "cfg/community.retentionCapDays"), "30\n");
    assert.equal(h.run("render").status, 0);
    const read = () => JSON.parse(readFileSync(path.join(h.home, "results/retention-cap.json"), "utf8"));
    assert.equal(read().v, 1); assert.equal(read().capDays, 30); assert.match(read().at, /^\d{4}-\d{2}-\d{2}T/);
    // The saved cap changes; until the next render the published one is the old one.
    writeFileSync(path.join(h.fake, "cfg/community.retentionCapDays"), "0\n");
    assert.equal(read().capDays, 30);
    // retry: the next render publishes the new one; a second, the same.
    assert.equal(h.run("render").status, 0);
    assert.equal(read().capDays, 0);
    assert.equal(h.run("render").status, 0);
    assert.equal(read().capDays, 0);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
  // A box with no results folder (or one it may not write): the render still succeeds and says why.
  const bare = renderHome();
  try {
    const r = runRender(bare);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(path.join(bare, "results/retention-cap.json")));
  } finally { rmSync(bare, { recursive: true, force: true }); }
});

test("END anchor: render.sh and blackbranch were read to their last lines", () => {
  assert.match(read("matrix/render.sh"), /\n\thandle \{\n\t\trespond 404\n\t\}\nEOF\n\}\n$/);
  assert.match(read("blackbranch"), /\n {2}\*\) die "unknown command \\"\$cmd\\" \(blackbranch help\)" ;;\nesac\n$/);
});
