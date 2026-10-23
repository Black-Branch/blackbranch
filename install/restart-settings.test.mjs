// The settings that apply only at a restart, as ONE list for the operator. Run: node --test install/
//
// What they hold: the list is generated from the schema's `reload: 'restart'` keys and holds every
// one an operator of this bundle can change (the ones left out are exactly the ones the bundle's .env
// never holds); install/restart-settings.tsv and the section of docs/public/operate.md match the
// schema; `blackbranch help` prints the same text the generator prints; and `blackbranch status`
// names an Admin Panel setting changed after its service started, until that service restarts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INSTANCE_KEYS } from "../config/instance-schema.mjs";
import { restartSettings, tsv, text, markdown, DOC_START, DOC_END } from "./restart-settings.mjs";
import { fakeHome } from "./scratch-home.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const read = (rel) => readFileSync(path.join(here, rel), "utf8");

// The install-tier keys an operator of this bundle cannot set: its .env never holds them.
const NOT_IN_ENV = ["discordBridge.displaynameTemplate", "discordBridge.usernameTemplate", "homeassistant.url",
  "matrix.federationServer", "matrix.legacyNamespace", "obs.url", "site.legacyId"];

test("the list is the schema's: every restart-only setting an operator of this bundle can change", () => {
  const schema = INSTANCE_KEYS.filter((k) => k.reload === "restart");
  assert.ok(schema.length >= 40, `vacuity: only ${schema.length} restart-only keys in the schema`);
  const rows = restartSettings();
  assert.deepEqual(rows.map((r) => r.key).sort(), schema.map((k) => k.key).filter((k) => !NOT_IN_ENV.includes(k)).sort());
  // Each left-out key really is one the bundle's .env never holds, and is install tier.
  const env = read(".env.example");
  for (const key of NOT_IN_ENV) {
    const k = INSTANCE_KEYS.find((x) => x.key === key);
    assert.equal(k.tier, "install", key); assert.doesNotMatch(env, new RegExp(`^${k.env[0]}=`, "m"), key);
  }
  // Every Admin Panel one (instance or secret tier) is a "panel" row naming the services that read it.
  for (const k of schema.filter((x) => x.tier !== "install")) {
    const r = rows.find((x) => x.key === k.key);
    assert.equal(r.group, "panel", k.key); assert.deepEqual(r.services, k.packages, k.key);
  }
  // A .env display value is one `blackbranch set` changes (and so restarts); the rest are the identity.
  const settable = read("blackbranch").match(/\nSETTABLE_KEYS=\(\n?([\s\S]*?)\n?\)/)[1].split(/\s+/).filter(Boolean);
  for (const r of rows.filter((x) => x.group !== "panel")) assert.equal(r.group === "set", settable.includes(r.env), r.key);
  assert.ok(rows.some((r) => r.group === "permanent" && r.env === "SITE_ORIGIN"));
});

