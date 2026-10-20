// F2 (review round 5): stream-api's pool had no connection or statement timeout, so a hung
// database (a socket that accepts and never answers, a lock nobody releases) held every request —
// and every money hold — open forever. db-pool.js bounds both and the error handler answers a
// timed-out database 503, not a generic 500 after an unbounded wait.
//
// The hung database here is real: a TCP server that accepts and never says a word.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const express = require('express');
const { Pool } = require('pg');
const { poolOptions, isDbUnavailable, apiErrorHandler, DB_TIMEOUTS } = require('./db-pool');

test('every timeout is set, bounded, and overridable', () => {
  const o = poolOptions({ DB_PASSWORD: 'x' });
  assert.equal(o.connectionTimeoutMillis, DB_TIMEOUTS.connectionTimeoutMillis);
  assert.ok(o.connectionTimeoutMillis > 0 && o.connectionTimeoutMillis <= 10_000);
  assert.ok(o.statement_timeout > 0 && o.statement_timeout <= 120_000);
  assert.ok(o.query_timeout > o.statement_timeout, 'the client-side read timeout must let the server-side one fire first');
  assert.ok(o.idle_in_transaction_session_timeout > 0);
  const tuned = poolOptions({ DB_PASSWORD: 'x', DB_CONNECT_TIMEOUT_MS: '2000', DB_STATEMENT_TIMEOUT_MS: '9000' });
  assert.equal(tuned.connectionTimeoutMillis, 2000);
  assert.equal(tuned.statement_timeout, 9000);
  assert.ok(tuned.query_timeout > 9000);
  // Garbage never turns a bound off.
  const junk = poolOptions({ DB_PASSWORD: 'x', DB_CONNECT_TIMEOUT_MS: '0', DB_STATEMENT_TIMEOUT_MS: 'nope' });
  assert.equal(junk.connectionTimeoutMillis, DB_TIMEOUTS.connectionTimeoutMillis);
  assert.equal(junk.statement_timeout, DB_TIMEOUTS.statement_timeout);
});

test('index.js builds its pool from poolOptions and uses the shared error handler', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8');
  assert.match(src, /new Pool\(poolOptions\(process\.env\)\)/);
  assert.match(src, /app\.use\(apiErrorHandler\)/);
  assert.match(src, /process\.exit/, 'vacuity anchor: the whole file was read'); // the file's tail has the shutdown path
});

test('a HUNG database answers 503 within the connection bound', async (t) => {
  const sockets = new Set();
  const hung = net.createServer((s) => { sockets.add(s); }); // accepts, never answers
  await new Promise((r) => hung.listen(0, '127.0.0.1', r));
  const pool = new Pool({ ...poolOptions({ DB_PASSWORD: 'x', DB_CONNECT_TIMEOUT_MS: '700' }),
    host: '127.0.0.1', port: hung.address().port, user: 'u', database: 'd' });
  pool.on('error', () => {});
  const app = express();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  app.get('/x', wrap(async (_req, res) => { await pool.query('SELECT 1'); res.json({ ok: true }); }));
  const saved = console.error;
  console.error = () => {};
  app.use(apiErrorHandler);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    console.error = saved;
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
    await new Promise((r) => hung.close(r));
    await pool.end().catch(() => {});
  });
  const started = Date.now();
  const res = await fetch(`http://127.0.0.1:${server.address().port}/x`, { signal: AbortSignal.timeout(10_000) });
  const took = Date.now() - started;
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'database unavailable' });
  assert.ok(took < 3000, `took ${took} ms — the bound is 700 ms`);
});

test('which errors are "the database is unavailable"', () => {
  assert.equal(isDbUnavailable(new Error('timeout exceeded when trying to connect')), true);
  assert.equal(isDbUnavailable(new Error('Connection terminated due to connection timeout')), true);
  assert.equal(isDbUnavailable(new Error('Query read timeout')), true);
  assert.equal(isDbUnavailable(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })), true);
  assert.equal(isDbUnavailable(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })), true);
  assert.equal(isDbUnavailable(Object.assign(new Error('duplicate key'), { code: '23505' })), false);
  assert.equal(isDbUnavailable(new Error('x is not a function')), false);
  assert.equal(isDbUnavailable(null), false);
});
