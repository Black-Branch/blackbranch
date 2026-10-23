// The box's alerts. Run: node --test install/
//
// What they hold: a nightly backup and a weekly restore check that fail, and the daily check (low
// disk, a certificate about to run out in direct mode, no good backup for 36 hours) each reach the
// ONE channel kept in .env (an ntfy topic and/or an email command); with no channel the alert is
// logged only; a channel that fails is said and never changes the outcome of what raised it; the
// topic address never reaches a command line or the output; and the daily check's floors are the
// doctor's. (Updates that go back: install/update.test.mjs, "alerts".)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, renameSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeHome } from "./scratch-home.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const read = (rel) => readFileSync(path.join(here, rel), "utf8");
const TOPIC = "bb-alerts-0c9f3e2a7d";

// A stand-in ntfy: records every publish. `status` is what it answers.
async function ntfy(status = 200) {
  const got = [];
  const srv = createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    got.push({ method: req.method, url: req.url, title: req.headers.title, priority: req.headers.priority, body });
    res.writeHead(status); res.end("{}");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { got, url: `http://127.0.0.1:${srv.address().port}/${TOPIC}`, close: () => srv.close() };
}

// A scratch install with the stand-in docker, a curl that logs its command line before running the
// real one, and <channel> lines replacing the empty ones .env.example holds.
function alertHome(channel = {}) {
  const h = fakeHome();
  mkdirSync(path.join(h.home, "results"), { mode: 0o755 }); mkdirSync(path.join(h.home, "state"), { recursive: true });
  writeFileSync(path.join(h.fake, "bin/curl"), `#!/usr/bin/env bash\necho "$*" >> "$FAKE/curl-argv"\nexec /usr/bin/curl "$@"\n`, { mode: 0o755 });
  let env = h.env();
  for (const [k, v] of Object.entries(channel)) env = env.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`);
  writeFileSync(path.join(h.home, ".env"), env, { mode: 0o600 });
  const mail = path.join(h.home, "mail.txt"), subject = path.join(h.home, "subject.txt");
  // Async: the stand-in ntfy answers from this process while the command runs.
  const run = (extra, ...args) => new Promise((resolve) => {
    const p = spawn("bash", [path.join(here, "blackbranch"), ...args], {
      env: { ...process.env, BB_HOME: h.home, FAKE: h.fake, PATH: `${path.join(h.fake, "bin")}:/usr/bin:/bin`, ...extra } });
    let stdout = "", stderr = "";
    p.stdout.on("data", (c) => (stdout += c)); p.stderr.on("data", (c) => (stderr += c));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  const file = (f) => (existsSync(f) ? readFileSync(f, "utf8") : "");
  return { ...h, run, mail, subject, file, curlArgv: () => file(path.join(h.fake, "curl-argv")) };
}
const EMAIL = (h) => `'cat > ${h.mail}; printf %s "$BB_ALERT_SUBJECT" > ${h.subject}'`;
// The nightly backup refused before anything ran: the target is not usable.
const failingBackup = (h) => {
  const t = path.join(h.home, "state/target"); writeFileSync(t, "BK_TARGET=floppy\n");
  return h.run({ BB_BACKUP_TARGET_FILE: t }, "backup", "--scheduled");
};

test("no channel: the failed nightly backup is in the log only, and the backup's own outcome is unchanged", async () => {
  const h = alertHome();
  try {
    const r = await failingBackup(h);
    assert.equal(r.status, 1, "the backup still fails");
    assert.match(r.stderr, /nothing was backed up: the target is not usable/);
    assert.match(r.stderr, /ALERT: example\.test: the nightly backup failed\n {3}The nightly backup failed at \S+\. The last good backup: none yet\./);
    assert.match(r.stdout + r.stderr, /no alert channel is set \(BB_ALERT_NTFY_URL or BB_ALERT_EMAIL_COMMAND in \.env\): this alert is in the log only/);
    assert.equal(h.curlArgv(), "", "nothing was sent anywhere");
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("ntfy: the failed nightly backup is published once, in fixed words; the topic never reaches a command line or the output", async () => {
  const n = await ntfy();
  const h = alertHome({ BB_ALERT_NTFY_URL: n.url });
  try {
    const r = await failingBackup(h);
    assert.equal(r.status, 1, "the backup still fails");
    assert.equal(n.got.length, 1, "published once");
    const [p] = n.got;
    assert.equal(p.method, "POST"); assert.equal(p.url, `/${TOPIC}`); assert.equal(p.priority, "4");
    assert.equal(p.title, "Black Branch example.test: the nightly backup failed");
    assert.match(p.body, /^The nightly backup failed at \S+\. The last good backup: none yet\.\nSee why on the server: sudo blackbranch status\n$/);
    assert.doesNotMatch(p.body, /target|floppy/i, "never a tool's own error text");
    assert.match(r.stdout + r.stderr, /alert sent: ntfy/);
    for (const where of [r.stdout, r.stderr, h.curlArgv(), h.calls()]) assert.ok(!where.includes(TOPIC), "the topic was printed or put on a command line");
    assert.ok(h.curlArgv().length > 0, "vacuity: curl's command line was recorded");
  } finally { n.close(); rmSync(h.home, { recursive: true, force: true }); }
});

test("email: the command reads the whole message, headers first; $BB_ALERT_SUBJECT holds the subject", async () => {
  const h = alertHome();
  const env = h.env().replace(/^BB_ALERT_EMAIL_COMMAND=.*$/m, `BB_ALERT_EMAIL_COMMAND=${EMAIL(h)}`);
  writeFileSync(path.join(h.home, ".env"), env, { mode: 0o600 });
  try {
    const r = await failingBackup(h);
    assert.equal(r.status, 1);
    assert.match(h.file(h.mail), /^Subject: \[Black Branch\] example\.test: the nightly backup failed\nContent-Type: text\/plain; charset=UTF-8\n\nThe nightly backup failed at /);
    assert.equal(h.file(h.subject), "[Black Branch] example.test: the nightly backup failed");
    assert.match(r.stdout + r.stderr, /alert sent: email/);
    assert.ok(!(r.stdout + r.stderr).includes(h.mail), "the command was printed");
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("a channel that fails is said, the other still sends, and what raised the alert ends as before (retry: the next alert sends)", async () => {
  const n = await ntfy(500);
  const h = alertHome({ BB_ALERT_NTFY_URL: n.url });
  writeFileSync(path.join(h.home, ".env"), h.env().replace(/^BB_ALERT_EMAIL_COMMAND=.*$/m, `BB_ALERT_EMAIL_COMMAND=${EMAIL(h)}`), { mode: 0o600 });
  try {
    let r = await failingBackup(h);
    assert.equal(r.status, 1);
    assert.equal(n.got.length, 1, "ntfy was asked");
    assert.match(r.stdout + r.stderr, /alert sent: email/);
    assert.match(r.stdout + r.stderr, /the alert could not be sent through the ntfy topic \(BB_ALERT_NTFY_URL\): check it with sudo blackbranch alerts test/);
    // An email command that fails, and a topic address that is not one: both said, nothing thrown.
    writeFileSync(path.join(h.home, ".env"), h.env().replace(/^BB_ALERT_EMAIL_COMMAND=.*$/m, "BB_ALERT_EMAIL_COMMAND='exit 3'")
      .replace(/^BB_ALERT_NTFY_URL=.*$/m, "BB_ALERT_NTFY_URL=ftp://nowhere"), { mode: 0o600 });
    r = await failingBackup(h);
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /could not be sent through the ntfy topic \(BB_ALERT_NTFY_URL\) the email command \(BB_ALERT_EMAIL_COMMAND\)/);
    assert.equal(n.got.length, 1, "an address that is not http(s) is never fetched");
    // Retry: the channel works again; the next failure is sent.
    writeFileSync(path.join(h.home, ".env"), h.env().replace(/^BB_ALERT_EMAIL_COMMAND=.*$/m, `BB_ALERT_EMAIL_COMMAND=${EMAIL(h)}`), { mode: 0o600 });
    rmSync(h.mail, { force: true });
    r = await failingBackup(h);
    assert.match(h.file(h.mail), /the nightly backup failed/);
  } finally { n.close(); rmSync(h.home, { recursive: true, force: true }); }
});

test("only the timers' failed runs alert: a nightly backup that works, and a backup run by hand that fails, send nothing", async () => {
  const n = await ntfy();
  const h = alertHome({ BB_ALERT_NTFY_URL: n.url });
  try {
    const t = path.join(h.home, "state/target"); writeFileSync(t, "BK_TARGET=local\n");
    writeFileSync(path.join(h.fake, "run-out-backup"), 'BBRESULT {"ok":true,"snapshot":"abcd1234abcd1234","message":"kept 7 daily"}\n');
    let r = await h.run({ BB_BACKUP_TARGET_FILE: t, FAKE_RUN_STATUS: "0", BB_SYSTEMD_DIR: path.join(h.home, "systemd") }, "backup", "--scheduled");
    assert.equal(r.status, 0, r.stderr);
    writeFileSync(t, "BK_TARGET=floppy\n");
    r = await h.run({ BB_BACKUP_TARGET_FILE: t }, "backup");
    assert.equal(r.status, 1);
    assert.equal(n.got.length, 0, "an alert was sent");
  } finally { n.close(); rmSync(h.home, { recursive: true, force: true }); }
});

test("the weekly restore check that fails is sent; the command it names is the one that shows why", async () => {
  const n = await ntfy();
  const h = alertHome({ BB_ALERT_NTFY_URL: n.url });
  try {
    const t = path.join(h.home, "state/target"); writeFileSync(t, "BK_TARGET=floppy\n");
    const r = await h.run({ BB_BACKUP_TARGET_FILE: t }, "restore", "latest", "--verify", "--scheduled");
    assert.equal(r.status, 1);
    assert.equal(n.got.length, 1);
    assert.equal(n.got[0].title, "Black Branch example.test: the weekly restore check failed");
    assert.match(n.got[0].body, /See why on the server: sudo blackbranch restore latest --verify\n$/);
  } finally { n.close(); rmSync(h.home, { recursive: true, force: true }); }
});

// The daily check, with df and openssl stood in for: <free> % free on every disk, a certificate
// ending at <end> (or none).
function dailyHome(n, { free = 50, end = null, mode = "direct", backupOkHoursAgo = 2 } = {}) {
  const h = alertHome({ BB_ALERT_NTFY_URL: n.url, BB_TLS_MODE: mode });
  writeFileSync(path.join(h.fake, "bin/df"), `#!/usr/bin/env bash\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/x 1000 $((1000 - ${free} * 10)) ${free * 10} 0% /"\n`, { mode: 0o755 });
  // Docker keeps its data at its own root (the stand-in docker does not answer `info`).
  renameSync(path.join(h.fake, "bin/docker"), path.join(h.fake, "docker-real"));
  writeFileSync(path.join(h.fake, "bin/docker"), `#!/usr/bin/env bash\nif [ "$1" = info ]; then echo /var/lib/docker; exit 0; fi\nexec "$FAKE/docker-real" "$@"\n`, { mode: 0o755 });
  writeFileSync(path.join(h.fake, "bin/openssl"),`#!/usr/bin/env bash\ncase "$1" in s_client) cat >/dev/null ;; x509) ${end ? `echo "notAfter=${end}"` : "exit 1"} ;; esac\n`, { mode: 0o755 });
  if (backupOkHoursAgo !== null) {
    const at = new Date(Date.now() - backupOkHoursAgo * 3600_000).toISOString().replace(/\.\d+Z$/, "Z");
    writeFileSync(path.join(h.home, "results/backup-last.json"), `{"v":1,"at":"${at}","ok":true,"snapshot":"abcd","target":"local","lastOkAt":"${at}","message":""}\n`);
  }
  return h;
}
const inDays = (d) => new Date(Date.now() + d * 86400_000).toUTCString().replace("GMT", "GMT");

