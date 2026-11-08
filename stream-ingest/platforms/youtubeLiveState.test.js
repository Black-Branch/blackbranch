// youtubeLiveState keeps "YouTube answered: not live" apart from "could not ask" (ADR 0133,
// research §C2), and says how sure the answer is (Task 4).
//
// Three defects this pins:
// - The sticky check on the video already being watched: when its watch page ANSWERS, owner
//   matching, isLive false and isLiveNow:false actually present, the broadcast is over — `offline`
//   at once, with no /live scrape. That answer is the only CERTAIN one the pages give (ADR 0134 E7).
// - A watch page with no liveBroadcastDetails block says nothing: reading its missing isLiveNow as
//   false would call a LIVE broadcast offline and end the night. It falls through to /live.
// - The old `:407` line: after a FAILED sticky check (the page threw, or gave no player response),
//   /live naming the same id was read as `offline`. While live, /live's canonical points at that very
//   id, so one watch-page blip became a confident "ended". Once offline counts at once, that would end
//   the night on a fetch error; it must read `unknown` (sticky-check-failed).
// And Task 4's: a scheduled broadcast reads `upcoming`, never live and never offline, with its start.
//
// Run: node --test platforms/youtubeLiveState.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

delete process.env.YOUTUBE_VIDEO_ID;
const { youtubeLiveState } = await import('./youtube.js');

const CH = 'UCcaseytestchannel00000';
const VID = 'abcdefghijk';
const html = (s, status = 200) => new Response(s, { status, headers: { 'content-type': 'text/html' } });
// A player response. `live`: isLiveNow in liveBroadcastDetails, or the block left out when undefined.
const playerResponse = ({ id = VID, live, isLive = false, owner = CH }) => `<script>var ytInitialPlayerResponse = ${JSON.stringify({
  videoDetails: { videoId: id, channelId: owner, ...(isLive ? { isLive: true } : {}) },
  microformat: { playerMicroformatRenderer: { externalChannelId: owner, ...(live === undefined ? {} : { liveBroadcastDetails: { isLiveNow: live } }) } },
})};</script>`;
const watchPage = (o) => html(playerResponse(o));
const liveCanonical = (id, body = '') => html(`<link rel="canonical" href="https://www.youtube.com/watch?v=${id}">${body}`);
const channelCanonical = () => html(`<link rel="canonical" href="https://www.youtube.com/channel/${CH}">`);
// The full answer: state, the video it is about ('' unless live or upcoming), how sure, why, and a start.
const ans = (state, videoId, certain, evidence, scheduledStart = null) => ({ state, videoId, certain, evidence, scheduledStart });

/** Mock fetch from a routing table; returns the list of URLs asked, in order. */
function mockFetch(route) {
  const asked = [];
  const real = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    asked.push(u);
    const r = route(u);
    if (r instanceof Error) throw r;
    if (!r) throw new Error(`unexpected request: ${u}`);
    return r;
  };
  return { asked, restore: () => { global.fetch = real; } };
}
const isWatch = (u, id = VID) => u.startsWith(`https://www.youtube.com/watch?v=${id}`);
const isLive = (u) => u.startsWith(`https://www.youtube.com/channel/${CH}/live`);
const quiet = async (fn) => {
  const warn = console.warn;
  console.warn = () => {};
  try { return await fn(); } finally { console.warn = warn; }
};

test('(a) the known id\'s watch page answers isLiveNow:false, owner matching → offline, CERTAIN, and /live is never asked', async () => {
  const f = mockFetch((u) => (isWatch(u) ? watchPage({ live: false }) : null));
  try {
    assert.deepEqual(await youtubeLiveState(CH, { knownId: VID, allowEnvOverride: false }), ans('offline', '', true, 'not-live'));
    assert.equal(f.asked.length, 1, `one request, the watch page: ${f.asked.join(' , ')}`);
    assert.ok(!f.asked.some(isLive), 'no /live scrape after an answered end');
  } finally { f.restore(); }
});

