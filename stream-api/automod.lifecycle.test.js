// Automod's held-row retention timer (automod.js start/stop), with the timers and the pool faked:
// started with the module, first prune a minute after boot, then every 24 h, both unref'd so
// they never hold the process open, a failed prune logged and never thrown, stop clears both.
// automod.db.test.js runs the same timer for real against Postgres.
// Run: node --test automod.lifecycle.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createAutomod, AUTOMOD_HELD_RETENTION_DAYS } = require('./automod');

function fakeTimers() {
  const made = [];
  const mk = (kind) => (fn, ms) => {
    const t = { kind, fn, ms, unrefd: false, cleared: false, unref() { this.unrefd = true; return this; } };
    made.push(t);
    return t;
  };
  return {
    made,
    setTimeout: mk('timeout'), setInterval: mk('interval'),
    clearTimeout: (t) => { if (t) t.cleared = true; }, clearInterval: (t) => { if (t) t.cleared = true; },
  };
}
const config = { get: () => null };

test('start schedules the prune a minute after boot, then every 24 h, both unref’d', async () => {
  const timers = fakeTimers();
  const queries = [];
  const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rowCount: 2 }; } };
  const am = createAutomod({ pool, ai: {}, config, log: { log() {}, warn() {} }, timers });
  am.start();
  const first = timers.made.find((t) => t.kind === 'timeout');
  assert.ok(first, 'no prune was scheduled on start');
  assert.equal(first.ms, 60_000);
  assert.ok(first.unrefd, 'the first prune holds the process open');
  await first.fn();
  const prune = queries.find((q) => /DELETE FROM site\.automod_held/.test(q.sql));
  assert.ok(prune, 'the first run did not prune');
  assert.match(prune.sql, /held_at < now\(\) - make_interval\(days => \$1::int\)/);
  assert.deepEqual(prune.params, [AUTOMOD_HELD_RETENTION_DAYS]);
  assert.doesNotMatch(prune.sql, /status|source/, 'the prune is limited by status or source — it must apply whatever their status');
  const daily = timers.made.find((t) => t.kind === 'interval' && t.ms === 24 * 60 * 60 * 1000);
  assert.ok(daily, 'no daily prune after the first');
  assert.ok(daily.unrefd, 'the daily prune holds the process open');
  const sweep = queries.findIndex((q) => /DELETE FROM site\.user_marks/.test(q.sql));
  assert.ok(sweep > queries.indexOf(prune), 'the first run did not sweep the marks AFTER the held rows');
  queries.length = 0;
  await daily.fn();
  assert.ok(queries.some((q) => /DELETE FROM site\.automod_held/.test(q.sql)), 'the daily run did not prune');
  assert.ok(queries.some((q) => /DELETE FROM site\.user_marks/.test(q.sql)), 'the daily run did not sweep the marks');
  am.stop();
  assert.ok(first.cleared && daily.cleared, 'stop left a prune timer running');
});

test('restart: after stop(), a new instance\'s start() registers both timers again and its runs sweep the marks', async () => {
  const pool = { query: async () => ({ rowCount: 0 }) };
  const old = fakeTimers();
  const before = createAutomod({ pool, ai: {}, config, log: { log() {}, warn() {} }, timers: old });
  before.start();
  before.stop();
  assert.ok(old.made.filter((t) => t.kind === 'timeout').every((t) => t.cleared), 'stop left the first run pending');
  const timers = fakeTimers();
  const queries = [];
  const after = createAutomod({ pool: { query: async (sql) => { queries.push(sql); return { rowCount: 0 }; } }, ai: {}, config, log: { log() {}, warn() {} }, timers });
  after.start();
  const first = timers.made.find((t) => t.kind === 'timeout' && t.ms === 60_000);
  assert.ok(first && first.unrefd, 'the restarted instance did not register the first run');
  await first.fn();
  assert.ok(queries.some((q) => /DELETE FROM site\.user_marks/.test(q)), 'the restarted first run did not sweep the marks');
  const daily = timers.made.find((t) => t.kind === 'interval' && t.ms === 24 * 60 * 60 * 1000);
  assert.ok(daily, 'the restarted instance did not register the daily run');
  queries.length = 0;
  await daily.fn();
  assert.ok(queries.some((q) => /DELETE FROM site\.user_marks/.test(q)), 'the restarted daily run did not sweep the marks');
  after.stop();
});

test('a failed prune is logged, never thrown', async () => {
  const timers = fakeTimers();
  const warned = [];
  const pool = { query: async () => { throw new Error('db down'); } };
  const am = createAutomod({ pool, ai: {}, config, log: { log() {}, warn: (m) => warned.push(m) }, timers });
  am.start();
  const first = timers.made.find((t) => t.kind === 'timeout');
  await assert.doesNotReject(async () => { await first.fn(); });
  assert.ok(warned.some((m) => /prune failed: db down/.test(m)), `nothing logged: ${JSON.stringify(warned)}`);
  assert.ok(timers.made.some((t) => t.kind === 'interval' && t.ms === 24 * 60 * 60 * 1000), 'one failure stopped the daily prune');
  am.stop();
});

test('stream-api starts automod at boot, so the timer runs on every install', () => {
  const src = readFileSync(join(__dirname, 'index.js'), 'utf8');
  assert.match(src, /const automod = createAutomod\(/);
  assert.match(src, /\nautomod\.start\(\{ content \}\);\n/);
  assert.ok(src.length > 10_000, 'vacuity: index.js read whole');
});
