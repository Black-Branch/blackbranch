// Viewer poller + stream lifecycle. Lives here because stream-ingest already
// holds the platform credentials (the Twitch bot token or the Twitch app pair,
// the Kick app pair, the YouTube API key). Calls stream-api's stream
// start/end/snapshot endpoints.
//
//   • Lifecycle (session open/close) is an OR across Twitch, Kick, YouTube and
//     stream.place: any one of them going live opens or sustains a session; the
//     session closes only once every configured platform has confirmed offline.
//     Each platform's state is lib/platformState.js's: live counts at once, a
//     certain end at once, any other answered offline on its second reading.
//   • While a session is open, polls viewer counts for ALL platforms: Twitch
//     viewer_count, YouTube "watching now" (chat watcher's videoId first,
//     zero-quota /live scrape as id fallback; count via zero-quota InnerTube
//     updated_metadata, 1-unit videos.list as count fallback — sticky id +
//     last-good cache), Kick (official public API with app token; v2 scrape
//     fallback), and stream.place (read passively off the chat WS's viewer
//     frames via the connector handle).
//   • stream.place votes too: its chat socket carries the channel's
//     livestream record, and the reader turns it into live/offline/unknown
//     (platforms/streamplace.js streamplaceObservation). Without it a
//     stream.place-only install never opens a session.
//   • YouTube votes from the chat reader's own vote (ADR 0133: an answered end
//     is offline even while the reader still reads the chat tail); when NO reader is
//     running (it failed to start — no browser — or is still starting) the
//     poller asks YouTube itself with the same zero-quota lookup, and a
//     lookup that failed votes unknown, never offline.
//   • Push hints wake it (lib/liveHints.js, ADR 0134 E7/E11): Kick's start/stop events and the
//     stream.place ended stamp run a tick at once, or at the end of a 10 s gap, instead of waiting
//     for the timer (startPoller has the rules). A hint is never
//     an answer: Kick's API answering not-live within KICK_STOP_WINDOW_MS of its stop event is a
//     certain end; the event alone ends nothing.
//   • A platform that can't tell for longer than the vocabulary's stale window while the night is
//     open is said once per episode (logStale, ADR 0134 E10); /health carries the same flag for the
//     Doctor and the Stream tab (lib/health.js).

import { getAccessToken, refreshAccessToken } from './twitchToken.js';
import { postStreamStart, postStreamEnd, postViewerSnapshot, getCurrentStream, postPlatformStates } from './api.js';
import { fetchWatchingNow, youtubeLiveState } from '../platforms/youtube.js';
import { fetchKickState } from '../platforms/kick.js';
import { instanceConfig } from './instanceConfig.js';
import { platformState, voteOf, formatStatesLine, transitionLine } from './platformState.js';
import { PLATFORM_LIVENESS } from './platformLiveness.generated.js';
import { lastHint, onHint } from './liveHints.js';

const { PLATFORMS, STALE_ANSWER_MS, RESUME_GRACE_MS, staleAnswer } = PLATFORM_LIVENESS;

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
// At most one hint-driven read per this long: a hint inside it is read once, at its end.
const HINT_MIN_GAP_MS = 10_000;
// How long after Kick's stop event an answered is_live:false counts as certain: three live ticks,
// so an API that still said live on the woken read is still believed on the next reads.
const KICK_STOP_WINDOW_MS = 180_000;
// A stop hint whose own read still found Kick live is read once more this much later (Kick's API
// can lag its own event).
const KICK_STOP_RECHECK_MS = 30_000;

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
// Each platform's state (lib/platformState.js), as of the last tick; null = not configured.
// `ytEndedMisses` (youtubeViewers) is a different thing: it only decides when the viewer COUNT
// stops being served, never the vote.
let states = Object.fromEntries(PLATFORMS.map((p) => [p, null]));
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
// The platforms whose stale episode (logStale) has been said.
const staleLogged = new Set();
// Each platform's last LIVE broadcast key (nextLiveKeys): an answered offline carries no key, so the
// key that identifies the night has to be kept from the live readings.
let lastLiveKeys = {};
// The poller's own last end, for a same-broadcast resume (resumeCandidate):
// { streamId, lastLiveKeys, at, forced } | null. In memory: a restart forgets it, and the next
// return is a new night (the safe direction — a split night, never two nights merged).
let lastEnded = null;
// While an unforced end is inside its resume window the poller keeps the live cadence (nextDelay):
// Twitch and YouTube have no push hint, and the idle 180 s would see a return only at end + 3 and
// end + 6 min, cutting the window to 3. The last read of the window lands this long before it
// closes, so a tick's own drift cannot push it past the edge.
const RESUME_EDGE_MS = 5_000;