test("the daily check: all well sends nothing; low disk, a certificate near its end, no good backup for 36 hours each make one alert naming them all", async () => {
  const n = await ntfy();
  try {
    let h = dailyHome(n, { end: inDays(60) });
    let r = await h.run({}, "alerts", "check");
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /daily check: disk, certificates and backups are fine/);
    assert.equal(n.got.length, 0);
    rmSync(h.home, { recursive: true, force: true });

    h = dailyHome(n, { free: 9, end: inDays(5), backupOkHoursAgo: 40 });
    r = await h.run({}, "alerts", "check");
    assert.equal(r.status, 1, "the unit shows failed");
    assert.equal(n.got.length, 1, "one alert for every problem");
    const { title, body } = n.got[0];
    assert.equal(title, "Black Branch example.test: the daily check found 6 problems");
    assert.match(body, /^Low disk: 9% free where the install data lives \(/m);
    assert.match(body, /^Low disk: 9% free where the docker data lives \(\/var\/lib\/docker\)/m);
    for (const name of ["example.test", "api.example.test", "matrix.example.test"]) {
      assert.match(body, new RegExp(`^The certificate for ${name.replaceAll(".", "\\.")} runs out in [45] days\\. The router renews it by itself, so something stops it: sudo blackbranch logs caddy$`, "m"));
    }
    assert.match(body, /^No good backup in the last 36 hours \(the last good one: \S+\)\. See why: sudo blackbranch status$/m);
    rmSync(h.home, { recursive: true, force: true });

    // Retry: the next day, fixed, sends nothing (and a certificate that cannot be read is said).
    h = dailyHome(n, { end: null });
    r = await h.run({}, "alerts", "check");
    assert.equal(n.got.length, 2);
    assert.match(n.got[1].body, /^No certificate could be read for example\.test\. Check: sudo blackbranch doctor$/m);
    rmSync(h.home, { recursive: true, force: true });
    h = dailyHome(n, { end: inDays(60) });
    r = await h.run({}, "alerts", "check");
    assert.equal(r.status, 0); assert.equal(n.got.length, 2, "fixed: nothing more sent");
    rmSync(h.home, { recursive: true, force: true });

    // Tunnel mode has no certificates on the box; a box with no backup yet is not nagged.
    h = dailyHome(n, { mode: "tunnel", end: null, backupOkHoursAgo: null });
    r = await h.run({}, "alerts", "check");
    assert.equal(r.status, 0, r.stderr); assert.equal(n.got.length, 2);
    rmSync(h.home, { recursive: true, force: true });
  } finally { n.close(); }
});

