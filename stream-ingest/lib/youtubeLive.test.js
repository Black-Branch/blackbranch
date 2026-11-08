// The one YouTube classifier (config/youtube-live.mjs → ./youtubeLive.generated.js), on real pages.
//
// The defect it fixes: web's community slot read `html.includes('"isLive":true')`, and a SCHEDULED
// broadcast's watch page carries exactly that text inside its "N waiting" counter, so the slot
// advertised a schedule as live (k, 2026-10-22; web/app/lib/streamStatus.ts:116). stream-ingest's
// own reading (owner + isLiveNow) never crossed to web. One classifier now serves both.
//
// Fixtures: platforms/fixtures/youtube/, fetched 2026-10-24 with youtube.js PAGE_HEADERS; the README
// there names each page's source and owner channel id, and CH is read from it.
//
// Run: node --test lib/youtubeLive.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { YOUTUBE_LIVE } from './youtubeLive.generated.js';

const { parsePlayerResponse, classifyPlayerResponse, classifyLivePage } = YOUTUBE_LIVE;
const FIXTURES = new URL('../platforms/fixtures/youtube/', import.meta.url);
const read = (name) => readFileSync(new URL(name, FIXTURES), 'utf8');
const pick = ({ state, evidence }) => ({ state, evidence });

// The README's lines: "<file> — <url> — <date> — owner <id> [— asked as <id>]".
const README = read('README');
const field = (file, label) => {
  const line = README.split('\n').find((l) => l.startsWith(`${file} — `));
  assert.ok(line, `README names ${file}`);
  const m = line.match(new RegExp(`${label} (UC[\\w-]{22})`));
  assert.ok(m, `README gives ${file} its ${label}`);
  return m[1];
};
const CH = {
  live: field('live.html', 'owner'),
  liveNoMf: field('live-no-microformat.html', 'owner'),
  upcoming: field('upcoming-watch.html', 'owner'),
  foreignAsked: field('foreign.html', 'asked as'),
  none: field('none.html', 'owner'),
};

test('live', () => assert.equal(classifyLivePage(read('live.html'), CH.live).state, 'live'));
test('live without microformat', () => assert.equal(classifyLivePage(read('live-no-microformat.html'), CH.liveNoMf).state, 'live'));
test('upcoming is never live (the 10-22 bug)', () => {
  const html = read('upcoming-watch.html');
  assert.ok(html.includes('"isLive":true'), 'fixture must carry the waiting-counter text that fooled streamStatus.ts:116');
  const c = classifyPlayerResponse(parsePlayerResponse(html), CH.upcoming);
  assert.equal(c.state, 'upcoming'); assert.ok(c.scheduledStart > 1.7e12);
});
test('foreign', () => assert.deepEqual(pick(classifyLivePage(read('foreign.html'), CH.foreignAsked)), { state: 'offline', evidence: 'foreign-video' }));
test('none', () => assert.deepEqual(pick(classifyLivePage(read('none.html'), CH.none)), { state: 'offline', evidence: 'channel-canonical' }));
test('consent', () => assert.equal(classifyLivePage(read('consent.html'), CH.none).evidence, 'unrecognized-page'));
test('bot-check', () => assert.equal(classifyLivePage(read('botcheck.html'), CH.none).state, 'unknown'));

// ── Beyond the fixtures: the details a caller relies on ──────────────────────────────────────────

test('the upcoming page read whole is upcoming too, about its own id, with the slate time', () => {
  const html = read('upcoming-watch.html');
  const c = classifyLivePage(html, CH.upcoming);
  const id = html.match(/watch\?v=([\w-]{11})/)[1];
  assert.deepEqual([c.state, c.evidence, c.videoId, c.ownerChannelId], ['upcoming', 'upcoming', id, CH.upcoming]);
  const pr = parsePlayerResponse(html);
  const secs = Number(pr.playabilityStatus.liveStreamability.liveStreamabilityRenderer.offlineSlate.liveStreamOfflineSlateRenderer.scheduledStartTime);
  assert.equal(c.scheduledStart, secs * 1000);
});

