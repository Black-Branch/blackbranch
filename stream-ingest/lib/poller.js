// Viewer poller + stream lifecycle. Lives here because stream-ingest already
// holds the platform credentials (the Twitch bot token or the Twitch app pair,
// the Kick app pair, the YouTube API key). Calls stream-api's stream
// start/end/snapshot endpoints.
//
//   • Lifecycle (session open/close) is an OR across Twitch, YouTube, and Kick:
//     any one of them going live opens or sustains a session; the session
//     closes only once every configured platform has independently confirmed
//     offline (with consecutive-miss hysteresis on that transition only — a
//     live reading is never delayed).
//   • While a session is open, polls viewer counts for ALL platforms: Twitch
//     viewer_count, YouTube "watching now" (chat watcher's videoId first,
//     zero-quota /live scrape as id fallback; count via zero-quota InnerTube
//     updated_metadata, 1-unit videos.list as count fallback — sticky id +
//     last-good cache), Kick (official public API with app token; v2 scrape
//     fallback), and stream.place (read passively off the chat WS's viewer
//     frames via the connector handle).
//   • stream.place votes too: its chat socket carries the channel's
//     livestream record, and the reader turns it into live/offline/unknown
//     (platforms/streamplace.js streamplaceLiveness). Without it a
//     stream.place-only install never opens a session.
//   • YouTube votes from the chat reader's verified video id; when NO reader is
//     running (it failed to start — no browser — or is still starting) the
//     poller asks YouTube itself with the same zero-quota lookup, and a
//     lookup that failed votes unknown, never offline.

import { getAccessToken, refreshAccessToken } from './twitchToken.js';
import { postStreamStart, postStreamEnd, postViewerSnapshot, getCurrentStream } from './api.js';
import { findLiveVideoId, fetchWatchingNow, youtubeLiveState } from '../platforms/youtube.js';
import { fetchKickState } from '../platforms/kick.js';
import { instanceConfig } from './instanceConfig.js';

// Instance keys, read at call time (an edit applies without a restart): the channel's numeric
// Twitch id, the YouTube Data API key and the YouTube channel id.
const broadcasterId = () => instanceConfig.get('platform.twitch.broadcasterId') || '';
const ytApiKey = () => instanceConfig.get('youtube.apiKey') || '';
const ytChannelId = () => instanceConfig.get('platform.youtube.channelId') || '';
// The install's Twitch app (the setup wizard's client id + secret).
const twitchAppId = () => instanceConfig.get('twitch.clientId') || '';
const twitchAppSecret = () => instanceConfig.get('twitch.clientSecret') || '';
const kickSlug = () => instanceConfig.get('platform.kick.slug') || '';
const YT_INNERTUBE = process.env.YT_INNERTUBE_VIEWERS !== '0'; // zero-quota primary; =0 reverts to videos.list only
const POLL_MS = Number(process.env.VIEWER_POLL_MS || 60000);
const IDLE_POLL_MS = Number(process.env.VIEWER_IDLE_POLL_MS || 180000);

// Pure so the idle/live cadence choice is testable without the real timer.
export function nextPollDelay(sessionOpen) {
  return sessionOpen ? POLL_MS : IDLE_POLL_MS;
}
const nowSec = () => Math.floor(Date.now() / 1000);

