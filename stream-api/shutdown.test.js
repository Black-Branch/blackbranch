// Contract for stream-api's graceful shutdown (index.js).
//
// This is a source-text scan because index.js is not importable: it fatals
// without DB_PASSWORD and opens a pool, a WS server and an OBS socket at
// require time. Same reason webhooks.test.js pins the Ko-fi parser this way.
//
// What decays here is ORDER, not existence. Every step below has a specific
// failure if it goes missing, and none of them are visible in a passing
// deploy — a broken drain shows up only as systemd sitting in `deactivating`
// for the full grace period, or as a merge that silently didn't apply.
//
// Run: node --test shutdown.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

// Strip comments: this block is HEAVILY commented and every term below appears
// in the prose. Without this the assertions would pass on the explanation alone.
//
// ORDER MATTERS, and getting it wrong fails SILENTLY. index.js:168 documents
// the money routes as `/timer/*, /chat/event …` inside a `//` comment. To a
// block-comment regex that `/*` is an OPENER, so stripping blocks first eats
// everything from line 168 to the next `*/` anywhere below — about 60 lines of
// real code, with no error. Whole-line `//` comments are removed FIRST so that
// stray opener is gone before the block regex ever sees it. (The line filter
// only drops lines that START with `//`, so it can never damage a URL or a
// regex literal mid-line.)
const src = readFileSync(join(__dirname, 'index.js'), 'utf8')
  .split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

// Vacuity guard. The anchor is deliberately the LAST statement in the file:
// truncation always eats the tail, so an early anchor (server.listen, say) stays
// green while everything the other tests examine has been silently removed.
// That exact false pass happened while writing this file.
test('the scan sees the whole file, tail included', () => {
  assert.ok(src.length > 2000, 'index.js source scan came back too small to be the real file');
  assert.match(src, /unhandledRejection/,
    'the scan lost the END of index.js — a stray `/*` in a line comment truncated it, and every ' +
    'assertion below is now checking a file that stops early');
});