test('(b) the known id\'s page has NO liveBroadcastDetails, /live answers the same id live → live (a missing block is not "ended")', async () => {
  const f = mockFetch((u) => (isWatch(u) ? watchPage({}) : isLive(u) ? liveCanonical(VID, playerResponse({ live: true })) : null));
  try {
    assert.deepEqual(await youtubeLiveState(CH, { knownId: VID, allowEnvOverride: false }), ans('live', VID, false, 'is-live-now'));
    assert.ok(f.asked.some(isLive), 'the undecided sticky check falls through to /live');
  } finally { f.restore(); }
});

test('(b2) no liveBroadcastDetails on the known page and nothing more from /live than its canonical → unknown, never offline', async () => {
  const f = mockFetch((u) => (isWatch(u) ? watchPage({}) : isLive(u) ? liveCanonical(VID) : null));
  try {
    assert.deepEqual(await quiet(() => youtubeLiveState(CH, { knownId: VID, allowEnvOverride: false })), ans('unknown', '', false, 'sticky-check-failed'));
  } finally { f.restore(); }
});

test('(b3) videoDetails.isLive true with no liveBroadcastDetails → live, /live not asked', async () => {
  const f = mockFetch((u) => (isWatch(u) ? watchPage({ isLive: true }) : null));
  try {
    assert.deepEqual(await youtubeLiveState(CH, { knownId: VID, allowEnvOverride: false }), ans('live', VID, false, 'is-live'));
    assert.equal(f.asked.length, 1);
  } finally { f.restore(); }
});

test('(c) the known id\'s watch page throws and /live still names that id → unknown (sticky-check-failed), never offline (the :407 fix)', async () => {
  const f = mockFetch((u) => (isWatch(u) ? new Error('ECONNRESET') : isLive(u) ? liveCanonical(VID) : null));
  try {
    const r = await quiet(() => youtubeLiveState(CH, { knownId: VID, allowEnvOverride: false }));
    assert.deepEqual(r, ans('unknown', '', false, 'sticky-check-failed'));
    assert.ok(f.asked.some(isLive), 'the failed sticky check falls through to /live');
  } finally { f.restore(); }
});

test('(c2) the known id\'s watch page gives no player response (a bot-check page) → the same: unknown', async () => {
  const f = mockFetch((u) => (isWatch(u) ? html('<html>consent</html>') : isLive(u) ? liveCanonical(VID) : null));
  try {
    assert.deepEqual(await quiet(() => youtubeLiveState(CH, { knownId: VID, allowEnvOverride: false })), ans('unknown', '', false, 'sticky-check-failed'));
  } finally { f.restore(); }
});

test('(c3) the known id\'s page answers live → live on that id, /live not asked', async () => {
  const f = mockFetch((u) => (isWatch(u) ? watchPage({ live: true }) : null));
  try {
    assert.deepEqual(await youtubeLiveState(CH, { knownId: VID, allowEnvOverride: false }), ans('live', VID, false, 'is-live-now'));
    assert.equal(f.asked.length, 1);
  } finally { f.restore(); }
});

test('(d) the known id\'s page throws and /live answers the channel page with no candidate → offline, but NOT certain (Task 1\'s rule stands)', async () => {
  const f = mockFetch((u) => (isWatch(u) ? new Error('ECONNRESET') : isLive(u) ? channelCanonical() : null));
  try {
    assert.deepEqual(await youtubeLiveState(CH, { knownId: VID, allowEnvOverride: false }), ans('offline', '', false, 'channel-canonical'));
  } finally { f.restore(); }
});

test('retry: a failed watch-page fetch, then the next tick\'s page answers live → unknown then live, never offline', async () => {
  let fail = true;
  const f = mockFetch((u) => {
    if (isWatch(u)) return fail ? new Error('ETIMEDOUT') : watchPage({ live: true });
    if (isLive(u)) return liveCanonical(VID);
    return null;
  });
  try {
    const first = await quiet(() => youtubeLiveState(CH, { knownId: VID, allowEnvOverride: false }));
    fail = false;
    const second = await youtubeLiveState(CH, { knownId: VID, allowEnvOverride: false });
    assert.deepEqual([first.state, second.state], ['unknown', 'live']);
    assert.equal(second.videoId, VID);
  } finally { f.restore(); }
});