test('the live pages carry the video id of their canonical', () => {
  for (const [file, ch] of [['live.html', CH.live], ['live-no-microformat.html', CH.liveNoMf]]) {
    const html = read(file);
    assert.equal(classifyLivePage(html, ch).videoId, html.match(/watch\?v=([\w-]{11})/)[1], file);
  }
});

test('the no-live page names no video, though it holds a recommendation', () => {
  const html = read('none.html');
  assert.match(html, /"videoId":"[\w-]{11}"/, 'fixture keeps the recommended videoId the page really carries');
  assert.equal(classifyLivePage(html, CH.none).videoId, '');
});

// The table, one row each, on synthetic responses (first match wins).
const OWN = 'UCowntestchannel0000000';
const pr = ({ videoDetails = {}, mf, status } = {}) => ({
  videoDetails: { videoId: 'abcdefghijk', ...videoDetails },
  ...(mf === undefined ? {} : { microformat: { playerMicroformatRenderer: mf } }),
  ...(status ? { playabilityStatus: status } : {}),
});
const slate = (t) => ({ status: 'LIVE_STREAM_OFFLINE', liveStreamability: { liveStreamabilityRenderer: { offlineSlate: { liveStreamOfflineSlateRenderer: { scheduledStartTime: t } } } } });

test('table: no response → unknown (no-player-response)', () => {
  assert.deepEqual(pick(classifyPlayerResponse(null, OWN)), { state: 'unknown', evidence: 'no-player-response' });
});
test('table: no owner anywhere → unknown (no-owner)', () => {
  assert.deepEqual(pick(classifyPlayerResponse(pr({ videoDetails: { isLive: true } }), OWN)), { state: 'unknown', evidence: 'no-owner' });
});
test('table: the owner from microformat alone counts', () => {
  assert.deepEqual(pick(classifyPlayerResponse(pr({ mf: { externalChannelId: OWN, liveBroadcastDetails: { isLiveNow: true } } }), OWN)), { state: 'live', evidence: 'is-live-now' });
});
test('table: another owner wins over isLive → offline (foreign-video)', () => {
  assert.deepEqual(pick(classifyPlayerResponse(pr({ videoDetails: { channelId: 'UCother', isLive: true } }), OWN)), { state: 'offline', evidence: 'foreign-video' });
});
test('table: isLive → live (is-live), with no microformat at all', () => {
  assert.deepEqual(pick(classifyPlayerResponse(pr({ videoDetails: { channelId: OWN, isLive: true } }), OWN)), { state: 'live', evidence: 'is-live' });
});
test('table: LIVE_STREAM_OFFLINE with a slate and no isUpcoming → upcoming', () => {
  const c = classifyPlayerResponse(pr({ videoDetails: { channelId: OWN }, status: slate('1793270700') }), OWN);
  assert.deepEqual([c.state, c.evidence, c.scheduledStart], ['upcoming', 'upcoming', 1793270700000]);
});
test('table: isUpcoming beats isLiveNow true (a scheduled page is never live) and has no time without a slate', () => {
  const c = classifyPlayerResponse(pr({ videoDetails: { channelId: OWN, isUpcoming: true }, mf: { liveBroadcastDetails: { isLiveNow: true } } }), OWN);
  assert.deepEqual([c.state, c.scheduledStart], ['upcoming', null]);
});
test('table: no liveBroadcastDetails says nothing → unknown, never offline', () => {
  assert.deepEqual(pick(classifyPlayerResponse(pr({ videoDetails: { channelId: OWN }, mf: {} }), OWN)), { state: 'unknown', evidence: 'no-player-response' });
  assert.deepEqual(pick(classifyPlayerResponse(pr({ videoDetails: { channelId: OWN }, mf: { liveBroadcastDetails: {} } }), OWN)), { state: 'unknown', evidence: 'no-player-response' });
});
test('table: isLiveNow false, present → offline (not-live)', () => {
  assert.deepEqual(pick(classifyPlayerResponse(pr({ videoDetails: { channelId: OWN }, mf: { liveBroadcastDetails: { isLiveNow: false } } }), OWN)), { state: 'offline', evidence: 'not-live' });
});