test("install/restart-settings.tsv and docs/public/operate.md match the schema (regenerate with --write)", () => {
  assert.equal(read("restart-settings.tsv"), tsv(), "install/restart-settings.tsv drifted: node install/restart-settings.mjs --write");
  const doc = readFileSync(path.join(root, "docs/public/operate.md"), "utf8");
  const a = doc.indexOf(DOC_START), b = doc.indexOf(DOC_END);
  assert.ok(a > 0 && b > a, "operate.md has the generated section");
  assert.equal(doc.slice(a, b + DOC_END.length), markdown(), "docs/public/operate.md drifted: node install/restart-settings.mjs --write");
  const r = spawnSync(process.execPath, [path.join(here, "restart-settings.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  // Vacuity: one more restart-only key in the schema changes both.
  const more = [...INSTANCE_KEYS, { key: "modules.extra", tier: "instance", reload: "restart", packages: ["web"], env: [], label: "Extra" }];
  assert.notEqual(tsv(restartSettings(more)), tsv()); assert.notEqual(markdown(restartSettings(more)), markdown());
  // The section names every row, and says what to do in plain words.
  for (const row of restartSettings()) assert.ok(markdown().includes(`\`${row.group === "panel" ? row.key : row.env}\``), row.key);
  assert.doesNotMatch(markdown(), /—|\bsimply\b|\bseamless/i);
});

test("blackbranch help prints the generator's list, read from the release's tsv", () => {
  const r = spawnSync("bash", [path.join(here, "blackbranch"), "help"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", BB_HOME: "/nonexistent" } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.endsWith(`\n\n${text()}`), `help does not end with the list:\n${r.stdout.slice(-600)}`);
  assert.match(r.stdout, /blackbranch status/, "the usage comes first");
  assert.match(text(), /^Settings that apply only when their service restarts \(34\):$/m);
  assert.match(text(), /^ {4}modules\.obs {19} stream-api {17}OBS control$/m);
});

function statusHome() {
  const h = fakeHome();
  const changed = (lines) => writeFileSync(path.join(h.fake, "changed"), lines.join("\n") + "\n");
  const started = (svc, iso) => writeFileSync(path.join(h.fake, `started-${svc}`), `${iso}\n`);
  const status = (env = {}) => {
    const r = h.runWith(env, "status");
    return { ...r, lines: r.stdout.split("\n").filter((l) => /^ {2}restart {6}/.test(l)) };
  };
  return { ...h, changed, started, status };
}
const epoch = (iso) => Math.floor(Date.parse(iso) / 1000);

test("status: a restart-only setting changed in the Admin Panel after its service started is named with the restart; after the restart it is not", () => {
  const h = statusHome();
  try {
    // Nothing changed since the services started.
    h.started("stream-api", "2026-10-20T10:00:00Z"); h.started("web", "2026-10-20T10:00:00Z");
    h.changed([`modules.obs ${epoch("2026-10-19T09:00:00Z")}`]);
    let r = h.status();
    assert.deepEqual(r.lines, ["  restart      nothing waiting (34 settings apply only at a restart: blackbranch help lists them)"]);
    // Two settings written after stream-api started, one after web did: one line per service, its command.
    h.changed([`modules.obs ${epoch("2026-10-20T11:00:00Z")}`, `tts.enabled ${epoch("2026-10-20T11:05:00Z")}`, `matrix.registration ${epoch("2026-10-20T12:00:00Z")}`]);
    r = h.status();
    assert.deepEqual(r.lines, [
      "  restart      WAITING: modules.obs, tts.enabled changed after stream-api started, not applied yet. Run: sudo blackbranch restart stream-api",
      "  restart      WAITING: matrix.registration changed after web started, not applied yet. Run: sudo blackbranch restart web",
    ]);
    // Retry: asking again says the same; nothing was changed by asking.
    assert.deepEqual(h.status().lines, r.lines);
    // Restart: stream-api started again after the writes; only web's is still waiting.
    h.started("stream-api", "2026-10-20T13:00:00Z");
    assert.deepEqual(h.status().lines, ["  restart      WAITING: matrix.registration changed after web started, not applied yet. Run: sudo blackbranch restart web"]);
    h.started("web", "2026-10-20T13:00:00Z");
    assert.match(h.status().lines[0], /nothing waiting/);
    // A key that is not a panel restart-only setting is never named (a live one, a made-up one).
    h.changed([`site.timeZone ${epoch("2026-10-21T00:00:00Z")}`, `x;rm ${epoch("2026-10-21T00:00:00Z")}`]);
    assert.match(h.status().lines[0], /nothing waiting/);
    // The database down: said, not guessed.
    assert.deepEqual(h.status({ FAKE_STATE: "exited" }).lines,
      ["  restart      not checked: the database is not running (34 settings apply only at a restart: blackbranch help lists them)"]);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("status reads only the panel keys of the list, and the query sends them as one psql variable", () => {
  const bb = read("blackbranch");
  const fn = bb.slice(bb.indexOf("restart_pending() {"), bb.indexOf("restart_status_lines() {"));
  assert.ok(fn.length > 400, "the function was found");
  assert.match(fn, /\$2 == "panel"/);
  assert.match(fn, /key = ANY \(string_to_array\(:'keys', ' '\)\)/, "values travel as psql variables, never spliced into SQL");
  assert.match(fn, /-v keys="\$keys"/);
  // Vacuity anchor: the end of the status lines.
  assert.match(bb, /restart_status_lines\(\) \{[\s\S]*?Run: sudo blackbranch restart %s\\n' "\$keys" "\$svc" "\$svc"\n {2}done\n\}\n/);
});
