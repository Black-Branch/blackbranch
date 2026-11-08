// E12 (ADR 0134): with a YouTube Data API key, a 1-unit videos.list call double-checks a YouTube
// state change. The pages are undocumented and the API is the documented, exact classifier
// (research §A2), so its answer wins — but the daily quota is shared with everything else the key
// pays for (cross-posting once spent a whole day of it), so the confirm is capped per UTC day, pauses
// after a quotaExceeded, never runs without a video id or a key, and never logs its URL (the key
// rides in it).
//
// Run: node --test platforms/ytConfirm.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

delete process.env.YOUTUBE_VIDEO_ID;
const { classifyVideosList, createYtConfirm, YT_CONFIRM_MAX_PER_DAY, YT_CONFIRM_PAUSE_MS } = await import('./youtube.js');

const VID = 'abcdefghijk';
const KEY = 'test-api-key-not-real';
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/youtube/${name}`, import.meta.url), 'utf8'));
const item = (name) => fixture(name).items[0];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ── classifyVideosList, on the five fixtures ─────────────────────────────────

test('classifyVideosList: live → live, not certain, keyed by the video', () => {
  assert.deepEqual(classifyVideosList(item('videos-list-live.json')),
    { raw: 'live', certain: false, key: VID, evidence: 'api-confirmed', scheduledStart: null });
});

test('classifyVideosList: upcoming → upcoming with its scheduledStartTime', () => {
  assert.deepEqual(classifyVideosList(item('videos-list-upcoming.json')),
    { raw: 'upcoming', certain: false, key: VID, evidence: 'api-confirmed', scheduledStart: Date.parse('2026-10-24T20:00:00Z') });
});

test('classifyVideosList: none → offline, CERTAIN (ADR 0134 E7)', () => {
  assert.deepEqual(classifyVideosList(item('videos-list-none.json')),
    { raw: 'offline', certain: true, key: '', evidence: 'api-confirmed', scheduledStart: null });
});

test('classifyVideosList: actualEndTime set → offline, CERTAIN — and it wins over a stale "live" label', () => {
  const ended = { raw: 'offline', certain: true, key: '', evidence: 'api-confirmed', scheduledStart: null };
  assert.deepEqual(classifyVideosList(item('videos-list-ended.json')), ended);
  const racing = { ...item('videos-list-ended.json'), snippet: { liveBroadcastContent: 'live' } };
  assert.deepEqual(classifyVideosList(racing), ended, 'an end stamp is the end, whatever the label still says');
});

test('classifyVideosList: no item (the id names nothing) → null, so the page\'s answer stands', () => {
  assert.equal(classifyVideosList(fixture('videos-list-empty.json').items[0]), null);
  assert.equal(classifyVideosList(null), null);
  assert.equal(classifyVideosList({ id: VID, snippet: { liveBroadcastContent: 'something-new' } }), null, 'an unknown label is no answer');
});

// ── confirmViaApi ────────────────────────────────────────────────────────────

/** A fake Data API: counts calls, answers with `respond()`, and records every log line. */
function world(respond = () => json(fixture('videos-list-live.json'))) {
  const calls = [];
  const logs = [];
  const real = { fetch: global.fetch, warn: console.warn, log: console.log };
  global.fetch = async (url) => {
    const u = String(url);
    if (!u.startsWith('https://www.googleapis.com/youtube/v3/videos?')) throw new Error(`unexpected request: ${u}`);
    calls.push(u);
    return respond(u);
  };
  console.warn = (...a) => logs.push(a.join(' '));
  console.log = (...a) => logs.push(a.join(' '));
  return { calls, logs, restore: () => { global.fetch = real.fetch; console.warn = real.warn; console.log = real.log; } };
}
const DAY = Date.parse('2026-10-24T12:00:00Z');

test('confirmViaApi asks videos.list once, for that id, with snippet + liveStreamingDetails (1 unit), and returns its observation', async () => {
  const w = world();
  try {
    const { confirmViaApi } = createYtConfirm({ apiKey: () => KEY, now: () => DAY });
    assert.deepEqual(await confirmViaApi(VID), classifyVideosList(item('videos-list-live.json')));
    assert.equal(w.calls.length, 1);
    const u = new URL(w.calls[0]);
    assert.equal(u.searchParams.get('id'), VID);
    assert.deepEqual(u.searchParams.get('part').split(',').sort(), ['liveStreamingDetails', 'snippet']);
  } finally { w.restore(); }
});

test('confirmViaApi: no video id → no call; no key → no call', async () => {
  const w = world();
  try {
    assert.equal(await createYtConfirm({ apiKey: () => KEY, now: () => DAY }).confirmViaApi(''), null);
    assert.equal(await createYtConfirm({ apiKey: () => '', now: () => DAY }).confirmViaApi(VID), null);
    assert.equal(w.calls.length, 0);
  } finally { w.restore(); }
});

test(`confirmViaApi: at most ${YT_CONFIRM_MAX_PER_DAY} calls per UTC day, then null without a call; the next UTC day starts again`, async () => {
  assert.equal(YT_CONFIRM_MAX_PER_DAY, 20);
  const w = world();
  let t = Date.parse('2026-10-24T00:00:05Z');
  try {
    const { confirmViaApi } = createYtConfirm({ apiKey: () => KEY, now: () => t });
    for (let i = 0; i < YT_CONFIRM_MAX_PER_DAY; i++) assert.notEqual(await confirmViaApi(VID), null, `call ${i + 1}`);
    assert.equal(w.calls.length, YT_CONFIRM_MAX_PER_DAY);
    t = Date.parse('2026-10-24T23:59:59Z');
    assert.equal(await confirmViaApi(VID), null, 'over the cap');
    assert.equal(await confirmViaApi(VID), null);
    assert.equal(w.calls.length, YT_CONFIRM_MAX_PER_DAY, 'no call past the cap');
    assert.equal(w.logs.filter((l) => /cap/i.test(l)).length, 1, 'the cap is logged once, not per refusal');
    t = Date.parse('2026-10-25T00:00:01Z');
    assert.notEqual(await confirmViaApi(VID), null, 'a new UTC day');
    assert.equal(w.calls.length, YT_CONFIRM_MAX_PER_DAY + 1);
  } finally { w.restore(); }
});

test('confirmViaApi: a 403 quotaExceeded pauses it for 1 h (null, no calls), then it asks again', async () => {
  assert.equal(YT_CONFIRM_PAUSE_MS, 60 * 60_000);
  let quota = true;
  const w = world(() => (quota
    ? json({ error: { code: 403, message: 'quota', errors: [{ reason: 'quotaExceeded', domain: 'youtube.quota' }] } }, 403)
    : json(fixture('videos-list-none.json'))));
  let t = DAY;
  try {
    const { confirmViaApi } = createYtConfirm({ apiKey: () => KEY, now: () => t });
    assert.equal(await confirmViaApi(VID), null);
    assert.equal(w.calls.length, 1);
    quota = false;
    t = DAY + YT_CONFIRM_PAUSE_MS - 1;
    assert.equal(await confirmViaApi(VID), null, 'still paused');
    assert.equal(w.calls.length, 1, 'no call while paused');
    t = DAY + YT_CONFIRM_PAUSE_MS;
    assert.equal((await confirmViaApi(VID))?.raw, 'offline', 'retry: the pause is over');
    assert.equal(w.calls.length, 2);
  } finally { w.restore(); }
});

test('retry: any other failure (HTTP 500, a 403 that is not quota, a network error) is null for that call only — no pause', async () => {
  let mode = 'http500';
  const w = world(() => {
    if (mode === 'http500') return json({ error: { code: 500 } }, 500);
    if (mode === 'forbidden') return json({ error: { code: 403, errors: [{ reason: 'forbidden' }] } }, 403);
    if (mode === 'network') throw new TypeError('fetch failed');
    return json(fixture('videos-list-live.json'));
  });
  try {
    const { confirmViaApi } = createYtConfirm({ apiKey: () => KEY, now: () => DAY });
    for (const m of ['http500', 'forbidden', 'network']) {
      mode = m;
      assert.equal(await confirmViaApi(VID), null, m);
    }
    mode = 'ok';
    assert.equal((await confirmViaApi(VID))?.raw, 'live', 'the next call asks at once');
    assert.equal(w.calls.length, 4);
  } finally { w.restore(); }
});

test('confirmViaApi never logs its URL or the key — only HTTP <status>', async () => {
  const w = world(() => json({ error: { code: 403, errors: [{ reason: 'quotaExceeded' }] } }, 403));
  try {
    const c = createYtConfirm({ apiKey: () => KEY, now: () => DAY });
    await c.confirmViaApi(VID);
    const c2 = createYtConfirm({ apiKey: () => KEY, now: () => DAY });
    global.fetch = async () => json({}, 500);
    await c2.confirmViaApi(VID);
    global.fetch = async () => { throw new Error(`request to https://www.googleapis.com/youtube/v3/videos?key=${KEY} failed`); };
    await c2.confirmViaApi(VID);
    assert.ok(w.logs.length >= 3, `logged: ${w.logs.length}`);
    for (const l of w.logs) {
      assert.ok(!l.includes(KEY), `a log line carries the key: ${l}`);
      assert.ok(!l.includes('googleapis'), `a log line carries the URL: ${l}`);
    }
    assert.ok(w.logs.some((l) => l.includes('HTTP 403')));
    assert.ok(w.logs.some((l) => l.includes('HTTP 500')));
  } finally { w.restore(); }
});