test('SIGTERM and SIGINT both drain; a stray rejection does not kill the service', () => {
  assert.match(src, /process\.on\('SIGTERM'/,
    'systemd sends SIGTERM on restart — without this, in-flight requests are dropped mid-flight');
  assert.match(src, /process\.on\('SIGINT'/,
    'SIGINT (a foreground run, Ctrl-C) must drain the same way or local testing diverges from prod');
  assert.match(src, /process\.on\('unhandledRejection'/,
    'an unawaited rejection must be logged, not fatal — this is the money service');
});

test('the drain is re-entrant-safe', () => {
  assert.match(src, /if \(shuttingDown\) return/,
    'a second SIGTERM would re-enter shutdown() and race two process.exit() paths');
});

test('the drain is bounded by a backstop that cannot itself hold the process open', () => {
  assert.match(src, /SHUTDOWN_GRACE_MS/,
    'no grace bound — a stuck socket or hung query makes the restart hang indefinitely');
  // Anchored on the unique identifier rather than a byte window: an earlier version
  // sliced the first 400 chars after the setTimeout, and adding diagnostics to the
  // backstop pushed the unref past the cutoff — the test failed for its own reason,
  // not the code's.
  assert.ok(src.includes('const forced = setTimeout'), 'the backstop timer is gone');
  assert.match(src, /process\.exit\(1\)/, 'the backstop must actually exit, not just log');
  assert.match(src, /if \(forced\.unref\) forced\.unref\(\)/,
    'an un-unref\'d backstop timer keeps the event loop alive for the whole grace period, ' +
    'turning every clean shutdown into a full-grace wait');
});

test('everything that would stall server.close() is released BEFORE it is awaited', () => {
  // server.close() waits for every open socket. WS clients never leave on their
  // own and idle keep-alives are held by the web app, so awaiting first is a
  // guaranteed hang to the grace timeout.
  const iTerminate = src.indexOf('ws.terminate()');
  const iIdle = src.indexOf('closeIdleConnections');
  const iAwait = src.indexOf('await closed');
  assert.ok(iTerminate > 0, 'WS clients are never terminated — server.close() cannot settle');
  assert.ok(iIdle > 0, 'idle keep-alive sockets are never dropped — the web app holds these between calls');
  assert.ok(iAwait > 0, 'the server close is never awaited, so the pool closes under live requests');
  assert.ok(iTerminate < iAwait,
    'WS clients are terminated AFTER awaiting the close — that await can never resolve');
  assert.ok(iIdle < iAwait,
    'idle connections are dropped AFTER awaiting the close — the drain waits out the full grace');
});

test('the parked long-poll is released, or every restart hits the backstop', () => {
  // Found by DEPLOYING, not by this file: the first version drained "correctly" by
  // every assertion above and still took a flat 10s and exited 1 on every restart.
  // the help-desk relay parks the brain's /bot/support/next for up to 25s — longer
  // than the grace — and it is an ACTIVE request, so closeIdleConnections() cannot
  // reach it and server.close() waits on it.
  const iRelease = src.indexOf('supportRelay.release()');
  const iAwait = src.indexOf('await closed');
  assert.match(src, /const supportRelay = createSupportRelay\(\)/,
    'the relay is constructed inline again, so the drain has no handle to release its ' +
    'parked long-poll — restarts will silently run to the forced-exit backstop');
  assert.ok(iRelease > 0, 'the brain\'s parked poll is never released — server.close() cannot settle');
  assert.ok(iRelease < iAwait, 'the relay is released AFTER awaiting the close, which is too late');

  // The ordering bug that survived the first fix: releasing a parked poll completes
  // its response, making that socket newly IDLE. Sweep first and nothing ever closes
  // it, so close() waits anyway — a 10s stop with release() present and "working".
  const iIdle = src.indexOf('closeIdleConnections');
  assert.ok(iRelease < iIdle,
    'closeIdleConnections() runs BEFORE supportRelay.release(), so the socket freed by the ' +
    'release becomes idle after the sweep and nothing closes it — this order costs a ' +
    'full 10s forced exit even with release() wired in');

  const relay = readFileSync(join(__dirname, 'helpdesk-relay.js'), 'utf8');
  assert.match(relay, /return \{ ask, next, reply, stats, status, release \}/,
    'createSupportRelay stopped exporting release() — index.js\'s drain depends on it');
  assert.match(relay, /draining = true/,
    'release() no longer latches the relay, so the brain can re-park a fresh 25s poll ' +
    'mid-drain and the close never settles');
});

test('the grace is 30 s (inside the bundle\'s 40 s stop) and the relay hold would eat most of it — release() keeps restarts quick', () => {
  // The grace is 30 s so that, under Docker's stop_grace_period of 40 s, an overrunning drain
  // prints its diagnostic before the kill. That puts the grace PAST the relay's 25 s hold, so
  // release() does not prevent an exit 1 — it prevents every restart from waiting out a parked poll. A 25 s restart is a 25 s dark site;
  // shutdown-run.db.test.js times the real drain to hold that.
  const relay = readFileSync(join(__dirname, 'helpdesk-relay.js'), 'utf8');
  const poll = Number(/pollTimeoutMs = (\d+)/.exec(relay)?.[1]);
  const grace = Number(/SHUTDOWN_GRACE_MS \|\| ([\d_]+)/.exec(src)?.[1]?.replace(/_/g, ''));
  assert.ok(Number.isFinite(poll) && poll > 0, 'could not read pollTimeoutMs — this guard went vacuous');
  assert.ok(Number.isFinite(grace) && grace > 0, 'could not read SHUTDOWN_GRACE_MS — this guard went vacuous');
  assert.equal(grace, 30_000, 'SHUTDOWN_GRACE_MS defaults to 30 s (compose gives the container 40 s)');
  assert.ok(poll * 2 > grace,
    `pollTimeoutMs (${poll}ms) is now a small part of the grace (${grace}ms) — release() is no longer ` +
    'what keeps a restart short, and the comments in index.js and helpdesk-relay.js explaining it are stale.');
});

test('the pool is drained after the server closes, not before', () => {
  const iAwaitClosed = src.indexOf('await closed');
  const iPoolEnd = src.indexOf('await pool.end()');
  assert.ok(iPoolEnd > 0, 'the pool is never drained — checked-out clients die with the process');
  assert.ok(iAwaitClosed < iPoolEnd,
    'pool.end() runs BEFORE in-flight HTTP finishes, so identity.js\'s merge transaction ' +
    'loses its connection mid-flight — the exact failure this shutdown exists to prevent');
});

test('the aggregate rebuild is stopped and awaited before the pool ends', () => {
  const iStop = src.indexOf('await stopAggregates()');
  const iPoolEnd = src.indexOf('await pool.end()');
  assert.ok(iStop > 0, 'the drain never stops the aggregate rebuild — "Cannot use a pool after calling end" on every stop');
  assert.ok(iStop < iPoolEnd, 'the rebuild is stopped AFTER the pool ended');
  assert.match(src, /stop: stopAggregates \} = createAggregates\(/, 'stopAggregates is not the aggregates handle\'s stop()');
  // The boot's first reads too: a stop in the first second ended the pool under sponsors.init().
  const iBoot = src.indexOf('await Promise.allSettled(bootLoads)');
  assert.ok(iBoot > 0 && iBoot < iPoolEnd, 'the boot reads are not awaited before the pool ends');
  for (const load of ['content.load()', 'sponsors.init()', 'supportBar.init()', 'pollEngine.init()']) {
    assert.ok(new RegExp(`bootLoads\\.push\\([^;]*${RegExp.escape(load)}`, 's').test(src), `${load} is not held in bootLoads`);
  }
});

test('the Streamlabs socket is closed so no donation lands after the pool is gone', () => {
  assert.match(src, /const streamlabs = startStreamlabs/,
    'startStreamlabs returns a { stop } handle; discarding it leaves a live donation socket ' +
    'attached to a service that is shutting down');
  assert.match(src, /streamlabs\.stop\(\)/, 'the handle is captured but never used');
});

test('ws-hub exposes wss to index.js, or the drain has nothing to terminate', () => {
  const hub = readFileSync(join(__dirname, 'ws-hub.js'), 'utf8');
  assert.match(hub, /return \{ wss,/,
    'createWsHub stopped returning wss — index.js can no longer terminate WS clients on drain');
  assert.match(hub, /wss\.on\('close', \(\) => clearInterval\(wsHeartbeat\)\)/,
    'the heartbeat is no longer cleared when wss closes, so the drain leaks a live interval');
  assert.match(src, /\{ wss, msgBuffer/, 'index.js stopped destructuring wss from the hub');
});

// ── the reason this file is a scan and not an import ────────────────────────

test('OBS is deliberately not disconnected during the drain', () => {
  // Documented trap: obs.js re-arms on close, so a "tidy" disconnect would hold
  // the loop open with a fresh reconnect timer — the opposite of draining.
  const obs = readFileSync(join(__dirname, 'obs.js'), 'utf8');
  assert.match(obs, /ConnectionClosed[\s\S]{0,200}scheduleReconnect\(\)/,
    'obs.js no longer re-arms on ConnectionClosed — if that is now false, the note in ' +
    'index.js\'s shutdown block explaining why OBS is left alone is stale');
  assert.doesNotMatch(src, /obs\.disconnect\(\)/,
    'disconnecting OBS in the drain arms scheduleReconnect() and holds the process open');
});
