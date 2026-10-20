// The settings layer's security posture:
//   1. Secret routes take the bearer secret ONLY — 127.0.0.1 is not enough, because everything
//      co-located on the host is 127.0.0.1 (other services, local tools, an SSRF in a
//      co-located process).
//   2. A browser request never reaches them, secret or not.
//   3. Control frames reach ONLY sockets that authenticated with the secret at upgrade — never
//      a browser or an overlay.
// Run: node --test instance-config-security.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const { createAuth } = require('./auth');
const { createWsHub } = require('./ws-hub');

const quiet = { warn() {}, error() {}, exit() {} };
const auth = createAuth({ env: { STREAM_API_SECRET: 'the-secret', STREAM_API_ENFORCE: '1' }, ...quiet });

function req({ ip = '127.0.0.1', headers = {} } = {}) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { method: 'GET', path: '/config/secrets', socket: { remoteAddress: ip }, get: (n) => h[n.toLowerCase()] };
}
function run(mw, r) {
  let status = null; let passed = false;
  const res = { status(s) { status = s; return this; }, json() { return this; } };
  mw(r, res, () => { passed = true; });
  return passed ? 'next' : status;
}

test('localhost WITHOUT the secret: requireInternal lets it in, requireSecret does not', () => {
  assert.equal(run(auth.requireInternal, req()), 'next', 'premise: the allowlist trusts 127.0.0.1');
  assert.equal(run(auth.requireSecret, req()), 401);
  assert.equal(run(auth.requireSecret, req({ headers: { authorization: 'Bearer wrong-secret' } })), 401);
  assert.equal(run(auth.requireSecret, req({ ip: '10.0.0.9', headers: { authorization: 'Bearer the-secret' } })), 'next');
});

test('a browser request is refused even WITH the secret (Sec-Fetch-Site, any value)', () => {
  for (const site of ['same-origin', 'same-site', 'cross-site', 'none']) {
    assert.equal(run(auth.requireSecret, req({ headers: { authorization: 'Bearer the-secret', 'sec-fetch-site': site } })), 403, site);
  }
});

test('no secret configured: the routes are closed, whatever STREAM_API_ENFORCE says', () => {
  const open = createAuth({ env: { STREAM_API_ENFORCE: '0' }, ...quiet });
  assert.equal(run(open.requireInternal, req({ ip: '8.8.8.8' })), 'next', 'premise: enforcement off opens requireInternal');
  assert.equal(run(open.requireSecret, req({ headers: { authorization: 'Bearer ' } })), 401);
});

test('control frames go to internal sockets only; broadcasts still go to everyone', async (t) => {
  const server = http.createServer();
  const hub = createWsHub({ server, isInternalUpgrade: auth.isInternalUpgrade });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${server.address().port}`;
  const open = (opts) => new Promise((res, rej) => {
    const ws = new WebSocket(url, opts);
    const got = [];
    ws.on('message', (m) => got.push(JSON.parse(m.toString())));
    ws.on('open', () => res({ ws, got }));
    ws.on('error', rej);
  });
  const internal = await open({ headers: { Authorization: 'Bearer the-secret' } });
  const browser = await open({ headers: { Origin: 'https://site.example', 'Sec-Fetch-Site': 'cross-site', Authorization: 'Bearer the-secret' } });
  const viewer = await open({});
  t.after(() => { for (const c of [internal, browser, viewer]) c.ws.terminate(); hub.wss.close(); server.close(); });
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(hub.sendInternal({ type: 'config_test', key: 'openai.apiKey', nonce: 'n' }), 1, 'exactly one internal socket');
  hub.broadcast({ type: 'badges_changed' });
  await new Promise((r) => setTimeout(r, 100));
  // Every socket first hears the hub's verdict on it (ws-hub.js hello) — a browser-shaped upgrade
  // carrying the secret is told it is NOT internal.
  assert.deepEqual([internal, browser, viewer].map((c) => c.got[0]), [
    { type: 'hello', internal: true }, { type: 'hello', internal: false }, { type: 'hello', internal: false }]);
  const types = (c) => c.got.slice(1).map((f) => f.type);
  assert.deepEqual(types(internal), ['config_test', 'badges_changed']);
  assert.deepEqual(types(viewer), ['badges_changed'], 'a viewer must never see a control frame');
  assert.deepEqual(types(browser), ['badges_changed'], 'a browser-shaped upgrade is never internal, even carrying the secret');
});
