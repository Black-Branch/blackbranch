// Banned chatters at the chat door (ban-hold.js).
//
// Without a ban check in POST /chat, the site shows a banned platform chatter (a spamming bot, say)
// for seconds, until the PLATFORM's own ban lands. These tests run the real POST /chat handler and
// the real hold against a fake pool.
//
// Run: node --test ban-hold.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createChat } = require('./chat');
const { createBanHold, PLATFORM_HOLD_MS } = require('./ban-hold');
const { _resetIngestPause } = require('./ingest-pause');

const KICK_BOT = 'aaaaaaaaaaaa';   // a platform-only chatter's canonical id
const LINKED = 'bbbbbbbbbbbb';     // the canonical of a site account's linked platform identity
const quiet = { warn() {}, log() {}, error() {} };

/** site.bans / site.mod_log / the link tables as rows the fake pool answers from. */
function db() {
  const state = { bans: [], modLog: [], links: { '@casey:site.test': [LINKED] }, queries: [] };
  const pool = {
    query: async (sql, params) => {
      state.queries.push(sql);
      if (/FROM site\.bans b/.test(sql)) {
        return { rows: state.bans.flatMap((b) => (state.links[b.matrix_id] || []).map((c) => ({ canonical: c, expires_at: b.expires_at }))) };
      }
      if (/FROM site\.mod_log/.test(sql)) return { rows: state.modLog };
      if (/FROM site\.platform_links WHERE matrix_id = ANY/.test(sql)) {
        return { rows: params[0].flatMap((m) => (state.links[m] || []).map((c) => ({ canonical: c }))) };
      }
      if (/FROM site\.lockdown_now/.test(sql)) return { rows: [{ ingest_paused: [], min_account_age_days: 0 }] };
      return { rows: [{ id: 1 }], rowCount: 1 };
    },
  };
  return { state, pool };
}

function chatWith({ pool, banHold, canonical }) {
  _resetIngestPause();
  const broadcasts = [];
  const chat = createChat({
    pool, banHold, resolveOrCreate: async () => canonical, resolveCanonical: async () => null,
    pollEngine: { active: () => false, vote: async () => {} }, msgBuffer: [], broadcast: (f) => broadcasts.push(f), bufferPush: () => {},
  });
  const routes = {};
  const reg = (method) => (p, ...h) => { routes[`${method} ${p}`] = h[h.length - 1]; };
  chat.registerChatRoutes(
    { post: reg('POST'), get: reg('GET'), patch: reg('PATCH'), delete: reg('DELETE'), put: reg('PUT') },
    { requireInternal: (req, res, next) => next(), wrap: (fn) => fn },
  );
  const post = async (over = {}) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await routes['POST /chat']({ body: { platform: 'kick', userId: 'k1', username: 'spambot', message: 'buy followers', ...over }, ip: '127.0.0.1' }, res);
    await new Promise((r) => setImmediate(r));
    return res;
  };
  return { post, broadcasts };
}

function holdRoute(banHold) {
  const routes = {};
  banHold.registerBanHoldRoutes(
    { post: (p, ...h) => { routes[p] = h; } },
    { requireInternal: 'requireInternal', wrap: (fn) => fn },
  );
  assert.equal(routes['/chat/ban'][0], 'requireInternal', 'POST /chat/ban is not behind requireInternal');
  return async (body) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await routes['/chat/ban'].at(-1)({ body }, res);
    return res;
  };
}

test('THE BUG: a banned Kick chatter\'s next line is dropped the moment web pushes the ban — not stored, not shown', async () => {
  const { pool, state } = db();
  const banHold = createBanHold({ pool, log: quiet });
  const chat = chatWith({ pool, banHold, canonical: KICK_BOT });
  const before = await chat.post();
  assert.notEqual(before.body?.reason, 'banned', 'premise: not banned yet, the line goes out');

  const res = await holdRoute(banHold)({ canonicalId: KICK_BOT, expiresAt: null });
  assert.equal(res.statusCode, 200);
  state.queries.length = 0;
  const after = await chat.post({ message: 'buy followers again' });
  assert.deepEqual(after.body, { ok: true, filtered: true, reason: 'banned' });
  assert.ok(!state.queries.some((q) => /INSERT INTO stream\.chat_log/.test(q)), 'a banned line was stored');
  assert.ok(!chat.broadcasts.some((f) => f.message === 'buy followers again'), 'a banned line was broadcast');
});

test('an unban lifts the hold at once, and the site\'s own chat is never held here', async () => {
  const { pool } = db();
  const banHold = createBanHold({ pool, log: quiet });
  const push = holdRoute(banHold);
  await push({ canonicalId: KICK_BOT });
  const chat = chatWith({ pool, banHold, canonical: KICK_BOT });
  assert.equal((await chat.post()).body.reason, 'banned');
  assert.notEqual((await chat.post({ platform: 'native' })).body?.reason, 'banned', 'the native path is web\'s to refuse');
  await push({ canonicalId: KICK_BOT, lift: true });
  assert.notEqual((await chat.post()).body?.reason, 'banned', 'an unban did not lift the hold');
});

test('a platform-only ban holds for the bridge window, then the platform\'s own ban is what holds', async () => {
  let clock = 1_000_000;
  const { pool } = db();
  const banHold = createBanHold({ pool, log: quiet, now: () => clock });
  await holdRoute(banHold)({ canonicalId: KICK_BOT, expiresAt: null });
  assert.equal(banHold.isHeld(KICK_BOT), true);
  clock += PLATFORM_HOLD_MS - 1;
  assert.equal(banHold.isHeld(KICK_BOT), true);
  clock += 2;
  assert.equal(banHold.isHeld(KICK_BOT), false, 'a platform-only hold outlived its bridge — a second ban list the platform cannot see');
});