test('restart: a fresh reader (no known id) mid-tail — /live names the ended video, its page answers not-live → offline, not certain (no known broadcast yet)', async () => {
  const f = mockFetch((u) => (isLive(u) ? liveCanonical(VID) : isWatch(u) ? watchPage({ live: false }) : null));
  try {
    assert.deepEqual(await youtubeLiveState(CH, { knownId: '', allowEnvOverride: false }), ans('offline', '', false, 'not-live'));
  } finally { f.restore(); }
});

// The 2026-10-24 03:36–04:18 journal, mid-stream with chat delivering: the known video's page did not
// answer and /live named a foreign recommendation, a dozen times in forty minutes. Before 0133 the
// chat hold masked it; once offline counts, reading that as offline would end a YouTube-only night.
const FOREIGN = 'zyxwvutsrqp';
const OTHER_CH = 'UCsomeoneelse0000000000';
const noCanonicalWith = (id) => html(`<html><script>var d = {"videoId":"${id}"};</script></html>`);
const offlinePage = (rec) => html(`<link rel="canonical" href="https://www.youtube.com/channel/${CH}"><script>var d = {"videoId":"${rec}"};</script>`);

test('mid-stream blip (10-24 03:36): known page unreadable, /live with no canonical names a foreign video → unknown', async () => {
  const f = mockFetch((u) => {
    if (isWatch(u)) return html('<html>consent</html>');
    if (isLive(u)) return noCanonicalWith(FOREIGN);
    if (isWatch(u, FOREIGN)) return watchPage({ live: true, owner: OTHER_CH });
    return null;
  });
  try {
    assert.deepEqual(await quiet(() => youtubeLiveState(CH, { knownId: VID, allowEnvOverride: false })), ans('unknown', '', false, 'foreign-video'));
  } finally { f.restore(); }
});

test('known page unreadable, /live with no canonical and no video at all → unknown', async () => {
  const f = mockFetch((u) => (isWatch(u) ? new Error('ECONNRESET') : isLive(u) ? html('<html></html>') : null));
  try {
    assert.deepEqual(await quiet(() => youtubeLiveState(CH, { knownId: VID, allowEnvOverride: false })), ans('unknown', '', false, 'unrecognized-page'));
  } finally { f.restore(); }
});

test('known page unreadable, /live is YouTube\'s no-live page (channel canonical + a recommendation, as fetched 10-24) → offline, not certain', async () => {
  const f = mockFetch((u) => {
    if (isWatch(u)) return new Error('ECONNRESET');
    if (isLive(u)) return offlinePage(FOREIGN);
    if (isWatch(u, FOREIGN)) return watchPage({ live: false, owner: OTHER_CH });
    return null;
  });
  try {
    assert.deepEqual(await quiet(() => youtubeLiveState(CH, { knownId: VID, allowEnvOverride: false })), ans('offline', '', false, 'channel-canonical'));
  } finally { f.restore(); }
});

test('known page unreadable, /live names a NEW live video of ours → live on the new id', async () => {
  const NEW = 'newbroadcst';
  const f = mockFetch((u) => {
    if (isWatch(u)) return new Error('ECONNRESET');
    if (isLive(u)) return liveCanonical(NEW);
    if (isWatch(u, NEW)) return watchPage({ id: NEW, live: true });
    return null;
  });
  try {
    assert.deepEqual(await youtubeLiveState(CH, { knownId: VID, allowEnvOverride: false }), ans('live', NEW, false, 'is-live-now'));
  } finally { f.restore(); }
});

test('no known id (nothing being watched): a no-canonical page naming a foreign video still reads offline, as before', async () => {
  const f = mockFetch((u) => (isLive(u) ? noCanonicalWith(FOREIGN) : isWatch(u, FOREIGN) ? watchPage({ live: true, owner: OTHER_CH }) : null));
  try {
    assert.deepEqual(await quiet(() => youtubeLiveState(CH, { knownId: '', allowEnvOverride: false })), ans('offline', '', false, 'foreign-video'));
  } finally { f.restore(); }
});

