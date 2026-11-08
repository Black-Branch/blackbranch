// The host's half of the community reconciler: `blackbranch community reconcile|on|off`, the
// request the site drops (community-reconcile), the unit and timer that run it. Run: node --test install/
//
// The host command runs for real on a scratch install home (scratch-home.mjs fakeHome) with stand-ins
// for docker and systemctl that log every call; the reconciler's own container is the stand-in's
// (its stdin, its answer and its status are files under fake/). install/reconcile.test.mjs runs the
// reconciler itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { spawn, spawnSync, execFile } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeHome } from "./scratch-home.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const read = (rel) => readFileSync(path.join(here, rel), "utf8");
const bb = read("blackbranch");

/** A scratch install whose community account is registered (its name checked free, its registration
 *  rendered), with the request folders. systemctl is the harness's stand-in (scratch-home.mjs). */
function home(extra = "") {
  const h = fakeHome(extra);
  mkdirSync(path.join(h.home, "rendered/synapse"), { recursive: true });
  writeFileSync(path.join(h.home, "rendered/synapse/appservice-community.yaml"), "id: community\n");
  mkdirSync(path.join(h.home, "requests")); mkdirSync(path.join(h.home, "results"), { mode: 0o755 });
  const envVal = (k) => h.env().match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.replace(/^"(.*)"$/, "$1");
  /** The command started in the background (a run that is kept busy). */
  const start = (...args) => {
    const p = spawn("bash", [path.join(here, "blackbranch"), ...args], {
      env: { ...process.env, BB_HOME: h.home, FAKE: h.fake, PATH: `${path.join(h.fake, "bin")}:/usr/bin:/bin` }, detached: true,
    });
    let err = ""; p.stderr.on("data", (c) => (err += c));
    const done = new Promise((r) => p.on("close", (code) => r({ code, err })));
    return { p, done };
  };
  const ask = (verb = "community-reconcile") => {
    writeFileSync(path.join(h.home, `requests/${verb}.req`), "");
    const r = h.run("process-requests");
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(readFileSync(path.join(h.home, `results/${verb}.json`), "utf8"));
  };
  return { ...h, envVal, start, ask };
}
const waitFor = async (f, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error("timed out waiting"); await new Promise((r) => setTimeout(r, 50)); }
};
const token = (h) => h.envVal("COMMUNITY_AS_TOKEN");
/** Whether another process holds the lock on `file` (flock -n cannot take it). */
const held = (file) => spawnSync("flock", ["-n", file, "true"]).status !== 0;

