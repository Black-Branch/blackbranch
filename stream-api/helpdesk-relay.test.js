// The support relay's holder logic, exercised with mock res objects and fake
// timers — no express, no network. The routes are thin wrappers over this.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSupportRelay } = require('./helpdesk-relay');

function mockRes() {
  return {
    sent: undefined, code: 200,
    status(c) { this.code = c; return this; },
    json(x) { this.sent = x; return this; },
  };
}

test('ask → next → reply resolves the held web response', () => {
  const relay = createSupportRelay();
  const webRes = mockRes();
  relay.ask({ matrixId: '@a:x', username: 'a', text: 'hi', history: [] }, webRes);
  const brainRes = mockRes();
  relay.next(brainRes);
  assert.equal(brainRes.sent.text, 'hi', 'the brain gets the queued job');
  assert.ok(brainRes.sent.requestId, 'the job carries its id');
  const ok = relay.reply(brainRes.sent.requestId, 'hello there');
  assert.equal(ok, true);
  assert.deepEqual(webRes.sent, { text: 'hello there' });
});

test('a parked brain poll gets a new ask immediately', () => {
  const relay = createSupportRelay();
  const brainRes = mockRes();
  relay.next(brainRes); // parks — queue empty
  assert.equal(brainRes.sent, undefined, 'nothing yet');
  const webRes = mockRes();
  relay.ask({ matrixId: '@a:x', username: 'a', text: 'q', history: [] }, webRes);
  assert.equal(brainRes.sent.text, 'q', 'the parked poll is fed without waiting');
});

test('asks past the queue cap are refused 503, not queued forever', () => {
  const relay = createSupportRelay({ maxQueue: 2 });
  relay.ask({ matrixId: '@a:x', username: 'a', text: '1', history: [] }, mockRes());
  relay.ask({ matrixId: '@b:x', username: 'b', text: '2', history: [] }, mockRes());
  const overflow = mockRes();
  relay.ask({ matrixId: '@c:x', username: 'c', text: '3', history: [] }, overflow);
  assert.equal(overflow.code, 503);
  assert.deepEqual(overflow.sent, { error: 'busy' });
});

test('an unanswered ask times out 504 and a LATE reply is refused', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const relay = createSupportRelay({ askTimeoutMs: 1000 });
  const webRes = mockRes();
  relay.ask({ matrixId: '@a:x', username: 'a', text: 'q', history: [] }, webRes);
  const brainRes = mockRes();
  relay.next(brainRes);
  const id = brainRes.sent.requestId;
  t.mock.timers.tick(1001);
  assert.equal(webRes.code, 504);
  assert.deepEqual(webRes.sent, { error: 'timeout' });
  assert.equal(relay.reply(id, 'too late'), false, 'a late reply must not resolve a dead request');
});

test('an empty poll parks, then times out to {} so the brain re-polls', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const relay = createSupportRelay({ pollTimeoutMs: 500 });
  const brainRes = mockRes();
  relay.next(brainRes);
  assert.equal(brainRes.sent, undefined);
  t.mock.timers.tick(501);
  assert.deepEqual(brainRes.sent, {});
});

test('two asks queue FIFO', () => {
  const relay = createSupportRelay();
  relay.ask({ matrixId: '@a:x', username: 'a', text: 'first', history: [] }, mockRes());
  relay.ask({ matrixId: '@b:x', username: 'b', text: 'second', history: [] }, mockRes());
  const p1 = mockRes(); relay.next(p1);
  const p2 = mockRes(); relay.next(p2);
  assert.equal(p1.sent.text, 'first');
  assert.equal(p2.sent.text, 'second');
});

test('a second poll while one is parked replaces it cleanly', (t) => {
  // The brain loop is serial, but a restart mid-poll can briefly double up —
  // the OLD waiter must be released (empty) so its socket isn't left hanging.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const relay = createSupportRelay();
  const old = mockRes(); relay.next(old);
  const fresh = mockRes(); relay.next(fresh);
  assert.deepEqual(old.sent, {}, 'the displaced waiter is answered empty');
  const webRes = mockRes();
  relay.ask({ matrixId: '@a:x', username: 'a', text: 'q', history: [] }, webRes);
  assert.equal(fresh.sent.text, 'q', 'the new waiter is the live one');
});

