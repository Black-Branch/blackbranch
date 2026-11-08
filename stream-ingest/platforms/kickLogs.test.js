// A Kick money event's journal line carries the event name, its id and the payload's top-level
// KEYS — never a value. The raw payload names the subscriber, the gifter and every giftee.
//
// Run: node --test platforms/kickLogs.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

// postAlert goes through fetch to STREAM_API_URL. A test must never reach a real /alert (a money
// endpoint — a probe is a write), so the address is a made-up one and fetch is stubbed below.
process.env.STREAM_API_URL = 'http://stream-api.site.test';
process.env.KICK_CHANNEL_SLUG = 'testchannel';

const { handleKickMonetization, handleKickModeration } = await import('./kick.js');
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

// ── Kick moderation events: one journal line each, ids only (the #185 lag read) ──────────────
// The read times a site ban (site.platform_mod_actions.created_at) against Kick's own event. A
// site ban's echo flags nothing at stream-api (its rows are already deleted), so this receipt
// line is the only record that Kick sent it.

const AT = new Date('2026-11-04T08:34:38.912Z');
// The receipt line itself (not the unparsed-shape line, not the mirror-failure line).
const modLines = (lines) => lines.filter((l) => /^\[kick\] moderation (UserBannedEvent|MessageDeletedEvent) /.test(l));

test('a Kick ban logs the banned user id, Kick\'s time, our receipt time and the keys — no name', async () => {
  const ban = { id: 'evt-9', user: { id: 131902950, username: 'casey', slug: 'casey' }, banned_by: { id: 7, username: 'Gadget', slug: 'gadget' }, permanent: true, created_at: '2026-11-04T08:34:37.500Z' };
  const { lines, posted } = await capture(() => handleKickModeration('App\\Events\\UserBannedEvent', JSON.stringify(ban), AT));
  assertNoName(lines);
  assert.deepEqual(modLines(lines), [
    '[kick] moderation UserBannedEvent user=131902950 kickAt=2026-11-04T08:34:37.500Z receivedAt=2026-11-04T08:34:38.912Z id=evt-9 keys=[id,user,banned_by,permanent,created_at]',
  ]);
  // The mirror still gets the username: it is stream-api's fallback match, not a journal value.
  assert.equal(posted.length, 1);
  assert.match(posted[0].url, /\/chat\/platform-delete$/);
  assert.deepEqual(JSON.parse(posted[0].body), { platform: 'kick', platformUserId: '131902950', username: 'casey' });
});

test('a Kick delete logs the message uuid only — never the deleted text', async () => {
  const del = { id: 'evt-10', message: { id: '0f6c1a2e-5b1d-4c3e-9a77-1f2e3d4c5b6a', content: 'Gadget says hi' } };
  const { lines, posted } = await capture(() => handleKickModeration('App\\Events\\MessageDeletedEvent', JSON.stringify(del), AT));
  assertNoName(lines);
  assert.ok(!lines.some((l) => l.includes('says hi')), lines.join('\n'));
  assert.deepEqual(modLines(lines), [
    '[kick] moderation MessageDeletedEvent msg=0f6c1a2e-5b1d-4c3e-9a77-1f2e3d4c5b6a kickAt=none receivedAt=2026-11-04T08:34:38.912Z id=evt-10 keys=[id,message]',
  ]);
  assert.deepEqual(JSON.parse(posted[0].body), { platform: 'kick', platformMsgId: '0f6c1a2e-5b1d-4c3e-9a77-1f2e3d4c5b6a' });
});

test('a Kick ban with no user id prints user=?, never the username the mirror falls back to', async () => {
  const { lines, posted } = await capture(() => handleKickModeration('App\\Events\\UserBannedEvent', JSON.stringify({ user: { slug: 'robin_t' } }), AT));
  assertNoName(lines);
  assert.match(modLines(lines)[0], /^\[kick\] moderation UserBannedEvent user=\? kickAt=none receivedAt=\S+ id=\? keys=\[user\]$/);
  assert.equal(posted.length, 1, 'the mirror still runs on the username');
});

test('Kick\'s own time: epoch seconds and milliseconds read alike; anything else is "none", never echoed', async () => {
  const at = async (v) => {
    const { lines } = await capture(() => handleKickModeration('App\\Events\\UserBannedEvent', JSON.stringify({ user: { id: 1 }, created_at: v }), AT));
    return modLines(lines)[0].match(/kickAt=(\S+)/)[1];
  };
  assert.equal(await at(1762245277), '2025-11-04T08:34:37.000Z');
  assert.equal(await at(1762245277500), '2025-11-04T08:34:37.500Z');
  assert.equal(await at('Gadget'), 'none');
  assert.equal(await at({ username: 'casey' }), 'none');
});

test('an id that is not id-shaped prints as ?, so a drifted field can never carry text', async () => {
  const { lines } = await capture(() => handleKickModeration('App\\Events\\MessageDeletedEvent', JSON.stringify({ message: { id: 'Gadget says hi to everyone in chat' } }), AT));
  assertNoName(lines);
  assert.match(modLines(lines)[0], /^\[kick\] moderation MessageDeletedEvent msg=\? /);
});

test('an unparsable Kick moderation frame is described by its shape and asks no mirror', async () => {
  const { lines, posted } = await capture(() => handleKickModeration('App\\Events\\UserBannedEvent', 'casey{not json', AT));
  assertNoName(lines);
  assert.ok(lines.some((l) => /^\[kick\] moderation event App\\Events\\UserBannedEvent unparsed \(shape drift\?\): unparsed, 14 bytes$/.test(l)), lines.join('\n'));
  assert.equal(modLines(lines).length, 0, 'an unparsed frame is not a receipt line');
  assert.equal(posted.length, 0);
});

test('retry: a mirror that fails still leaves the receipt line, and Kick sending the event again logs it again', async () => {
  const realFetch = global.fetch;
  const lines = [];
  const orig = { log: console.log, warn: console.warn };
  console.log = (...a) => lines.push(a.map(String).join(' '));
  console.warn = (...a) => lines.push(a.map(String).join(' '));
  let calls = 0;
  global.fetch = async () => { calls += 1; return new Response('down', { status: 502 }); };
  const ban = JSON.stringify({ id: 'evt-11', user: { id: 42, username: 'casey' } });
  try {
    assert.equal(await handleKickModeration('App\\Events\\UserBannedEvent', ban, AT), false);
    assert.equal(await handleKickModeration('App\\Events\\UserBannedEvent', ban, AT), false);
  } finally {
    Object.assign(console, orig);
    global.fetch = realFetch;
  }
  assertNoName(lines);
  assert.equal(calls, 2, 'each event asks the mirror once');
  assert.equal(modLines(lines).filter((l) => l.startsWith('[kick] moderation UserBannedEvent user=42 kickAt=none')).length, 2, lines.join('\n'));
  assert.equal(lines.filter((l) => /^\[kick\] moderation mirror failed event=App\\Events\\UserBannedEvent id=42 .*-> 502/.test(l)).length, 2, lines.join('\n'));
});
