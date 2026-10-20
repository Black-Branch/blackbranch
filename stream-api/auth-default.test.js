// FAIL-CLOSED GUARD for requireInternal.
//
// stream-api sits behind a public Cloudflare Tunnel. requireInternal is the ONLY
// thing standing between api.site.test and every internal route — support-bar
// credits, moderation, identity resolution, the Gadget config endpoints.
//
// What this pins: enforcement is the DEFAULT. An opt-in flag would leave the
// hole closed only by configuration, and configuration is precisely what does
// not survive a fresh deploy, a restored box, or a dropped .env — and the
// failure is silent: the service starts, logs a warning nobody reads, and
// serves the tunnel.
//
// auth.js is a parameterized factory, so the invariants are exercised for real:
// fake env in, observed behavior out.
//
// Run: node --test auth-default.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuth } = require('./auth');

const quiet = { warn: () => {}, error: () => {} };

// Fake req/res: capture what requireInternal actually does with a caller.
function fakeReq({ ip = '203.0.113.9', authorization = '', secFetchSite = '' } = {}) {
  const headers = { authorization, 'sec-fetch-site': secFetchSite };
  return {
    method: 'POST',
    path: '/chat/event',
    socket: { remoteAddress: ip },
    get: (h) => headers[h.toLowerCase()] || '',
  };
}
function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
function run(auth, reqOpts) {
  const req = fakeReq(reqOpts), res = fakeRes();
  let nexted = false;
  auth.requireInternal(req, res, () => { nexted = true; });
  return { res, nexted };
}

test('enforcement is opt-OUT, not opt-in — absent config must enforce', () => {
  // Unset: enforced. '1': enforced. Anything but the explicit '0': enforced.
  assert.equal(createAuth({ env: { STREAM_API_SECRET: 's' }, ...quiet }).ENFORCE_AUTH, true,
    'with STREAM_API_ENFORCE unset the service fails OPEN and every internal route ' +
    'answers anyone who can reach the public tunnel — the default must enforce');
  assert.equal(createAuth({ env: { STREAM_API_SECRET: 's', STREAM_API_ENFORCE: '1' }, ...quiet }).ENFORCE_AUTH, true);
  assert.equal(createAuth({ env: { STREAM_API_SECRET: 's', STREAM_API_ENFORCE: 'yes' }, ...quiet }).ENFORCE_AUTH, true);
  assert.equal(createAuth({ env: { STREAM_API_SECRET: 's', STREAM_API_ENFORCE: '0' }, ...quiet }).ENFORCE_AUTH, false,
    'the explicit local-dev escape hatch must still work');
});

test('the deny path returns 401 and does NOT fall through to next()', () => {
  const auth = createAuth({ env: { STREAM_API_SECRET: 'topsecret' }, ...quiet });
  const { res, nexted } = run(auth, { ip: '203.0.113.9' });          // tunnel-ish stranger
  assert.equal(res.statusCode, 401, 'the enforced branch no longer rejects');
  assert.deepEqual(res.body, { error: 'unauthorized' });
  assert.equal(nexted, false, 'the enforced branch calls next() — it is not denying');

  // Wrong secret is the same as no secret.
  const bad = run(auth, { authorization: 'Bearer wrong' });
  assert.equal(bad.res.statusCode, 401);
  assert.equal(bad.nexted, false);
});

test('the trusted paths still exist (the guard cannot be satisfied by denying everything)', () => {
  const auth = createAuth({ env: { STREAM_API_SECRET: 'topsecret' }, ...quiet });

  // Shared-secret path — this is how a peer host (the tunnel connector) authenticates; lose it and the site goes dark.
  const bySecret = run(auth, { authorization: 'Bearer topsecret' });
  assert.equal(bySecret.nexted, true, 'the shared-secret path is gone — a peer host would be locked out');
  assert.equal(bySecret.res.statusCode, null);

  // Internal-IP path — co-located local services carry no secret.
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const byIp = run(auth, { ip });
    assert.equal(byIp.nexted, true, `the internal-IP path is gone for ${ip} — local services would be locked out`);
  }

  // A LAN peer — the tunnel connector's host, say — must NEVER be IP-trusted: it is spoof-reachable.
  assert.equal(auth.INTERNAL_IPS.has('10.0.0.9'), false,
    'a LAN peer such as the tunnel egress; trusting it by IP reopens the tunnel hole');
});

