'use strict';
// `blackbranch mail test <address>`: one message through the install's mail server, the way the
// sign-in service will send its mail (the same host, port, connection, user name and password the
// render gives MAS). Run with node in the stream-api image on the bundle network; the settings
// arrive in the environment (MX_SMTP_* and MX_MAIL_FROM, from install/matrix/mail.cjs), never on a
// command line. No dependency: SMTP is a few lines of text.
//
// Prints ONE fixed code on stdout — sent, not_set, unreachable, tls_failed, auth_refused,
// sender_refused, recipient_refused, data_refused, protocol_error — and exits 0 only for sent.
// The server's own words go to stderr (one line, no password ever).

const net = require('node:net');
const tls = require('node:tls');

const E = process.env;
const to = process.argv[2] || '';
const host = E.MX_SMTP_HOST || '';
const mode = E.MX_SMTP_MODE || 'starttls';
const port = Number(E.MX_SMTP_PORT || (mode === 'tls' ? 465 : mode === 'plain' ? 25 : 587));
const user = E.MX_SMTP_USERNAME || '';
const pass = E.MX_SMTP_PASSWORD || '';
const from = E.MX_MAIL_FROM || '';
const ADDRESS = /^[A-Za-z0-9._%+=-]{1,64}@[A-Za-z0-9.-]{1,253}$/;
const TIMEOUT_MS = 20_000;

function done(code, why) {
  if (why) process.stderr.write(`${String(why).replace(/[\r\n]+/g, ' ').slice(0, 300)}\n`);
  process.stdout.write(`${code}\n`);
  process.exit(code === 'sent' ? 0 : 1);
}

if (!host) done('not_set', 'no mail server is set (mail.smtp.host)');
if (!ADDRESS.test(to)) done('protocol_error', 'not an address to send to');
if (!ADDRESS.test(from)) done('protocol_error', 'the sender is not an address');

let sock;
let buf = '';
let waiting = null;
const lines = [];

/** The next whole reply: its code and text (a multi-line reply ends at "NNN "). */
function reply() {
  return new Promise((resolve) => {
    const take = () => {
      const i = lines.findIndex((l) => /^\d{3} /.test(l) || /^\d{3}$/.test(l));
      if (i < 0) return false;
      const all = lines.splice(0, i + 1);
      resolve({ code: Number(all[i].slice(0, 3)), text: all.map((l) => l.slice(4)).join(' ') });
      return true;
    };
    if (!take()) waiting = take;
  });
}
function attach(s) {
  sock = s;
  s.setTimeout(TIMEOUT_MS, () => done('unreachable', 'the mail server stopped answering'));
  s.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
    if (waiting && waiting()) waiting = null;
  });
  s.on('error', (e) => done(e && e.code && /CERT|TLS|SSL|ERR_SSL/.test(String(e.code)) ? 'tls_failed' : 'unreachable', e && e.message));
}
const say = (line) => sock.write(`${line}\r\n`);
async function cmd(line, okCodes, failCode) {
  say(line);
  const r = await reply();
  if (!okCodes.includes(r.code)) done(failCode, `${r.code} ${r.text}`);
  return r;
}

async function main() {
  const opened = await new Promise((resolve) => {
    const s = mode === 'tls'
      ? tls.connect({ host, port, servername: host }, () => resolve(s))
      : net.connect({ host, port }, () => resolve(s));
    attach(s);
  });
  void opened;
  const hello = await reply();
  if (hello.code !== 220) done('protocol_error', `${hello.code} ${hello.text}`);
  await cmd('EHLO blackbranch.local', [250], 'protocol_error');
  if (mode === 'starttls') {
    await cmd('STARTTLS', [220], 'tls_failed');
    const plain = sock;
    plain.removeAllListeners('data');
    await new Promise((resolve) => {
      const s = tls.connect({ socket: plain, servername: host }, () => resolve());
      attach(s);
    });
    await cmd('EHLO blackbranch.local', [250], 'protocol_error');
  }
  if (user) {
    await cmd(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`).toString('base64')}`, [235], 'auth_refused');
  }
  await cmd(`MAIL FROM:<${from}>`, [250], 'sender_refused');
  await cmd(`RCPT TO:<${to}>`, [250, 251], 'recipient_refused');
  await cmd('DATA', [354], 'data_refused');
  const date = new Date().toUTCString();
  const body = [
    `From: <${from}>`, `To: <${to}>`, `Date: ${date}`,
    'Subject: A test message from your Black Branch install',
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '',
    'This is the test message `blackbranch mail test` sends. If it reached you, the sign-in service',
    'can send password recovery and address checks through the same mail server.', '',
  ].join('\r\n');
  await cmd(`${body}\r\n.`, [250], 'data_refused');
  // The message is accepted; a polite goodbye, not waited on for long.
  say('QUIT');
  await Promise.race([reply(), new Promise((r) => setTimeout(r, 2000))]);
  done('sent');
}

main().catch((e) => done('protocol_error', e instanceof Error ? e.message : String(e)));
