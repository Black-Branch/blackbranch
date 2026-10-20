// Tests for twitch-app.js — the app-token cache and the profile-image resolver.
//
// The resolver sits on the money path (alert.js dispatch) AND the chat hot path
// (chat.js POST /chat), so the properties that matter are not "does it return a
// URL" but: it NEVER throws, it caches, and a failure costs '' rather than a
// broken alert. Those are what these pin.
//
// Run: node --test twitch-app.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const {
  twitchProfileImage, getAppToken, invalidateAppToken, __resetTwitchAppCaches,
} = require('./twitch-app.js');

const realFetch = global.fetch;
function withFetch(impl, fn) {
  global.fetch = impl;
  return (async () => { try { return await fn(); } finally { global.fetch = realFetch; } })();
}

function env(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  return (async () => {
    try { return await fn(); }
    finally {
      for (const k of Object.keys(vars)) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    }
  })();
}

const CREDS = {
  TWITCH_OAUTH_CLIENT_ID: 'cid', TWITCH_OAUTH_CLIENT_SECRET: 'csec',
  TWITCH_CLIENT_ID: '', TWITCH_CLIENT_SECRET: '',
};
const tokenOk = () => ({ ok: true, status: 200, json: async () => ({ access_token: 't1', expires_in: 3600 }) });
const usersOk = (url) => ({
  ok: true, status: 200,
  json: async () => ({ data: [{ id: '42', profile_image_url: `https://static-cdn.twitch.tv/${url.includes('42') ? 'pic42' : 'other'}.png` }] }),
});

test('resolves a profile image and caches it — one HTTP pair per user', async () => {
  __resetTwitchAppCaches();
  let tokenCalls = 0, userCalls = 0;
  await env(CREDS, () => withFetch(async (url) => {
    if (String(url).includes('oauth2/token')) { tokenCalls++; return tokenOk(); }
    userCalls++; return usersOk(String(url));
  }, async () => {
    assert.equal(await twitchProfileImage('42'), 'https://static-cdn.twitch.tv/pic42.png');
    assert.equal(await twitchProfileImage('42'), 'https://static-cdn.twitch.tv/pic42.png');
    assert.equal(await twitchProfileImage('42'), 'https://static-cdn.twitch.tv/pic42.png');
  }));
  assert.equal(userCalls, 1, 'the cache is what makes this safe on the chat hot path — 3 messages must not be 3 lookups');
  assert.equal(tokenCalls, 1);
});

test('a thrown fetch returns empty string, never a rejection', async () => {
  __resetTwitchAppCaches();
  await env(CREDS, () => withFetch(async () => { throw new Error('ECONNRESET'); }, async () => {
    // If this rejects, an alert or a chat message fails because a PICTURE failed.
    assert.equal(await twitchProfileImage('42'), '');
  }));
});

test('an HTTP error returns empty string, and is negatively cached', async () => {
  __resetTwitchAppCaches();
  let userCalls = 0;
  await env(CREDS, () => withFetch(async (url) => {
    if (String(url).includes('oauth2/token')) return tokenOk();
    userCalls++; return { ok: false, status: 500, json: async () => ({}) };
  }, async () => {
    assert.equal(await twitchProfileImage('42'), '');
    assert.equal(await twitchProfileImage('42'), '');
  }));
  assert.equal(userCalls, 1, 'without a negative cache a Twitch outage means a lookup per message');
});

test('200 with no rows is empty string, not undefined', async () => {
  __resetTwitchAppCaches();
  await env(CREDS, () => withFetch(async (url) => {
    if (String(url).includes('oauth2/token')) return tokenOk();
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  }, async () => {
    const v = await twitchProfileImage('42');
    assert.equal(v, '', 'consumers do `p.userImage || \'\'` and the web checks truthiness — undefined would leak into the payload');
  }));
});

test('no credentials configured is empty string, not a throw', async () => {
  __resetTwitchAppCaches();
  await env({ ...CREDS, TWITCH_OAUTH_CLIENT_ID: '', TWITCH_OAUTH_CLIENT_SECRET: '' },
    () => withFetch(async () => { throw new Error('should not be called'); }, async () => {
      assert.equal(await twitchProfileImage('42'), '');
      assert.equal(await getAppToken(), null, 'no creds is null (a decision for the caller), not an exception');
    }));
});