test('a known id whose page names another owner is not trusted as offline: /live decides', async () => {
  const f = mockFetch((u) => (isWatch(u) ? watchPage({ live: false, owner: 'UCsomeoneelse0000000000' }) : isLive(u) ? liveCanonical(VID) : null));
  try {
    assert.deepEqual(await quiet(() => youtubeLiveState(CH, { knownId: VID, allowEnvOverride: false })), ans('unknown', '', false, 'sticky-check-failed'));
    assert.ok(f.asked.some(isLive));
  } finally { f.restore(); }
});

test('certain is true ONLY on the known video\'s own answered not-live; every other offline is uncertain', async () => {
  const cases = [
    [{ knownId: VID }, (u) => (isWatch(u) ? watchPage({ live: false }) : null), true],
    [{ knownId: VID }, (u) => (isWatch(u) ? new Error('x') : isLive(u) ? channelCanonical() : null), false],
    [{ knownId: '' }, (u) => (isLive(u) ? channelCanonical() : null), false],
    [{ knownId: '' }, (u) => (isLive(u) ? liveCanonical(VID) : isWatch(u) ? watchPage({ live: false }) : null), false],
  ];
  for (const [opts, route, certain] of cases) {
    const f = mockFetch(route);
    try {
      const r = await quiet(() => youtubeLiveState(CH, { ...opts, allowEnvOverride: false }));
      assert.equal(r.state, 'offline');
      assert.equal(r.certain, certain, JSON.stringify(r));
    } finally { f.restore(); }
  }
});