let clientId = '';     // the bot token's client-id (from the validate endpoint)
let ytVideoId = '';    // cached live videoId; cleared when the stream ends
let ytEndedMisses = 0; // consecutive videos.list "no concurrentViewers" answers
let lastGoodYt = null; // { count, at } — smooths one-tick gaps (5-min staleness)
const YT_VIEWER_STALE_MS = 5 * 60 * 1000;
const TW_OFFLINE_MISS_THRESHOLD = 2;
const KICK_OFFLINE_MISS_THRESHOLD = 2;
// This counter closes a DIFFERENT gap from `ytEndedMisses` (in youtubeViewers):
// that one debounces a DEFINITIVE "ended" answer from videos.list. This one
// debounces the liveness READING itself, so a single transient
// `findLiveVideoId` failure returning '' does not vote `offline`. Same
// threshold as the other two platforms.
//
// The two layers STACK, on purpose: a real end costs ytEndedMisses >= 2
// (videos.list confirms no viewers) PLUS this counter's own threshold (the
// liveness vote must also read offline that many times) before the session
// closes for YouTube. Merging them into one counter would remove the debounce
// on whichever layer got merged away.
const YT_OFFLINE_MISS_THRESHOLD = 2;
const twOffline = createMissCounter(TW_OFFLINE_MISS_THRESHOLD);
const kickOffline = createMissCounter(KICK_OFFLINE_MISS_THRESHOLD);
const ytOffline = createMissCounter(YT_OFFLINE_MISS_THRESHOLD);
// stream.place's own record already debounces (idleTimeoutSeconds); one more miss keeps a socket
// hiccup from ending a session.
const spOffline = createMissCounter(2);
// The last live id the poller's OWN YouTube lookup found (no reader running) — re-verified directly
// on the next tick instead of scraping /live again (youtubeLiveState's sticky path).
let ytOwnId = '';
// Read by startPoller's adaptive scheduler after every tick.
let sessionOpenNow = false;
// The forced-offline hold (see forcedHold): when this poller last saw every
// platform confirm offline, and whether the hold has been logged this episode.
let lastAllOfflineAt = null;
let holdLogged = false;
// Whether "no platform is configured" has been logged since one last was.
let noneLogged = false;

// Consecutive-miss debounce, shared by every platform's offline-declaration.
// A single bad reading (timeout, transient 5xx, a Kick is_live glitch) must
// not immediately count as "this platform ended" — only `threshold`
// consecutive offline readings do. A live reading is never delayed.
export function createMissCounter(threshold) {
  let misses = 0;
  return {
    record(raw) {
      if (raw === 'live') { misses = 0; return 'live'; }
      if (raw === 'unknown') return 'unknown';
      misses += 1;
      return misses >= threshold ? 'offline' : 'unknown';
    },
  };
}

async function ensureClientId(token) {
  if (clientId) return clientId;
  try {
    const v = await (await fetch('https://id.twitch.tv/oauth2/validate',
      { headers: { Authorization: 'OAuth ' + token }, signal: AbortSignal.timeout(8000) })).json();
    clientId = v.client_id || '';
  } catch (e) { console.warn('[poller] validate:', e.message); }
  return clientId;
}

// Client-credentials app token for the install's Twitch app — what live status runs on when no
// bot account is signed in (the setup wizard asks for the app pair and the broadcaster id only).
// Cached until a minute before expiry; `fresh` (after a Helix 401) drops it and mints anew. Throws
// on an HTTP or shape failure, which twitchStatus reads as 'unknown'. stream-api keeps its own
// cache for its own lookups (stream-api/twitch-app.js): one app may hold several app tokens.
let twitchApp = null; // { token, expiresAt, id }
async function twitchAppToken({ fresh = false } = {}) {
  const id = twitchAppId();
  const secret = twitchAppSecret();
  if (!fresh && twitchApp && twitchApp.id === id && Date.now() < twitchApp.expiresAt - 60_000) return twitchApp.token;
  twitchApp = null;
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`app token HTTP ${res.status}`);
  const j = await res.json();
  if (!j.access_token) throw new Error('app token response missing access_token');
  twitchApp = { token: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000, id };
  return twitchApp.token;
}