test('an empty / missing user id short-circuits without any HTTP', async () => {
  __resetTwitchAppCaches();
  await env(CREDS, () => withFetch(async () => { throw new Error('should not be called'); }, async () => {
    assert.equal(await twitchProfileImage(''), '');
    assert.equal(await twitchProfileImage(undefined), '');
    assert.equal(await twitchProfileImage(null), '');
  }));
});

test('a 401 invalidates the token so the next call re-mints', async () => {
  __resetTwitchAppCaches();
  let tokenCalls = 0;
  await env(CREDS, () => withFetch(async (url) => {
    if (String(url).includes('oauth2/token')) { tokenCalls++; return tokenOk(); }
    return { ok: false, status: 401, json: async () => ({}) };
  }, async () => {
    assert.equal(await twitchProfileImage('42'), '');
    __resetTwitchAppCaches();          // clear the negative pic cache, keep the scenario
    assert.equal(await twitchProfileImage('42'), '');
  }));
  assert.equal(tokenCalls, 2, 'a rejected app token must not be reused forever');
});

test('the app token is cached across calls until it expires', async () => {
  __resetTwitchAppCaches();
  let tokenCalls = 0;
  await env(CREDS, () => withFetch(async (url) => {
    if (String(url).includes('oauth2/token')) { tokenCalls++; return tokenOk(); }
    return usersOk(String(url));
  }, async () => {
    await twitchProfileImage('1');
    await twitchProfileImage('2');
    await twitchProfileImage('3');
  }));
  assert.equal(tokenCalls, 1, 'three distinct users, one token mint');
  invalidateAppToken();
});

// ── the point of the whole change ───────────────────────────────────────────

test('no live code path builds a socialstream.ninja URL any more', () => {
  // Each entry carries its own TAIL anchor. This assertion is a NEGATIVE
  // (`!test`), which makes it the most truncation-prone scan in the package:
  // anything that shortens `code` makes it pass, and a scan that has silently
  // deleted the file reports the cleanest possible result.
  const files = [
    ['stream-api', 'alert.js', /buildEventCard \}/],
    ['stream-api', 'chat.js', /module\.exports = \{ createChat \}/],
    ['stream-api', 'twitch-app.js', /__resetTwitchAppCaches,/],
    ['stream-ingest', 'lib/alerts.js', /export function normalizeKickEvent/],
    ['stream-ingest', 'platforms/twitch.js', /sendMessage: onMessage \? null : reply/],
  ];
  for (const [pkg, rel, tailAnchor] of files) {
    const src = readFileSync(join(__dirname, pkg === 'stream-api' ? '.' : '../stream-ingest', rel), 'utf8');
    // Strip comments: every one of these files explains the retirement in prose,
    // and prose naming the host is the record, not a dependency on it.
    //
    // LINE comments FIRST. Stripping blocks first fails silently — a `//`
    // comment containing `/*` reads as an opener and everything to the next
    // `*/` vanishes. chat.js:245 already holds a literal `*/` inside a regex.
    const code = src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(code, tailAnchor,
      `${pkg}/${rel}: the scan lost the END of the file, so the check below would pass ` +
      `vacuously — it only asserts that a string is ABSENT`);
    assert.ok(!/socialstream\.ninja/.test(code),
      `${pkg}/${rel} references api.socialstream.ninja in CODE — a retired product's host is ` +
      `back on the alert or chat path. The vendored mirror may keep the string; nothing live may use it.`);
  }
});

test('stream-ingest overrides the vendored avatarUrl formatter rather than editing the mirror', () => {
  const conn = readFileSync(join(__dirname, '..', 'stream-ingest', 'platforms', 'twitch.js'), 'utf8');
  assert.match(conn, /formatters:\s*\{[^}]*avatarUrl:/,
    'the SSN default avatarUrl is back in play — it points at api.socialstream.ninja for EVERY message');
  const vendored = readFileSync(
    join(__dirname, '..', 'stream-ingest', 'vendor', 'socialstream', 'providers', 'twitch', 'chatClient.js'), 'utf8');
  assert.match(vendored, /socialstream\.ninja/,
    'the vendored mirror was edited in place — VENDOR.md requires it stay a clean upstream copy, ' +
    'which is exactly why the override lives in platforms/twitch.js instead');
});
