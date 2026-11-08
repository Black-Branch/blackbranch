// Optional mail (A2-05, KG-11): the SMTP settings reach the sign-in service's rendered config, and
// password recovery and a verified address at sign-up switch on with them — never without them.
//   mail.cjs     — the host reads the mail.* keys inside the stream-api image (secret one decrypted
//                  with stream-api's own key), like the backup target (backup/target.cjs)
//   render.sh    — MAS's `email:` block and the two account switches
//   mail-send.cjs — `blackbranch mail test`: one message through the server, run against a small
//                  SMTP server here
// Nothing real is called: the host command runs on a scratch home with stand-ins (scratch-home.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeHome, renderHome } from "./scratch-home.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const { INSTANCE_KEYS } = createRequire(import.meta.url)(path.join(root, "stream-api/instanceSchema.generated.js"));

// ── mail.cjs ──────────────────────────────────────────────────────────────────────────────────
function fakeApp(rows) {
  const app = mkdtempSync(path.join(tmpdir(), "bb-app-"));
  for (const f of ["instance-config.js", "instanceSchema.generated.js"]) copyFileSync(path.join(root, "stream-api", f), path.join(app, f));
  mkdirSync(path.join(app, "node_modules/pg"), { recursive: true });
  writeFileSync(path.join(app, "node_modules/pg/index.js"), `const rows = ${JSON.stringify(rows)};
class Pool { async query(sql) { return { rows: sql.includes("instance_secrets") ? rows.secrets : rows.config }; } async end() {} }
module.exports = { Pool };\n`);
  return app;
}
const runMail = (app, env) => spawnSync(process.execPath, [path.join(here, "matrix/mail.cjs")], { encoding: "utf8", env: { PATH: process.env.PATH, BB_APP_DIR: app, ...env } });

test("mail.cjs resolves every mail.* key as stream-api would, decrypting the password", () => {
  const keys = INSTANCE_KEYS.filter((e) => e.key.startsWith("mail."));
  assert.deepEqual(keys.map((e) => e.key).sort(), ["mail.from", "mail.smtp.host", "mail.smtp.mode", "mail.smtp.password", "mail.smtp.port", "mail.smtp.username"]);
  assert.deepEqual(keys.find((e) => e.key === "mail.smtp.password")?.packages, ["stream-api"], "the site never receives the password");
  const mk = randomBytes(32);
  const { encryptSecret } = createRequire(import.meta.url)(path.join(root, "stream-api/instance-config.js"));
  const app = fakeApp({
    config: [{ key: "mail.smtp.host", value: "smtp.mail.test" }, { key: "mail.smtp.username", value: "site" }],
    secrets: [{ key: "mail.smtp.password", ciphertext: encryptSecret("mail.smtp.password", "pa'ss word\"x", mk) }],
  });
  try {
    let r = runMail(app, { INSTANCE_MASTER_KEY: mk.toString("hex") });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split("\n").sort(), [
      "MX_MAIL_FROM_SET=", "MX_SMTP_HOST=smtp.mail.test", "MX_SMTP_MODE=starttls", "MX_SMTP_PASSWORD=pa'ss word\"x", "MX_SMTP_PORT=", "MX_SMTP_USERNAME=site",
    ]);
    // env > database, as everywhere else.
    r = runMail(app, { INSTANCE_MASTER_KEY: mk.toString("hex"), MAIL_SMTP_MODE: "tls", MAIL_SMTP_PORT: "465" });
    assert.match(r.stdout, /^MX_SMTP_MODE=tls$/m); assert.match(r.stdout, /^MX_SMTP_PORT=465$/m);
    // A password that does not decrypt is an error, never an empty value (that would send unsigned-in).
    r = runMail(app, { INSTANCE_MASTER_KEY: randomBytes(32).toString("hex") });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /mail\.smtp\.password does not decrypt/); assert.equal(r.stdout, "");
  } finally { rmSync(app, { recursive: true, force: true }); }
  // Nothing set: every line empty but the mode's default; no key needed.
  const none = fakeApp({ config: [], secrets: [] });
  try {
    const r = runMail(none, {});
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^MX_SMTP_HOST=$/m);
  } finally { rmSync(none, { recursive: true, force: true }); }
});