test("alerts test sends one, so the operator can try the channel; with no channel it says so", async () => {
  const n = await ntfy();
  const h = alertHome({ BB_ALERT_NTFY_URL: n.url });
  try {
    const r = await h.run({}, "alerts", "test");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(n.got[0].title, "Black Branch example.test: a test alert"); assert.equal(n.got[0].priority, "3");
    const none = alertHome();
    try {
      const r2 = await none.run({}, "alerts", "test");
      assert.equal(r2.status, 0); assert.match(r2.stdout + r2.stderr, /this alert is in the log only/);
    } finally { rmSync(none.home, { recursive: true, force: true }); }
  } finally { n.close(); rmSync(h.home, { recursive: true, force: true }); }
});

test("the daily check's floors are the doctor's, and its timer and unit ship and are enabled", () => {
  const doctor = readFileSync(path.join(root, "config/doctor.mjs"), "utf8");
  const bb = read("blackbranch");
  for (const [sh, js] of [["ALERT_DISK_FREE_PCT", "MIN_DISK_FREE_PCT"], ["ALERT_CERT_DAYS", "MIN_CERT_DAYS"], ["ALERT_BACKUP_AGE_H", "MAX_BACKUP_AGE_H"]]) {
    const a = bb.match(new RegExp(`\\n${sh}=(\\d+)\\n`))?.[1], b = doctor.match(new RegExp(`const ${js} = (\\d+);`))?.[1];
    assert.ok(a && b, `${sh} / ${js} found`); assert.equal(a, b, `${sh} is not the doctor's ${js}`);
  }
  assert.match(read("systemd/blackbranch-check.service"), /\nExecStart=\/usr\/local\/bin\/blackbranch alerts check\n/);
  const timer = read("systemd/blackbranch-check.timer");
  assert.match(timer, /\nOnCalendar=\*-\*-\* 09:00:00\n/); assert.match(timer, /\nPersistent=true\n/); assert.match(timer, /\nUnit=blackbranch-check\.service\n/);
  assert.match(bb, /\nBUNDLE_UNITS=\([^)]*blackbranch-check\.service blackbranch-check\.timer\)/);
  assert.match(bb, /systemctl is-enabled -q blackbranch-check\.timer 2>\/dev\/null \|\| systemctl enable -q --now blackbranch-check\.timer/);
  // The address reaches curl on a descriptor, never its command line; the command never sees argv either.
  assert.match(bb, /-K <\(printf 'url = "%s"\\n' "\$url"\)/);
  // The keys: in .env.example, in what install.sh writes, and added to an older .env by migration 003.
  assert.match(read(".env.example"), /^BB_ALERT_NTFY_URL=\nBB_ALERT_EMAIL_COMMAND=\n$/m);
  assert.match(read("migrations/003-alerts.sh"), /envm_add BB_ALERT_NTFY_URL ""\nenvm_add BB_ALERT_EMAIL_COMMAND ""\n$/);
  // Vacuity anchor: the end of the alerts section.
  assert.match(bb, /\n {4}\*\) die "usage: blackbranch alerts check\|test" ;;\n {2}esac\n\}\n/);
});
