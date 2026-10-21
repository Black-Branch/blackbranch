// The doctor. Run: node --test install/
// What they hold: every check's verdict for a green, a red and a grey set of facts; the list is one
// list (the page's copy is the same text, the command runs the same file); the release's database
// version is the newest migration; `blackbranch doctor` prints the list, exits 1 on a red, keeps
// working with the site down, writes nothing but its facts and its report; the report holds no
// .env value, and a report that would is refused rather than written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DOCTOR } from "../config/doctor.mjs";
import { renderHome, runRender } from "./scratch-home.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

// All green: a bundle in tunnel mode that is healthy in every way the doctor can see.
const greenHost = () => ({
  v: 1, at: "2026-10-10T00:00:00Z", release: "r1", mode: "tunnel", memTotalMiB: 3922,
  disk: [{ what: "install", freePct: 60 }, { what: "docker", freePct: 60 }], clockSynced: true, upgrades: true,
  names: [{ name: "site", resolves: true }, { name: "api", resolves: true }, { name: "matrix", resolves: true }],
  tunnel: true, certs: [], answers: [{ name: "site", status: 200 }, { name: "api", status: 200 }, { name: "matrix", status: 200 }], answersVia: "public", outside: [],
  rendered: [{ file: "Caddyfile", match: true }, { file: "synapse/homeserver.yaml", match: true }], renderError: false,
  secrets: { count: 15, missing: [], masKeys: true, signingKey: true },
  // stream-ingest's own report (contract 1) and read-aloud's (contract 2), asked inside each container.
  ingest: { answered: true, ok: true, readers: { twitch: { state: "running", since: "2026-10-09T20:00:00Z", error: "" }, kick: { state: "off", since: null, error: "" } } },
  tts: { answered: true, enabled: true, keySet: true, voiceSet: true },
  // A backup 5 hours before these facts, checked two days before them; the target answers.
  backups: { last: { at: "2026-10-09T19:00:00Z", ok: true, lastOkAt: "2026-10-09T19:00:00Z" },
    verify: { at: "2026-10-08T00:00:00Z", ok: true, failed: [] }, target: { kind: "local", repo: "ok" } },
  // The feed read 4 hours before these facts, up to date; one update applied before.
  updates: {
    check: { v: 1, at: "2026-10-09T20:00:00Z", ok: true, readAt: "2026-10-09T20:00:00Z", channel: "stable", current: "1.0.1", available: null, refused: null, expires: "2026-11-01T00:00:00Z", error: null },
    last: { v: 1, at: "2026-10-05T04:50:00Z", from: "1.0.0", to: "1.0.1", result: "updated", ok: true, message: "1.0.0 → 1.0.1", snapshot: "abcd1234", health: { ok: true }, rollbackHealth: null },
    state: { v: 1, state: "idle", from: "1.0.0", to: "1.0.1", step: 0, steps: 8, words: "", since: "2026-10-05T04:45:00Z", at: "2026-10-05T04:50:00Z" },
  },
});
const greenSite = () => ({
  v: 1, at: "2026-10-10T00:00:00Z", bundle: true,
  db: { reachable: true, version: DOCTOR.SCHEMA_VERSION, baseline: true, vector: "0.8.0" },
  matrix: { versions: 200, mas: 200, issuer: true, wellKnownClient: true, wellKnownServer: true, federation: { switch: false, reachable: false }, legacyNamespace: false,
    // The lockdown last closed sign-up an hour before these facts; the host rendered it a minute later.
    lockdown: { managed: "bundle", registration: "closed", closedByLockdown: true, lastWrite: "2026-10-09T23:00:00Z", render: { ok: true, at: "2026-10-09T23:01:00Z" } } },
  secrets: { missing: [], token: "ok", stored: { total: 2, unreadable: 0 } },
  modules: [{ id: "obs", on: true, servesMedia: false, tests: [{ step: "websocket", ok: true, detail: "accepted" }] }],
  skipped: [],
  heldOn: [],
  payments: { stripe: { on: true, test: { ok: true, code: "accepted", detail: "accepted" } }, paypal: { on: true, test: { ok: true, code: "accepted", detail: "accepted (live)" } } },
  platforms: [{ id: "twitch", label: "Twitch", set: true, ok: true, detail: "accepted — channel found, id 123" }, { id: "kick", label: "Kick", set: false, ok: null, detail: "" }],
  platform: { legacyId: "unset", olderAccounts: false },
  services: { api: { reachable: true, loaded: true }, ingest: { reportedMinutesAgo: 2, loaded: true },
    platforms: [{ id: "twitch", label: "Twitch", set: true, connected: null, lastMessageMinutes: 30 }, { id: "kick", label: "Kick", set: false, connected: null, lastMessageMinutes: null }] },
  alerts: { topics: 2 },
});
const run = (mutate = () => {}, input = {}) => {
  const host = greenHost(); const site = greenSite();
  mutate(host, site);
  return Object.fromEntries(DOCTOR.evaluate({ host, hostState: "ok", site, siteError: null, ...input }).map((r) => [r.id, r]));
};

test("the installer and the doctor have one memory floor: a box install.sh accepts is never one the doctor fails", () => {
  const inInstaller = readFileSync(path.join(here, "install.sh"), "utf8").match(/^MIN_MEMORY_MIB=(\d+)$/m);
  const inDoctor = readFileSync(path.join(root, "config/doctor.mjs"), "utf8").match(/^ {2}const MIN_MEMORY_MIB = (\d+);/m);
  assert.ok(inInstaller && inDoctor, "both floors are where this test reads them");
  assert.equal(inInstaller[1], inDoctor[1]);
  assert.match(readFileSync(path.join(here, "install.sh"), "utf8"), /\[ "\$mem_mb" -ge "\$MIN_MEMORY_MIB" \] \|\| die /, "the installer compares against it");
  const floor = Number(inDoctor[1]);
  assert.equal(run((h) => { h.memTotalMiB = floor; })["box.memory"].status, "ok");
  assert.equal(run((h) => { h.memTotalMiB = floor - 1; })["box.memory"].status, "fail");
});