// ── render.sh: MAS's email block ──────────────────────────────────────────────────────────────
function renderMas(extraEnv) {
  const env = {
    PATH: "/usr/bin:/bin", MX_ISSUER: "https://matrix.example.test/auth/", MX_SERVER_NAME: "example.test", MX_MAS_DB_URI: "postgresql://mas:pw@postgres/mas",
    MX_MAIL_FROM: "noreply@example.test", MX_CLIENT_ID: "00000000000000000000000000", MX_CLIENT_SECRET: "secret", MX_REDIRECT_URI: "https://example.test/api/auth/mas-callback",
    MX_SYNAPSE_ENDPOINT: "http://synapse:8008/", MX_MAS_SECRET: "s", MX_ENCRYPTION_SECRET: "e".repeat(64), MX_REGISTRATION: "open", ...extraEnv,
  };
  const home = renderHome();
  try {
    env.MX_MAS_KEYS_FILE = path.join(home, "matrix/mas-keys.yaml");
    return spawnSync("bash", ["-c", `. "${path.join(here, "matrix/render.sh")}"; mx_render_mas`], { encoding: "utf8", env });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

test("without a mail server: mail is dropped, no recovery, no address required — as before", () => {
  const r = renderMas({});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\n {2}transport: blackhole\n/);
  assert.match(r.stdout, /\n {2}password_registration_email_required: false\n/);
  assert.match(r.stdout, /\n {2}password_recovery_enabled: false\n/);
  assert.doesNotMatch(r.stdout, /hostname:|password: '/);
});

test("with a mail server: SMTP through it, password recovery on, a verified address at sign-up", () => {
  const r = renderMas({ MX_SMTP_HOST: "smtp.mail.test", MX_SMTP_MODE: "starttls", MX_SMTP_USERNAME: "site", MX_SMTP_PASSWORD: "pa'ss \"w\\rd", MX_MAIL_FROM_SET: "stream@example.test" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\nemail:\n {2}from: "stream@example\.test"\n {2}reply_to: "stream@example\.test"\n {2}transport: smtp\n {2}mode: starttls\n {2}hostname: "smtp\.mail\.test"\n {2}port: 587\n {2}username: "site"\n {2}password: 'pa''ss "w\\rd'\n/);
  assert.match(r.stdout, /\n {2}password_recovery_enabled: true\n/);
  assert.match(r.stdout, /\n {2}password_registration_email_required: true\n/);
  // The port follows the mode when unset; an explicit one wins.
  assert.match(renderMas({ MX_SMTP_HOST: "smtp.mail.test", MX_SMTP_MODE: "tls" }).stdout, /\n {2}port: 465\n/);
  assert.match(renderMas({ MX_SMTP_HOST: "smtp.mail.test", MX_SMTP_MODE: "plain" }).stdout, /\n {2}port: 25\n/);
  assert.match(renderMas({ MX_SMTP_HOST: "smtp.mail.test", MX_SMTP_PORT: "2525" }).stdout, /\n {2}port: 2525\n/);
  // No user name: no credentials lines.
  assert.doesNotMatch(renderMas({ MX_SMTP_HOST: "smtp.mail.test" }).stdout, /username:|password: '/);
});

test("render refuses mail values that would break the config, before writing anything", () => {
  for (const [k, v] of [["MX_SMTP_HOST", "smtp.mail.test:25"], ["MX_SMTP_HOST", "smtp mail"], ["MX_SMTP_MODE", "ssl"], ["MX_SMTP_PORT", "99999"],
    ["MX_SMTP_PASSWORD", "two\nlines"], ["MX_MAIL_FROM_SET", "not an address"], ["MX_SMTP_USERNAME", 'a"b']]) {
    const r = renderMas({ MX_SMTP_HOST: "smtp.mail.test", MX_SMTP_USERNAME: "site", MX_SMTP_PASSWORD: "pw", [k]: v });
    assert.notEqual(r.status, 0, `${k}=${JSON.stringify(v)}`);
    assert.equal(r.stdout, "", `${k}: nothing rendered`);
  }
});

// ── mail-send.cjs: one message through the server ───────────────────────────────────────────────
/** A minimal SMTP server (plain, no TLS): records what it was sent; `auth` = the AUTH PLAIN it wants. */
function smtpServer({ auth = null, refuseRcpt = false } = {}) {
  const got = { auth: null, from: null, to: null, data: "" };
  const srv = createServer((s) => {
    let buf = "", inData = false;
    s.on("error", () => {}); // a client that leaves early is its own business
    s.write("220 mail.test ESMTP\r\n");
    s.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) {
          if (line === ".") { inData = false; s.write("250 queued\r\n"); } else got.data += `${line}\n`;
          continue;
        }
        if (/^EHLO /i.test(line)) s.write(`250-mail.test\r\n250 AUTH PLAIN LOGIN\r\n`);
        else if (/^AUTH PLAIN /i.test(line)) { got.auth = line.slice(11); s.write(auth && got.auth === auth ? "235 ok\r\n" : "535 bad credentials\r\n"); }
        else if (/^MAIL FROM:/i.test(line)) { got.from = line; s.write("250 ok\r\n"); }
        else if (/^RCPT TO:/i.test(line)) { got.to = line; s.write(refuseRcpt ? "550 no such user\r\n" : "250 ok\r\n"); }
        else if (/^DATA$/i.test(line)) { inData = true; s.write("354 go\r\n"); }
        else if (/^QUIT$/i.test(line)) { s.write("221 bye\r\n"); s.end(); }
        else s.write("500 what\r\n");
      }
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port, got })));
}
const send = (env, to) => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(here, "matrix/mail-send.cjs"), to], { env: { PATH: process.env.PATH, ...env } });
  let out = "", err = "";
  p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { err += d; });
  p.on("close", (status) => resolve({ status, out, err }));
});