test('page: a watch canonical whose response names another video → unknown (needs-verify) about the canonical id', () => {
  const html = `<link rel="canonical" href="https://www.youtube.com/watch?v=canonicalid"><script>var ytInitialPlayerResponse = ${JSON.stringify(pr({ videoDetails: { channelId: OWN, isLive: true } }))};</script>`;
  const c = classifyLivePage(html, OWN);
  assert.deepEqual([c.state, c.evidence, c.videoId], ['unknown', 'needs-verify', 'canonicalid']);
});
test('page: a watch canonical with no response → unknown, about the canonical id (the caller checks its watch page)', () => {
  const c = classifyLivePage('<link rel="canonical" href="https://www.youtube.com/watch?v=canonicalid">', OWN);
  assert.deepEqual([c.state, c.evidence, c.videoId], ['unknown', 'no-player-response', 'canonicalid']);
});
test('page: no canonical, a response → classified, its own video id', () => {
  const c = classifyLivePage(`<script>var ytInitialPlayerResponse = ${JSON.stringify(pr({ videoDetails: { channelId: OWN, isLive: true } }))};</script>`, OWN);
  assert.deepEqual([c.state, c.videoId], ['live', 'abcdefghijk']);
});
test('page: only a loose videoId → unknown (needs-verify), with the id', () => {
  const c = classifyLivePage('<script>var d = {"videoId":"loosevideo1"};</script>', OWN);
  assert.deepEqual([c.state, c.evidence, c.videoId], ['unknown', 'needs-verify', 'loosevideo1']);
});
test('page: another channel\'s channel canonical is not this channel\'s "nothing live"', () => {
  assert.equal(classifyLivePage('<link rel="canonical" href="https://www.youtube.com/channel/UCother">', OWN).evidence, 'unrecognized-page');
});

// Every code this classifier emits is one of Task 3's EVIDENCE codes (config/platform-liveness.mjs):
// lowercase kebab-case, from this list.
const YT_CODES = ['is-live', 'is-live-now', 'upcoming', 'not-live', 'channel-canonical', 'foreign-video', 'no-owner', 'no-player-response', 'needs-verify', 'unrecognized-page'];
test('every evidence code produced is a known kebab-case code', () => {
  const seen = new Set();
  for (const f of ['live.html', 'live-no-microformat.html', 'upcoming-watch.html', 'none.html', 'foreign.html', 'consent.html', 'botcheck.html']) {
    for (const ch of Object.values(CH)) seen.add(classifyLivePage(read(f), ch).evidence);
  }
  for (const code of seen) {
    assert.ok(YT_CODES.includes(code), `unknown code ${code}`);
    assert.match(code, /^[a-z]+(?:-[a-z]+)*$/);
  }
});

test('retry: a consent page, then the real page on the next tick → unknown then live (nothing is remembered)', () => {
  const a = classifyLivePage(read('consent.html'), CH.live);
  const b = classifyLivePage(read('live.html'), CH.live);
  const c = classifyLivePage(read('live.html'), CH.live);
  assert.deepEqual([a.state, b.state], ['unknown', 'live']);
  assert.deepEqual(b, c, 'the same page twice reads the same');
});

test('restart: a fresh load of the copy reads every fixture as the running one does', async () => {
  const fresh = (await import(`./youtubeLive.generated.js?restart=${Date.now()}`)).YOUTUBE_LIVE;
  assert.notEqual(fresh, YOUTUBE_LIVE, 'a second module instance');
  for (const f of ['live.html', 'upcoming-watch.html', 'none.html', 'foreign.html', 'botcheck.html']) {
    assert.deepEqual(fresh.classifyLivePage(read(f), CH.live), classifyLivePage(read(f), CH.live), f);
  }
});

// Purity: the copy logs nothing (its old console.warn lines moved to youtube.js, the one caller).
// Scanned to the END of the file, so a truncated read cannot pass.
test('the copy is pure: no console, no fetch, no clock', () => {
  const src = readFileSync(new URL('./youtubeLive.generated.js', import.meta.url), 'utf8');
  assert.ok(src.trimEnd().endsWith('export { YOUTUBE_LIVE };'), 'vacuity anchor: the scan reached the end of the copy');
  for (const banned of [/\bconsole\./, /\bfetch\(/, /\bDate\.now\(/]) assert.doesNotMatch(src, banned);
});
