// Round 7 (ingest-logs): a Kick money event's journal line carries the event name, its id and
// the payload's top-level KEYS — never a value. The old line printed the first 400 characters
// of the raw payload, which names the subscriber, the gifter and every giftee.
//
// Run: node --test platforms/kickLogs.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

// postAlert goes through fetch to STREAM_API_URL. A test must never reach a real /alert (a money
// endpoint — a probe is a write), so the address is a made-up one and fetch is stubbed below.
process.env.STREAM_API_URL = 'http://stream-api.site.test';
process.env.KICK_CHANNEL_SLUG = 'testchannel';

const { handleKickMonetization } = await import('./kick.js');
const { payloadShape } = await import('../lib/logShape.js');

const NAMES = ['casey', 'Gadget', 'robin_t', 'Sprocket'];

async function capture(fn) {
  const lines = [];
  const orig = {};
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
    orig[k] = console[k];
    console[k] = (...a) => lines.push(a.map(String).join(' '));
  }
  const realFetch = global.fetch;
  const posted = [];
  global.fetch = async (url, init) => {
    posted.push({ url: String(url), body: init?.body });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 20)); // let the un-awaited postAlert settle
  } finally {
    Object.assign(console, orig);
    global.fetch = realFetch;
  }
  return { lines, posted };
}

function assertNoName(lines) {
  for (const l of lines) for (const n of NAMES) assert.ok(!l.includes(n), `a name reached the journal: ${l}`);
}

test('a Kick gifted-subs event logs its name, id and keys — no gifter, no giftee', async () => {
  const payload = { id: 'evt-77', gifter_username: 'casey', gifted_usernames: ['Gadget', 'robin_t'], gifter_total: 9 };
  const { lines, posted } = await capture(() =>
    handleKickMonetization('App\\Events\\GiftedSubscriptionsEvent', JSON.stringify(payload)));
  assertNoName(lines);
  const shape = lines.find((l) => l.includes('monetization'));
  assert.ok(shape, `no monetization line in ${JSON.stringify(lines)}`);
  assert.match(shape, /GiftedSubscriptionsEvent/);
  assert.match(shape, /id=evt-77/);
  assert.match(shape, /keys=\[id,gifter_username,gifted_usernames,gifter_total\]/);
  // The alert itself still carries the gifter: the journal line is what changed, not the event.
  assert.equal(posted.length, 1);
  assert.match(posted[0].body, /casey/);
});

test('a Kick sub and a Kicks gift log keys only', async () => {
  const sub = { id: 12, username: 'Sprocket', months: 3 };
  const kicks = { sender: { id: 4, username: 'casey' }, amount: 100 };
  const { lines } = await capture(() => {
    handleKickMonetization('App\\Events\\SubscriptionEvent', JSON.stringify(sub));
    handleKickMonetization('App\\Events\\KicksGifted', JSON.stringify(kicks));
  });
  assertNoName(lines);
  assert.ok(lines.some((l) => /SubscriptionEvent id=12 keys=\[id,username,months\]/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /KicksGifted id=\? keys=\[sender,amount\]/.test(l)), lines.join('\n'));
});

test('an unparsable Kick money frame is described by its size, not its text', async () => {
  const { lines } = await capture(() => handleKickMonetization('App\\Events\\SubscriptionEvent', 'casey{not json'));
  assertNoName(lines);
  assert.ok(lines.some((l) => /unparsed, 14 bytes/.test(l)), lines.join('\n'));
});

test('payloadShape: keys and id, never a value, for every input shape', () => {
  assert.equal(payloadShape('{"id":5,"user":{"username":"casey"}}'), 'id=5 keys=[id,user]');
  assert.equal(payloadShape({ user: { username: 'casey' } }), 'id=? keys=[user]');
  assert.equal(payloadShape('Gadget says hi'), 'unparsed, 14 bytes');
  assert.equal(payloadShape('"Gadget"'), 'string, 8 bytes');
  assert.equal(payloadShape('[1,2]'), 'array of 2');
  assert.equal(payloadShape(null), 'null');
  assert.equal(payloadShape(undefined), 'undefined');
  // An id is printed only when it is an id-shaped scalar: an object or an over-long string is not.
  assert.equal(payloadShape({ id: { username: 'casey' } }), 'id=? keys=[id]');
  assert.equal(payloadShape({ id: 'x'.repeat(200) }), 'id=? keys=[id]');
});