test("mail test sends one message, signed in, to the address given; the answer is a fixed code", async () => {
  const { srv, port, got } = await smtpServer({ auth: Buffer.from("\0site\0pw").toString("base64") });
  try {
    const r = await send({ MX_SMTP_HOST: "127.0.0.1", MX_SMTP_PORT: String(port), MX_SMTP_MODE: "plain", MX_SMTP_USERNAME: "site", MX_SMTP_PASSWORD: "pw", MX_MAIL_FROM: "noreply@example.test" }, "owner@example.test");
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out.trim(), "sent");
    assert.equal(got.from, "MAIL FROM:<noreply@example.test>");
    assert.equal(got.to, "RCPT TO:<owner@example.test>");
    assert.match(got.data, /^Subject: A test message from your Black Branch install$/m);
    assert.doesNotMatch(r.out + r.err, /pw/, "the password is never printed");
  } finally { srv.close(); }
});

test("mail test: wrong credentials, a refused recipient, nobody answering — each a named failure", async () => {
  const bad = await smtpServer({ auth: "something-else" });
  try {
    const r = await send({ MX_SMTP_HOST: "127.0.0.1", MX_SMTP_PORT: String(bad.port), MX_SMTP_MODE: "plain", MX_SMTP_USERNAME: "site", MX_SMTP_PASSWORD: "pw", MX_MAIL_FROM: "noreply@example.test" }, "owner@example.test");
    assert.notEqual(r.status, 0); assert.equal(r.out.trim(), "auth_refused");
  } finally { bad.srv.close(); }
  const rc = await smtpServer({ refuseRcpt: true });
  try {
    const r = await send({ MX_SMTP_HOST: "127.0.0.1", MX_SMTP_PORT: String(rc.port), MX_SMTP_MODE: "plain", MX_MAIL_FROM: "noreply@example.test" }, "nobody@example.test");
    assert.notEqual(r.status, 0); assert.equal(r.out.trim(), "recipient_refused");
  } finally { rc.srv.close(); }
  const r = await send({ MX_SMTP_HOST: "127.0.0.1", MX_SMTP_PORT: "1", MX_SMTP_MODE: "plain", MX_MAIL_FROM: "noreply@example.test" }, "owner@example.test");
  assert.notEqual(r.status, 0); assert.equal(r.out.trim(), "unreachable");
  const none = await send({ MX_SMTP_HOST: "" }, "owner@example.test");
  assert.notEqual(none.status, 0); assert.equal(none.out.trim(), "not_set");
});