// Twitch live status + viewer count. Two ways to ask Helix: the bot account's user token when one
// is signed in (preferred — it is what an install that has one always used), else the install's
// Twitch app with a client-credentials token. Either is renewed once on a 401.
// Returns { state: 'live'|'offline'|'unknown'|null, viewers }:
//   • 'offline' — Helix answered, with an empty `data` array. A real "not streaming".
//   • 'unknown' — could not ask, or could not read the answer (no client-id,
//     HTTP error, network/timeout, a body with no `data` array). Votes neither
//     way, and never advances the offline miss counter.
//   • null      — Twitch is not configured here at all (no bot token and no app
//     pair, or no broadcaster id). Excluded from
//     the vote entirely rather than held as a permanent 'unknown', which would
//     make `allConfirmedOffline` unreachable and leave the session open forever.
//
// Keeping 'unknown' apart from 'offline' means a Twitch API blip is never read
// as the stream ending. In particular a 401 that survives the refresh returns an
// error envelope, which must not be read as an empty `data` array.
export async function twitchStatus() {
  const botToken = getAccessToken();
  const viaApp = !botToken && twitchAppId() !== '' && twitchAppSecret() !== '';
  if (!botToken && !viaApp) return { state: null, viewers: 0 };
  // No channel id configured is "not configured" too — never a query for user_id= (nothing).
  if (!broadcasterId()) return { state: null, viewers: 0 };
  const call = (t, c) => fetch(`https://api.twitch.tv/helix/streams?user_id=${broadcasterId()}`,
    { headers: { 'Client-Id': c, Authorization: 'Bearer ' + t }, signal: AbortSignal.timeout(8000) });
  try {
    let token = botToken;
    let cid;
    if (viaApp) {
      token = await twitchAppToken();
      cid = twitchAppId();
    } else {
      cid = await ensureClientId(token);
      if (!cid) return { state: 'unknown', viewers: 0 };
    }
    let res = await call(token, cid);
    if (res.status === 401) {                 // token expired → renew + retry once
      if (viaApp) {
        token = await twitchAppToken({ fresh: true });
      } else {
        token = await refreshAccessToken();
        clientId = ''; cid = await ensureClientId(token);
      }
      res = await call(token, cid);
    }
    if (!res.ok) { console.warn(`[poller] twitch: HTTP ${res.status} — unknown, not offline`); return { state: 'unknown', viewers: 0 }; }
    const j = await res.json();
    // A successful Helix answer is ALWAYS an array; empty means "not streaming".
    // Anything else is a shape we cannot read, which is not evidence of an end.
    if (!Array.isArray(j?.data)) { console.warn('[poller] twitch: no data array in Helix body — unknown, not offline'); return { state: 'unknown', viewers: 0 }; }
    const s = j.data[0];
    return s ? { state: 'live', viewers: Number(s.viewer_count) || 0 } : { state: 'offline', viewers: 0 };
  } catch (e) { console.warn('[poller] twitch:', e.message); return { state: 'unknown', viewers: 0 }; }
}

// YouTube concurrent viewers — only called WHILE live. The chat watcher's
// videoId is authoritative (ownership + isLiveNow verified, 3-miss debounced);
// the ZERO-quota /live scrape is only the fallback when the watcher has none.
// The COUNT comes from zero-quota InnerTube updated_metadata first, then the
// cheap videos.list (1 unit) as fallback. The videoId is STICKY: the /live
// scrape can fail most ticks (foreign recommended videos, "no player
// response"), and clearing the id on every miss would make the count spotty.
// Network errors keep the id; only two consecutive "videos.list answered but
// no concurrentViewers" ticks (with no watcher id) drop it. search.list is
// avoided: it costs 100 units per call.
const staleYt = () =>
  lastGoodYt && Date.now() - lastGoodYt.at < YT_VIEWER_STALE_MS ? lastGoodYt.count : null;