test("all green facts: every check this release makes is ok, and the later areas are grey", () => {
  const rows = run();
  const later = DOCTOR.CHECKS.filter((c) => c.side === "later").map((c) => c.id);
  assert.deepEqual(later, [], "every area is checked");
  for (const [id, r] of Object.entries(rows)) {
    if (later.includes(id)) { assert.equal(r.status, "grey", id); assert.equal(r.detail, "not checked in this release"); }
    // The Cloudflare skip rule cannot be read without a Cloudflare token: grey "check by hand", never red.
    else if (id === "payments.cloudflare") { assert.equal(r.status, "grey"); assert.match(r.detail, /check by hand: a WAF Skip rule for \/api\/billing\/webhook/); }
    // A fresh install has no older platform id: not applicable, grey (not a pass it never needed).
    else if (id === "site.legacyId") { assert.equal(r.status, "grey"); assert.match(r.detail, /^not needed: a fresh install/); }
    else assert.equal(r.status, "ok", `${id}: ${r.detail}`);
  }
  assert.equal(Object.keys(rows).length, 43, "vacuity: the list was read whole");
});

// One red fixture per check: [id, mutate(host, site), detail it must say].
const RED = [
  ["box.memory", (h) => { h.memTotalMiB = 1990; }, /1990 MiB/],
  ["box.disk", (h) => { h.disk[1].freePct = 9; }, /9 % free where Docker/],
  ["box.clock", (h) => { h.clockSynced = false; }, /not synchronised/],
  ["box.upgrades", (h) => { h.upgrades = false; }, /off/],
  ["door.names", (h) => { h.names[2].resolves = false; }, /matrix\. does not resolve/],
  ["door.tls", (h) => { h.tunnel = false; }, /not connected/],
  ["door.answers", (h) => { h.answers[2].status = 502; }, /matrix\. answered 502/],
  ["db.reachable", (h, s) => { s.db.reachable = false; }, /cannot reach/],
  ["db.schema", (h, s) => { s.db.version = DOCTOR.SCHEMA_VERSION - 1; }, /this release expects/],
  ["db.vector", (h, s) => { s.db.vector = null; }, /not installed/],
  ["matrix.synapse", (h, s) => { s.matrix.versions = 502; }, /answered 502/],
  ["matrix.mas", (h, s) => { s.matrix.mas = 0; }, /did not answer/],
  ["matrix.issuer", (h, s) => { s.matrix.issuer = false; }, /different issuer/],
  ["matrix.wellknown", (h, s) => { s.matrix.wellKnownServer = false; }, /server differs/],
  ["matrix.rendered", (h) => { h.rendered[1].match = false; }, /homeserver\.yaml differs/],
  ["matrix.federation", (h, s) => { s.matrix.federation.reachable = true; }, /switched off, but other servers can reach it/],
  // The Lockdown screen's "Not applied to the homeserver yet — retrying", on the doctor: a render
  // older than the lockdown's last write (20 min ago), or one that failed.
  ["matrix.lockdown", (h, s) => { s.matrix.lockdown.lastWrite = "2026-10-09T23:40:00Z"; }, /the lockdown closed homeserver sign-up 20 min ago, but the server has not applied it — the site keeps retrying/],
  ["matrix.namespace", (h, s) => { s.matrix.legacyNamespace = true; }, /started from the baseline/],
  ["site.legacyId", (h, s) => { s.platform.legacyId = "ignored"; }, /the site ignores it/],
  ["secrets.bootstrap", (h) => { h.secrets.missing = ["TOKEN_ENC_KEY"]; }, /missing: TOKEN_ENC_KEY/],
  ["secrets.site", (h, s) => { s.secrets.missing = ["AUTH_SECRET"]; }, /AUTH_SECRET/],
  ["secrets.token", (h, s) => { s.secrets.token = "fail"; }, /does not decrypt/],
  ["secrets.stored", (h, s) => { s.secrets.stored.unreadable = 1; }, /1 of 2/],
  ["modules.tests", (h, s) => { s.modules[0].tests[0] = { step: "websocket", ok: false, detail: "refused" }; }, /obs: refused/],
  ["media.tunnel", (h, s) => { s.modules.push({ id: "radio", on: true, servesMedia: true, tests: [] }); }, /radio serves a media library through the tunnel/],
  ["payments.stripe", (h, s) => { s.payments.stripe.test = { ok: false, code: "not_found", detail: "not found at the provider — check the name, id or address" }; }, /not found at the provider/],
  ["payments.paypal", (h, s) => { s.payments.paypal.test = { ok: false, code: "wrong_target", detail: "the webhook points at another address, not this site" }; }, /another address/],
  ["services.api", (h, s) => { s.services.api.reachable = false; }, /does not answer the site/],
  ["services.ingest", (h, s) => { s.services.ingest.reportedMinutesAgo = 40; s.services.platforms[0].set = false; }, /last reported 40 min ago/],
  ["services.platforms", (h, s) => { s.services.platforms[0].connected = false; }, /Twitch: connection broken/],
  ["ingest.readers", (h) => { h.ingest.ok = false; h.ingest.readers.youtube = { state: "failed", since: "2026-10-09T20:00:00Z", error: "the browser did not start" }; }, /YouTube: the browser did not start/],
  ["tts.ready", (h) => { h.tts.voiceSet = false; }, /switched on, but a voice id is not set — nothing is read aloud/],
  ["platforms.credentials", (h, s) => { s.platforms[0] = { id: "twitch", label: "Twitch", set: true, ok: false, detail: "rejected (HTTP 403)" }; }, /Twitch: rejected \(HTTP 403\)/],
  ["backups.age", (h) => { h.backups.last = { at: "2026-10-08T11:00:00Z", ok: true, lastOkAt: "2026-10-08T11:00:00Z" }; }, /the last good backup is 37 hours old/],
  ["backups.verify", (h) => { h.backups.verify = { at: "2026-10-09T00:00:00Z", ok: false, failed: ["tables", "signingKey"] }; }, /the last check failed \(tables and signingKey\)/],
  ["backups.target", (h) => { h.backups.target.repo = "unreachable"; }, /this server's backup folder does not answer/],
  ["updates.feed", (h) => { h.updates.check.readAt = "2026-10-06T23:00:00Z"; h.updates.check.ok = false; h.updates.check.error = "the feed did not answer"; }, /not read for 3 days \(the feed did not answer\)/],
  ["updates.last", (h) => { h.updates.last = { ...h.updates.last, result: "rollback-failed", to: "1.0.2", message: "failed its health check — and going back failed" }; }, /1\.0\.2 failed, and going back did not finish cleanly/],
];

test("each check goes red on its own fact, says what is wrong, and carries a fix line", () => {
  const ids = DOCTOR.CHECKS.filter((c) => c.side !== "later").map((c) => c.id);
  // modules.skipped, modules.failsafe, alerts.channel and door.outside are amber at worst; payments.cloudflare is grey at worst.
  assert.deepEqual([...RED.map((x) => x[0]), "modules.skipped", "modules.failsafe", "payments.cloudflare", "alerts.channel", "door.outside"].sort(), [...ids].sort(), "a red fixture for every check");
  for (const [id, mutate, says] of RED) {
    const rows = run(mutate);
    assert.equal(rows[id].status, "fail", `${id} did not go red`);
    assert.match(rows[id].detail, says, id);
    assert.ok(rows[id].fix.length > 20, `${id} has no fix line`);
    const others = Object.values(rows).filter((r) => r.id !== id && r.status === "fail").map((r) => r.id);
    assert.deepEqual(others, [], `${id}'s fact turned other checks red too`);
  }
  const skipped = run((h, s) => { s.skipped = ["obs:websocket"]; })["modules.skipped"];
  assert.equal(skipped.status, "warn"); assert.match(skipped.detail, /obs:websocket/);
});

test("payments and platforms — off is ok, a key that may not read webhooks is grey, the upgrade fail-safe is amber", () => {
  const off = run((h, s) => { s.payments = { stripe: { on: false, test: null }, paypal: { on: false, test: null } }; });
  assert.equal(off["payments.stripe"].status, "ok"); assert.equal(off["payments.stripe"].detail, "Stripe is switched off");
  assert.equal(off["payments.cloudflare"].status, "ok", "no Stripe, nothing for Cloudflare to block");
  assert.equal(off["payments.paypal"].detail, "PayPal is switched off");
  const limited = run((h, s) => { s.payments.stripe.test = { ok: true, code: "limited", detail: "key works, but lacks a permission this check needs" }; })["payments.stripe"];
  assert.equal(limited.status, "grey"); assert.match(limited.detail, /check the webhook by hand/);
  assert.equal(run((h, s) => { s.payments.paypal.test = { ok: null, code: "unanswered", detail: "not checked" }; })["payments.paypal"].status, "grey");
  assert.equal(run((h, s) => { s.platforms = []; })["platforms.credentials"].detail, "no platform is set up");
  assert.equal(run((h, s) => { s.platforms = [{ id: "kick", label: "Kick", set: true, ok: true, detail: "channel only: no app to test" }]; })["platforms.credentials"].status, "ok");
  const held = run((h, s) => { s.heldOn = ["modules.stripe", "modules.paypal"]; })["modules.failsafe"];
  assert.equal(held.status, "warn"); assert.equal(held.detail, "held on with no saved switch: stripe and paypal"); assert.match(held.fix, /blackbranch migrate/);
  assert.equal(run((h, s) => { delete s.heldOn; delete s.payments; delete s.platforms; })["payments.stripe"].status, "grey", "an older site that does not report: grey");
});

test("updates: the feed quiet for 3 days is red, a failed read amber, a rollback amber, a cut-off update red; running is grey", () => {
  const feed = (mut) => run((h) => mut(h.updates.check))["updates.feed"];
  assert.equal(feed((c) => { c.readAt = "2026-10-07T01:00:00Z"; }).status, "ok", "71 h");
  assert.equal(feed((c) => { c.readAt = "2026-10-07T00:00:00Z"; }).status, "fail", "72 h");
  assert.match(feed((c) => { c.readAt = "2026-10-07T00:00:00Z"; }).detail, /not read for 3 days/);
  const failed = feed((c) => { c.ok = false; c.error = "the feed did not answer"; });
  assert.equal(failed.status, "warn"); assert.match(failed.detail, /the last read failed \(the feed did not answer\); the one before was 4 h ago/);
  assert.match(feed((c) => { c.available = { version: "1.0.2", security: true, published: "x", notes: "" }; }).detail, /1\.0\.2 is available — a security release: it applies itself at the quiet hour, never while the stream is live/);
  assert.match(feed((c) => { c.available = { version: "1.0.2", security: false, published: "x", notes: "" }; }).detail, /a feature release: Admin Panel → Updates/);
  assert.match(feed((c) => { c.available = { version: "2.0.0", security: false, published: "x", notes: "" }; c.refused = "it runs Postgres 19"; }).detail, /2\.0\.0 is published but cannot be applied here: it runs Postgres 19/);
  assert.match(feed((c) => { c.readAt = null; c.error = "the feed is signed by a key this box does not trust"; }).detail, /never been read \(the feed is signed by a key this box does not trust\)/);
  assert.equal(run((h) => { h.updates.check = null; })["updates.feed"].status, "fail");
  const plain = feed((c) => { c.plainHttp = true; });
  assert.equal(plain.status, "warn"); assert.match(plain.detail, /over plain http — a network in between could hold a release back/);
  assert.equal(run((h) => { delete h.updates; })["updates.feed"].status, "grey", "an older box's facts: grey, never red");
  const last = (over) => run((h) => { h.updates.last = { ...h.updates.last, ...over }; })["updates.last"];
  assert.equal(last({}).detail, "1.0.0 → 1.0.1 (2026-10-05)");
  const rb = last({ result: "rolled-back", to: "1.0.2", message: "failed its health check; the box is back on 1.0.1" , from: "1.0.1" });
  assert.equal(rb.status, "warn"); assert.match(rb.detail, /^1\.0\.2 failed its health check \(2026-10-05\); the box went back to 1\.0\.1/);
  // Only a chat reader failed: retried by the timer, three nights in all, then parked — said either way.
  const reader = (attempts) => last({ result: "rolled-back", to: "1.0.2", from: "1.0.1", reason: "reader-regression", attempts, message: "failed its health check: a chat reader that ran before the update failed after it — YouTube: x; the box is back" });
  assert.match(reader(1).detail, /only a chat reader failed: the timer tries it again tonight \(attempt 1 of 3 done\)$/);
  assert.equal(reader(3).status, "warn"); assert.match(reader(3).detail, /parked after 3 attempts, each failed only by a chat reader/);
  assert.doesNotMatch(rb.detail, /chat reader|parked/, "any other failure: as before");
  assert.equal(last({ result: "not-applied", message: "a key no migration explains: X" }).status, "warn");
  assert.equal(last({ result: "interrupted", message: "stopped at step 7" }).status, "fail");
  assert.match(last({ result: "interrupted", message: "stopped at step 7" }).fix, /blackbranch restore <snapshot> --yes/);
  assert.equal(run((h) => { h.updates.last = null; })["updates.last"].detail, "no update has run on this box yet");
  const running = run((h) => { h.updates.state = { ...h.updates.state, state: "running", to: "1.0.2", step: 4, words: "building" }; })["updates.last"];
  assert.equal(running.status, "grey"); assert.match(running.detail, /an update to 1\.0\.2 is running — step 4 of 8: building/);
  assert.equal(run(() => {}, { host: null, hostState: "none" })["updates.feed"].detail, "not a bundle install");
});

test("the update's health verdict: the checks an update can affect, nothing else; the site's facts required unless setup runs", () => {
  const ids = DOCTOR.CHECKS.map((c) => c.id);
  for (const id of DOCTOR.UPDATE_CHECKS) assert.ok(ids.includes(id), `${id} is a check`);
  assert.ok(DOCTOR.UPDATE_CHECKS.length >= 12, "vacuity");
  const verdict = (mutate, input = {}) => {
    const host = greenHost(); const site = greenSite(); mutate(host, site);
    const i = { host, hostState: "ok", site, siteError: null, ...input };
    return DOCTOR.health(DOCTOR.evaluate(i), i);
  };
  assert.deepEqual(verdict(() => {}), { ok: true, failed: [], rows: [] });
  assert.deepEqual(verdict((h, s) => { s.db.version = DOCTOR.SCHEMA_VERSION - 1; }).failed, ["db.schema"], "migrations not applied");
  assert.deepEqual(verdict((h) => { h.answers[1].status = 502; }).failed, ["door.answers"]);
  assert.equal(verdict((h) => { h.disk[0].freePct = 5; h.backups.last = null; }).ok, true, "a full disk or no backup is the doctor's, not the update's");
  const down = verdict(() => {}, { site: null, siteError: "web is exited" });
  assert.equal(down.ok, false); assert.ok(down.failed.includes("db.reachable") && down.failed.includes("matrix.synapse"), "the site not answering fails the update");
  const setup = verdict(() => {}, { site: null, siteError: "setting up", setupRunning: true });
  assert.equal(setup.ok, true, "while setup runs the site serves no facts: the box's checks only");
  assert.deepEqual(verdict((h) => { h.secrets.missing = ["AUTH_SECRET"]; }, { site: null, setupRunning: true }).failed, ["secrets.bootstrap"]);
});

// R1.1: a direct-mode box behind a home router often cannot reach its own public address (no NAT
// hairpin). The update's check asks caddy on the box itself, by name, with the real certificate;
// the by-public-name answer is its own row, amber at worst, and never part of an update's verdict.
test("direct mode: the update's front-door check is caddy on this box; the public-name answer is a warning that no update waits on", () => {
  assert.ok(DOCTOR.UPDATE_CHECKS.includes("door.answers"), "the router answering by name still gates an update");
  assert.ok(!DOCTOR.UPDATE_CHECKS.includes("door.outside"), "reaching the box from outside never gates an update");
  const direct = (outside) => (h) => {
    h.mode = "direct"; h.tunnel = null; h.answersVia = "box";
    h.certs = [{ name: "site", daysLeft: 80 }, { name: "api", daysLeft: 80 }, { name: "matrix", daysLeft: 80 }];
    h.outside = outside;
  };
  const noHairpin = [{ name: "site", status: 0 }, { name: "api", status: 0 }, { name: "matrix", status: 0 }];
  const rows = run(direct(noHairpin));
  assert.equal(rows["door.answers"].status, "ok");
  assert.match(rows["door.answers"].detail, /asked at this box's own router/);
  assert.equal(rows["door.outside"].status, "warn", "amber, never red");
  assert.match(rows["door.outside"].detail, /the site, api\. and matrix\. did not answer this box by their public names/);
  assert.match(rows["door.outside"].fix, /Wi-Fi off/);
  assert.match(rows["door.outside"].fix, /NAT loopback/);
  const i = { host: (() => { const h = greenHost(); direct(noHairpin)(h); return h; })(), hostState: "ok", site: greenSite(), siteError: null };
  assert.deepEqual(DOCTOR.health(DOCTOR.evaluate(i), i), { ok: true, failed: [], rows: [] }, "no hairpin: the update's verdict passes");
  assert.equal(run(direct([{ name: "site", status: 200 }, { name: "api", status: 200 }, { name: "matrix", status: 200 }]))["door.outside"].status, "ok");
  assert.equal(run(direct([]))["door.outside"].status, "grey", "not asked (the update's own run skips it)");
  assert.equal(run(direct(undefined))["door.outside"].status, "grey", "an older box's facts: grey");
  // Tunnel mode: the router row IS the outside path (out to Cloudflare and back in); lab mode has no outside.
  assert.equal(run()["door.outside"].status, "ok"); assert.match(run()["door.outside"].detail, /through the tunnel/);
  assert.equal(run((h) => { h.answers[0].status = 0; })["door.outside"].status, "warn", "the tunnel's failure is the row above's red, here amber");
  assert.equal(run((h) => { h.mode = "internal"; })["door.outside"].status, "grey");
});

// Round 1 contract 1: the readers stream-ingest reports, named when one failed to start.
test("ingest.readers: a reader that failed is named with its reason; off is ignored; no answer is grey; never an update check", () => {
  const row = (mut) => run((h) => mut(h.ingest, h))["ingest.readers"];
  assert.equal(row(() => {}).detail, "Twitch: running", "an off reader is not listed");
  const bad = row((g) => { g.ok = false; g.readers.youtube = { state: "failed", since: null, error: "browserType.launch: Executable doesn't exist" }; g.readers.kick = { state: "failed", since: null, error: "" }; });
  assert.equal(bad.status, "fail");
  assert.equal(bad.detail, "Kick: failed to start; YouTube: browserType.launch: Executable doesn't exist");
  assert.equal(bad.fix, "Admin Panel → Stream shows the reason; blackbranch logs stream-ingest.");
  assert.equal(row((g) => { g.readers.youtube = { state: "starting", since: null, error: "" }; }).status, "ok", "starting under two minutes counts as ok (the service says ok)");
  const slow = row((g) => { g.ok = false; g.readers.youtube = { state: "starting", since: null, error: "" }; });
  assert.equal(slow.status, "warn"); assert.match(slow.detail, /YouTube still starting after two minutes/);
  assert.equal(row((g) => { g.readers = { kick: { state: "off" } }; }).detail, "no platform is switched on");
  assert.equal(run((h) => { h.ingest = { answered: false }; })["ingest.readers"].status, "grey");
  assert.equal(run((h) => { delete h.ingest; })["ingest.readers"].status, "grey", "an older box's facts");
  assert.ok(!DOCTOR.UPDATE_CHECKS.includes("ingest.readers"), "a platform outside the box never rolls an update back");
});

// The host asks stream-ingest inside its container with blackbranch's own snippet; run that snippet
// here against a stand-in /health: it keeps fixed fields only and one cleaned line per reader.
test("the host's ingest snippet: fixed fields only, a cleaned one-line error, {answered:false} when nothing answers", async () => {
  const js = /\nINGEST_HEALTH_JS='([^']+)'\n/.exec(readFileSync(path.join(here, "blackbranch"), "utf8"))?.[1];
  assert.ok(js, "the snippet is where this test reads it");
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, bot: "running", extra: "dropped",
      readers: { youtube: { state: "failed", since: "2026-10-20T01:02:03Z<b>", error: "line one\nline two\u0007", payload: { text: "a viewer's words" } },
        "Bad Key": { state: "running" }, kick: { state: "weird" } } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    // Async: the stand-in is served from this process, so the child must not block its event loop.
    const { execFile } = await import("node:child_process");
    const run1 = (src) => new Promise((resolve) => execFile(process.execPath, ["-e", src], { encoding: "utf8", timeout: 20_000 }, (e, stdout) => resolve(stdout)));
    const out = JSON.parse(await run1(js.replace("127.0.0.1:3010", `127.0.0.1:${server.address().port}`)));
    assert.deepEqual(out, { answered: true, ok: false, readers: {
      youtube: { state: "failed", since: "2026-10-20T01:02:03Z", error: "line one line two " },
      kick: { state: "unknown", since: null, error: "" } } });
  } finally { server.close(); }
  assert.deepEqual(JSON.parse(run1Closed(js)), { answered: false });
  const tts = /\nTTS_STATUS_JS='([^']+)'\n/.exec(readFileSync(path.join(here, "blackbranch"), "utf8"))?.[1];
  assert.ok(tts, "the read-aloud snippet is where this test reads it");
  assert.deepEqual(JSON.parse(run1Closed(tts)), { answered: false }, "it parses and runs");
});
const run1Closed = (js) => spawnSync(process.execPath, ["-e", js.replace(/127\.0\.0\.1:30(10|01)/, "127.0.0.1:9")], { encoding: "utf8", timeout: 20_000 }).stdout;