// The publish to stream-api (publishStates): a stream-api without the route (404, an older deploy)
// is said once per process; any other failure once per run of failures.
let publish404Logged = false;
let publishFailing = false;

/**
 * Tell stream-api every configured platform's state (POST /stream/platforms), once per tick, as
 * soon as the tick has decided the session (before the viewer counts; on every early return or
 * throw too — tick's `publish`), so the site's per-platform picture is as fresh as the poller's own.
 * Nothing configured sends `platforms: {}` (stream-api then knows the poller is alive and has
 * nothing to say). `nextInMs` is the gap to the next tick, from which stream-api judges silence: it
 * is nextDelay() once the session is decided — the very delay scheduleNext waits.
 * (Sent before the session read, it was a guess: stream-api closing a session itself while a
 * platform read "can't tell" sent 60 s and waited 180 s, and the site read every platform unknown.)
 * Never throws: a failure here costs the site a stale picture for one tick, never the session logic.
 * @param {number} at the tick's time
 * @param {number} nextInMs
 */
async function publishStates(at, nextInMs) {
  const platforms = Object.fromEntries(PLATFORMS.filter((name) => states[name]).map((name) => [name, states[name]]));
  try {
    await postPlatformStates({ at, nextInMs, platforms });
    publishFailing = false;
  } catch (e) {
    if (e.status === 404) {
      if (!publish404Logged) {
        console.warn('[poller] stream-api has no POST /stream/platforms (404) — the site gets no per-platform states until it is updated; said once');
        publish404Logged = true;
      }
      return;
    }
    if (!publishFailing) console.warn('[poller] could not publish platform states (said once until one goes through):', e.message);
    publishFailing = true;
  }
}

/**
 * E10 (ADR 0134): while the night is open, a platform whose last real answer is older than the
 * vocabulary's stale rule (staleAnswer) is said once per episode — the night stays open while it
 * can't tell, and the journal says why. An answer (or the night closing) ends the episode. The
 * Doctor warns on the same rule without the open night (ingest /health `stale`).
 * @param {number} now the tick's time
 */
function logStale(now) {
  for (const platform of PLATFORMS) {
    const s = states[platform];
    if (!sessionOpenNow || !staleAnswer(s, now)) { staleLogged.delete(platform); continue; }
    if (staleLogged.has(platform)) continue;
    staleLogged.add(platform);
    console.warn(`[liveness] ${platform} has not answered for ${Math.round(STALE_ANSWER_MS / 60_000)} min — the night stays open while it can't tell (${s.evidence})`);
  }
}

/**
 * Each platform's state as of the last tick (null = not configured), for the snapshot (Task 6) and
 * /health (Task 10). A copy: the caller cannot change the poller's.
 * @returns {Record<string, import('./platformState.js').PlatformState|null>}
 */
export function getPlatformStates() {
  return { ...states };
}

/**
 * The live keys after this tick: a platform's key is written only when it is `live` with a
 * non-empty key, and kept until a new live key replaces it — an offline, unknown or upcoming
 * reading never overwrites it. Pure; a new object.
 * @param {Record<string, string>} prev
 * @param {Record<string, { state: string, key: string } | null>} current each platform's state
 * @returns {Record<string, string>}
 */
export function nextLiveKeys(prev, current) {
  const next = { ...prev };
  for (const name of PLATFORMS) {
    const s = current[name];
    if (s?.state === 'live' && s.key) next[name] = s.key;
  }
  return next;
}

/**
 * ADR 0134 E8: the stream id to reopen instead of minting a new one — when the poller's own last end
 * was not forced, is at most RESUME_GRACE_MS old, and one platform is live now on the SAME broadcast
 * (its non-empty key equals that platform's key at the end). Else null. Pure.
 * @param {{ streamId: string, lastLiveKeys: Record<string, string>, at: number, forced: boolean } | null} ended
 * @param {Record<string, string>} liveKeys each live platform's key this tick
 * @param {number} now
 * @returns {string|null}
 */