async function youtubeViewers(getYtVideoId) {
  if (!ytApiKey() && !YT_INNERTUBE) return null;
  try {
    const watcherId = getYtVideoId ? getYtVideoId() : '';
    if (watcherId && watcherId !== ytVideoId) { ytVideoId = watcherId; ytEndedMisses = 0; }
    if (!ytVideoId) {
      ytVideoId = (await findLiveVideoId(ytChannelId())) || '';
      if (!ytVideoId) return staleYt();
    }
    // PRIMARY: zero-quota InnerTube "watching now". A number here means the
    // stream is live and this tick is done. ANYTHING else — ended
    // (isLive:false), endpoint drift, parse refusal, network error — falls
    // through to the 1-unit videos.list below, which keeps SOLE custody of the
    // ended/sticky-id bookkeeping (ytEndedMisses). So InnerTube only ever adds
    // a cheaper source and never changes lifecycle behavior.
    // Kill switch: YT_INNERTUBE_VIEWERS=0 (unofficial endpoint insurance).
    if (YT_INNERTUBE) {
      try {
        const n = await fetchWatchingNow(ytVideoId);
        if (n != null) {
          ytEndedMisses = 0;
          lastGoodYt = { count: n, at: Date.now() };
          return n;
        }
      } catch (e) { console.warn('[poller] youtube innertube:', e.message); }
    }
    // Keyless degradation: without the Data API there is no fallback — serve
    // last-good and let the sticky id refresh via the watcher/scrape, so the
    // primary still works on an install without a key.
    if (!ytApiKey()) return staleYt();
    const vUrl = `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${ytVideoId}&key=${ytApiKey()}`;
    const vj = await (await fetch(vUrl, { signal: AbortSignal.timeout(8000) })).json();
    const cv = vj.items?.[0]?.liveStreamingDetails?.concurrentViewers;
    if (cv == null) {
      // Definitive answer with no live count: ended — or a transient API gap.
      // While the watcher still vouches for the id, trust it and serve last-good.
      if (!watcherId && ++ytEndedMisses >= 2) { ytVideoId = ''; ytEndedMisses = 0; lastGoodYt = null; return null; }
      return staleYt();
    }
    ytEndedMisses = 0;
    const n = Number(cv) || 0;
    lastGoodYt = { count: n, at: Date.now() };
    return n;
  } catch (e) { console.warn('[poller] youtube:', e.message); return staleYt(); }
}

// Pure: the body of one viewer snapshot. The live YouTube broadcast id rides
// along so stream-api can hand the site an id to embed
// instead of the undocumented `live_stream?channel=` form. The id passed in
// is the chat WATCHER's (`getVideoId`: ownership + isLiveNow verified, 3-miss
// debounced, '' once YouTube is confirmed off) — NOT this module's sticky
// `ytVideoId`, which the viewer-count path keeps across errors and drops only
// after two misses, and would hand the site an ended broadcast's archive at
// 0:00 while Twitch kept the session open. '' → null; stream-api validates
// the shape at its end (the trust boundary).
export function snapshotBody({ streamId, twRaw, yt, kickRaw, sp, ytVideoId }) {
  return {
    streamId,
    twitch: twRaw.state === 'live' && twRaw.viewers > 0 ? twRaw.viewers : null,
    youtube: yt,
    kick: kickRaw.viewers,
    streamplace: sp,
    ytVideoId: ytVideoId || null,
  };
}

// One tick's session decision, extracted pure so it is testable: a FAILED
// getCurrentStream read is NOT "no live session". Minting a fresh streamId on
// a read error would fork a second open stream.sessions row mid-stream,
// re-arming every viewer's first-message bonus and fragmenting
// stats/snapshots. Only a SUCCESSFUL read may start or end a session;
// "couldn't ask" skips the tick and the next one re-asks.
export function sessionDecision({ curFailed, curLive, anyPlatformLive, heldOffline = false }) {
  if (curFailed) return 'skip';
  if (anyPlatformLive) return curLive ? 'snapshot' : heldOffline ? 'hold' : 'start';
  return curLive ? 'maybe-end' : 'idle';
}

// A mod's "force offline" (stream-api reports it as `forcedEndAt` on
// /stream/current, for two hours) holds a new session back until this
// poller has SEEN every platform confirm offline since the press. Without
// it the very next tick would re-open a session while another platform still
// reports live — a phantom second session, under which the credit pool
// re-keys the night's supporters as the previous stream's cohort.
export function forcedHold({ forcedEndAt, lastAllOfflineAt }) {
  if (!forcedEndAt) return false;
  return lastAllOfflineAt == null || lastAllOfflineAt < forcedEndAt;
}