test('the IP allowlist is loopback ONLY — the whole set, not just membership', () => {
  // Pinned as an exact set on purpose. A `has(x) === true` test cannot see an
  // ADDITION, and every entry here is an unconditional grant of every internal
  // route (money, moderation, identity, Gadget config) to anything that can
  // source from that address.
  //
  // The failure mode this pin exists to catch is not a wrong entry but a STALE
  // one: an address kept for a retired host comes back to life the moment any
  // unrelated machine takes it.
  const auth = createAuth({ env: { STREAM_API_SECRET: 'topsecret' }, ...quiet });
  assert.deepEqual(
    [...auth.INTERNAL_IPS].sort(),
    ['::1', '::ffff:127.0.0.1', '127.0.0.1'].sort(),
    'the internal-IP allowlist changed — every entry is a full grant, so this must be deliberate'
  );
});

test('a cross-site browser request never rides the IP allowlist', () => {
  // The CSRF shape: a browser runs on the same machine, so a hostile page's form-POST
  // arrives from 127.0.0.1 — IP-trusted. Browsers stamp such requests
  // Sec-Fetch-Site: cross-site; that stamp must beat the allowlist.
  const auth = createAuth({ env: { STREAM_API_SECRET: 'topsecret' }, ...quiet });
  const { res, nexted } = run(auth, { ip: '127.0.0.1', secFetchSite: 'cross-site' });
  assert.equal(res.statusCode, 401, 'a cross-site request from a trusted IP was allowed — CSRF is open again');
  assert.equal(nexted, false);
});

test('non-cross-site fetch metadata (and its absence) still passes the IP allowlist', () => {
  const auth = createAuth({ env: { STREAM_API_SECRET: 'topsecret' }, ...quiet });
  // Server-to-server callers send NO Sec-Fetch-Site; overlay pages and direct
  // navigations send same-origin/none. None of these may be locked out.
  for (const secFetchSite of ['', 'same-origin', 'same-site', 'none']) {
    const { nexted } = run(auth, { ip: '127.0.0.1', secFetchSite });
    assert.equal(nexted, true, `Sec-Fetch-Site: '${secFetchSite || '(absent)'}' from an internal IP must pass`);
  }
});

test('a valid secret wins even on a cross-site-stamped request', () => {
  // The secret is proof of a trusted server, not a browser session — nothing
  // a CSRF page can forge. Header order must not matter.
  const auth = createAuth({ env: { STREAM_API_SECRET: 'topsecret' }, ...quiet });
  const { nexted } = run(auth, { authorization: 'Bearer topsecret', secFetchSite: 'cross-site' });
  assert.equal(nexted, true);
});

test('enforcement disabled (=0) allows but only via the explicit escape hatch', () => {
  const auth = createAuth({ env: { STREAM_API_ENFORCE: '0' }, ...quiet });
  const { res, nexted } = run(auth, { ip: '203.0.113.9' });
  assert.equal(nexted, true);
  assert.equal(res.statusCode, null);
});

test('enforcing with no secret refuses to START rather than half-working', () => {
  // Enforce + no secret is the worst state: IP-trusted localhost keeps working,
  // so the process looks healthy while a peer host (secret-only) 401s and the site
  // goes dark with nothing in the logs pointing at the cause.
  const exits = [];
  createAuth({ env: {}, exit: (c) => exits.push(c), ...quiet });
  assert.deepEqual(exits, [1],
    'the startup check is gone — a deploy that loses STREAM_API_SECRET would boot enforcing ' +
    'and silently lock out the web server instead of failing loudly');

  // ...and the fatal must NOT fire in either legitimate configuration.
  const ok = [];
  createAuth({ env: { STREAM_API_SECRET: 's' }, exit: (c) => ok.push(c), ...quiet });
  createAuth({ env: { STREAM_API_ENFORCE: '0' }, exit: (c) => ok.push(c), ...quiet });
  assert.deepEqual(ok, [], 'startup fatal fires on a valid config');
});

test('the bearer parse is linear: a long run of whitespace with no token is refused at once', () => {
  const auth = createAuth({ env: { STREAM_API_SECRET: 'topsecret' }, ...quiet });
  // `^Bearer\s+(.+)$` backtracked quadratically on this (about 1.3 s at this length).
  const t0 = process.hrtime.bigint();
  const { res, nexted } = run(auth, { authorization: 'Bearer ' + ' '.repeat(50_000) + '\n' });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 401);
  assert.ok(ms < 100, `the parse took ${ms.toFixed(0)} ms`);
  // Whitespace still separates the secret from "Bearer", and only exactly the secret passes.
  assert.equal(run(auth, { authorization: 'bearer \t topsecret' }).nexted, true);
  assert.equal(run(auth, { authorization: 'Bearer topsecret ' }).nexted, false);
  assert.equal(run(auth, { authorization: 'Bearer    ' }).nexted, false);
});