// ── the host: `blackbranch mail test` and the doctor's facts ───────────────────────────────────
test("blackbranch mail test <address>: runs the sender in the site's image, records the answer for the doctor", () => {
  const h = fakeHome();
  try {
    mkdirSync(path.join(h.home, "results"), { mode: 0o755 });
    writeFileSync(path.join(h.fake, "mail-lines"), "MX_SMTP_HOST=smtp.mail.test\nMX_SMTP_PORT=\nMX_SMTP_MODE=starttls\nMX_SMTP_USERNAME=site\nMX_SMTP_PASSWORD=pw\nMX_MAIL_FROM_SET=\n");
    writeFileSync(path.join(h.fake, "mail-send-out"), "sent\n");
    let r = h.runWith({ BB_MAIL_LINES_FILE: path.join(h.fake, "mail-lines") }, "mail", "test", "owner@example.test");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout + r.stderr, /sent to owner@example\.test/);
    const last = JSON.parse(readFileSync(path.join(h.home, "results/mail-test.json"), "utf8"));
    assert.equal(last.ok, true); assert.equal(last.code, "sent"); assert.match(last.at, /^\d{4}-\d\d-\d\dT/);
    assert.doesNotMatch(readFileSync(path.join(h.home, "results/mail-test.json"), "utf8"), /owner@|pw/, "no address, no password in the result");
    assert.match(h.calls(), /mail-send\.cjs owner@example\.test/);
    assert.doesNotMatch(h.calls(), /MX_SMTP_PASSWORD=pw/, "the password never on a command line");
    // A failure is recorded as one too, with its code.
    writeFileSync(path.join(h.fake, "mail-send-out"), "auth_refused\n");
    r = h.runWith({ BB_MAIL_LINES_FILE: path.join(h.fake, "mail-lines"), FAKE_MAIL_SEND_STATUS: "1" }, "mail", "test", "owner@example.test");
    assert.notEqual(r.status, 0); assert.match(r.stderr, /auth_refused/);
    assert.equal(JSON.parse(readFileSync(path.join(h.home, "results/mail-test.json"), "utf8")).ok, false);
    // A wrong use asks nothing.
    for (const args of [["mail"], ["mail", "test"], ["mail", "test", "not-an-address"], ["mail", "send", "a@b.test"]]) {
      assert.notEqual(h.run(...args).status, 0, args.join(" "));
    }
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("render feeds the mail settings to MAS; with the database down (restart) it keeps the last ones it read, root-only", () => {
  const h = fakeHome();
  try {
    const mas = () => readFileSync(path.join(h.home, "rendered/mas/config.yaml"), "utf8");
    writeFileSync(path.join(h.fake, "mail-out"), "MX_SMTP_HOST=smtp.mail.test\nMX_SMTP_PORT=\nMX_SMTP_MODE=starttls\nMX_SMTP_USERNAME=site\nMX_SMTP_PASSWORD=pw\nMX_MAIL_FROM_SET=\n");
    let r = h.run("render");
    assert.equal(r.status, 0, r.stderr);
    assert.match(mas(), /\n {2}transport: smtp\n/); assert.match(mas(), /\n {2}password_recovery_enabled: true\n/);
    const cache = path.join(h.home, "state/mail.env");
    assert.equal(statSync(cache).mode & 0o777, 0o600, "the cached password is root's alone");
    assert.match(h.calls(), /--entrypoint node stream-api \/bb-matrix\/mail\.cjs/);
    // The database is down now (a restart before it is up): the render keeps the mail it had.
    rmSync(path.join(h.fake, "mail-out"));
    r = h.runWith({ FAKE_UNHEALTHY: "postgres" }, "render");
    assert.equal(r.status, 0, r.stderr);
    assert.match(mas(), /\n {2}transport: smtp\n/, "mail kept from the last settings read");
    // Retry with the database back and mail switched off: the render follows the settings.
    writeFileSync(path.join(h.fake, "mail-out"), "MX_SMTP_HOST=\nMX_SMTP_PORT=\nMX_SMTP_MODE=starttls\nMX_SMTP_USERNAME=\nMX_SMTP_PASSWORD=\nMX_MAIL_FROM_SET=\n");
    r = h.run("render");
    assert.equal(r.status, 0, r.stderr);
    assert.match(mas(), /\n {2}transport: blackhole\n/); assert.match(mas(), /\n {2}password_recovery_enabled: false\n/);
    assert.doesNotMatch(readFileSync(cache, "utf8"), /pw/, "the old password is gone from the cache");
  } finally { rmSync(h.home, { recursive: true, force: true }); }
  assert.ok(existsSync(path.join(here, "matrix/mail.cjs")) && existsSync(path.join(here, "matrix/mail-send.cjs")));
});
