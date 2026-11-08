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
  secrets: { count: 17, missing: [], masKeys: true, signingKey: true },
  // The community service account: its registration as rendered, its token answering as it.
  community: { registration: "match", whoami: "ok" },
  // The rendered homeserver's retention block, as days: the schema's default cap.
  retention: { rendered: true, defaultDays: 365, maxDays: 365 },
  // stream-ingest's own report (contract 1) and read-aloud's (contract 2), asked inside each container.
  ingest: { answered: true, ok: true, readers: { twitch: { state: "running", since: "2026-10-09T20:00:00Z", error: "" }, kick: { state: "off", since: null, error: "" } },
    // Each platform's live state as the poller last decided it (liveness Task 10); null = not configured.
    liveness: { twitch: { state: "live", since: "2026-10-09T23:00:00Z", lastAnswerAt: "2026-10-09T23:59:00Z", scheduledStart: null, evidence: "helix-live", stale: false }, kick: null, youtube: null, streamplace: null } },
  tts: { answered: true, enabled: true, keySet: true, voiceSet: true },
  // The Discord bridge switched on, its token set, its container healthy.
  discord: { profile: true, token: true, state: "healthy" },
  // The bot as the host asked Discord through the bridge: let in, both switches on, in the imported server.
  discordBot: { checked: true, ok: true, status: null, members: true, content: true, guild: "present" },
  // A mail server set, and the last `blackbranch mail test` sent (A2-05).
  mail: { set: true, test: { v: 1, at: "2026-10-09T18:00:00Z", ok: true, code: "sent" } },
  // Every sign-in provider slot on, offered by the sign-in service, its provider answering (ADR 0154).
  signin: { read: true, slots: Object.fromEntries(["google", "discord", "twitch", "oidc"].map((p) => [p, { on: true, complete: true, listed: true, discovery: { status: 200, issuer: true } }])) },
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
  payments: { stripe: { on: true, test: { ok: true, code: "accepted", detail: "accepted" } }, paypal: { on: true, test: { ok: true, code: "accepted", detail: "accepted (live)" } }, giftRefunds: { partial: 0 } },
  platforms: [{ id: "twitch", label: "Twitch", set: true, ok: true, detail: "accepted — channel found, id 123" }, { id: "kick", label: "Kick", set: false, ok: null, detail: "" }],
  platform: { legacyId: "unset", olderAccounts: false },
  services: { api: { reachable: true, loaded: true }, ingest: { reportedMinutesAgo: 2, loaded: true },
    platforms: [{ id: "twitch", label: "Twitch", set: true, connected: null, lastMessageMinutes: 30 }, { id: "kick", label: "Kick", set: false, connected: null, lastMessageMinutes: null }] },
  alerts: { topics: 2 },
  // Deleted accounts whose Matrix erase has not landed yet (counts and fixed codes only).
  deletions: { matrixPending: 0, codes: [] },
  // The community's run log: the newest run finished 9 minutes before these facts, with nothing changed.
  community: { reconciler: true, retentionCapDays: 365,
    latest: { mode: "apply", startedAt: "2026-10-09T23:50:00Z", finishedAt: "2026-10-09T23:51:00Z", ok: true, putBack: 0, left: 0, clock: "23:51" },
    lastFinished: { mode: "apply", startedAt: "2026-10-09T23:50:00Z", finishedAt: "2026-10-09T23:51:00Z", ok: true, putBack: 0, left: 0, clock: "23:51" } },
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
    else if (id === "payments.cloudflare") { assert.equal(r.status, "grey"); assert.match(r.detail, /check by hand/); assert.match(r.detail, /Bot Fight Mode/); }
    // A fresh install has no older platform id: not applicable, grey (not a pass it never needed).
    else if (id === "site.legacyId") { assert.equal(r.status, "grey"); assert.match(r.detail, /^not needed: a fresh install/); }
    else assert.equal(r.status, "ok", `${id}: ${r.detail}`);
  }
  assert.equal(Object.keys(rows).length, 57, "vacuity: the list was read whole");
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
  ["accounts.matrixErase", (h, s) => { s.deletions = { matrixPending: 1, codes: ["not_allowed"] }; }, /^1 deleted account still has an active Matrix account \(last answer: not_allowed\); the site retries every hour$/],
  ["mail.sends", (h) => { h.mail.test = { v: 1, at: "2026-10-09T18:00:00Z", ok: false, code: "auth_refused" }; }, /^the last test message was not sent: auth_refused \(6 h ago\)$/],
  ["signin.google", (h) => { h.signin.slots.google.complete = false; }, /^on, but its client id or secret is not set or not usable: nobody sees the button$/],
  ["signin.discord", (h) => { h.signin.slots.discord.listed = false; }, /^on, but the sign-in service does not offer it yet$/],
  ["signin.twitch", (h) => { h.signin.slots.twitch.discovery = { status: 0, issuer: null }; }, /^on the sign-in page, but Twitch does not answer this server$/],
  ["signin.oidc", (h) => { h.signin.slots.oidc.discovery = { status: 200, issuer: false }; }, /your OpenID server names a different address for itself/],
  ["community.service", (h) => { h.community.whoami = "wrong"; }, /its token answers as another account/],
  ["community.drift", (h, s) => { s.community.lastFinished.ok = false; }, /^the last run, at 23:51, failed$/],
  ["community.retention", (h) => { h.retention = { rendered: true, defaultDays: 180, maxDays: null }; }, /^the server's retention settings do not match the cap$/],
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
  ["discord.bridge", (h) => { h.discord.state = "unhealthy"; }, /^on, but it does not answer: Discord or the homeserver has not let it in yet \(it keeps trying\)$/],
  ["discord.bot", (h) => { h.discordBot.guild = "absent"; }, /^the bot is not in the Discord server the community was imported from$/],
  ["platforms.credentials", (h, s) => { s.platforms[0] = { id: "twitch", label: "Twitch", set: true, ok: false, detail: "rejected (HTTP 403)" }; }, /Twitch: rejected \(HTTP 403\)/],
  ["backups.age", (h) => { h.backups.last = { at: "2026-10-08T11:00:00Z", ok: true, lastOkAt: "2026-10-08T11:00:00Z" }; }, /the last good backup is 37 hours old/],
  ["backups.verify", (h) => { h.backups.verify = { at: "2026-10-09T00:00:00Z", ok: false, failed: ["tables", "signingKey"] }; }, /the last check failed \(tables and signingKey\)/],
  ["backups.target", (h) => { h.backups.target.repo = "unreachable"; }, /this server's backup folder does not answer/],
  ["updates.feed", (h) => { h.updates.check.readAt = "2026-10-06T23:00:00Z"; h.updates.check.ok = false; h.updates.check.error = "the feed did not answer"; }, /not read for 3 days \(the feed did not answer\)/],
  ["updates.last", (h) => { h.updates.last = { ...h.updates.last, result: "rollback-failed", to: "1.0.2", message: "failed its health check — and going back failed" }; }, /1\.0\.2 failed, and going back did not finish cleanly/],
];

test("each check goes red on its own fact, says what is wrong, and carries a fix line", () => {
  const ids = DOCTOR.CHECKS.filter((c) => c.side !== "later").map((c) => c.id);
  // modules.skipped, modules.failsafe, alerts.channel, door.outside, community.lastRun and payments.giftRefunds are amber at worst; payments.cloudflare is grey at worst.
  assert.deepEqual([...RED.map((x) => x[0]), "modules.skipped", "modules.failsafe", "payments.cloudflare", "alerts.channel", "door.outside", "community.lastRun", "payments.giftRefunds", "ingest.liveness"].sort(), [...ids].sort(), "a red fixture for every check");
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

test("mail.sends: grey when no mail server is set or not tested yet, ok when the last test was sent, red when it was not", () => {
  const row = (m) => run((h) => { h.mail = m; })["mail.sends"];
  assert.deepEqual([row(undefined).status, row(null).status], ["grey", "grey"]);
  const unset = row({ set: false, test: null });
  assert.equal(unset.status, "grey"); assert.match(unset.detail, /^no mail server is set: no password recovery, and sign-up asks for no address$/);
  const untested = row({ set: true, test: null });
  assert.equal(untested.status, "grey"); assert.match(untested.detail, /sudo blackbranch mail test <your address>/);
  const sent = row({ set: true, test: { v: 1, at: "2026-10-09T18:00:00Z", ok: true, code: "sent" } });
  assert.deepEqual([sent.status, sent.detail], ["ok", "a test message was sent 6 h ago"]);
  assert.equal(row({ set: null, test: null }).status, "grey", "settings that cannot be read are not a verdict");
  // A test recorded before the mail server was unset says nothing about a server that is not there.
  assert.equal(row({ set: false, test: { v: 1, at: "2026-10-09T18:00:00Z", ok: false, code: "unreachable" } }).status, "grey");
  assert.ok(!DOCTOR.UPDATE_CHECKS.includes("mail.sends"));
});

test("accounts.matrixErase: ok when none waits; red with the count, plural, and the fix; grey when the site could not count", () => {
  assert.deepEqual([run()["accounts.matrixErase"].status, run()["accounts.matrixErase"].detail], ["ok", "no deleted account is waiting on its Matrix account"]);
  const two = run((h, s) => { s.deletions = { matrixPending: 2, codes: ["unreachable", "not_allowed"] }; })["accounts.matrixErase"];
  assert.equal(two.status, "fail");
  assert.equal(two.detail, "2 deleted accounts still have an active Matrix account (last answers: unreachable, not_allowed); the site retries every hour");
  assert.match(two.fix, /admin grant/);
  assert.match(two.fix, /deactivate/);
  for (const d of [null, undefined, { matrixPending: null }]) {
    assert.equal(run((h, s) => { s.deletions = d; })["accounts.matrixErase"].status, "grey", JSON.stringify(d));
  }
  assert.ok(!DOCTOR.UPDATE_CHECKS.includes("accounts.matrixErase"), "an update cannot cause it; it never blocks one");
});

test("community.service: ok when the registration is as rendered and the token answers as the account; red when either is not; grey when not asked", () => {
  const row = (mut) => run((h) => mut(h.community, h))["community.service"];
  const ok = row(() => {});
  assert.equal(ok.status, "ok"); assert.equal(ok.detail, "registered, and its token answers as the account");
  const FIX = "Run sudo blackbranch up; if it stays red, sudo blackbranch community token-check";
  for (const [mut, says] of [
    [(c) => { c.registration = "missing"; }, "the registration file is missing"],
    [(c) => { c.registration = "differs"; }, "the registration file differs from a fresh render"],
    [(c) => { c.whoami = "wrong"; }, "its token answers as another account"],
    [(c) => { c.whoami = "refused"; }, "the homeserver refused its token"],
  ]) {
    const r = row(mut);
    assert.equal(r.status, "fail", says); assert.equal(r.detail, says); assert.equal(r.fix, FIX);
  }
  // The name is a person's: nothing was registered, and the row says what to do in plain words.
  const taken = row((c) => { c.registration = "missing"; c.whoami = null; c.nameTaken = true; c.localpart = "blackbranch"; });
  assert.equal(taken.status, "fail");
  assert.equal(taken.detail, "Someone already uses the name @blackbranch on this server, so the community has no account of its own");
  assert.equal(taken.fix, "Set COMMUNITY_LOCALPART in the install's .env to a name nobody uses on this server, then run sudo blackbranch up.");
  // Never checked (the database did not answer): red, nothing registered, run up again.
  const unchecked = row((c) => { c.registration = "missing"; c.whoami = null; c.nameChecked = false; c.localpart = "blackbranch"; });
  assert.equal(unchecked.status, "fail");
  assert.equal(unchecked.detail, "Could not check whether the name @blackbranch is free, so nothing is registered for it");
  assert.equal(unchecked.fix, "Run sudo blackbranch up again once the database answers.");
  // Not asked (Synapse not running, or it did not answer) and an older box's facts: grey, never red.
  assert.equal(row((c) => { c.whoami = null; }).status, "grey");
  assert.equal(row((c) => { c.whoami = null; }).detail, "Synapse is not running, so the account was not asked");
  assert.equal(row((c) => { c.whoami = "unreachable"; }).status, "grey");
  assert.equal(row((c) => { c.registration = "unknown"; c.whoami = null; }).status, "grey", "the config does not render: matrix.rendered is the red row");
  assert.equal(run((h) => { delete h.community; })["community.service"].status, "grey");
  assert.equal(run(() => {}, { host: null, hostState: "none" })["community.service"].status, "grey");
  // Plain words: no Matrix jargon a streamer would have to look up, in what the row says or its fix.
  const check = DOCTOR.CHECKS.find((c) => c.id === "community.service");
  assert.doesNotMatch(`${check.title} ${check.fix} ${ok.detail}`, /power level|join rule|state event|appservice|whoami|as_token/i);
  assert.ok(!DOCTOR.UPDATE_CHECKS.includes("community.service"), "an update does not wait on it");
});

// The community's run log as the doctor reads it (spec 2026-10-23 §4.1 "drift 0; last reconcile").
const finished = (over = {}) => ({ mode: "apply", startedAt: "2026-10-09T23:50:00Z", finishedAt: "2026-10-09T23:51:00Z", ok: true, putBack: 0, left: 0, clock: "23:51", ...over });

test("community.drift: ok when nothing drifted; amber 'N things were put back at HH:MM'; red with the fix line when the last run failed", () => {
  const row = (mut) => run((h, s) => mut(s.community))["community.drift"];
  const ok = row(() => {});
  assert.equal(ok.status, "ok"); assert.equal(ok.detail, "nothing to put back (last run at 23:51)");
  const back = row((c) => { c.lastFinished = finished({ putBack: 3 }); });
  assert.equal(back.status, "warn"); assert.equal(back.detail, "3 things were put back at 23:51");
  assert.match(back.fix, /^Nothing to do: the Community page's settings were put back\. Admin Panel → Site → Community shows what changed\.$/);
  assert.equal(row((c) => { c.lastFinished = finished({ putBack: 1, clock: "09:05 UTC" }); }).detail, "1 thing was put back at 09:05 UTC");
  // Found but left (a check, or put-back off): amber, said apart from what was put back.
  const left = row((c) => { c.lastFinished = finished({ mode: "report", left: 2, putBack: 0 }); });
  assert.equal(left.status, "warn"); assert.equal(left.detail, "2 things differ from the Community page and were left as they are (last run at 23:51)");
  const failed = row((c) => { c.lastFinished = finished({ ok: false }); });
  assert.equal(failed.status, "fail"); assert.equal(failed.detail, "the last run, at 23:51, failed");
  assert.equal(failed.fix, "Run sudo blackbranch community reconcile --mode report and read its output");
  // A run that could not look after rooms at all (the account not in them): amber, never green.
  const noHub = row((c) => { c.lastFinished = finished({ warns: { no_hub_access: 1, cannot_read: 3 } }); });
  assert.equal(noHub.status, "warn");
  assert.equal(noHub.detail, "the community's own account is not in the community's main space, so nothing is kept (last run at 23:51)");
  assert.match(noHub.fix, /^Invite the community account to the main space/);
  const unread = row((c) => { c.lastFinished = finished({ warns: { cannot_read: 2 } }); });
  assert.equal(unread.status, "warn"); assert.equal(unread.detail, "the community's own account cannot read 2 rooms, so they are not kept (last run at 23:51)");
  assert.equal(row((c) => { c.lastFinished = finished({ warns: { cannot_read: 1 } }); }).detail, "the community's own account cannot read 1 room, so it is not kept (last run at 23:51)");
  const bridge = row((c) => { c.lastFinished = finished({ warns: { bridge_accounts_unknown: 1 } }); });
  assert.equal(bridge.status, "warn"); assert.match(bridge.detail, /^in 1 bridged room nobody is removed/);
  const unlisted = row((c) => { c.lastFinished = finished({ warns: { bridge_account_unlisted: 2 } }); });
  assert.equal(unlisted.status, "warn");
  assert.equal(unlisted.detail, "2 rooms look bridged by an account not listed as a bridge account (last run at 23:51)");
  assert.match(unlisted.fix, /under Bridge accounts/);
  // Other notes (an invite left alone, a room not in the panel, a linked room the account is not in:
  // listed on the Runs card) stay green; a failed run stays red.
  assert.equal(row((c) => { c.lastFinished = finished({ warns: { invite_ignored: 2, not_in_panel: 1, not_joined: 1 } }); }).status, "ok");
  // A grant the community account cannot change is a standing fact, listed on the Runs card: never amber.
  assert.equal(row((c) => { c.lastFinished = finished({ warns: { grant_out_of_reach: 3 } }); }).status, "ok");
  assert.equal(row((c) => { c.lastFinished = finished({ ok: false, warns: { cannot_read: 1 } }); }).status, "fail");
  assert.equal(row((c) => { c.lastFinished = finished({ warns: "cannot_read" }); }).status, "ok", "facts that are not counts are never read as some");
  // No run yet, nothing reported, an older site: grey, never red.
  assert.equal(row((c) => { c.lastFinished = null; }).detail, "no run has finished yet");
  assert.equal(row((c) => { c.lastFinished = null; c.reconciler = false; }).detail, "switched off, and no run yet");
  assert.equal(run((h, s) => { delete s.community; })["community.drift"].status, "grey");
  // A clock that is not one (anything the site might send) is never printed.
  assert.equal(row((c) => { c.lastFinished = finished({ putBack: 2, clock: "<b>x</b>" }); }).detail, "2 things were put back");
  // Not a bundle: no blackbranch command in the fix.
  const outside = run((h, s) => { s.community.lastFinished = finished({ ok: false }); }, { host: null, hostState: "none" })["community.drift"];
  assert.equal(outside.status, "fail"); assert.doesNotMatch(outside.fix, /blackbranch/);
  // Plain words: no Matrix terms in the title, the fix or what it says.
  const check = DOCTOR.CHECKS.find((c) => c.id === "community.drift");
  assert.doesNotMatch(`${check.title} ${check.fix} ${back.detail} ${back.fix} ${left.detail} ${noHub.detail} ${noHub.fix} ${unread.detail} ${unread.fix} ${bridge.detail}`, /power level|join rule|state event|appservice|reconciler|drift/i);
  assert.ok(!DOCTOR.UPDATE_CHECKS.includes("community.drift"), "an update does not wait on it");
});

test("community.lastRun: amber past 30 minutes; a run under 20 minutes is running, not stale; switched off is grey", () => {
  const row = (mut) => run((h, s) => mut(s.community))["community.lastRun"];
  const ok = row(() => {});
  assert.equal(ok.status, "ok"); assert.equal(ok.detail, "the last run was 9 min ago");
  // Facts at 00:00: a run that finished 31 minutes before is amber; 30 is still ok.
  const at = (finishedAt) => (c) => { c.latest = finished({ finishedAt }); };
  assert.equal(row(at("2026-10-09T23:30:00Z")).status, "ok");
  const stale = row(at("2026-10-09T23:29:00Z"));
  assert.equal(stale.status, "warn"); assert.equal(stale.detail, "the last run was 31 min ago");
  assert.equal(stale.fix, "Run sudo blackbranch community on: it starts the 10-minute timer again and a run right away.");
  // A run still going: its row is written when it starts. Under the 20-minute limit it is running.
  const going = row((c) => { c.latest = finished({ startedAt: "2026-10-09T23:45:00Z", finishedAt: null, ok: null, clock: "23:45" }); });
  assert.equal(going.status, "ok"); assert.equal(going.detail, "running since 23:45");
  // Past the limit and never finished: it crashed.
  const crashed = row((c) => { c.latest = finished({ startedAt: "2026-10-09T23:39:00Z", finishedAt: null, ok: null, clock: "23:39" }); });
  assert.equal(crashed.status, "warn"); assert.equal(crashed.detail, "a run started at 23:39 and never finished");
  // Switched off: nothing runs on its own, so an old run is no warning.
  const off = row((c) => { c.reconciler = false; c.latest = finished({ finishedAt: "2026-10-01T00:00:00Z" }); });
  assert.equal(off.status, "grey"); assert.equal(off.detail, "switched off — the last run was 9 days ago");
  assert.equal(row((c) => { c.latest = null; }).status, "warn", "on, and never run: the timer is not running");
  assert.equal(row((c) => { c.latest = null; c.reconciler = false; }).status, "grey");
  assert.ok(!DOCTOR.UPDATE_CHECKS.includes("community.lastRun"));
  // The limit is the web panel's own (one number for "running" in both places).
  const web = readFileSync(path.join(root, "web/app/lib/community/runLimit.ts"), "utf8").match(/RUN_LIMIT_MS = (\d+) \* 60_000;/);
  const here_ = readFileSync(path.join(root, "config/doctor.mjs"), "utf8").match(/const RUN_LIMIT_MIN = (\d+);/);
  assert.ok(web && here_, "vacuity: both limits are where this test reads them");
  assert.equal(here_[1], web[1]);
});

test("community.retention: ok when the rendered block is the cap; red when it is not; grey where the bundle does not render the server", () => {
  const row = (mutH, mutS = () => {}, input = {}) => run((h, s) => { mutH(h); mutS(s); }, input)["community.retention"];
  assert.equal(row(() => {}).status, "ok"); assert.equal(row(() => {}).detail, "at most 365 days");
  const capOff = row((h) => { h.retention = { rendered: true, defaultDays: null, maxDays: null }; }, (s) => { s.community.retentionCapDays = 0; });
  assert.equal(capOff.status, "ok"); assert.match(capOff.detail, /^no limit/);
  // The cap changed on the Channels card since the last start: the server still has the old block.
  const changed = row(() => {}, (s) => { s.community.retentionCapDays = 30; });
  assert.equal(changed.status, "fail"); assert.equal(changed.detail, "the cap was changed; the server applies it at its next start", "a pending cap edit is said as one");
  assert.equal(changed.fix, "Run sudo blackbranch up");
  const uncapped = row((h) => { h.retention = { rendered: true, defaultDays: null, maxDays: null }; });
  assert.equal(uncapped.status, "fail"); assert.equal(uncapped.detail, "the cap was changed; the server applies it at its next start", "cap 365 saved, the no-limit block rendered");
  // An older render (180 days, one year): not the cap.
  const older = row((h) => { h.retention = { rendered: true, defaultDays: 180, maxDays: null }; });
  assert.equal(older.status, "fail"); assert.equal(older.detail, "the server's retention settings do not match the cap", "not a block any cap renders");
  // A homeserver the bundle does not render (one run by other means): its settings apply, grey with the note.
  const outside = row(() => {}, () => {}, { host: null, hostState: "none" });
  assert.equal(outside.status, "grey"); assert.equal(outside.detail, "managed outside Black Branch — the server's own retention settings apply");
  assert.doesNotMatch(outside.fix, /blackbranch/);
  assert.equal(row((h) => { h.retention = { rendered: false }; }).status, "grey");
  assert.equal(row((h) => { delete h.retention; }).status, "grey", "an older box's facts");
  assert.equal(row(() => {}, (s) => { delete s.community; }).status, "grey");
  assert.equal(row(() => {}, () => {}, { host: null, hostState: "missing" }).status, "grey");
  assert.ok(!DOCTOR.UPDATE_CHECKS.includes("community.retention"));
});

test("community rows restart + retry: a fresh load of the doctor file and a second run give the same verdicts", async () => {
  const facts = () => { const site = greenSite(); site.community.lastFinished = finished({ putBack: 2 }); return { host: greenHost(), hostState: "ok", site, siteError: null }; };
  const pick = (d) => d.evaluate(facts()).filter((r) => r.id.startsWith("community."));
  const first = pick(DOCTOR);
  assert.deepEqual(first.map((r) => [r.id, r.status]), [["community.service", "ok"], ["community.drift", "warn"], ["community.lastRun", "ok"], ["community.retention", "ok"]]);
  assert.deepEqual(pick(DOCTOR), first, "retry: the same verdicts");
  const { DOCTOR: reloaded } = await import(`../config/doctor.mjs?restart=${Date.now()}`);
  assert.deepEqual(pick(reloaded), first, "restart: a fresh load gives the same verdicts");
  const generated = await import(`../web/app/lib/doctor.generated.mjs?restart=${Date.now()}`);
  assert.deepEqual(pick(generated.DOCTOR), first, "the site's generated copy says the same");
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
  assert.equal(bad.fix, "The site's Stream tab (admins only) shows the reason; sudo blackbranch logs stream-ingest.");
  assert.equal(row((g) => { g.readers.youtube = { state: "starting", since: null, error: "" }; }).status, "ok", "starting under two minutes counts as ok (the service says ok)");
  const slow = row((g) => { g.ok = false; g.readers.youtube = { state: "starting", since: null, error: "" }; });
  assert.equal(slow.status, "warn"); assert.match(slow.detail, /YouTube still starting after two minutes/);
  assert.equal(row((g) => { g.readers = { kick: { state: "off" } }; }).detail, "no platform is switched on");
  assert.equal(run((h) => { h.ingest = { answered: false }; })["ingest.readers"].status, "grey");
  assert.equal(run((h) => { delete h.ingest; })["ingest.readers"].status, "grey", "an older box's facts");
  assert.ok(!DOCTOR.UPDATE_CHECKS.includes("ingest.readers"), "a platform outside the box never rolls an update back");
});

// Liveness Task 10: every configured platform's live detection answers. The rule (no answer for the
// vocabulary's stale window) is computed by stream-ingest; the row reads its boolean.
const LIVE_AT = "2026-10-09T23:38:00Z"; // 22 min before the host's facts
const can = (evidence, o = {}) => ({ state: "unknown", since: "2026-10-09T23:30:00Z", lastAnswerAt: LIVE_AT, scheduledStart: null, evidence, stale: true, ...o });
test("ingest.liveness: amber for a platform with no answer, ok for a fresh one, grey when ingest did not answer, ok with no platform; never an update check", () => {
  const row = (mut) => run((h) => mut(h.ingest, h))["ingest.liveness"];
  const check = DOCTOR.CHECKS.find((c) => c.id === "ingest.liveness");
  assert.equal(check.title, "Live detection answers for every configured platform");
  const fresh = row(() => {});
  assert.deepEqual([fresh.status, fresh.detail], ["ok", "Twitch: live"]);
  const stale = row((g) => { g.liveness.twitch = can("helix-error"); });
  assert.equal(stale.status, "warn");
  assert.equal(stale.detail, "Twitch: no answer for 22 min (helix-error); an open stream stays open while it can't tell");
  assert.equal(stale.fix, check.fix);
  const never = row((g) => { g.liveness.kick = can("kick-error", { lastAnswerAt: null }); });
  assert.equal(never.status, "warn");
  assert.match(never.detail, /^Kick: no answer for 30 min \(kick-error\)/, "never answered: counted from its state's start");
  // YouTube's consent or bot-check page: the fix names the Data API key that asks YouTube's API instead.
  const yt = row((g) => { g.liveness.youtube = can("unrecognized-page"); });
  assert.equal(yt.status, "warn");
  assert.match(yt.fix, /youtube\.apiKey/);
  assert.doesNotMatch(stale.fix, /youtube\.apiKey/, "only that evidence names the key");
  // The Doctor reads the flag, never the clock: an old answer the ingest calls fresh is fresh.
  const flag = row((g) => { g.liveness.twitch = can("helix-error", { lastAnswerAt: "2026-10-01T00:00:00Z", stale: false }); });
  assert.deepEqual([flag.status, flag.detail], ["ok", "Twitch: can't tell (helix-error)"]);
  const mixed = row((g) => { g.liveness.youtube = { state: "upcoming", since: LIVE_AT, lastAnswerAt: LIVE_AT, scheduledStart: "2026-10-10T02:00:00Z", evidence: "upcoming", stale: false }; g.liveness.kick = { ...g.liveness.twitch, state: "offline", evidence: "kick-not-live" }; });
  assert.deepEqual([mixed.status, mixed.detail], ["ok", "Twitch: live · Kick: offline · YouTube: scheduled"]);
  // Nothing configured: nothing to ask.
  assert.deepEqual([row((g) => { g.liveness = { twitch: null, kick: null, youtube: null, streamplace: null }; }).status, row((g) => { g.liveness = {}; }).status], ["ok", "ok"]);
  assert.equal(row((g) => { g.liveness = {}; }).detail, "no platform is set up for live detection");
  // Not answered: grey.
  assert.equal(run((h) => { h.ingest = { answered: false }; })["ingest.liveness"].status, "grey");
  assert.equal(run((h) => { delete h.ingest; })["ingest.liveness"].status, "grey", "an older box's facts");
  assert.equal(row((g) => { delete g.liveness; }).status, "grey", "an ingest older than this check");
  assert.ok(!DOCTOR.UPDATE_CHECKS.includes("ingest.liveness"), "a platform outside the box never rolls an update back");
});

test("ingest.liveness restart + retry: a fresh load of the doctor file and the site's copy give the same verdict", async () => {
  const facts = () => { const host = greenHost(); host.ingest.liveness.youtube = can("unrecognized-page"); return { host, hostState: "ok", site: greenSite(), siteError: null }; };
  const pick = (d) => d.evaluate(facts()).find((r) => r.id === "ingest.liveness");
  const first = pick(DOCTOR);
  assert.equal(first.status, "warn");
  assert.deepEqual(pick(DOCTOR), first, "retry");
  const { DOCTOR: reloaded } = await import(`../config/doctor.mjs?liveness=${Date.now()}`);
  assert.deepEqual(pick(reloaded), first, "restart");
  const generated = await import(`../web/app/lib/doctor.generated.mjs?liveness=${Date.now()}`);
  assert.deepEqual(pick(generated.DOCTOR), first, "the site's generated copy says the same");
});

test("ingest.liveness reads the stale flag and never repeats the rule (scan, anchored at the end of config/doctor.mjs)", () => {
  const src = readFileSync(path.join(root, "config/doctor.mjs"), "utf8");
  assert.match(src, /CHECKS: CHECKS\.map\([^\n]*\n\}\)\(\);\s*$/, "the scan read to the end of the file");
  const at = src.indexOf("{ id: 'ingest.liveness'");
  assert.ok(at > 0, "the row is where this scan looks");
  const end = src.indexOf("\n    { id: '", at + 1);
  assert.ok(end > at, "the row's end is found");
  const body = src.slice(at, end);
  assert.match(body, /\.stale === true/, "the row reads the boolean");
  assert.doesNotMatch(body, /\b15\b|STALE|60_?000|900/, "the stale window lives once, in config/platform-liveness.mjs");
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

// Liveness Task 10: the snippet passes liveness through in fixed shapes only — a name, one of the four
// states, a kebab code, ISO-like times, and stale as a boolean. Every code of the vocabulary passes.
const ingestSnippet = () => /\nINGEST_HEALTH_JS='([^']+)'\n/.exec(readFileSync(path.join(here, "blackbranch"), "utf8"))?.[1];
async function runSnippet(js, body) {
  const { createServer } = await import("node:http");
  const { execFile } = await import("node:child_process");
  const server = createServer((req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const out = await new Promise((resolve) => execFile(process.execPath, ["-e", js.replace("127.0.0.1:3010", `127.0.0.1:${server.address().port}`)], { encoding: "utf8", timeout: 20_000 }, (e, stdout) => resolve(stdout)));
    return JSON.parse(out);
  } finally { server.close(); }
}

test("the host's ingest snippet passes liveness in fixed shapes: a hostile code is dropped, a bad state is unknown, stale only as a boolean", async () => {
  const js = ingestSnippet();
  assert.ok(js, "the snippet is where this test reads it");
  const out = await runSnippet(js, { ok: true, readers: {}, liveness: {
    twitch: { state: "live", since: "2026-10-20T01:02:03.000Z", lastAnswerAt: "2026-10-20T01:05:00.000Z", scheduledStart: null, evidence: "helix-live", misses: 0, stale: false, key: "50009" },
    youtube: { state: "dancing", since: "2026-10-20T01:02:03Z<b>", lastAnswerAt: 5, evidence: "x\u0000;rm", stale: "yes" },
    kick: null,
    "Bad Key": { state: "live" },
    streamplace: "live",
  } });
  assert.deepEqual(out.liveness, {
    twitch: { state: "live", since: "2026-10-20T01:02:03.000Z", lastAnswerAt: "2026-10-20T01:05:00.000Z", scheduledStart: null, evidence: "helix-live", stale: false },
    youtube: { state: "unknown", since: "2026-10-20T01:02:03Z", lastAnswerAt: null, scheduledStart: null, evidence: "", stale: false },
    kick: null,
  });
  const older = await runSnippet(js, { ok: true, readers: {} });
  assert.equal("liveness" in older, false, "an ingest older than liveness: the Doctor reads it as not reported");
});

test("the host's ingest snippet passes every evidence code of the vocabulary", async () => {
  const { PLATFORM_LIVENESS } = await import("../config/platform-liveness.mjs");
  const codes = Object.keys(PLATFORM_LIVENESS.EVIDENCE);
  assert.ok(codes.length >= 30, "vacuity: the vocabulary was read");
  const js = ingestSnippet();
  // Several bodies: the snippet reads at most 12 platforms per answer.
  for (let i = 0; i < codes.length; i += 10) {
    const chunk = codes.slice(i, i + 10);
    const liveness = Object.fromEntries(chunk.map((c, j) => [`p${"abcdefghij"[j]}`, { state: "unknown", since: "2026-10-20T01:02:03Z", lastAnswerAt: null, evidence: c, stale: true }]));
    const out = await runSnippet(js, { ok: true, readers: {}, liveness });
    assert.deepEqual(Object.values(out.liveness).map((v) => v.evidence), chunk);
    assert.ok(Object.values(out.liveness).every((v) => v.stale === true));
  }
});

// Round 1 contract 2: read-aloud's readiness, only while it is switched on.
test("tts.ready: switched off is skipped; on without the key or a voice is red with the Voice page's fix", () => {
  const row = (mut) => run((h) => mut(h.tts))["tts.ready"];
  assert.equal(row(() => {}).status, "ok");
  const off = row((t) => { t.enabled = false; t.keySet = false; t.voiceSet = false; });
  assert.equal(off.status, "grey"); assert.equal(off.detail, "skipped: read-aloud is switched off");
  const both = row((t) => { t.keySet = false; t.voiceSet = false; });
  assert.equal(both.status, "fail"); assert.match(both.detail, /the ElevenLabs key and a voice id are not set/);
  assert.equal(both.fix, "Admin Panel → Utility → TTS: set the ElevenLabs key and a voice id.");
  assert.equal(run((h) => { h.tts = { answered: false }; })["tts.ready"].status, "grey");
});

// A module's own switch says whether it is set up, not whether its setup page was ever opened:
// switched off = "not set up yet" (grey, never red); switched on with its keys missing = its Test
// fails (red); switched on with its keys = its Test's verdict. The setup flow's "visited" stamp
// (h.setup) no longer changes a verdict.
test("modules.tests: a switched-off module is grey 'not set up yet'; on with no keys is red; on with keys is tested", () => {
  const row = (mut) => run(mut)["modules.tests"];
  const off = row((h, s) => { s.modules = [{ id: "obs", on: false, servesMedia: false, owner: false, tests: [] }]; });
  assert.equal(off.status, "grey");
  assert.equal(off.detail, "not set up yet: obs is switched off");
  const noKeys = row((h, s) => { s.modules[0].tests[0] = { step: "websocket", ok: false, detail: "the address is not set" }; });
  assert.equal(noKeys.status, "fail");
  assert.equal(noKeys.detail, "obs: the address is not set");
  const keys = row(() => {});
  assert.equal(keys.status, "ok"); assert.equal(keys.detail, "1 passed");
  const mixed = row((h, s) => { s.modules.push({ id: "radio", on: false, servesMedia: true, owner: false, tests: [] }); });
  assert.equal(mixed.status, "ok"); assert.equal(mixed.detail, "1 passed; not set up yet: radio is switched off");
});

test("modules.tests: the setup flow's 'visited' stamp no longer turns a failing switched-on module amber", () => {
  const failing = (setup) => run((h, s) => { s.modules[0].tests[0] = { step: "websocket", ok: false, detail: "refused" }; h.setup = setup; s.modules[0].untouched = true; })["modules.tests"].status;
  for (const setup of [{ visited: ["core:kick"], completed: false }, { visited: null, completed: false }, { visited: ["module:obs"], completed: true }, null]) {
    assert.equal(failing(setup), "fail", JSON.stringify(setup));
  }
});

test("modules.tests restart + retry: a fresh load of the doctor file and a second run give the same off/on verdicts", async () => {
  const facts = () => { const site = greenSite(); site.modules = [{ id: "obs", on: false, servesMedia: false, owner: false, tests: [] }, { id: "youtube", on: true, servesMedia: false, owner: false, tests: [{ step: "channel", ok: false, detail: "the key is not set" }] }]; return { host: greenHost(), hostState: "ok", site, siteError: null }; };
  const pick = (d) => d.evaluate(facts()).find((r) => r.id === "modules.tests");
  const first = pick(DOCTOR);
  assert.equal(first.status, "fail"); assert.equal(first.detail, "youtube: the key is not set");
  assert.deepEqual(pick(DOCTOR), first, "retry: the same verdict");
  const { DOCTOR: reloaded } = await import(`../config/doctor.mjs?restart=${Date.now()}`);
  assert.deepEqual(pick(reloaded), first, "restart: a fresh load gives the same verdict");
  const generated = await import(`../web/app/lib/doctor.generated.mjs?restart=${Date.now()}`);
  assert.deepEqual(pick(generated.DOCTOR), first, "the site's generated copy says the same");
});

// Kick's refused lookup: the reader's one-line reason travels stream-ingest /health → the host's
// snippet (one line, cut at 160) → the Doctor's "Chat readers started" row. The row must show the
// whole sentence, with where the two numbers are read, and so must the settings' own help.
test("Kick refused: the Doctor's row shows the whole help sentence, saying where both numbers are found", async () => {
  const kickSrc = readFileSync(path.join(root, "stream-ingest/platforms/kick.js"), "utf8");
  const help = /\nexport const KICK_IDS_HELP = '([^'\n]+)';\n/.exec(kickSrc)?.[1];
  assert.ok(help, "KICK_IDS_HELP is where this test reads it");
  assert.match(help, /kick\.com\/api\/v2\/channels\/YOUR-CHANNEL/);
  assert.match(help, /chatroom\.id/);
  assert.match(help, /"Kick chatroom id"/); assert.match(help, /"Kick channel id"/);
  const js = /\nINGEST_HEALTH_JS='([^']+)'\n/.exec(readFileSync(path.join(here, "blackbranch"), "utf8"))?.[1];
  assert.ok(js, "the snippet is where this test reads it");
  const { createServer } = await import("node:http");
  const { execFile } = await import("node:child_process");
  for (const error of [help, `${help}; no browser to retry in`]) {
    const server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, readers: { kick: { state: "failed", since: null, error } } }));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const out = await new Promise((resolve) => execFile(process.execPath, ["-e", js.replace("127.0.0.1:3010", `127.0.0.1:${server.address().port}`)], { encoding: "utf8", timeout: 20_000 }, (e, stdout) => resolve(stdout)));
      const ingest = JSON.parse(out);
      const row = run((h) => { h.ingest = ingest; })["ingest.readers"];
      assert.equal(row.status, "fail");
      assert.equal(row.detail, `Kick: ${error}`, "the Doctor's row cut the help sentence");
    } finally { server.close(); }
  }
  const { INSTANCE_KEYS } = await import("../config/instance-schema.mjs");
  for (const key of ["kick.chatroomId", "kick.channelId"]) {
    const e = INSTANCE_KEYS.find((k) => k.key === key);
    assert.ok(e, `${key} is in the schema`);
    assert.match(e.description, /kick\.com\/api\/v2\/channels\/YOUR-CHANNEL/, `${key}: its help says where the number is found`);
  }
});