export function resumeCandidate(ended, liveKeys, now) {
  if (!ended || ended.forced || now - ended.at > RESUME_GRACE_MS) return null;
  for (const name of PLATFORMS) {
    const key = liveKeys?.[name];
    if (key && ended.lastLiveKeys?.[name] === key) return ended.streamId;
  }
  return null;
}

/**
 * The delay to the next tick: the live cadence while a session is open, or while the poller's own
 * unforced, resumable end is inside RESUME_GRACE_MS (then never past the window's last read); else
 * idle.
 * @param {number} now
 */
function nextDelay(now) {
  // An end with no kept key (e.g. Kick on its v2 fallback, which has none) can never resume.
  const resumable = lastEnded && !lastEnded.forced && Object.values(lastEnded.lastLiveKeys).some(Boolean);
  const left = resumable ? lastEnded.at + RESUME_GRACE_MS - now : 0;
  if (!sessionOpenNow && left > RESUME_EDGE_MS) return Math.min(POLL_MS, left - RESUME_EDGE_MS);
  return nextPollDelay(sessionOpenNow);
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
// Returns { state: 'live'|'offline'|'unknown'|null, viewers, key, evidence } — `key` is the Helix
// stream id ('' unless live), `evidence` a code of the liveness vocabulary:
//   • 'live'    — `data[0].type === 'live'` (helix-live).
//   • 'offline' — Helix answered, with an empty `data` array. A real "not streaming" (helix-empty).
//   • 'unknown' — could not ask, or could not read the answer: no client-id (no-token), HTTP
//     error, network/timeout, a body with no `data` array (helix-error), or a stream whose `type`
//     is "" (helix-type-empty: Helix's shape on an error; web's twin twitchLive.ts requires
//     'live' too). Votes neither way, and never advances the offline count.
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
  if (!botToken && !viaApp) return { state: null, viewers: 0, key: '', evidence: '' };
  // No channel id configured is "not configured" too — never a query for user_id= (nothing).
  if (!broadcasterId()) return { state: null, viewers: 0, key: '', evidence: '' };
  const unknown = (evidence) => ({ state: 'unknown', viewers: 0, key: '', evidence });
  const call = (t, c) => fetch(`https://api.twitch.tv/helix/streams?user_id=${broadcasterId()}`,
    { headers: { 'Client-Id': c, Authorization: 'Bearer ' + t }, signal: AbortSignal.timeout(8000) });
  try {
    // An app token that cannot be minted is "no token to ask with", not a Twitch answer.
    const appToken = (o) => twitchAppToken(o).catch((e) => { console.warn('[poller] twitch:', e.message); return null; });
    let token = botToken;
    let cid;
    if (viaApp) {
      token = await appToken();
      if (!token) return unknown('no-token');
      cid = twitchAppId();
    } else {
      cid = await ensureClientId(token);
      if (!cid) return unknown('no-token');
    }
    let res = await call(token, cid);
    if (res.status === 401) {                 // token expired → renew + retry once
      if (viaApp) {
        token = await appToken({ fresh: true });
        if (!token) return unknown('no-token');
      } else {
        token = await refreshAccessToken();
        clientId = ''; cid = await ensureClientId(token);
      }
      res = await call(token, cid);
    }
    if (!res.ok) { console.warn(`[poller] twitch: HTTP ${res.status} — unknown, not offline`); return unknown('helix-error'); }
    const j = await res.json();
    // A successful Helix answer is ALWAYS an array; empty means "not streaming".
    // Anything else is a shape we cannot read, which is not evidence of an end.
    if (!Array.isArray(j?.data)) { console.warn('[poller] twitch: no data array in Helix body — unknown, not offline'); return unknown('helix-error'); }
    const s = j.data[0];
    if (!s) return { state: 'offline', viewers: 0, key: '', evidence: 'helix-empty' };
    if (s.type !== 'live') return unknown('helix-type-empty');
    return { state: 'live', viewers: Number(s.viewer_count) || 0, key: String(s.id ?? ''), evidence: 'helix-live' };
  } catch (e) { console.warn('[poller] twitch:', e.message); return unknown('helix-error'); }
}