// Through the shared classifier (config/youtube-live.mjs), on the real pages in fixtures/youtube/.
const fixture = (name) => readFileSync(new URL(`./fixtures/youtube/${name}`, import.meta.url), 'utf8');
const NASA = 'UCLA_DiR1FfKNvjuUpBHmylQ';
const LOFI = 'UCSJ4gkVC6NrvII8umztf0Ow';
const liveOf = (ch) => (u) => u.startsWith(`https://www.youtube.com/channel/${ch}/live`);
const canonicalId = (name) => fixture(name).match(/watch\?v=([\w-]{11})/)[1];
// The fixture's own countdown slate (epoch seconds), so the expected start is the page's, not a typed number.
const slateStart = (name) => Number(fixture(name).match(/scheduledStartTime":"(\d+)"/)[1]) * 1000;

test('a scheduled broadcast on /live (our waiting room) is never live: it reads upcoming, with its start', async () => {
  const UP = canonicalId('upcoming-watch.html');
  const f = mockFetch((u) => (liveOf(NASA)(u) || isWatch(u, UP) ? html(fixture('upcoming-watch.html')) : null));
  try {
    assert.deepEqual(await youtubeLiveState(NASA, { knownId: '', allowEnvOverride: false }),
      ans('upcoming', UP, false, 'upcoming', slateStart('upcoming-watch.html')));
    assert.equal(f.asked.length, 1, 'the /live page itself answered');
  } finally { f.restore(); }
});

test('the known video is scheduled (its page answers upcoming) → upcoming with its start; /live is still read, and showing the same schedule leaves it standing', async () => {
  const UP = canonicalId('upcoming-watch.html');
  const f = mockFetch((u) => (isWatch(u, UP) || liveOf(NASA)(u) ? html(fixture('upcoming-watch.html')) : null));
  try {
    assert.deepEqual(await youtubeLiveState(NASA, { knownId: UP, allowEnvOverride: false }),
      ans('upcoming', UP, false, 'upcoming', slateStart('upcoming-watch.html')));
    assert.ok(f.asked.some(liveOf(NASA)), 'a countdown must not stop /live being read');
  } finally { f.restore(); }
});

// Review I1: a countdown open on X, and the channel goes live on ANOTHER video (an early start on a
// new broadcast, or a forgotten overdue schedule). Before the fix the sticky path returned X's
// upcoming without ever fetching /live, so the reader read upcoming all night.
test('upcoming X, then live on another video Y → live, key = Y (the countdown is overtaken)', async () => {
  const Y = 'newbroadcst';
  const f = mockFetch((u) => {
    if (isWatch(u, VID)) return html(`<link rel="canonical" href="https://www.youtube.com/watch?v=${VID}"><script>var ytInitialPlayerResponse = ${JSON.stringify({
      videoDetails: { videoId: VID, channelId: CH, isUpcoming: true },
      playabilityStatus: { status: 'LIVE_STREAM_OFFLINE', liveStreamability: { liveStreamabilityRenderer: { offlineSlate: { liveStreamOfflineSlateRenderer: { scheduledStartTime: '1793270700' } } } } },
      microformat: { playerMicroformatRenderer: { externalChannelId: CH, liveBroadcastDetails: { isLiveNow: false } } },
    })};</script>`);
    if (isLive(u)) return liveCanonical(Y);
    if (isWatch(u, Y)) return watchPage({ id: Y, live: true });
    return null;
  });
  try {
    assert.deepEqual(await youtubeLiveState(CH, { knownId: VID, allowEnvOverride: false }), ans('live', Y, false, 'is-live-now'));
  } finally { f.restore(); }
});

test('upcoming X, and /live fails or shows nothing live → still upcoming X (a blip never drops the countdown)', async () => {
  for (const liveRoute of [() => new Error('ECONNRESET'), () => channelCanonical(), () => html('<html>consent</html>')]) {
    const f = mockFetch((u) => {
      if (isWatch(u, VID)) return html(`<script>var ytInitialPlayerResponse = ${JSON.stringify({
        videoDetails: { videoId: VID, channelId: CH, isUpcoming: true },
        microformat: { playerMicroformatRenderer: { externalChannelId: CH } },
      })};</script>`);
      if (isLive(u)) return liveRoute();
      return null;
    });
    try {
      const r = await quiet(() => youtubeLiveState(CH, { knownId: VID, allowEnvOverride: false }));
      assert.equal(r.state, 'upcoming', JSON.stringify(r));
      assert.equal(r.videoId, VID);
    } finally { f.restore(); }
  }
});

test('live on the known video, its check fails, and /live shows ANOTHER scheduled video of ours → unknown, never upcoming (a schedule must not end a live night)', async () => {
  const UP = canonicalId('upcoming-watch.html');
  const f = mockFetch((u) => (isWatch(u, VID) ? new Error('ECONNRESET') : liveOf(NASA)(u) || isWatch(u, UP) ? html(fixture('upcoming-watch.html')) : null));
  try {
    const r = await quiet(() => youtubeLiveState(NASA, { knownId: VID, allowEnvOverride: false }));
    assert.equal(r.state, 'unknown', JSON.stringify(r));
  } finally { f.restore(); }
});

test('a real /live page with no microformat, ours and live → live on its canonical id, in one request', async () => {
  const f = mockFetch((u) => (liveOf(LOFI)(u) ? html(fixture('live-no-microformat.html')) : null));
  try {
    assert.deepEqual(await youtubeLiveState(LOFI, { knownId: '', allowEnvOverride: false }), ans('live', canonicalId('live-no-microformat.html'), false, 'is-live'));
    assert.equal(f.asked.length, 1, 'the page itself answered: no second fetch');
  } finally { f.restore(); }
});

test('YouTube\'s real no-live page (channel canonical + a recommendation) → offline, without checking the recommendation', async () => {
  const MKBHD = 'UCBJycsmduvYEL83R_U4JriQ';
  const f = mockFetch((u) => (liveOf(MKBHD)(u) ? html(fixture('none.html')) : null));
  try {
    assert.deepEqual(await youtubeLiveState(MKBHD, { knownId: VID, allowEnvOverride: false }), ans('offline', '', false, 'channel-canonical'));
  } finally { f.restore(); }
});

// Step 2 of the brief: our OWN channel's /live while a broadcast is scheduled (an unlisted test
// broadcast k schedules ~45 min ahead, chat on). Until that page is captured as
// fixtures/youtube/upcoming-own-live.html this stays a todo, and Task 4 is not done.
test.todo('upcoming-own-live.html: classifyLivePage on our own /live during a schedule → upcoming, owner = our channel');