// What an operator reads must be what they can do. Every command a row prints is run on the
// server as root (blackbranch refuses otherwise), so it is printed with sudo; a page name is the
// one the Admin Panel or the site shows; and Cloudflare advice matches the plan the operator is on.
test("every blackbranch command the doctor prints is printed with sudo", () => {
  const src = readFileSync(path.join(root, "config/doctor.mjs"), "utf8");
  assert.match(src, /CHECKS: CHECKS\.map\([^\n]*\n\}\)\(\);\s*$/, "the scan read to the end of the file");
  const strings = [...src.replace(/^\s*\/\/.*$/gm, "").matchAll(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g)].map((m) => m[0]);
  const shown = strings.filter((t) => /\bblackbranch [a-z]/.test(t));
  assert.ok(shown.length >= 25, `only ${shown.length} strings name a command: the scan lost them`);
  const bare = shown.filter((t) => /(^|[^\w-])(?<!sudo )blackbranch [a-z]/.test(t));
  assert.deepEqual(bare, [], "a command printed without sudo");
  // Not only blackbranch: every command that needs root on the box (the clock, the package
  // manager, docker, systemd). Each needs sudo before it, and before each one after "then".
  const ROOT = /(?<![\w-])(?<!sudo )(?:docker|timedatectl|apt|apt-get|dpkg-reconfigure|systemctl|ufw) [a-z-]/;
  assert.ok(strings.some((t) => /sudo timedatectl set-ntp/.test(t)), "the clock fix is where this scan looks");
  assert.deepEqual(strings.filter((t) => ROOT.test(t)), [], "a root command printed without sudo");
});