// ── The site's request ──────────────────────────────────────────────────────────────────────────
test("the community-reconcile request starts apply in its own unit and answers \"started\" at once", () => {
  const h = home();
  try {
    const a = h.ask();
    assert.equal(a.ok, true, a.message);
    assert.equal(a.message, "started");
    assert.equal(a.request, "community-reconcile");
    assert.match(h.calls(), /^systemctl start --no-block blackbranch-community@apply\.service$/m);
    assert.doesNotMatch(h.calls(), /reconcile\.mjs/, "the run itself is the unit's, never inside the request");
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("the community-report request (the panel's Check now) starts report in its own unit, switch on or off", () => {
  for (const extra of ["", "COMMUNITY_RECONCILER=false"]) {
    const h = home(extra);
    try {
      const a = h.ask("community-report");
      assert.equal(a.ok, true, `${extra}: ${a.message}`);
      assert.equal(a.message, "started");
      assert.equal(a.request, "community-report");
      assert.match(h.calls(), /^systemctl start --no-block blackbranch-community@report\.service$/m);
      assert.doesNotMatch(h.calls(), /blackbranch-community@apply/, "a check never applies");
    } finally { rmSync(h.home, { recursive: true, force: true }); }
  }
});

test("the request is refused while the server does not keep the rooms (the switch is off)", () => {
  const h = home("COMMUNITY_RECONCILER=false");
  try {
    const a = h.ask();
    assert.equal(a.ok, false);
    assert.match(a.message, /sudo blackbranch community on/);
    assert.doesNotMatch(h.calls(), /systemctl start/);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("the request is refused during an update with the try-again words", async () => {
  const h = home();
  writeFileSync(path.join(h.home, "state/update.lock"), "");
  const holder = execFile("flock", [path.join(h.home, "state/update.lock"), "sleep", "20"]);
  try {
    await waitFor(() => held(path.join(h.home, "state/update.lock")));
    const a = h.ask();
    assert.equal(a.ok, false);
    assert.equal(a.message, "an update is running; try again when it has finished");
    assert.doesNotMatch(h.calls(), /systemctl start/);
  } finally { holder.kill(); rmSync(h.home, { recursive: true, force: true }); }
});

// ── The run ─────────────────────────────────────────────────────────────────────────────────────
test("community reconcile runs the reconciler in a one-shot container: the token on stdin only, the account and the site in its environment", () => {
  const h = home();
  try {
    writeFileSync(path.join(h.fake, "reconcile-out"), '{"mode":"report","ok":true,"drift":[],"applied":[],"error":null}\n');
    const r = h.run("community", "reconcile");
    assert.equal(r.status, 0, r.stderr);
    const call = h.calls().split("\n").find((l) => l.includes("/bb-matrix/reconcile.mjs"));
    assert.ok(call, h.calls());
    assert.equal(call, `compose run --rm --no-deps -T -v ${h.home}/release/install/matrix:/bb-matrix:ro`
      + " -e MX_BASE=http://synapse:8008 -e MX_SERVER_NAME=example.test -e MX_AS_USER=@blackbranch:example.test"
      + " -e COMMUNITY_WEB_BASE=http://web:3000 --entrypoint node stream-api /bb-matrix/reconcile.mjs --mode report",
      "report unless a mode is given");
    assert.ok(token(h).length >= 32, "vacuity: the box has a token");
    assert.equal(readFileSync(path.join(h.fake, "reconcile-stdin"), "utf8"), `${token(h)}\n`);
    assert.ok(!h.calls().includes(token(h)), "never on a command line");
    assert.match(r.stdout, /"mode":"report"/, "the reconciler's JSON line is passed through");
    // Its exit status is the command's: 1 = report found something to change; 2 = it failed.
    for (const s of ["1", "2"]) assert.equal(h.runWith({ FAKE_RECONCILE_STATUS: s }, "community", "reconcile", "--mode", "apply").status, Number(s));
    assert.match(h.calls(), /reconcile\.mjs --mode apply$/m);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("community reconcile refuses a mode it does not know, and apply while the switch is off", () => {
  const h = home("COMMUNITY_RECONCILER=false");
  try {
    for (const args of [["--mode", "delete"], ["--mode"], ["--nope"]]) {
      const r = h.run("community", "reconcile", ...args);
      assert.notEqual(r.status, 0, args.join(" "));
      assert.match(r.stderr, /usage: blackbranch community reconcile \[--mode report\|adopt\|apply\]/);
    }
    const off = h.run("community", "reconcile", "--mode", "apply");
    assert.equal(off.status, 1);
    assert.match(off.stderr, /sudo blackbranch community on/);
    // Report and adopt read the homeserver and change nothing on it: they run whatever the switch.
    assert.equal(h.run("community", "reconcile", "--mode", "report").status, 0);
    assert.equal((h.calls().match(/reconcile\.mjs/g) ?? []).length, 1, "only the report ran");
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("an account whose registration is not there yet: no run, and the words say what to do", () => {
  const h = home();
  try {
    rmSync(path.join(h.home, "rendered/synapse/appservice-community.yaml"));
    const r = h.run("community", "reconcile");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /sudo blackbranch community token-check/);
    assert.doesNotMatch(h.calls(), /reconcile\.mjs/);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("unit_is_single_instance: a second run while one is going exits 75, already running", async () => {
  const h = home();
  try {
    writeFileSync(path.join(h.fake, "reconcile-hold"), "");
    const first = h.start("community", "reconcile", "--mode", "apply");
    await waitFor(() => existsSync(path.join(h.fake, "reconcile-running")));
    const second = h.run("community", "reconcile");
    assert.equal(second.status, 75, second.stderr);
    assert.match(second.stderr, /already running/);
    assert.equal((h.calls().match(/reconcile\.mjs/g) ?? []).length, 1, "the second never started a container");
    rmSync(path.join(h.fake, "reconcile-hold"));
    assert.equal((await first.done).code, 0, "the first finishes as it would have");
    // Retry: once it has finished, the next run goes.
    assert.equal(h.run("community", "reconcile").status, 0);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("restart: a run killed part way leaves no lock behind; the next run goes", async () => {
  const h = home();
  try {
    writeFileSync(path.join(h.fake, "reconcile-hold"), "");
    const first = h.start("community", "reconcile", "--mode", "apply");
    await waitFor(() => existsSync(path.join(h.fake, "reconcile-running")));
    process.kill(-first.p.pid, "SIGKILL");
    await first.done;
    rmSync(path.join(h.fake, "reconcile-hold"));
    const next = h.run("community", "reconcile", "--mode", "apply");
    assert.equal(next.status, 0, next.stderr);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("a run during an update exits 75 with the try-again words and starts nothing", async () => {
  const h = home();
  writeFileSync(path.join(h.home, "state/update.lock"), "");
  const holder = execFile("flock", [path.join(h.home, "state/update.lock"), "sleep", "20"]);
  try {
    await waitFor(() => held(path.join(h.home, "state/update.lock")));
    const r = h.run("community", "reconcile", "--mode", "apply");
    assert.equal(r.status, 75);
    assert.match(r.stderr, /an update is running; try again when it has finished/);
    assert.doesNotMatch(h.calls(), /reconcile\.mjs/);
  } finally { holder.kill(); rmSync(h.home, { recursive: true, force: true }); }
});

// ── What a run's outcome does to the unit and the operator ──────────────────────────────────────
/** The command, asynchronously (a stand-in ntfy in this process answers while it runs). */
const runAsync = (h, extra, ...args) => new Promise((resolve) => {
  const p = spawn("bash", [path.join(here, "blackbranch"), ...args], {
    env: { ...process.env, BB_HOME: h.home, FAKE: h.fake, PATH: `${path.join(h.fake, "bin")}:/usr/bin:/bin`, ...extra } });
  let stdout = "", stderr = "";
  p.stdout.on("data", (c) => (stdout += c)); p.stderr.on("data", (c) => (stderr += c));
  p.on("close", (status) => resolve({ status, stdout, stderr }));
});
async function ntfy() {
  const got = [];
  const srv = createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    got.push({ title: req.headers.title, priority: req.headers.priority, body });
    res.writeHead(200); res.end("{}");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { got, url: `http://127.0.0.1:${srv.address().port}/bb-community-alerts`, close: () => srv.close() };
}

test("a report that found something to change ends the unit well (exit 0); apply keeps 1 and 2 as failures", () => {
  const h = home();
  try {
    assert.equal(h.runWith({ FAKE_RECONCILE_STATUS: "1" }, "community", "reconcile", "--mode", "report").status, 0, "the drift is in the result, not a failed unit");
    assert.equal(h.runWith({ FAKE_RECONCILE_STATUS: "2" }, "community", "reconcile", "--mode", "report").status, 2, "a report that failed still fails");
    assert.equal(h.runWith({ FAKE_RECONCILE_STATUS: "1" }, "community", "reconcile", "--mode", "apply").status, 1);
    assert.equal((h.calls().match(/reconcile\.mjs --mode report$/gm) ?? []).length, 2, "vacuity: the reports ran");
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("apply alerts on a flip only: one when it starts failing, one when it works again, nothing between; report never", async () => {
  const n = await ntfy();
  const h = home(`BB_ALERT_NTFY_URL=${n.url}`);
  const apply = (status) => runAsync(h, { FAKE_RECONCILE_STATUS: status }, "community", "reconcile", "--mode", "apply");
  const outcome = () => readFileSync(path.join(h.home, "state/community.last-outcome"), "utf8").trim();
  try {
    assert.equal((await apply("0")).status, 0);
    assert.equal(n.got.length, 0, "ok with no earlier run: nothing to say");
    assert.equal(outcome(), "ok");
    const failed = await apply("2");
    assert.equal(failed.status, 2, "the alert never changes the run's own outcome");
    assert.equal(n.got.length, 1);
    assert.equal(n.got[0].title, "Black Branch example.test: the community's rooms could not be kept");
    assert.equal(n.got[0].priority, "4");
    assert.match(n.got[0].body, /The Doctor's row "The community's rooms are as the Community page sets them" says more\./);
    assert.match(n.got[0].body, /on the server run: sudo blackbranch community reconcile --mode report\n?$/);
    assert.doesNotMatch(n.got[0].body, /![A-Za-z0-9]+:|@blackbranch|mct_|syt_/, "no room, account or token");
    assert.ok(!n.got[0].body.includes(token(h)));
    // Restart / retry: failing again (1 = ops refused counts too) says nothing more; a report never alerts.
    assert.equal((await apply("1")).status, 1);
    assert.equal((await runAsync(h, { FAKE_RECONCILE_STATUS: "2" }, "community", "reconcile", "--mode", "report")).status, 2);
    assert.equal(n.got.length, 1, "nothing between");
    assert.equal(outcome(), "failed", "a report does not touch the recorded outcome");
    // Working again: one note.
    assert.equal((await apply("0")).status, 0);
    assert.equal(n.got.length, 2);
    assert.equal(n.got[1].title, "Black Branch example.test: community reconcile is working again");
    assert.equal(n.got[1].priority, "3");
    assert.equal((await apply("0")).status, 0);
    assert.equal(n.got.length, 2, "and nothing after");
  } finally { n.close(); rmSync(h.home, { recursive: true, force: true }); }
});

test("refused_setup_pending: a run before setup finishes (the reconciler's 75) sends no alert, records no outcome, and the first good run after it says nothing", async () => {
  const n = await ntfy();
  const h = home(`BB_ALERT_NTFY_URL=${n.url}`);
  const apply = (status) => runAsync(h, { FAKE_RECONCILE_STATUS: status }, "community", "reconcile", "--mode", "apply");
  const outcomeFile = path.join(h.home, "state/community.last-outcome");
  try {
    for (let i = 0; i < 3; i++) assert.equal((await apply("75")).status, 75, "the unit counts it a success (SuccessExitStatus=75)");
    assert.equal(n.got.length, 0, "no alert");
    assert.equal(existsSync(outcomeFile), false, "no failure recorded");
    assert.equal((h.calls().match(/reconcile\.mjs --mode apply$/gm) ?? []).length, 3, "vacuity: the reconciler ran each time");
    // Setup finished: the first good run is a first run, not a recovery.
    assert.equal((await apply("0")).status, 0);
    assert.equal(n.got.length, 0, "no \"working again\"");
    assert.equal(readFileSync(outcomeFile, "utf8").trim(), "ok");
  } finally { n.close(); rmSync(h.home, { recursive: true, force: true }); }
});

test("restart: a refused run between a failure and its recovery changes nothing; the recovery still says so once", async () => {
  const n = await ntfy();
  const h = home(`BB_ALERT_NTFY_URL=${n.url}`);
  const apply = (status) => runAsync(h, { FAKE_RECONCILE_STATUS: status }, "community", "reconcile", "--mode", "apply");
  const outcome = () => readFileSync(path.join(h.home, "state/community.last-outcome"), "utf8").trim();
  try {
    assert.equal((await apply("2")).status, 2);
    assert.equal(n.got.length, 1);
    assert.equal((await apply("75")).status, 75);
    assert.equal(outcome(), "failed", "the refused run is not an outcome");
    assert.equal(n.got.length, 1);
    assert.equal((await apply("0")).status, 0);
    assert.deepEqual(n.got.map((g) => g.title), ["Black Branch example.test: the community's rooms could not be kept", "Black Branch example.test: community reconcile is working again"]);
  } finally { n.close(); rmSync(h.home, { recursive: true, force: true }); }
});

test("the first apply that fails on a box with no recorded outcome alerts", async () => {
  const n = await ntfy();
  const h = home(`BB_ALERT_NTFY_URL=${n.url}`);
  try {
    assert.equal((await runAsync(h, { FAKE_RECONCILE_STATUS: "2" }, "community", "reconcile", "--mode", "apply")).status, 2);
    assert.equal(n.got.length, 1);
  } finally { n.close(); rmSync(h.home, { recursive: true, force: true }); }
});

// ── The switch ──────────────────────────────────────────────────────────────────────────────────
test("community off / on: sets the install's value, restarts the site with it, stops or starts the timer", () => {
  const h = home();
  try {
    writeFileSync(path.join(h.fake, "enabled-blackbranch-community.timer"), "");
    const off = h.run("community", "off");
    assert.equal(off.status, 0, off.stderr);
    assert.equal(h.envVal("COMMUNITY_RECONCILER"), "false");
    assert.match(h.calls(), /^compose up -d$/m, "the site is recreated with the new value");
    assert.match(h.calls(), /^systemctl disable -q --now blackbranch-community\.timer$/m);
    assert.doesNotMatch(h.calls(), /systemctl start --no-block blackbranch-community/);
    assert.match(off.stdout, /no longer/);

    const on = h.run("community", "on");
    assert.equal(on.status, 0, on.stderr);
    assert.equal(h.envVal("COMMUNITY_RECONCILER"), "true");
    assert.match(h.calls(), /^systemctl enable -q --now blackbranch-community\.timer$/m);
    assert.match(h.calls(), /^systemctl start --no-block blackbranch-community@apply\.service$/m, "a first run now");

    // Again: nothing to change, nothing restarted.
    const before = (h.calls().match(/^compose up -d$/gm) ?? []).length;
    assert.equal(h.run("community", "on").status, 0);
    assert.equal((h.calls().match(/^compose up -d$/gm) ?? []).length, before);
    assert.notEqual(h.run("community", "maybe").status, 0);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("a site that does not come back with the new value gets the old one again", () => {
  const h = home();
  try {
    const r = h.runWith({ FAKE_UNHEALTHY: "web", BB_HEALTH_WAIT: "1" }, "community", "off");
    assert.notEqual(r.status, 0);
    assert.equal(h.envVal("COMMUNITY_RECONCILER"), "true", "put back");
    assert.match(r.stderr, /put back/);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

// ── Never the real systemctl ────────────────────────────────────────────────────────────────────
// A test once ran `up`, which ends by starting a community run, with no stand-in for systemctl: the
// REAL one ran as a normal user and the desktop asked for a password. The harness now puts one first
// on PATH for every run, and it records where it ran from.
test("the harness's systemctl is the stand-in, first on PATH, for every run of the command", () => {
  const h = fakeHome();
  try {
    const PATH = `${path.join(h.fake, "bin")}:/usr/bin:/bin`;
    const found = spawnSync("bash", ["-c", "command -v systemctl"], { encoding: "utf8", env: { PATH } }).stdout.trim();
    assert.equal(found, path.join(h.fake, "bin/systemctl"));
    const r = h.run("community", "reconcile", "--mode", "report"); // any run: its PATH is the harness's
    assert.ok(r.status !== null, "vacuity: it ran");
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("up ends by starting a community run, through the stand-in only (never the real systemctl)", () => {
  const h = fakeHome();
  try {
    mkdirSync(path.join(h.home, "release")); mkdirSync(path.join(h.home, "bin")); mkdirSync(path.join(h.home, "systemd"));
    symlinkSync(here, path.join(h.home, "release/install"));
    symlinkSync(path.join(root, "config"), path.join(h.home, "release/config"));
    const r = h.runWith({ BB_BIN_DIR: path.join(h.home, "bin"), BB_SYSTEMD_DIR: path.join(h.home, "systemd"), BB_HEALTH_WAIT: "1", FAKE_RUN_STATUS: "0" }, "up");
    assert.equal(r.status, 0, r.stderr);
    assert.match(h.calls(), /^systemctl start --no-block blackbranch-community@apply\.service$/m);
    const ran = readFileSync(path.join(h.fake, "systemctl-ran-from"), "utf8").trim().split("\n");
    assert.ok(ran.length >= 1);
    for (const p of ran) assert.equal(p, path.join(h.fake, "bin/systemctl"), "only the stand-in ever ran");
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

// ── Units, start, install, docs ─────────────────────────────────────────────────────────────────
test("the unit is a one-shot template that runs the command; busy (75) is not a failure", () => {
  const unit = read("systemd/blackbranch-community@.service");
  assert.match(unit, /^Type=oneshot$/m);
  assert.match(unit, /^ExecStart=\/usr\/local\/bin\/blackbranch community reconcile --mode %i$/m);
  assert.match(unit, /^TimeoutStartSec=20min$/m);
  assert.match(unit, /^SuccessExitStatus=75$/m);
  assert.match(unit, /^Requires=docker\.service$/m);
  const timer = read("systemd/blackbranch-community.timer");
  assert.match(timer, /^Unit=blackbranch-community@apply\.service$/m);
  assert.match(timer, /^OnUnitActiveSec=10min$/m);
  assert.match(timer, /^OnBootSec=\d+min$/m);
  assert.match(timer, /^WantedBy=timers\.target$/m);
  assert.match(bb, /\nBUNDLE_UNITS=\([^)]*blackbranch-community@\.service blackbranch-community\.timer[^)]*\)/);
});

test("start and every update: the timer runs only while the switch is on; up starts a run after the rooms check", () => {
  // install_files (install.sh's `blackbranch install-files`, every update and every `up`).
  assert.match(bb, /\n {2}systemctl is-enabled -q blackbranch-check\.timer 2>\/dev\/null \|\| systemctl enable -q --now blackbranch-check\.timer \|\| true\n {2}community_timer_sync \|\| true\n {2}return 0\n\}/);
  // cmd_up's last lines.
  assert.match(bb, /\n {2}matrix_ensure "\$UP_AFTER" \|\| true\n {2}if community_reconciler_on; then community_reconcile_start apply >\/dev\/null \|\| true; fi\n\}\n/);
});

test("the request is listed in both of the dispatcher's lists, and the site may ask for it", () => {
  const fn = bb.slice(bb.indexOf("\ncmd_process_requests() {"), bb.indexOf("\n# The site's icons from the setup pages"));
  assert.ok(fn.length > 1000, "vacuity: the dispatcher was found");
  assert.match(fn, /\n {8}restart-\*\|render\|matrix-bootstrap\|apply-install\|backup\|backup-test\|community-reconcile\|community-report\|update-v\*\|discord-guild-\*\|discord-link-\*\|discord-unlink-\*\|discord-privacy-\*\|discord-token\)\n/);
  assert.match(fn, /\n {6}community-reconcile\) verb="community reconcile"; if msg=\$\(community_reconcile_start apply 2>&1\); then ok=true; fi ;;\n/);
  assert.match(fn, /\n {6}community-report\) verb="community report"; if msg=\$\(community_reconcile_start report 2>&1\); then ok=true; fi ;;\n/);
  const site = readFileSync(path.join(root, "web/app/lib/hostRequests.ts"), "utf8");
  assert.match(site, /\| "community-reconcile"/);
  assert.match(site, /\| "community-report"/);
});

test("the switch is not in the restart list as permanent: it has its own command, which the docs name", async () => {
  assert.doesNotMatch(read("restart-settings.tsv"), /COMMUNITY_RECONCILER/);
  const doc = readFileSync(path.join(root, "docs/public/operate.md"), "utf8");
  assert.doesNotMatch(doc, /\| `COMMUNITY_RECONCILER` \|/);
  assert.match(doc, /sudo blackbranch community off/);
  assert.match(doc, /sudo blackbranch community reconcile --mode report/);
  // Put-back follows the panel's setting (spec §4.1), named by its label in the schema; report ends with the JSON line.
  const { INSTANCE_KEYS } = await import("../config/instance-schema.mjs");
  const keep = INSTANCE_KEYS.find((k) => k.key === "community.keepElementEdits");
  assert.equal(keep.default, false);
  assert.ok(doc.includes(`**${keep.label}**`), `the doc names the setting as the panel does: ${keep.label}`);
  assert.match(doc, /Off \(the default\): the server puts it back the way the panel has it\. On: the\s+change stays, and the server only reports it\./);
  assert.match(doc, /\{"mode":"report"/);
  assert.doesNotMatch(doc, /ends with a summary line/);
  // The exit codes are the command's own (cmd_community_reconcile: a report's 1 becomes 0).
  assert.match(doc, /It exits with 0 when it finished, whether or not something would change/);
  assert.doesNotMatch(doc, /exits with 1 when something would change/);
  assert.match(bb, /\n {2}if \[ "\$mode" = report \] && \[ "\$rc" = 1 \]; then rc=0; fi\n/);
  // A stranger's invite: pending and unlisted (an appservice cannot list its own invites).
  assert.match(doc, /an invite to any other room stays\s+pending and is not listed/);
  assert.match(bb, /\n# {3}blackbranch community reconcile \[--mode report\|adopt\|apply\]/, "help names it");
  // The help header `blackbranch help` prints says the same exit codes as the command (area 7, A7-11).
  const header = bb.slice(0, bb.indexOf("\nset -euo pipefail"));
  assert.match(header, /# {3}blackbranch community reconcile/, "the header was read past the reconcile entry");
  assert.match(header, /default\): what would change, nothing changed \(exit 0 either way;/);
  assert.doesNotMatch(header, /exit 1 when\s+(#\s+)?something would/);
});

test("vacuity: this file was read to its end", () => {
  const me = readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.match(me, /\n\/\/ END: community\.test\.mjs\n$/);
});

// END: community.test.mjs