// Round 1 contract 2: read-aloud's readiness, only while it is switched on.
test("tts.ready: switched off is skipped; on without the key or a voice is red with the Voice page's fix", () => {
  const row = (mut) => run((h) => mut(h.tts))["tts.ready"];
  assert.equal(row(() => {}).status, "ok");
  const off = row((t) => { t.enabled = false; t.keySet = false; t.voiceSet = false; });
  assert.equal(off.status, "grey"); assert.equal(off.detail, "skipped: read-aloud is switched off");
  const both = row((t) => { t.keySet = false; t.voiceSet = false; });
  assert.equal(both.status, "fail"); assert.match(both.detail, /the ElevenLabs key and a voice id are not set/);
  assert.equal(both.fix, "Admin Panel → Voice: set the ElevenLabs key and a voice id");
  assert.equal(run((h) => { h.tts = { answered: false }; })["tts.ready"].status, "grey");
});

// W18b: a fresh install's failing rows were all "module on, keys not set". A module that is
// untouched (switched on, never configured, its page never opened — the site's fact) is amber
// "not set up yet" until its page is visited; then its Test counts as before.
test("modules.tests: an untouched module is 'not set up yet' (amber), a visited one fails as before", () => {
  const failing = (untouched) => (h, s) => { s.modules[0].tests[0] = { step: "websocket", ok: false, detail: "refused" }; s.modules[0].untouched = untouched; };
  const fresh = run(failing(true))["modules.tests"];
  assert.equal(fresh.status, "warn");
  assert.equal(fresh.detail, "not set up yet: obs — switched on, but its page has not been opened");
  assert.match(fresh.fix, /set it up, or switch the module off/);
  assert.equal(run(failing(false))["modules.tests"].status, "fail", "visited: its Test counts");
  assert.equal(run(failing(undefined))["modules.tests"].status, "fail", "a site that does not report the fact: as before");
  // The setup flow's stamp, read by the host: setup.state.visited ("module:<id>").
  const stamped = (setup) => run((h, s) => { failing(undefined)(h, s); h.setup = setup; })["modules.tests"].status;
  assert.equal(stamped({ visited: ["core:kick", "module:stripe"], completed: false }), "warn", "obs's page not in the list: not set up yet");
  assert.equal(stamped({ visited: ["module:obs"], completed: true }), "fail", "visited: its Test counts");
  assert.equal(stamped({ visited: null, completed: false }), "warn", "no list during setup = nothing visited yet");
  assert.equal(stamped({ visited: null, completed: true }), "fail", "an install that finished setup before the stamp existed: as before");
  assert.equal(stamped(null), "fail", "the host could not read it: as before");
  const mixed = run((h, s) => { failing(true)(h, s); s.modules.push({ id: "youtube", on: true, servesMedia: false, tests: [{ step: "channel", ok: false, detail: "not found" }] }); })["modules.tests"];
  assert.equal(mixed.status, "fail"); assert.equal(mixed.detail, "youtube: not found; not set up yet: obs");
});

