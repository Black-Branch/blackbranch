// GET /health: the body, the 120 s grace for a starting reader, and the real server.
// Run: node --test lib/health.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { healthBody, startHealthServer } from './health.js';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
const r = (state, msAgo = 0, error = '') => ({ state, since: at(msAgo), error });
const only = (...names) => (n) => names.includes(n);
const quiet = { log() {}, error() {} };

test('ok = every chosen reader running, or starting for under 120 s; an unchosen one never counts', () => {
  const readers = { twitch: r('running', 5_000), kick: r('starting', 30_000), youtube: r('failed', 60_000, 'browser missing: x'), streamplace: r('off') };
  assert.equal(healthBody({ readers, wanted: only('twitch', 'kick'), bot: false, now: NOW }).ok, true);
  assert.equal(healthBody({ readers, wanted: only('twitch', 'kick', 'youtube'), bot: false, now: NOW }).ok, false, 'a failed reader');
  assert.equal(healthBody({ readers: { ...readers, kick: r('starting', 121_000) }, wanted: only('kick'), bot: false, now: NOW }).ok, false, 'starting for over 120 s');
  assert.equal(healthBody({ readers, wanted: () => false, bot: false, now: NOW }).ok, true, 'nothing set up is healthy');
  const body = healthBody({ readers, wanted: only('twitch'), bot: true, now: NOW });
  assert.equal(body.bot, 'running');
  assert.deepEqual(body.readers.youtube, { state: 'failed', since: at(60_000), error: 'browser missing: x' });
});

test('the real server: GET /health answers the snapshot as JSON; anything else is 404', async () => {
  const s = startHealthServer({ snapshot: () => ({ ok: true, readers: {}, bot: 'off' }), port: 0, host: '127.0.0.1', log: quiet });
  const port = await s.ready;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), { ok: true, readers: {}, bot: 'off' });
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`, { method: 'POST' })).status, 404);
  } finally { await s.stop(); }
});

test('a port already taken: one error line, no crash, and the process keeps its readers', async () => {
  const blocker = createServer();
  await new Promise((res) => blocker.listen(0, '127.0.0.1', res));
  const lines = [];
  const s = startHealthServer({ snapshot: () => ({}), port: blocker.address().port, host: '127.0.0.1', log: { log() {}, error: (l) => lines.push(l) } });
  try {
    assert.equal(await s.ready, null);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[health\] cannot listen on 127\.0\.0\.1:\d+ \(EADDRINUSE\)/);
  } finally {
    await s.stop();
    await new Promise((res) => blocker.close(res));
  }
});

test('the compose healthcheck command exits 0 on ok and 1 otherwise — run for real', async () => {
  const { spawn } = await import('node:child_process');
  for (const ok of [true, false]) {
    const s = startHealthServer({ snapshot: () => ({ ok, readers: {}, bot: 'off' }), port: 0, host: '127.0.0.1', log: quiet });
    const port = await s.ready;
    try {
      const code = await new Promise((res) => {
        const p = spawn(process.execPath, ['-e', `fetch('http://127.0.0.1:${port}/health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1),()=>process.exit(1))`]);
        p.on('exit', res);
      });
      assert.equal(code, ok ? 0 : 1);
    } finally { await s.stop(); }
  }
});

test('the health server binds to localhost unless INGEST_HEALTH_BIND says otherwise (the bundle sets 0.0.0.0 for the website; a systemd install stays off the LAN)', async () => {
  const had = process.env.INGEST_HEALTH_BIND; delete process.env.INGEST_HEALTH_BIND;
  const s = startHealthServer({ snapshot: () => ({ ok: true, readers: {}, bot: 'off' }), port: 0, log: quiet });
  try {
    const port = await s.ready;
    assert.ok(port, 'bound');
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    // the server object is not exposed; the address it reports is what we can hold: the loopback name
    assert.equal(s.host, '127.0.0.1');
  } finally { await s.stop(); if (had !== undefined) process.env.INGEST_HEALTH_BIND = had; }
});

