// Unit tests for the cross-platform poll engine (start / vote / tally / end).
// Server-authoritative logic only — DB + broadcast are mocked. Run:
//   node --test poll.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPoll } = require('./poll');

// Minimal deps: pool returns a fresh id for the polls INSERT and empty rows for
// every other statement; broadcast/bufferPush/persistCard just record.
function makeDeps({ persistId = 555 } = {}) {
  const sent = [];
  const buffered = [];
  let pollSeq = 0;
  const pool = {
    async query(sql) {
      if (/INSERT INTO stream\.polls/.test(sql)) return { rows: [{ id: ++pollSeq }] };
      return { rows: [] };
    },
  };
  const deps = {
    broadcast: (m) => sent.push(m),
    bufferPush: (c) => buffered.push(c),
    pool,
    persistCard: async () => persistId,
  };
  return { deps, sent, buffered };
}

const OPTS = ['Yes', 'No'];

test('start validates question + option count', async () => {
  const { deps } = makeDeps();
  const p = createPoll(deps);

  assert.equal((await p.start({ question: '', options: OPTS })).error, 'bad_poll');
  assert.equal((await p.start({ question: 'Q', options: ['only one'] })).error, 'bad_poll');
  assert.equal((await p.start({ question: 'Q', options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })).error, 'bad_poll');

  const r = await p.start({ question: 'Best?', options: OPTS });
  assert.equal(r.ok, true);
  assert.equal(r.poll.status, 'active');
  assert.deepEqual(r.poll.options, [{ n: 1, text: 'Yes' }, { n: 2, text: 'No' }]);
  assert.deepEqual(r.poll.tallies, { 1: 0, 2: 0 });
  assert.equal(r.poll.total, 0);
  await p.cancel();
});

test('start clamps duration to [30, 3600] seconds', async () => {
  const { deps } = makeDeps();
  const p = createPoll(deps);

  let r = await p.start({ question: 'Q', options: OPTS, durationSec: 5 });
  assert.equal(Math.round((r.poll.endsAt - r.poll.startedAt) / 1000), 30);
  await p.cancel();

  r = await p.start({ question: 'Q', options: OPTS, durationSec: 99999 });
  assert.equal(Math.round((r.poll.endsAt - r.poll.startedAt) / 1000), 3600);
  await p.cancel();
});

test('one vote per voter; changing option moves the tally', async () => {
  const { deps } = makeDeps();
  const p = createPoll(deps);
  await p.start({ question: 'Q', options: OPTS });

  let r = await p.vote({ voterKey: 'a', optionN: 1 });
  assert.deepEqual(r.poll.tallies, { 1: 1, 2: 0 });
  assert.equal(r.poll.total, 1);

  // Same voter, same option → no-op.
  r = await p.vote({ voterKey: 'a', optionN: 1 });
  assert.equal(r.unchanged, true);
  assert.equal(r.poll.total, 1);

  // Same voter switches → moves, doesn't double-count.
  r = await p.vote({ voterKey: 'a', optionN: 2 });
  assert.deepEqual(r.poll.tallies, { 1: 0, 2: 1 });
  assert.equal(r.poll.total, 1);

  // A second voter adds to the total.
  r = await p.vote({ voterKey: 'b', optionN: 2 });
  assert.deepEqual(r.poll.tallies, { 1: 0, 2: 2 });
  assert.equal(r.poll.total, 2);
  await p.cancel();
});

test('vote rejects bad option, missing voter, and inactive poll', async () => {
  const { deps } = makeDeps();
  const p = createPoll(deps);

  // No poll yet.
  assert.equal((await p.vote({ voterKey: 'a', optionN: 1 })).error, 'no_active_poll');

  await p.start({ question: 'Q', options: OPTS });
  assert.equal((await p.vote({ voterKey: 'a', optionN: 7 })).error, 'bad_option');
  assert.equal((await p.vote({ voterKey: '', optionN: 1 })).error, 'bad_option');
  await p.cancel();

  // Voting after it ends is rejected.
  assert.equal((await p.vote({ voterKey: 'a', optionN: 1 })).error, 'no_active_poll');
});

test('end resolves a clear winner', async () => {
  const { deps, sent } = makeDeps();
  const p = createPoll(deps);
  await p.start({ question: 'Q', options: OPTS });
  await p.vote({ voterKey: 'a', optionN: 1 });
  await p.vote({ voterKey: 'b', optionN: 1 });
  await p.vote({ voterKey: 'c', optionN: 2 });

  const r = await p.end('mod');
  assert.equal(r.poll.status, 'ended');
  assert.equal(r.poll.winner, 1);
  assert.equal(r.poll.total, 3);
  assert.equal(sent.at(-1).type, 'pollEnd');
  assert.equal(p.active(), false);
  assert.equal(p.current(), null);
});

test('a tie yields no winner', async () => {
  const { deps } = makeDeps();
  const p = createPoll(deps);
  await p.start({ question: 'Q', options: OPTS });
  await p.vote({ voterKey: 'a', optionN: 1 });
  await p.vote({ voterKey: 'b', optionN: 2 });
  assert.equal((await p.end()).poll.winner, null);
});

test('ending with zero votes has no winner', async () => {
  const { deps } = makeDeps();
  const p = createPoll(deps);
  await p.start({ question: 'Q', options: OPTS });
  const r = await p.end();
  assert.equal(r.poll.winner, null);
  assert.equal(r.poll.total, 0);
});

test('cancel finalizes as cancelled, not ended', async () => {
  const { deps } = makeDeps();
  const p = createPoll(deps);
  await p.start({ question: 'Q', options: OPTS });
  const r = await p.cancel('mod');
  assert.equal(r.poll.status, 'cancelled');
  assert.equal(r.poll.winner, null);  // winner only computed for 'ended'
});

test('extend clamps added seconds and pushes endsAt out', async () => {
  const { deps } = makeDeps();
  const p = createPoll(deps);
  const s = await p.start({ question: 'Q', options: OPTS, durationSec: 60 });
  const before = s.poll.endsAt;

  let r = await p.extend({ addSec: 5 });    // below the 10s floor → +10s
  assert.equal(r.poll.endsAt - before, 10000);

  r = await p.extend({ addSec: 99999 });    // above the 3600s cap → +3600s
  assert.equal(r.poll.endsAt - before, 10000 + 3600000);
  await p.cancel();
});

test('active() and creatorOf() reflect lifecycle', async () => {
  const { deps } = makeDeps();
  const p = createPoll(deps);
  assert.equal(p.active(), false);
  assert.equal(p.creatorOf(), null);

  await p.start({ question: 'Q', options: OPTS, createdBy: 'mod1' });
  assert.equal(p.active(), true);
  assert.equal(p.creatorOf(), 'mod1');

  await p.cancel();
  assert.equal(p.active(), false);
  assert.equal(p.creatorOf(), null);
});

test('a second start is refused while one is active', async () => {
  const { deps } = makeDeps();
  const p = createPoll(deps);
  await p.start({ question: 'Q1', options: OPTS });
  const r = await p.start({ question: 'Q2', options: OPTS });
  assert.equal(r.error, 'poll_active');
  await p.cancel();
});