test("the printout's header: one line per group, each saying what it asks of the reader", () => {
  const rows = DOCTOR.evaluate({ host: (() => { const h = greenHost(); h.memTotalMiB = 1990; return h; })(), hostState: "ok", site: greenSite(), siteError: null });
  const head = DOCTOR.text(rows).split("\n").slice(0, 4);
  const n = (st) => rows.filter((r) => r.status === st).length;
  assert.deepEqual(head.map((l) => l.trim().split(" ")[0]).map(Number), [n("fail"), n("warn"), n("ok"), n("grey")]);
  assert.match(head[0], /^ ?1 failing {5}something does not work — fix these first; each says how$/);
  assert.match(head[2], /^\d+ ok$/);
  assert.deepEqual(DOCTOR.summary(rows).map((g) => [g.status, g.n]), [["fail", n("fail")], ["warn", n("warn")], ["ok", n("ok")], ["grey", n("grey")]]);
  assert.equal(n("fail") + n("warn") + n("ok") + n("grey"), rows.length, "every row in one group");
});

test("site.legacyId: needed only where the site had visitors before the platform-key rename", () => {
  const row = (legacyId, olderAccounts, baseline) => run((h, s) => { s.platform = { legacyId, olderAccounts }; s.db.baseline = baseline; })["site.legacyId"];
  // A chain-built database with accounts from before the rename, and no install value: amber, with the fix.
  const missing = row("unset", true, false);
  assert.equal(missing.status, "warn");
  assert.match(missing.detail, /accounts from before the platform-key rename/);
  assert.match(missing.fix, /SITE_LEGACY_ID/);
  assert.match(missing.fix, /restart the site — it is read when the site starts/, "an install value: read at start, nothing to rebuild");
  assert.doesNotMatch(missing.fix, /rebuild/);
  assert.equal(row("set", true, false).status, "ok");
  assert.match(row("set", true, false).detail, /migration chain/);
  // Not applicable: grey, never a pass and never a warning.
  assert.equal(row("unset", false, false).status, "grey");
  assert.equal(row("unset", false, true).status, "grey");
  assert.equal(row("unset", null, false).status, "grey");
  // Set where there is nothing to translate: amber, and its own fix says to remove it.
  const extra = row("set", false, true);
  assert.equal(extra.status, "warn");
  assert.match(extra.fix, /^Remove SITE_LEGACY_ID/);
  assert.equal(row("ignored", true, false).status, "fail");
  assert.equal(run((h, s) => { delete s.platform; })["site.legacyId"].status, "grey", "an older site that reports no such fact");
});