test('a waiter whose socket closes is dropped, so the next ask queues for a live poll', (t) => {
  // The ingest-restart race: the old process's parked poll dies with it, and a
  // job delivered to that dead socket vanished (one 504'd user turn per
  // deploy). Closing the socket must clear the waiter.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const relay = createSupportRelay();
  const listeners = {};
  const deadRes = {
    sent: undefined, code: 200,
    status(c) { this.code = c; return this; },
    json(x) { this.sent = x; return this; },
    on(ev, fn) { listeners[ev] = fn; },
  };
  relay.next(deadRes);
  listeners.close?.();                      // the poll's socket dies (restart)
  const webRes = mockRes();
  relay.ask({ matrixId: '@a:x', username: 'a', text: 'q', history: [] }, webRes);
  assert.equal(deadRes.sent, undefined, 'nothing is delivered to the dead socket');
  const fresh = mockRes();
  relay.next(fresh);
  assert.equal(fresh.sent.text, 'q', 'the job queued and the new poll gets it');
});

// ── release(): the drain path ────────────────────────────────────────────────
// The brain's poll is parked up to 25s, longer than the shutdown grace, and it is
// an ACTIVE request — so server.close() waits on it and the drain hits its
// forced-exit backstop. Found by deploying: every restart took a flat 10s and
// exited 1. See index.js's shutdown block.

test('release() frees the parked brain poll so the drain can finish', () => {
  const relay = createSupportRelay();
  const brainRes = mockRes();
  relay.next(brainRes);
  assert.equal(relay.stats().brainParked, true, 'precondition: a poll is parked');
  relay.release();
  assert.deepEqual(brainRes.sent, {},
    'the parked poll must be answered with the same empty body its timeout would send, ' +
    'so the brain simply re-polls against the new process');
  assert.equal(relay.stats().brainParked, false, 'the waiter is cleared');
});

test('release() 503s held web asks rather than leaving browsers hanging', () => {
  const relay = createSupportRelay();
  const a = mockRes(); const b = mockRes();
  relay.ask({ matrixId: '@a:x', username: 'a', text: '1', history: [] }, a);
  relay.ask({ matrixId: '@b:x', username: 'b', text: '2', history: [] }, b);
  assert.equal(relay.stats().pending, 2, 'precondition: two held asks');
  relay.release();
  for (const [label, r] of [['first', a], ['second', b]]) {
    assert.equal(r.code, 503, `${label} ask was not released — the browser hangs until its own timeout`);
    assert.deepEqual(r.sent, { error: 'restarting' });
  }
  assert.equal(relay.stats().pending, 0);
  assert.equal(relay.stats().queued, 0, 'the queue is dropped too — those jobs die with the process');
});

test('release() is safe when nothing is held, and safe twice', () => {
  const relay = createSupportRelay();
  assert.doesNotThrow(() => relay.release(), 'a drain with an idle relay must not throw');
  const brainRes = mockRes();
  relay.next(brainRes);
  relay.release();
  assert.doesNotThrow(() => relay.release(), 'a second SIGTERM must not throw on an already-released relay');
});

// Each path gets its own relay on purpose: parking a poll while a job is queued
// makes next() deliver immediately, so a dead socket would throw inside next()
// and the test would pass/fail for a reason that has nothing to do with release().
const deadRes = (why) => ({ status() { return this; }, json() { throw new Error(why); } });

test('release() survives a held ask whose socket is already gone', () => {
  const relay = createSupportRelay();
  relay.ask({ matrixId: '@a:x', username: 'a', text: '1', history: [] },
    deadRes('ERR_STREAM_WRITE_AFTER_END'));
  const live = mockRes();
  relay.ask({ matrixId: '@b:x', username: 'b', text: '2', history: [] }, live);
  assert.doesNotThrow(() => relay.release(),
    'one dead socket must not abort the release — the whole point is to let server.close() settle');
  assert.equal(live.code, 503, 'the LIVE ask after the dead one must still be released');
  assert.equal(relay.stats().pending, 0);
});

test('release() survives a parked poll whose socket is already gone', () => {
  const relay = createSupportRelay();
  relay.next(deadRes('socket closed')); // empty queue, so this parks without writing
  assert.equal(relay.stats().brainParked, true, 'precondition: parked');
  assert.doesNotThrow(() => relay.release(), 'a dead parked poll must not abort the drain');
  assert.equal(relay.stats().brainParked, false);
});