// Which platforms get a vote this tick, and what the vote says. Pure so the
// composition is testable.
// A `null` state means NOT CONFIGURED, which is different from 'unknown': an
// unconfigured platform must not vote at all, because a permanent 'unknown'
// would make `allConfirmedOffline` unreachable and the session could never close.
export function aggregateLiveness(platforms) {
  const voting = platforms.filter((p) => p.state != null);
  return {
    voting,
    anyPlatformLive: voting.some((p) => p.state === 'live'),
    // `[].every()` is vacuously TRUE — without the length guard, a setup with
    // nothing configured would read as "everyone confirmed offline" off zero
    // evidence and close the session.
    allConfirmedOffline: voting.length > 0 && voting.every((p) => p.state === 'offline'),
  };
}

/**
 * YouTube's reading for this tick. The reader's id when a reader runs ('' = it says not live);
 * with no reader (`watcher` null) the poller's own lookup while YouTube is chosen. Exported for
 * pollerYoutubeNoReader.test.js. Returns the raw reading (before the miss counter) and the verified
 * live id, or null when YouTube does not vote.
 * @returns {Promise<{ raw: 'live'|'offline'|'unknown', videoId: string } | null>}
 */
export async function youtubeReading({ watcher, wanted, channelId = ytChannelId(), lookup = youtubeLiveState }) {
  if (!channelId || !(ytApiKey() || YT_INNERTUBE)) return null;
  if (watcher != null) return { raw: watcher !== '' ? 'live' : 'offline', videoId: watcher };
  if (!wanted) return null;
  const r = await lookup(channelId, { knownId: ytOwnId });
  ytOwnId = r.state === 'live' ? r.videoId : r.state === 'offline' ? '' : ytOwnId;
  return { raw: r.state, videoId: r.state === 'live' ? r.videoId : '' };
}