test('a site ban holds every linked identity until it expires; a timeout ends on time', async () => {
  let clock = Date.parse('2026-10-20T12:00:00Z');
  const { pool } = db();
  const banHold = createBanHold({ pool, log: quiet, now: () => clock });
  const push = holdRoute(banHold);
  const r = await push({ matrixIds: ['@casey:site.test'], expiresAt: '2026-10-20T13:00:00Z' });
  assert.deepEqual(r.body, { ok: true, lifted: false, identities: 1 });
  assert.equal(banHold.isHeld(LINKED), true);
  clock = Date.parse('2026-10-20T12:59:59Z');
  assert.equal(banHold.isHeld(LINKED), true, 'released before the timeout ended');
  clock = Date.parse('2026-10-20T13:00:01Z');
  assert.equal(banHold.isHeld(LINKED), false, 'held past the timeout');
});

test('RESTART: the holds are rebuilt from site.bans and the bridge window of site.mod_log; an unban as the last action is not held', async () => {
  const clock = Date.parse('2026-10-20T12:00:00Z');
  const { pool, state } = db();
  state.bans = [{ matrix_id: '@casey:site.test', expires_at: null }];
  state.modLog = [
    { target_id: KICK_BOT, action: 'ban', expires_at: null, created_at: new Date(clock - 60_000).toISOString() },
    { target_id: 'cccccccccccc', action: 'unban', expires_at: null, created_at: new Date(clock - 30_000).toISOString() },
  ];
  // A fresh process: nothing pushed, everything from the database.
  const banHold = createBanHold({ pool, log: quiet, now: () => clock });
  await banHold.refresh();
  assert.equal(banHold.isHeld(LINKED), true, 'a site ban was lost across the restart');
  assert.equal(banHold.isHeld(KICK_BOT), true, 'a platform-only ban inside its bridge was lost across the restart');
  assert.equal(banHold.isHeld('cccccccccccc'), false, 'an unbanned chatter was held');
  assert.ok(state.queries.some((q) => /now\(\) - make_interval\(secs => \$1\)/.test(q)), 'the mod_log read is not bounded to the bridge window');
});

test('RETRY: a rebuild that read the database before an unban push does not put the hold back', async () => {
  let release;
  const { pool, state } = db();
  state.bans = [{ matrix_id: '@casey:site.test', expires_at: null }];
  const slow = { query: async (sql, params) => {
    if (/FROM site\.bans b/.test(sql)) { const rows = await pool.query(sql, params); await new Promise((r) => { release = r; }); return rows; }
    return pool.query(sql, params);
  } };
  const banHold = createBanHold({ pool: slow, log: quiet });
  await holdRoute(banHold)({ matrixIds: ['@casey:site.test'] });
  const rebuilding = banHold.refresh();         // reads "banned"…
  await new Promise((r) => setImmediate(r));
  await holdRoute(banHold)({ matrixIds: ['@casey:site.test'], lift: true }); // …the unban lands meanwhile
  release();
  await rebuilding;
  assert.equal(banHold.isHeld(LINKED), false, 'the rebuild undid an unban that landed while it read');
});

test('the drain: stop() awaits a running rebuild and no rebuild starts after it', async () => {
  const { pool, state } = db();
  let ticks = null;
  const banHold = createBanHold({ pool, log: quiet, schedule: (fn) => { ticks = fn; return 1; }, cancel: () => {} });
  banHold.start();
  await banHold.stop();
  const n = state.queries.length;
  await ticks();
  assert.equal(state.queries.length, n, 'a rebuild ran after stop() — against a pool the drain is ending');
});

test('wiring: index.js builds one hold, registers POST /chat/ban, starts it, hands it to chat and stops it before pool.end()', () => {
  const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  assert.match(src, /const banHold = require\('\.\/ban-hold'\)\.createBanHold\(\{ pool \}\);/);
  assert.match(src, /banHold\.registerBanHoldRoutes\(app, \{ requireInternal, wrap \}\);/);
  assert.match(src, /banHold\.start\(\);/);
  assert.match(src, /createChat\(\{ pool, resolveOrCreate, resolveCanonical, pronouns, banHold, pollEngine,/);
  const iStop = src.indexOf('await banHold.stop()');
  assert.ok(iStop > 0 && iStop < src.indexOf('await pool.end()'), 'the hold\'s rebuild is not stopped before the pool ends');
  const chatSrc = fs.readFileSync(path.join(__dirname, 'chat.js'), 'utf8');
  assert.match(chatSrc, /banHold\.isHeld\(canonicalId\)/, 'POST /chat no longer asks the hold');
  assert.match(chatSrc.slice(-120), /module\.exports = \{ createChat \};\s*$/, 'END anchor: chat.js read whole');
});

test('bad pushes are refused in words, and nothing is held', async () => {
  const { pool } = db();
  const banHold = createBanHold({ pool, log: quiet });
  const push = holdRoute(banHold);
  for (const body of [{}, null, { canonicalId: 'not-hex' }, { matrixIds: ['nobody'] }, { canonicalId: KICK_BOT, expiresAt: 'soon' }]) {
    const r = await push(body);
    assert.equal(r.statusCode, 400, `accepted ${JSON.stringify(body)}`);
    assert.match(r.body.error, /\w+/);
  }
  assert.equal(banHold.size(), 0);
});