test('after release() the relay refuses to park anything new', () => {
  // The re-park race: the brain answers its released poll by immediately polling
  // again. Without the latch that parks a fresh 25s request in the middle of the
  // drain, and server.close() never settles.
  const relay = createSupportRelay();
  relay.next(mockRes());
  relay.release();

  const rePoll = mockRes();
  relay.next(rePoll);
  assert.deepEqual(rePoll.sent, {}, 'a poll during the drain must be answered immediately');
  assert.equal(relay.stats().brainParked, false,
    'the drain re-parked the brain — the socket it just freed is held open again');

  const lateAsk = mockRes();
  relay.ask({ matrixId: '@a:x', username: 'a', text: 'hi', history: [] }, lateAsk);
  assert.equal(lateAsk.code, 503,
    'a web ask during the drain must not be held for askTimeoutMs against a dying process');
  assert.equal(relay.stats().pending, 0, 'nothing may be added to pending during a drain');
});

// ── a help desk with no brain ───────────────────────────────────────────────

test('a timed-out ask leaves the queue, so 20 unanswered questions do not refuse every later one', (t) => {
  // With the AI off nothing ever polls: each question waits, then 504s. If it stayed queued, after
  // maxQueue of them every new question would be refused "busy" until a restart.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const relay = createSupportRelay({ askTimeoutMs: 1000, maxQueue: 2 });
  for (let round = 0; round < 3; round++) {
    const a = mockRes(); const b = mockRes();
    relay.ask({ matrixId: '@a:x', username: 'a', text: `q${round}a`, history: [] }, a);
    relay.ask({ matrixId: '@b:x', username: 'b', text: `q${round}b`, history: [] }, b);
    assert.equal(a.code, 200, `round ${round}: a question was refused "busy" — timed-out jobs are still queued`);
    t.mock.timers.tick(1001);
    assert.equal(a.code, 504); assert.equal(b.code, 504);
    assert.equal(relay.stats().queued, 0, `round ${round}: timed-out jobs stayed in the queue`);
  }
  // And a brain that turns up later is not handed a stale question nobody is waiting for.
  const brain = mockRes();
  relay.next(brain);
  assert.equal(brain.sent, undefined, 'the brain was handed a question whose asker had already been told "timeout"');
});

test('a delivered job that times out is not "removed" twice — the queue keeps the others', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const relay = createSupportRelay({ askTimeoutMs: 1000 });
  relay.ask({ matrixId: '@a:x', username: 'a', text: 'first', history: [] }, mockRes());
  relay.next(mockRes()); // the brain takes "first"
  t.mock.timers.tick(500);
  relay.ask({ matrixId: '@b:x', username: 'b', text: 'second', history: [] }, mockRes());
  t.mock.timers.tick(501); // "first" times out — it is not in the queue any more
  assert.equal(relay.stats().queued, 1, '"second" was dropped by first\'s timeout');
  const brain = mockRes();
  relay.next(brain);
  assert.equal(brain.sent.text, 'second');
});

test('status: aiFreeText is false until the brain polls, true while it does, false again once it stops', () => {
  let clock = 1_000_000;
  const relay = createSupportRelay({ now: () => clock });
  assert.deepEqual(relay.status(), { aiFreeText: false }, 'a help desk nothing has polled offered free text');
  const poll = mockRes();
  relay.next(poll); // parked
  assert.deepEqual(relay.status(), { aiFreeText: true });
  relay.ask({ matrixId: '@a:x', username: 'a', text: 'q', history: [] }, mockRes()); // fed to the parked poll
  clock += 60_000; // a minute-long model call: not polling, still answering
  assert.equal(relay.status().aiFreeText, true, 'a brain busy answering read as gone');
  relay.reply(poll.sent.requestId, 'a');
  clock += 89_000;
  assert.equal(relay.status().aiFreeText, true);
  clock += 2_000; // 91 s since its last sign of life, nothing parked: switched off or down
  assert.equal(relay.status().aiFreeText, false, 'a brain that stopped polling still offered free text');
  relay.next(mockRes()); // it comes back (restart of stream-ingest, switch turned on)
  assert.equal(relay.status().aiFreeText, true, 'a returning brain was not noticed');
});

test('GET /bot/support/status is registered behind requireInternal and answers the relay\'s status', () => {
  const { registerHelpdeskRoutes } = require('./helpdesk-relay');
  const routes = {};
  const requireInternal = () => {};
  registerHelpdeskRoutes(
    { get: (p, ...h) => { routes[p] = h; }, post: (p, ...h) => { routes[p] = h; } },
    { requireInternal, wrap: (fn) => fn, relay: { status: () => ({ aiFreeText: false }) } },
  );
  const h = routes['/bot/support/status'];
  assert.ok(h, 'the status route is not registered');
  assert.equal(h[0], requireInternal, 'the status route is not behind requireInternal');
  const res = mockRes();
  h.at(-1)({}, res);
  assert.deepEqual(res.sent, { aiFreeText: false });
});