async function tick({ getStreamplaceViewers, getStreamplaceState, getYtVideoId, ytWanted }) {
  // When this tick's platform reads happen — the all-offline observation is
  // stamped with THIS, not with the later moment the session read resolves,
  // or a forced end landing in that gap would be judged against evidence
  // that predates it (pollerHold: "an all-offline seen BEFORE the press").
  const tickAt = Date.now();
  try {
    // Kick with no channel set is not configured: it does not vote (a request for an empty slug
    // would only ever answer 'unknown', which would hold every session open forever).
    const kickUnconfigured = { state: null, viewers: null };
    const [twRaw, kickRaw] = await Promise.all([twitchStatus(), kickSlug() ? fetchKickState() : kickUnconfigured]);
    // Only a configured platform's reading goes through its miss counter — a
    // null (unconfigured) state must not be fed in as a miss.
    const twState = twRaw.state == null ? null : twOffline.record(twRaw.state);
    const kickState = kickRaw.state == null ? null : kickOffline.record(kickRaw.state);

    // YouTube votes while there is a channel to watch and a reader to ask — the chat reader, or
    // with none running, the poller's own lookup (youtubeReading). A Data API key is not needed:
    // liveness is a verified video id, the count InnerTube's.
    const yt = await youtubeReading({
      watcher: typeof getYtVideoId === 'function' ? getYtVideoId() : null,
      wanted: typeof ytWanted === 'function' ? ytWanted() === true : typeof getYtVideoId === 'function',
    });
    const ytConfigured = yt !== null;
    const ytLiveId = yt?.videoId || '';
    const ytState = yt ? ytOffline.record(yt.raw) : null;
    // stream.place: the reader's reading of its own livestream record; null = no reader running.
    const spRaw = typeof getStreamplaceState === 'function' ? getStreamplaceState() : null;
    const spState = spRaw == null ? null : spOffline.record(spRaw);

    const { voting, anyPlatformLive, allConfirmedOffline } = aggregateLiveness([
      { name: 'twitch', state: twState },
      { name: 'kick', state: kickState },
      { name: 'youtube', state: ytState },
      { name: 'streamplace', state: spState },
    ]);
    // Nothing configured (yet — settings are read live, so a channel saved later is picked up on
    // the next tick): no vote, so the poller neither starts nor ends anything, and does not ask
    // stream-api. A session opened by hand is left alone.
    if (voting.length === 0) {
      if (!noneLogged) { console.log('[poller] no platform configured for live status — idle until one is'); noneLogged = true; }
      sessionOpenNow = false;
      return;
    }
    noneLogged = false;
    // Log every platform, voting or not, so a platform dropping out of the vote
    // is visible in the journal rather than just vanishing from the line.
    console.log(`[poller] platform states: twitch=${twState ?? 'unconfigured'} kick=${kickState ?? 'unconfigured'} youtube=${ytState ?? 'unconfigured'} streamplace=${spState ?? 'unconfigured'}`);

    let cur = null;
    let curFailed = false;
    try { cur = await getCurrentStream(); } catch (e) {
      curFailed = true;
      console.warn('[poller] getCurrentStream failed — skipping tick (a read error is not "not live"):', e.message);
    }
    if (allConfirmedOffline) lastAllOfflineAt = tickAt;
    const heldOffline = forcedHold({ forcedEndAt: cur?.forcedEndAt, lastAllOfflineAt });
    const decision = sessionDecision({ curFailed, curLive: !!(cur && cur.live), anyPlatformLive, heldOffline });
    if (decision === 'skip') { return; }
    if (decision === 'hold') {
      if (!holdLogged) {
        console.log(`[poller] a mod forced the stream offline${cur.forcedBy ? ` (${cur.forcedBy})` : ''} — holding until every platform confirms offline`);
        holdLogged = true;
      }
      // Returns before `sessionOpenNow` is updated, so the poller keeps its
      // live cadence while holding — a platform still reports live, and the
      // release (all-offline) should be seen promptly. Deliberate.
      return;
    }
    holdLogged = false;
    let streamId = cur && cur.live ? cur.streamId : null;

    if (anyPlatformLive) {
      if (decision === 'start') {
        streamId = String(nowSec());
        await postStreamStart(streamId);
        console.log(`[poller] stream started: ${streamId}`);
      }
      // YouTube's count only where YouTube votes: with no channel there is nothing to look up.
      const ytViewers = ytConfigured ? await youtubeViewers(() => ytLiveId) : null;
      const sp = getStreamplaceViewers ? getStreamplaceViewers() : null;
      // The verified-live id (see snapshotBody), not the sticky one.
      await postViewerSnapshot(snapshotBody({ streamId, twRaw, yt: ytViewers, kickRaw, sp, ytVideoId: ytLiveId }));
    } else if (streamId) {
      if (!allConfirmedOffline) {
        console.warn('[poller] no platform live this tick, but not every platform has confirmed offline yet — not ending');
      } else {
        await postStreamEnd(streamId);
        ytVideoId = ''; ytEndedMisses = 0; lastGoodYt = null; ytOwnId = '';
        streamId = null;
        console.log('[poller] stream ended (every platform confirmed offline)');
      }
    }
    sessionOpenNow = !!streamId;
  } catch (e) {
    console.warn('[poller] tick:', e.message);
  }
}

// Always runs: which platforms vote is decided on every tick from the live settings (see tick),
// so an install whose only channel is Kick, or YouTube without a Data API key, gets its sessions
// opened and closed, and a channel saved after boot is picked up without a restart.
export function startPoller({ getStreamplaceViewers, getStreamplaceState, getYtVideoId, ytWanted } = {}) {
  const sources = { getStreamplaceViewers, getStreamplaceState, getYtVideoId, ytWanted };
  console.log(`[poller] starting (live=${Math.round(POLL_MS / 1000)}s, idle=${Math.round(IDLE_POLL_MS / 1000)}s)`);
  let stopped = false;
  let timer = null;
  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      await tick(sources);
      scheduleNext();
    }, nextPollDelay(sessionOpenNow));
    if (timer.unref) timer.unref();
  };
  (async () => {
    await tick(sources);
    scheduleNext();
  })();
  return { stop() { stopped = true; if (timer) clearTimeout(timer); } };
}