test("fix lines name the real places: Utility → TTS, the site's Stream tab, and what a Free Cloudflare plan can do", () => {
  const fix = (id) => DOCTOR.CHECKS.find((c) => c.id === id).fix;
  assert.match(fix("tts.ready"), /^Admin Panel → Utility → TTS:/);
  assert.match(fix("ingest.readers"), /^The site's Stream tab/);
  const cf = fix("payments.cloudflare");
  assert.match(cf, /Free plan: .*turn Bot Fight Mode off/, "a Free plan cannot skip Bot Fight Mode with a rule");
  assert.match(cf, /Super Bot Fight Mode/);
  assert.match(cf, /\/api\/billing\/webhook/);
  for (const c of DOCTOR.CHECKS) assert.doesNotMatch(c.fix, /—/, `${c.id}: no em-dash`);
  // The Admin Panel's per-value button says Check (setup pages and KeyCards alike).
  for (const c of DOCTOR.CHECKS) assert.doesNotMatch(c.fix, /press Test/, `${c.id}: the button is Check`);
  assert.match(fix("payments.stripe"), /press Check\.$/);
});

test("module texts promise only what a standard install has, and give a Free Cloudflare plan's step", async () => {
  const { MODULES } = await import("../config/modules.mjs");
  const obs = MODULES.find((m) => m.id === "obs");
  assert.doesNotMatch(obs.description, /sound/i, "a standard install has no sound alerts");
  assert.doesNotMatch(obs.setup.find((s) => s.id === "rig").explain, /sound/i);
  const cf = MODULES.find((m) => m.id === "stripe").setup.find((s) => s.id === "cloudflare");
  assert.match(cf.explain, /Free plan/);
  assert.match(cf.explain, /Bot Fight Mode off/);
  assert.match(cf.explain, /Super Bot Fight Mode/);
  for (const t of [obs.description, obs.setup.find((s) => s.id === "rig").explain, cf.explain]) assert.doesNotMatch(t, /—/);
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
  assert.match(missing.fix, /restart the site: it is read when the site starts/, "an install value: read at start, nothing to rebuild");
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
  for (const id of siteIds.filter((x) => x !== "media.tunnel" && x !== "payments.cloudflare" && x !== "site.legacyId" && x !== "matrix.federation" && x !== "matrix.lockdown" && x !== "community.retention")) assert.notEqual(owner[id].status, "grey", `${id} needs no host facts`);
  assert.match(owner["matrix.federation"].detail, /^managed outside Black Branch/);
  assert.equal(owner["community.retention"].detail, "managed outside Black Branch — the server's own retention settings apply", "a homeserver the bundle does not render keeps its own");
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
    assert.match(r.stdout, /fix: sudo blackbranch status shows which service is down/);
    assert.match(r.stdout, /\[ok {2}\] The rendered config files match a fresh render — 5 files match/);
    assert.match(r.stdout, /\[ok {2}\] Every bootstrap secret is present — 19 present/);
    // No Synapse in a scratch home: the account is not asked, and the row says why (grey, not red).
    assert.match(r.stdout, /\[ - {2}\] The community service account answers — Synapse is not running, so the account was not asked/);
    assert.match(r.stdout, /\[ok {2}\] The database is at this release's version/);
    assert.deepEqual(listing(h), [...before, "results/doctor-host.json"].sort(), "nothing else was written (no state stamp either)");
    const facts = JSON.parse(readFileSync(path.join(h, "results/doctor-host.json"), "utf8"));
    assert.equal(facts.v, 1); assert.equal(facts.mode, "internal");
    assert.deepEqual(facts.community, { registration: "match", whoami: null, nameTaken: false, nameChecked: true, localpart: "blackbranch" });
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
    .map((m) => [m[1], m[2].replace(/^"(.*)"$/, "$1")])
    // The service account's name is the product's own word only while it is the default.
    .filter(([k, v]) => !plain.has(k) && !(k === "COMMUNITY_LOCALPART" && v === "blackbranch")).map(([, v]) => v).filter((v) => v.length >= 6);
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
    assert.match(fixes, /^ {2}door\.answers: sudo blackbranch status/m);
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

test("the service account's name in the doctor: plain only while it is the default; one .env cannot shape breaks no JSON", () => {
  const h = home(greenSite());
  try {
    // The default name is the product's word: a report holding it is written.
    const ok = doctor(h, ["--report"], siteEnv(h));
    assert.ok(readdirSync(h).some((f) => f.startsWith("doctor-report")), `${ok.stdout}${ok.stderr}`);
    for (const f of readdirSync(h).filter((x) => x.startsWith("doctor-report"))) rmSync(path.join(h, f));
    // A name the operator picked may identify them: a report that would hold it is refused.
    const env0 = readFileSync(path.join(h, ".env"), "utf8");
    writeFileSync(path.join(h, ".env"), env0.replace(/^COMMUNITY_LOCALPART=.*$/m, "COMMUNITY_LOCALPART=casey-keeper"));
    const leaky = greenSite(); leaky.modules[0].tests[0] = { step: "websocket", ok: false, detail: "seen as casey-keeper" };
    writeFileSync(path.join(h, "site.json"), JSON.stringify(leaky));
    const bad = doctor(h, ["--report"], siteEnv(h));
    assert.notEqual(bad.status, 0); assert.match(bad.stderr, /would hold a value from \.env — not written/);
    // A value no Matrix user name has (a quote, a backslash) is never written into the host facts' JSON.
    writeFileSync(path.join(h, ".env"), env0.replace(/^COMMUNITY_LOCALPART=.*$/m, 'COMMUNITY_LOCALPART=a\\b"c'));
    doctor(h, [], siteEnv(h));
    const facts = JSON.parse(readFileSync(path.join(h, "results/doctor-host.json"), "utf8"));
    assert.equal(facts.community.localpart, null);
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("the page's Check again: the request verb `doctor` writes the host facts and its result, nothing else", () => {
  const h = home(null);
  try {
    mkdirSync(path.join(h, "requests"));
    writeFileSync(path.join(h, "requests/doctor.req"), "");
    const r = spawnSync("bash", [path.join(here, "blackbranch"), "process-requests"], { encoding: "utf8", env: { ...process.env, BB_HOME: h, PATH: "/usr/bin:/bin" } });
    assert.equal(r.status, 0, r.stderr);
    // The render that made this home published its retention cap; the doctor verb adds exactly its two files.
    assert.deepEqual(readdirSync(path.join(h, "results")).sort(), ["doctor-host.json", "doctor.json", "retention-cap.json"]);
    assert.match(readFileSync(path.join(h, "results/doctor.json"), "utf8"), /"verb":"doctor","ok":true/);
    assert.match(readFileSync(path.join(here, "../web/app/lib/hostRequests.ts"), "utf8"), /\| "doctor"[ ;]/);
  } finally { rmSync(h, { recursive: true, force: true }); }
});

// Area-1 round 2, review R4: a partial refund of a community gift ends only what it covers; money that
// covers no whole slot ends nothing and is shown to the operator here (amber, never red).
test("payments.giftRefunds: a partial gift refund that covered part of a slot is amber, with what to do", () => {
  assert.equal(run()["payments.giftRefunds"].status, "ok");
  const amber = run((h, s) => { s.payments.giftRefunds = { partial: 2 }; })["payments.giftRefunds"];
  assert.equal(amber.status, "warn");
  assert.match(amber.detail, /^2 partial refunds of a community gift in the last 90 days covered part of a slot$/);
  assert.equal(run((h, s) => { delete s.payments.giftRefunds; })["payments.giftRefunds"].status, "grey", "an older site that does not report");
  const check = DOCTOR.CHECKS.find((c) => c.id === "payments.giftRefunds");
  assert.match(check.fix, /no gift was ended for that part/);
});