// ── Task 10: per-platform liveness for admins and the Doctor ──────────────────────────────────────
// /health carries every platform's state from the poller (getPlatformStates): ISO times, the evidence
// code, the miss count, and `stale` — the vocabulary's one stale rule (staleAnswer), computed HERE so
// the Doctor (which imports nothing) only reads a boolean.
const S = 15 * 60_000;
const st = (state, o = {}) => ({ state, since: NOW - 60_000, lastAnswerAt: NOW - 30_000, misses: 0, key: 'k-1', evidence: 'helix-live', scheduledStart: null, ...o });

test('healthBody carries liveness: every platform, ISO times, the code, the count; not configured is null; no key', () => {
  const body = healthBody({ readers: {}, wanted: () => false, bot: false, now: NOW,
    liveness: { twitch: st('live'), youtube: st('upcoming', { evidence: 'upcoming', scheduledStart: NOW + 3_600_000, lastAnswerAt: null }), kick: null } });
  assert.deepEqual(Object.keys(body.liveness), ['twitch', 'kick', 'youtube', 'streamplace']);
  assert.deepEqual(body.liveness.twitch, { state: 'live', since: at(60_000), lastAnswerAt: at(30_000), scheduledStart: null, evidence: 'helix-live', misses: 0, stale: false });
  assert.equal(body.liveness.youtube.scheduledStart, new Date(NOW + 3_600_000).toISOString());
  assert.equal(body.liveness.youtube.lastAnswerAt, null);
  assert.equal(body.liveness.kick, null);
  assert.equal(body.liveness.streamplace, null, 'a platform the poller never named is not configured');
  assert.ok(!JSON.stringify(body).includes('k-1'), 'the broadcast key never leaves the poller');
  assert.equal(body.ok, true, 'liveness never changes ok (that is the readers\' verdict)');
});

test('/health carries stale: fresh, stale, never answered with an old since, never answered with a recent since', () => {
  const stale = (s) => healthBody({ readers: {}, wanted: () => false, bot: false, now: NOW, liveness: { twitch: s } }).liveness.twitch.stale;
  assert.equal(stale(st('live', { lastAnswerAt: NOW - 1000 })), false, 'fresh');
  assert.equal(stale(st('unknown', { evidence: 'helix-error', lastAnswerAt: NOW - S - 1 })), true, 'stale');
  assert.equal(stale(st('unknown', { evidence: 'helix-error', lastAnswerAt: null, since: NOW - S - 1 })), true, 'never answered, old since');
  assert.equal(stale(st('unknown', { evidence: 'helix-error', lastAnswerAt: null, since: NOW - 1000 })), false, 'never answered, recent since');
});

test('restart + retry: no states yet (a poller that has not ticked, or POLLER_ENABLED=0) is every platform null; the same input twice is the same body', () => {
  const empty = healthBody({ readers: {}, wanted: () => false, bot: false, now: NOW });
  assert.deepEqual(empty.liveness, { twitch: null, kick: null, youtube: null, streamplace: null });
  const input = { readers: {}, wanted: () => false, bot: false, now: NOW, liveness: { twitch: st('live') } };
  assert.deepEqual(healthBody(input), healthBody(input));
});

test('the real server serves liveness as JSON', async () => {
  const s = startHealthServer({ snapshot: () => healthBody({ readers: {}, wanted: () => false, bot: false, now: NOW, liveness: { kick: st('offline', { evidence: 'kick-not-live' }) } }), port: 0, host: '127.0.0.1', log: quiet });
  const port = await s.ready;
  try {
    const j = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(j.liveness.kick.state, 'offline');
    assert.equal(j.liveness.kick.evidence, 'kick-not-live');
    assert.equal(j.liveness.kick.stale, false);
  } finally { await s.stop(); }
});

test('index.js hands /health the poller\'s states (scan, anchored at the end of index.js)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ startPoller, getPlatformStates \} from '\.\/lib\/poller\.js';/);
  assert.match(src, /healthBody\(\{[^}]*liveness: getPlatformStates\(\)/);
  assert.match(src, /\nmain\(\)\.catch\(\(err\) => \{\n[^\n]*\n[^\n]*\n\}\);\n$/, 'the scan read to the end of index.js');
});