// YouTube concurrent viewers — only called WHILE some platform is live, with this
// tick's YouTube reading (youtubeReading). The reader's videoId is authoritative
// (ownership + isLiveNow verified); the ZERO-quota lookup is only the fallback
// when the reading carries none. A reading of `offline` is YouTube's own answer
// that the broadcast is over (ADR 0133): the sticky id and the last-good count
// are dropped at once, so no ended broadcast's count is served for 5 minutes.
// The COUNT comes from zero-quota InnerTube updated_metadata first, then the
// cheap videos.list (1 unit) as fallback. The videoId is STICKY: the /live
// scrape can fail most ticks (foreign recommended videos, "no player
// response"), and clearing the id on every miss would make the count spotty.
// Network errors keep the id; only two consecutive "videos.list answered but
// no concurrentViewers" ticks (with no watcher id) drop it. search.list is
// avoided: since 2026-06-01 it is 1 unit, but from its own bucket of 100 calls a
// day, too few for a per-minute poll.
const staleYt = () =>
  lastGoodYt && Date.now() - lastGoodYt.at < YT_VIEWER_STALE_MS ? lastGoodYt.count : null;

const dropYt = () => { ytVideoId = ''; ytEndedMisses = 0; lastGoodYt = null; return null; };

async function youtubeViewers(reading) {
  if (!ytApiKey() && !YT_INNERTUBE) return null;
  try {
    // A scheduled broadcast has no viewers to count, and its id must not stick: like an end.
    if (reading.raw === 'offline' || reading.raw === 'upcoming') return dropYt();
    const watcherId = reading.videoId;
    if (watcherId && watcherId !== ytVideoId) { ytVideoId = watcherId; ytEndedMisses = 0; }
    if (!ytVideoId) {
      // live adopts the id; offline drops everything; unknown keeps what there is (nothing here).
      const r = await youtubeLiveState(ytChannelId());
      if (r.state === 'offline' || r.state === 'upcoming') return dropYt();
      if (r.state !== 'live') return staleYt();
      ytVideoId = r.videoId;
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
      if (!watcherId && ++ytEndedMisses >= 2) return dropYt();
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
// is the chat WATCHER's (`getLiveState().videoId`: ownership + isLiveNow verified, '' unless
// its vote is live — so '' from YouTube's answered end on) — NOT this module's sticky
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
// /stream/current, for 15 minutes: FORCED_END_TTL_MS) holds a new session back until this
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
 * @typedef {{ raw: 'live'|'offline'|'unknown'|'upcoming', certain: boolean, key: string, evidence: string,
 *   scheduledStart: number|null, videoId: string }} YtReading
 *   an Observation (lib/platformState.js) plus the verified live id ('' unless live)
 */

/**
 * YouTube's reading for this tick. With a reader running, its state, passed through as-is
 * (`watcher` = platforms/youtube.js getLiveState — ADR 0133: an answered end is offline even while
 * the chat tail is still read, certain when the known video's own page or the Data API said so; a
 * countdown is upcoming; a reader that could not ask is unknown); with no reader (`watcher` null)
 * the poller's own lookup while YouTube is chosen. Exported for pollerYoutubeNoReader.test.js.
 * Returns the reading (before the state model), or null when YouTube does not vote.
 * @param {{ watcher: YtReading | null, wanted: boolean, channelId?: string, lookup?: typeof youtubeLiveState }} o
 * @returns {Promise<YtReading | null>}
 */
export async function youtubeReading({ watcher, wanted, channelId = ytChannelId(), lookup = youtubeLiveState }) {
  if (!channelId || !(ytApiKey() || YT_INNERTUBE)) return null;
  if (watcher != null) return watcher;
  if (!wanted) return null;
  const r = await lookup(channelId, { knownId: ytOwnId });
  // A scheduled broadcast is not the live one to re-verify: like an end, the next tick asks /live.
  ytOwnId = r.state === 'live' ? r.videoId : r.state === 'offline' || r.state === 'upcoming' ? '' : ytOwnId;
  return {
    raw: r.state,
    certain: r.certain === true,
    key: r.videoId || '',
    evidence: r.evidence || '',
    scheduledStart: r.scheduledStart ?? null,
    videoId: r.state === 'live' ? r.videoId : '',
  };
}

/**
 * YouTube's observation for the state model, from this tick's reading: its own certainty, key,
 * evidence and start (Task 4). `source` ('reader' when the chat reader answered, 'lookup' when the
 * poller asked itself) names a reading that carries no evidence of its own.
 * @param {Partial<YtReading> & { raw: string } | null} reading
 * @param {'reader'|'lookup'} source
 */
export function youtubeObservation(reading, source) {
  if (!reading) return null;
  return {
    raw: reading.raw,
    certain: reading.certain === true,
    key: reading.key ?? reading.videoId ?? '',
    evidence: reading.evidence || (source === 'reader' ? 'yt-reader' : 'yt-lookup'),
    scheduledStart: reading.scheduledStart ?? null,
  };
}

/**
 * Whether Kick's answer is a certain end: an answered offline while Kick's own stop event came no
 * more than KICK_STOP_WINDOW_MS before this read (plan ruling 6) — the event triggered the read, the
 * read's answer counts. A live answer stays live whatever the event said. Pure.
 * @param {string|null} raw Kick's answer this tick
 * @param {{ kind: string, at: number } | null} hint lastHint('kick')
 * @param {number} now the tick's time (a hint during the read is newer than it, and counts)
 */
export function kickStopCertain(raw, hint, now) {
  return raw === 'offline' && hint?.kind === 'stop' && now - hint.at <= KICK_STOP_WINDOW_MS;
}

// Kick's observation from this tick's answer (see kickStopCertain).
function kickObservation(kickRaw, now) {
  if (kickRaw.state == null) return null;
  const certain = kickStopCertain(kickRaw.state, lastHint('kick'), now);
  return { raw: kickRaw.state, certain, key: kickRaw.key, evidence: certain ? 'stop-event' : kickRaw.evidence };
}

// The YouTube reader as the poller sees it: null when no reader is running (its state is null),
// else its state (getLiveState: the observation plus the verified live id).
function ytWatcher(getYtLiveState) {
  const s = typeof getYtLiveState === 'function' ? getYtLiveState() : null;
  return s ?? null;
}

async function tick({ getStreamplaceViewers, getStreamplaceObservation, getYtVideoId, getYtLiveState, ytWanted }) {
  // When this tick's platform reads happen — the all-offline observation is
  // stamped with THIS, not with the later moment the session read resolves,
  // or a forced end landing in that gap would be judged against evidence
  // that predates it (pollerHold: "an all-offline seen BEFORE the press").
  // It is also every observation's time in the state model.
  const tickAt = Date.now();
  // The one publish of this tick (publishStates), sent once the tick knows its next delay: when the
  // session's fate is decided, or in `finally` on any early return or throw. Its nextInMs is then
  // nextDelay() — exactly what startPoller's scheduleNext waits next.
  let published = false;
  const publish = async () => {
    if (published) return;
    published = true;
    await publishStates(tickAt, nextDelay(Date.now()));
  };
  try {
    // Kick with no channel set is not configured: it does not vote (a request for an empty slug
    // would only ever answer 'unknown', which would hold every session open forever).
    const kickUnconfigured = { state: null, viewers: null, key: '', evidence: '' };
    const [twRaw, kickRaw] = await Promise.all([twitchStatus(), kickSlug() ? fetchKickState() : kickUnconfigured]);

    // YouTube votes while there is a channel to watch and a reader to ask — the chat reader, or
    // with none running, the poller's own lookup (youtubeReading). A Data API key is not needed:
    // liveness is a verified video id, the count InnerTube's.
    const watcher = ytWatcher(getYtLiveState);
    const yt = await youtubeReading({
      watcher,
      wanted: typeof ytWanted === 'function' ? ytWanted() === true : typeof getYtVideoId === 'function',
    });
    const ytConfigured = yt !== null;
    const ytLiveId = yt?.videoId || '';

    // One observation per platform; null = not configured (no vote, never a miss). stream.place's
    // is its reader's, read off its chat socket; null = no reader running.
    const obs = {
      twitch: twRaw.state == null ? null : { raw: twRaw.state, certain: false, key: twRaw.key, evidence: twRaw.evidence },
      kick: kickObservation(kickRaw, tickAt),
      youtube: youtubeObservation(yt, watcher ? 'reader' : 'lookup'),
      streamplace: (typeof getStreamplaceObservation === 'function' ? getStreamplaceObservation() : null) ?? null,
    };
    const next = {};
    for (const name of PLATFORMS) {
      next[name] = platformState(states[name], obs[name], tickAt);
      const line = transitionLine(name, states[name], next[name]);
      if (line) console.log(line);
    }
    states = next;
    lastLiveKeys = nextLiveKeys(lastLiveKeys, states);

    const { voting, anyPlatformLive, allConfirmedOffline } = aggregateLiveness(PLATFORMS.map((name) => ({ name, state: voteOf(states[name]) })));
    // Nothing configured (yet — settings are read live, so a channel saved later is picked up on
    // the next tick): no vote, so the poller neither starts nor ends anything, and does not ask
    // stream-api. A session opened by hand is left alone.
    if (voting.length === 0) {
      if (!noneLogged) { console.log('[poller] no platform configured for live status — idle until one is'); noneLogged = true; }
      sessionOpenNow = false;
      return;
    }
    noneLogged = false;
    // Every platform, voting or not, so a platform dropping out of the vote is visible in the
    // journal rather than just vanishing from the line.
    console.log(formatStatesLine(states));

    let cur = null;
    let curFailed = false;
    try { cur = await getCurrentStream(); } catch (e) {
      curFailed = true;
      console.warn('[poller] getCurrentStream failed — skipping tick (a read error is not "not live"):', e.message);
    }
    if (allConfirmedOffline) lastAllOfflineAt = tickAt;
    // A mod's force-offline seen after the poller's own end (pressed in the moment between them):
    // that end is now a forced one and never resumes.
    if (cur?.forcedEndAt && lastEnded) lastEnded.forced = true;
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
        // The same broadcast back within the grace: the night goes on under its id (stream-api
        // re-checks the window and the forced end; a 409 falls back to a new id, as before).
        const resumeId = resumeCandidate(lastEnded, nextLiveKeys({}, states), tickAt);
        if (resumeId) {
          try {
            await postStreamStart(resumeId, { resume: true });
            streamId = resumeId;
            console.log(`[poller] stream resumed: ${resumeId} (the same broadcast came back within ${Math.round(RESUME_GRACE_MS / 60_000)} min)`);
          } catch (e) {
            if (e.status !== 409) throw e; // could not ask: the next tick asks again
            console.log(`[poller] stream-api refused to resume ${resumeId} — starting a new session`);
          }
        }
        if (!streamId) {
          streamId = String(nowSec());
          await postStreamStart(streamId);
          console.log(`[poller] stream started: ${streamId}`);
        }
        lastEnded = null;
      }
      // The session is open: publish now, before the viewer counts (a slow YouTube lookup must not
      // hold the site's picture back).
      sessionOpenNow = true;
      await publish();
      // YouTube's count only where YouTube votes: with no channel there is nothing to look up.
      const ytViewers = ytConfigured ? await youtubeViewers(yt) : null;
      const sp = getStreamplaceViewers ? getStreamplaceViewers() : null;
      // The verified-live id (see snapshotBody), not the sticky one.
      await postViewerSnapshot(snapshotBody({ streamId, twRaw, yt: ytViewers, kickRaw, sp, ytVideoId: ytLiveId }));
    } else if (streamId) {
      if (!allConfirmedOffline) {
        console.warn('[poller] no platform live this tick, but not every platform has confirmed offline yet — not ending');
      } else {
        await postStreamEnd(streamId);
        // A copy of the keys the night was LIVE on — never this tick's offline readings, which
        // carry none.
        lastEnded = { streamId, lastLiveKeys: { ...lastLiveKeys }, at: tickAt, forced: false };
        ytVideoId = ''; ytEndedMisses = 0; lastGoodYt = null; ytOwnId = '';
        streamId = null;
        console.log('[poller] stream ended (every platform confirmed offline)');
      }
    }
    sessionOpenNow = !!streamId;
  } catch (e) {
    console.warn('[poller] tick:', e.message);
  } finally {
    // Every tick publishes, a failed session read and a thrown step included (publishStates never
    // throws).
    await publish();
    logStale(tickAt);
  }
}

// Always runs: which platforms vote is decided on every tick from the live settings (see tick),
// so an install whose only channel is Kick, or YouTube without a Data API key, gets its sessions
// opened and closed, and a channel saved after boot is picked up without a restart.
//
// One tick at a time: the timer, wake() and the deferred read all go through `run`. A push hint
// (lib/liveHints.js) calls wake():
//   • no tick ran in the last HINT_MIN_GAP_MS and none is running → a tick now ('ran');
//   • else ONE deferred read waits for the gap's end ('gap' / 'running'); more hints meanwhile add
//     nothing, so hints never read more than once per gap. Any tick that begins first satisfies it;
//     one still running when it falls due is followed by it.
//   • a Kick stop hint whose own read still found Kick live gets one follow-up read
//     KICK_STOP_RECHECK_MS later (Kick's API can lag its event).
export function startPoller({ getStreamplaceViewers, getStreamplaceObservation, getYtVideoId, getYtLiveState, ytWanted } = {}) {
  const sources = { getStreamplaceViewers, getStreamplaceObservation, getYtVideoId, getYtLiveState, ytWanted };
  console.log(`[poller] starting (live=${Math.round(POLL_MS / 1000)}s, idle=${Math.round(IDLE_POLL_MS / 1000)}s)`);
  let stopped = false;
  let timer = null;
  let running = false;
  let lastTickAt = -Infinity;
  let deferred = null;     // { timer, reason }: the one read waiting for the gap's end
  let runAfter = null;     // the deferred read's reason, when it fell due during a tick
  let recheck = null;      // the follow-up read's timer
  let recheckedFor = null; // the stop hint (its `at`) that follow-up was armed for
  const later = (fn, ms) => {
    const t = setTimeout(fn, ms);
    if (t.unref) t.unref();
    return t;
  };
  const clearDeferred = () => {
    if (deferred) clearTimeout(deferred.timer);
    deferred = null;
    runAfter = null;
  };
  const scheduleNext = () => {
    if (stopped) return;
    clearTimeout(timer);
    timer = later(() => { timer = null; run(); }, nextDelay(Date.now()));
  };
  // After a tick: a Kick stop hint whose read (this one, begun after the hint) still found Kick
  // live is read once more.
  const armRecheck = () => {
    const h = lastHint('kick');
    if (!h || h.kind !== 'stop' || h.at > lastTickAt || h.at === recheckedFor) return;
    if (states.kick?.state !== 'live' || lastTickAt - h.at > KICK_STOP_WINDOW_MS) return;
    recheckedFor = h.at;
    clearTimeout(recheck);
    recheck = later(() => {
      recheck = null;
      if (lastHint('kick')?.at === h.at) wake('kick stop recheck');
    }, KICK_STOP_RECHECK_MS);
  };
  const run = async () => {
    running = true;
    lastTickAt = Date.now();
    clearDeferred(); // this tick begins after every hint so far: it is their read
    try {
      await tick(sources);
    } finally {
      running = false;
    }
    if (stopped) return;
    armRecheck();
    if (runAfter) {
      const reason = runAfter;
      runAfter = null;
      clearTimeout(timer);
      timer = null;
      console.log(`[poller] ${reason} — reading now (after the running read)`);
      run();
      return;
    }
    scheduleNext();
  };
  const fireDeferred = () => {
    const { reason } = deferred;
    deferred = null;
    if (stopped) return;
    if (running) { runAfter = reason; return; }
    clearTimeout(timer);
    timer = null;
    console.log(`[poller] ${reason} — reading now (the gap is over)`);
    run();
  };
  // A tick now, then the timer starts over from it; or, inside the gap or during a tick, the one
  // deferred read. Returns 'ran' | 'gap' | 'running' | 'stopped'.
  const wake = (reason) => {
    if (stopped) return 'stopped';
    const now = Date.now();
    const since = now - lastTickAt;
    if (!running && since >= HINT_MIN_GAP_MS) {
      clearTimeout(timer);
      timer = null;
      console.log(`[poller] ${reason} — reading now`);
      run();
      return 'ran';
    }
    const why = running ? 'running' : 'gap';
    if (!deferred && !runAfter) {
      deferred = { reason, timer: later(fireDeferred, Math.max(0, lastTickAt + HINT_MIN_GAP_MS - now)) };
      console.log(running
        ? `[poller] ${reason} — a read is running; reading again once the gap is over`
        : `[poller] ${reason} — a read began ${Math.round(since / 1000)}s ago; reading at the gap's end`);
    }
    return why;
  };
  const unsubscribe = onHint(({ platform, kind }) => { wake(`${platform} ${kind} hint`); });
  run();
  return {
    stop() {
      stopped = true;
      unsubscribe();
      clearTimeout(timer);
      timer = null;
      clearDeferred();
      clearTimeout(recheck);
      recheck = null;
    },
    wake,
  };
}