test("the edges: the schema the other way, certificates in direct mode, federation on, the old-chain namespace", () => {
  assert.match(run((h, s) => { s.db.version = DOCTOR.SCHEMA_VERSION + 1; })["db.schema"].fix, /newer release/);
  const direct = (days) => run((h) => { h.mode = "direct"; h.tunnel = null; h.certs = [{ name: "site", daysLeft: 80 }, { name: "api", daysLeft: days }, { name: "matrix", daysLeft: 80 }]; })["door.tls"];
  assert.equal(direct(15).status, "ok"); assert.equal(direct(14).status, "fail"); assert.equal(direct(null).status, "fail");
  assert.equal(run((h, s) => { s.matrix.federation = { switch: true, reachable: true }; })["matrix.federation"].status, "ok");
  assert.equal(run((h, s) => { s.matrix.federation = { switch: true, reachable: false }; })["matrix.federation"].status, "fail");
  assert.equal(run((h, s) => { s.matrix.legacyNamespace = true; s.db.baseline = false; })["matrix.namespace"].status, "ok", "the migration chain's own install may carry its prefix");
  assert.equal(run((h) => { h.renderError = true; })["matrix.rendered"].status, "fail");
  assert.equal(run((h, s) => { s.modules.push({ id: "radio", on: true, servesMedia: true, tests: [] }); h.mode = "direct"; })["media.tunnel"].status, "ok");
  assert.equal(run((h) => { h.disk[0].freePct = 15; })["box.disk"].status, "ok", "15 % is enough");
  // Media: not a bundle → the site's own probe of api. decides; an owner module is amber, a product one red.
  const media = (mod, door) => run((h, s) => { s.modules.push({ id: "radio", on: true, servesMedia: true, tests: [], ...mod }); s.door = door; }, { host: null, hostState: "none" })["media.tunnel"];
  assert.equal(media({ owner: true }, { apiCloudflare: true }).status, "warn", "the owner's own module through Cloudflare: to look at, said truthfully");
  assert.match(media({ owner: true }, { apiCloudflare: true }).detail, /owner's own module — serves its library through Cloudflare/);
  assert.equal(media({ owner: false }, { apiCloudflare: true }).status, "fail", "a product module through Cloudflare");
  assert.equal(media({ owner: true }, { apiCloudflare: false }).status, "ok");
  assert.equal(media({ owner: true }, { apiCloudflare: null }).status, "grey");
  assert.equal(run((h, s) => { s.modules.push({ id: "radio", on: true, servesMedia: true, owner: true, tests: [] }); })["media.tunnel"].status, "warn", "a bundle in tunnel mode, owner module");
  // Backups: 35 h is still fine, 36 h is not; a failed run after a recent good one is amber.
  const age = (at, ok = true, lastOkAt = at) => run((h) => { h.backups.last = { at, ok, lastOkAt }; })["backups.age"];
  assert.equal(age("2026-10-08T13:00:00Z").status, "ok"); assert.equal(age("2026-10-08T12:00:00Z").status, "fail");
  assert.equal(age("2026-10-09T23:00:00Z", false, "2026-10-09T19:00:00Z").status, "warn");
  assert.match(age("2026-10-09T23:00:00Z", false, null).detail, /every backup so far has failed/);
  assert.match(run((h) => { h.backups.last = null; })["backups.age"].detail, /no backup has been made yet/);
  assert.equal(run((h) => { h.backups.verify = null; })["backups.verify"].status, "fail", "never checked is red: an unchecked backup is not a backup");
  assert.equal(run((h) => { h.backups.verify.at = "2026-10-01T00:00:00Z"; })["backups.verify"].status, "warn", "nine days: the weekly check stopped");
  assert.equal(run((h) => { h.backups.target = { kind: "s3", repo: "password" }; })["backups.target"].detail, "the bucket answers, but the backup passphrase does not open it");
  assert.equal(run((h) => { h.backups.target = { kind: "sftp", repo: "missing" }; })["backups.target"].status, "fail");
  assert.match(run((h) => { h.backups.target = { kind: "s3", repo: "refused" }; })["backups.target"].detail, /the backup address is refused/);
});

test("matrix.lockdown: the lockdown's last change to homeserver sign-up, applied by a render at or after it", () => {
  const row = (m, input) => run((h, s) => m(s.matrix.lockdown, s), input)["matrix.lockdown"];
  assert.equal(row(() => {}).status, "ok"); assert.match(row(() => {}).detail, /applied — sign-up closed by the lockdown/);
  // Never written by the lockdown: nothing to apply.
  let r = row((l) => { l.lastWrite = null; l.render = null; l.closedByLockdown = false; l.registration = "open"; });
  assert.equal(r.status, "ok"); assert.match(r.detail, /the lockdown has not changed it/);
  // Just written (under 5 minutes): the render is on its way — grey, not red.
  r = row((l) => { l.lastWrite = "2026-10-09T23:58:00Z"; });
  assert.equal(r.status, "grey"); assert.match(r.detail, /changed 2 min ago — the server is applying it/);
  // The host answered the render with a failure after the write: red, and says so.
  r = row((l) => { l.render = { ok: false, at: "2026-10-09T23:30:00Z" }; });
  assert.equal(r.status, "fail"); assert.match(r.detail, /not applied it \(its last render failed\)/);
  // Put back after the lockdown (the lockdown wrote the old value back): "changed", not "closed".
  r = row((l) => { l.closedByLockdown = false; l.registration = "open"; l.lastWrite = "2026-10-09T23:40:00Z"; });
  assert.match(r.detail, /the lockdown changed homeserver sign-up 20 min ago/);
  // Not a bundle, or no fact: grey.
  assert.equal(row((l) => { l.managed = "outside"; }).status, "grey");
  assert.equal(row((l, s) => { delete s.matrix.lockdown; }).status, "grey");
  assert.equal(run(() => {}, { hostState: "none" })["matrix.lockdown"].status, "grey");
});

test("grey, never red, when a fact is missing: no host facts, a site that did not answer, lab mode, nothing stored yet", () => {
  const hostIds = DOCTOR.CHECKS.filter((c) => c.side === "host").map((c) => c.id);
  const siteIds = DOCTOR.CHECKS.filter((c) => c.side === "site" || c.side === "both").map((c) => c.id);
  assert.ok(hostIds.length >= 9 && siteIds.length >= 15, "vacuity");
  const owner = run(() => {}, { host: null, hostState: "none" });
  for (const id of hostIds) { assert.equal(owner[id].status, "grey", id); assert.equal(owner[id].detail, "not a bundle install"); }
  // site.legacyId is grey on these green facts for its own reason (a fresh install needs no old id).
  // matrix.federation is grey there for its own reason: a homeserver the bundle does not run has no switch to match.
  for (const id of siteIds.filter((x) => x !== "media.tunnel" && x !== "payments.cloudflare" && x !== "site.legacyId" && x !== "matrix.federation" && x !== "matrix.lockdown")) assert.notEqual(owner[id].status, "grey", `${id} needs no host facts`);
  assert.match(owner["matrix.federation"].detail, /^managed outside Black Branch/);
  assert.match(owner["matrix.lockdown"].detail, /^managed outside Black Branch/, "the lockdown reaches only a homeserver the bundle runs");
  assert.match(owner["site.legacyId"].detail, /^not needed: a fresh install/, "judged on the site's facts with no host facts at all");
  const fresh = run(() => {}, { host: null, hostState: "missing" });
  assert.match(fresh["box.disk"].detail, /not checked yet/);
  const down = run(() => {}, { site: null, siteError: "web is exited" });
  for (const id of siteIds) { assert.equal(down[id].status, "grey", id); assert.equal(down[id].detail, "site unreachable (web is exited)"); }
  for (const id of hostIds) assert.equal(down[id].status, "ok", `${id} still judged with the site down`);
  const lab = run((h) => { h.mode = "internal"; h.names = []; h.tunnel = null; });
  assert.equal(lab["door.names"].status, "grey"); assert.match(lab["door.tls"].detail, /lab mode/);
  assert.equal(run((h, s) => { s.secrets.token = "none"; })["secrets.token"].detail, "none stored yet");
  assert.equal(run((h, s) => { s.secrets.token = "none"; })["secrets.token"].status, "grey");
  assert.equal(run((h, s) => { s.modules[0].tests[0].ok = null; s.modules[0].tests[0].detail = "the chat service is older than the doctor"; })["modules.tests"].status, "grey");
  assert.equal(run((h, s) => { s.modules.push({ id: "radio", on: true, servesMedia: true, tests: [] }); }, { host: null, hostState: "none" })["media.tunnel"].status, "grey");
  assert.equal(run((h) => { h.memTotalMiB = "x"; })["box.memory"].status, "grey", "unreadable is grey, not red");
  // Host facts from before backups existed, or a target that could not be asked: grey.
  const older = run((h) => { delete h.backups; });
  for (const id of ["backups.age", "backups.verify", "backups.target"]) assert.equal(older[id].status, "grey", id);
  assert.equal(run((h) => { h.backups.target = { kind: null, repo: null }; })["backups.target"].status, "grey");
});

test("one list: the page's copy is the same text, and the command runs the release's own file", () => {
  const web = readFileSync(path.join(root, "web/app/lib/doctor.generated.mjs"), "utf8");
  const src = readFileSync(path.join(root, "config/doctor.mjs"), "utf8");
  assert.ok(web.includes(src.replace("export const DOCTOR = ", "const DOCTOR = ").trimEnd()), "web's copy is the list's text");
  assert.match(readFileSync(path.join(here, "doctor.mjs"), "utf8"), /^import \{ DOCTOR \} from "\.\.\/config\/doctor\.mjs";$/m);
  const bb = readFileSync(path.join(here, "blackbranch"), "utf8");
  assert.match(bb, /-v "\$BB_HOME\/release\/config:\/bb\/config:ro" -v "\$BB_HOME\/release\/install:\/bb\/install:ro"/);
  assert.match(bb, /--entrypoint node stream-api \/bb\/install\/doctor\.mjs/);
  // The printout and the report both carry every check.
  const rows = DOCTOR.evaluate({ host: greenHost(), hostState: "ok", site: greenSite(), siteError: null });
  const txt = DOCTOR.text(rows); const rep = DOCTOR.report({ rows, release: "r1", modules: [], at: "now" });
  for (const c of DOCTOR.CHECKS) { assert.ok(txt.includes(c.title), `${c.id} not printed`); assert.match(rep, new RegExp(`^\\S+\\s+${c.id.replace(".", "\\.")}\\s`, "m"), `${c.id} not in the report`); }
});

test("the release's database version is the newest migration it ships", () => {
  const base = readFileSync(path.join(root, "migrations/baseline/schema.sql"), "utf8");
  const baseMax = Math.max(...[...base.matchAll(/^\s*\((\d+), 'baseline'\)/gm)].map((m) => Number(m[1])));
  assert.ok(baseMax >= 142, `vacuity: baseline version ${baseMax}`);
  const chain = readdirSync(path.join(root, "migrations")).map((f) => /^migrate-v(\d+)\.sql$/.exec(f)).filter(Boolean).map((m) => Number(m[1]));
  assert.equal(DOCTOR.SCHEMA_VERSION, Math.max(baseMax, ...chain));
});

test("blackbranch knows the same bootstrap secrets install.sh makes", () => {
  const inst = readFileSync(path.join(here, "install.sh"), "utf8");
  const made = [...inst.matchAll(/^ {2}secret ([A-Z_]+) \d+$/gm)].map((m) => m[1]);
  // …and each one made is the one .env gets.
  for (const k of made) assert.match(inst, new RegExp(`^${k}=\\$SECRET_${k}$`, "m"), k);
  const block = /BOOTSTRAP_SECRETS=\(\n([\s\S]*?)\n\)/.exec(readFileSync(path.join(here, "blackbranch"), "utf8"));
  assert.ok(made.length >= 15 && block, "vacuity");
  assert.deepEqual(block[1].trim().split(/\s+/).sort(), [...made].sort());
});

// ── The command, in a scratch install home (no Docker: the evaluator runs on this node) ─────
function home(siteFacts) {
  const h = renderHome("BB_TLS_MODE=internal");
  mkdirSync(path.join(h, "results"), { mode: 0o755 });
  const r = runRender(h); assert.equal(r.status, 0, r.stderr);
  if (siteFacts) writeFileSync(path.join(h, "site.json"), JSON.stringify(siteFacts));
  return h;
}
const doctor = (h, args = [], extra = {}) => spawnSync("bash", [path.join(here, "blackbranch"), "doctor", ...args], {
  encoding: "utf8",
  env: { ...process.env, BB_HOME: h, BB_DOCTOR_NODE: process.execPath, PATH: "/usr/bin:/bin", ...extra },
});
const siteEnv = (h) => ({ BB_DOCTOR_SITE_FACTS: path.join(h, "site.json") });
const listing = (dir) => readdirSync(dir, { recursive: true }).map(String).sort();

test("blackbranch doctor prints the list, exits 1 on a red, and writes nothing but its host facts", () => {
  const h = home(greenSite());
  try {
    const before = listing(h);
    const r = doctor(h, [], siteEnv(h));
    // No router answers in a scratch home, so the front door is red: exit 1, with its fix line.
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /\[FAIL\] The site, api\. and matrix\. answer by name/);
    assert.match(r.stdout, /fix: blackbranch status shows which service is down/);
    assert.match(r.stdout, /\[ok {2}\] The rendered config files match a fresh render — 4 files match/);
    assert.match(r.stdout, /\[ok {2}\] Every bootstrap secret is present — 15 present/);
    assert.match(r.stdout, /\[ok {2}\] The database is at this release's version/);
    assert.deepEqual(listing(h), [...before, "results/doctor-host.json"].sort(), "nothing else was written (no state stamp either)");
    const facts = JSON.parse(readFileSync(path.join(h, "results/doctor-host.json"), "utf8"));
    assert.equal(facts.v, 1); assert.equal(facts.mode, "internal");
    const env = readFileSync(path.join(h, ".env"), "utf8");
    assert.ok(!JSON.stringify(facts).includes("example.test"), "the host facts hold no domain");
    for (const m of env.matchAll(/^[A-Z_]+=([0-9a-f]{32,})$/gm)) assert.ok(!JSON.stringify(facts).includes(m[1]), "a secret in the host facts");
    // A hand edit to a rendered file turns its check red.
    writeFileSync(path.join(h, "rendered/synapse/homeserver.yaml"), "# edited\n", { flag: "a" });
    assert.match(doctor(h, [], siteEnv(h)).stdout, /\[FAIL\] The rendered config files match a fresh render — synapse\/homeserver\.yaml differs/);
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("with the site down the host's checks still print, and the site's say why they are grey", () => {
  const h = home(null);
  try {
    const r = doctor(h); // no site facts and no Docker: web is "missing"
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /\[ok {2}\] The rendered config files match a fresh render/);
    assert.match(r.stdout, /\[ - {2}\] Postgres answers — site unreachable \(web is missing\)/);
    assert.match(r.stdout, /\[ - {2}\] Synapse answers \(\/versions\) — site unreachable/);
  } finally { rmSync(h, { recursive: true, force: true }); }
});

// Every .env value a report must not hold: 6+ characters, the product's own words excepted.
function envValues(h) {
  const plain = new Set(["COMPOSE_PROJECT_NAME", "COMPOSE_PROFILES", "BB_TLS_MODE"]);
  return [...readFileSync(path.join(h, ".env"), "utf8").matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/gm)]
    .filter((m) => !plain.has(m[1])).map((m) => m[2].replace(/^"(.*)"$/, "$1")).filter((v) => v.length >= 6);
}

test("--report: release, modules, every check and the failing fixes — and not one .env value", () => {
  const site = greenSite();
  site.modules[0].tests[0] = { step: "websocket", ok: false, detail: "refused" };
  const h = home(site);
  try {
    const r = doctor(h, ["--report"], siteEnv(h));
    assert.equal(r.status, 1, r.stderr);
    const file = readdirSync(h).find((f) => /^doctor-report-\d{8}-\d{6}\.txt$/.test(f));
    assert.ok(file, r.stdout + r.stderr);
    assert.equal(statSync(path.join(h, file)).mode & 0o777, 0o644);
    const rep = readFileSync(path.join(h, file), "utf8");
    assert.match(rep, /^modules {2}obs=on$/m);
    assert.match(rep, /^fail {2}modules\.tests /m);
    // The fix block lists the failing rows (which of the box's own rows fail depends on the machine).
    const fixes = rep.slice(rep.indexOf("How to fix the failing checks"));
    assert.ok(fixes.length > 30, "no fix block");
    assert.match(fixes, /^ {2}door\.answers: blackbranch status/m);
    assert.match(fixes, /^ {2}modules\.tests: Admin Panel/m);
    for (const line of rep.split("\n").filter((l) => l.startsWith("fail "))) assert.ok(fixes.includes(`  ${line.split(/\s+/)[1]}: `), `${line} has no fix line`);
    const values = envValues(h);
    assert.ok(values.length >= 20, `vacuity: only ${values.length} .env values read`);
    for (const v of values) assert.ok(!rep.includes(v), `the report holds a .env value (${v.length} characters)`);
    // The guard: a report that would hold a .env value is refused and never written.
    const leaky = greenSite();
    const secret = /^TOKEN_ENC_KEY=(.*)$/m.exec(readFileSync(path.join(h, ".env"), "utf8"))[1];
    leaky.modules[0].tests[0] = { step: "websocket", ok: false, detail: `bad ${secret}` };
    writeFileSync(path.join(h, "site.json"), JSON.stringify(leaky));
    rmSync(path.join(h, file));
    const bad = doctor(h, ["--report"], siteEnv(h));
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /would hold a value from \.env — not written/);
    assert.deepEqual(readdirSync(h).filter((f) => f.startsWith("doctor-report")), [], "the leaking report was removed");
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("the page's Check again: the request verb `doctor` writes the host facts and its result, nothing else", () => {
  const h = home(null);
  try {
    mkdirSync(path.join(h, "requests"));
    writeFileSync(path.join(h, "requests/doctor.req"), "");
    const r = spawnSync("bash", [path.join(here, "blackbranch"), "process-requests"], { encoding: "utf8", env: { ...process.env, BB_HOME: h, PATH: "/usr/bin:/bin" } });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(path.join(h, "results")).sort(), ["doctor-host.json", "doctor.json"]);
    assert.match(readFileSync(path.join(h, "results/doctor.json"), "utf8"), /"verb":"doctor","ok":true/);
    assert.match(readFileSync(path.join(here, "../web/app/lib/hostRequests.ts"), "utf8"), /\| "doctor"[ ;]/);
  } finally { rmSync(h, { recursive: true, force: true }); }
});
