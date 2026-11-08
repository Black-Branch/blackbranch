// YouTube connector — Playwright headless Chromium scraping the live-chat
// pop-out DOM via MutationObserver. The live feed is quota-free (the Data API
// key is used only to find the live videoId). Mirrors how SSN's extension reads
// YouTube chat.
//
// Identity: the pop-out DOM exposes no stable channel/user id, so 'dom' mode
// has an optional Data-API backfill that reads the SAME live chat via
// liveChatMessages.list to build a displayName -> authorChannelId map.
//
// The backfill runs in 'dom' mode only. The 'api' and 'net' read paths parse
// the innertube get_live_chat JSON, where every message carries
// authorExternalChannelId inline, so the resolver would spend quota filling a
// map nothing reads (deliverText prefers the inline channelId).
//
// With an API key alone, liveChatMessages.list answers 403 for authorization
// reasons while videos.list on the same key succeeds, so 'dom' mode likely
// needs the broadcaster's OAuth token for this call. The error log carries the
// API's `reason` so a 403 can be told apart from quota exhaustion.

import { launchBrowser } from '../lib/browser.js';
import { processMessage } from '../lib/pipeline.js';
import { normalizeYouTubeEvent } from '../lib/alerts.js';
import { postAlert, postPlatformDelete } from '../lib/api.js';
import { decideWatchdog, stallStrikeLine, STALL_MS, STALL_TICKS } from '../lib/ytWatchdog.js';
import { decideWatch, watcherVote, chatPollDelay } from '../lib/ytEndDecision.js';
import { createCadenceReporter } from '../lib/ytCadence.js';
import { instanceConfig } from '../lib/instanceConfig.js';
import { YOUTUBE_LIVE } from '../lib/youtubeLive.generated.js';

// Instance key platform.youtube.channelId, read at call time.
const channelIdCfg = () => instanceConfig.get('platform.youtube.channelId') || '';
const POLL_MS = 30000;
// The live_chat pop-out defaults to "Top chat" — YouTube's filtered view that
// silently drops messages. "live" switches to the full "Live chat" firehose.
const CHAT_MODE = (process.env.YOUTUBE_CHAT_MODE || 'live').toLowerCase();
// Read path:
//   'api' (default) — self-driven poller: POSTs get_live_chat every ~1s
//     (YOUTUBE_API_POLL_MS), chaining the continuation token and ignoring the
//     ~15s `timeoutMs` YouTube dictates to its own web client for low-traffic
//     chat. Forcing the tab "visible" does not change that server-dictated
//     interval; ignoring it (as pytchat, chat-downloader and SocialStream do)
//     brings latency down to ~1s.
//   'net' — passive: intercepts the popout's own get_live_chat responses
//     (~8s average latency, since the popout polls every ~15s). The automatic
//     fallback when the 'api' bootstrap (key/context/continuation) cannot be
//     read from the page.
//   'dom' — MutationObserver DOM scrape (slowest; last-resort fallback).
const READ_MODE = (process.env.YOUTUBE_READ_MODE || 'api').toLowerCase();
// Self-poll cadence in 'api' mode, floored at 300ms so a typo cannot hammer YouTube.
const API_POLL_MS = Math.max(300, Number(process.env.YOUTUBE_API_POLL_MS) || 1000);
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// --- innertube JSON parsers (Node-side; the 'net' read path) --------------
// Parse the same renderers the DOM observer reads, but straight from the
// get_live_chat response — richer and earlier. authorExternalChannelId is the
// real channelId, so these paths need no Data-API identity backfill.
// Link runs carry the truncated display string in run.text ("https://x.com/foo/bar…")
// and the real target in navigationEndpoint, usually wrapped in a
// youtube.com/redirect?...&q=<encoded url> shim. The full URL is returned: the
// site's send-to-all echo dedup keys on the exact message text, and truncated
// text would neither match the echo nor give viewers a working link.
function ytRunUrl(run) {
  const nav = run.navigationEndpoint;
  const raw = nav?.urlEndpoint?.url || nav?.commandMetadata?.webCommandMetadata?.url || '';
  if (!raw) return '';
  try {
    const u = new URL(raw, 'https://www.youtube.com');
    if ((u.hostname === 'youtube.com' || u.hostname.endsWith('.youtube.com')) && u.pathname === '/redirect') {
      return u.searchParams.get('q') || u.href;
    }
    return u.href;
  } catch { return ''; }
}
function ytRunsToText(runs) {
  let text = '';
  const emotes = {};
  for (const run of runs || []) {
    if (typeof run.text === 'string') {
      // Substitute the full URL only when the display text is visibly a piece of
      // it (linkified URL, possibly ellipsis-truncated) — never rewrite a run
      // whose label isn't the URL itself.
      const full = ytRunUrl(run);
      const shown = run.text.replace(/(\.\.\.|…)$/, '');
      text += (full && shown && full.toLowerCase().includes(shown.toLowerCase())) ? full : run.text;
      continue;
    }
    if (run.emoji) {
      const e = run.emoji;
      const token = (e.isCustomEmoji ? e.shortcuts?.[0] : e.emojiId) || e.shortcuts?.[0] || '';
      text += token;
      if (e.isCustomEmoji && token) {
        const src = e.image?.thumbnails?.slice(-1)[0]?.url || '';
        if (src) emotes[token] = src;
      }
    }
  }
  return { text: text.trim(), emotes };
}
function ytAvatar(r) { return r?.authorPhoto?.thumbnails?.slice(-1)[0]?.url || ''; }
function ytBadgeFlags(authorBadges) {
  let isMod = false, isMember = false;
  for (const b of authorBadges || []) {
    const r = b.liveChatAuthorBadgeRenderer;
    if (!r) continue;
    const t = r.icon?.iconType || '';
    if (t === 'MODERATOR' || t === 'OWNER') isMod = true;      // owner = broadcaster
    if (r.customThumbnail || /member/i.test(r.tooltip || '')) isMember = true;
  }
  return { isMod, isMember };
}
function ytParseText(r) {
  const author = r.authorName?.simpleText || '';
  if (!author) return null;
  const { text, emotes } = ytRunsToText(r.message?.runs);
  if (!text) return null;
  const { isMod, isMember } = ytBadgeFlags(r.authorBadges);
  // id = the innertube renderer id. Stored as chat_log.platform_msg_id so a
  // later markChatItemAsDeletedAction (same id space) can resolve the row.
  // It is not a Data-API liveChatMessages id ("LCC." prefix); the Data-API
  // delete/purge paths in web platformMod skip non-LCC ids explicitly.
  return { id: r.id || '', author, avatar: ytAvatar(r), channelId: r.authorExternalChannelId || '', text, emotes, isMod, isMember };
}
// Every event carries the renderer's own id: normalizeYouTubeEvent makes it the event
// id stream-api's ledger refuses a second credit by. Without it each read of the same
// banner minted a new one (ytEventIds.test.js, ytGiftCount.test.js).
function ytParseEvent(item) {
  if (item.liveChatPaidMessageRenderer) {
    const r = item.liveChatPaidMessageRenderer;
    return { kind: 'superchat', id: r.id || '', author: r.authorName?.simpleText || '', avatar: ytAvatar(r),
      amount: r.purchaseAmountText?.simpleText || '', message: ytRunsToText(r.message?.runs).text };
  }
  if (item.liveChatPaidStickerRenderer) {
    const r = item.liveChatPaidStickerRenderer;
    return { kind: 'supersticker', id: r.id || '', author: r.authorName?.simpleText || '', avatar: ytAvatar(r),
      amount: r.purchaseAmountText?.simpleText || '' };
  }
  if (item.liveChatMembershipItemRenderer) {
    const r = item.liveChatMembershipItemRenderer;
    const subtext = ytRunsToText(r.headerSubtext?.runs).text || '';
    const primaryHeader = ytRunsToText(r.headerPrimaryText?.runs).text || '';
    const header = subtext || primaryHeader;
    // `subtext`/`primaryHeader` ride along so lib/alerts.js can read the membership LEVEL name
    // ("Welcome to <level>!", or a milestone's subtext) — `header` keeps its old meaning.
    return { kind: 'membership', id: r.id || '', author: r.authorName?.simpleText || '', avatar: ytAvatar(r), header, subtext, primaryHeader };
  }
  if (item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer) {
    const r = item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer;
    const hdr = r.header?.liveChatSponsorshipsHeaderRenderer;
    const primary = ytRunsToText(hdr?.primaryText?.runs).text || '';
    const author = r.authorName?.simpleText || hdr?.authorName?.simpleText || (primary.split(/\s+(?:gifted|sent)\s+/i)[0] || '').trim();
    // The count is read from `primary` by normalizeYouTubeEvent (lib/alerts.js
    // parseGiftCount), the one parser both scrape paths share. `id` is the renderer's
    // own id and becomes the event id stream-api's ledger refuses a second credit by;
    // without it each read of the same banner minted a new one (ticket #168).
    return { kind: 'membership-gift', id: r.id || '', author, avatar: ytAvatar(hdr) || ytAvatar(r), primary };
  }
  return null;
}
/**
 * What ONE chat item is, decided in one place.
 *
 * Poll health measures the fetch, not what happens to each item after it, so
 * items can be lost here while every fetch counter looks healthy. The fates
 * are named so the caller can count them. `drop-*` means the renderer was
 * recognised and still produced nothing — the loss surface. `other` is an
 * unrecognised renderer (placeholders, engagement notices) and is expected:
 * those carry no id, so they never enter the dedup set.
 *
 * @returns {{kind:'text'|'event'|'drop-text'|'drop-event'|'other', data?:object}}
 */
export function ytClassifyItem(item) {
  if (item?.liveChatTextMessageRenderer) {
    const data = ytParseText(item.liveChatTextMessageRenderer);
    return data ? { kind: 'text', data } : { kind: 'drop-text' };
  }
  const ev = ytParseEvent(item || {});
  if (ev && ev.author) return { kind: 'event', data: ev };
  return ev ? { kind: 'drop-event' } : { kind: 'other' };
}
function ytRendererId(item) {
  return item.liveChatTextMessageRenderer?.id
      || item.liveChatPaidMessageRenderer?.id
      || item.liveChatPaidStickerRenderer?.id
      || item.liveChatMembershipItemRenderer?.id
      || item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer?.id
      || '';
}

// Pure parser (exported for tests): a get_live_chat action → the moderation
// mirror it implies, or null. YouTube signals a mod deleting one message as
// markChatItemAsDeletedAction (targetItemId = the renderer id we store as
// platform_msg_id) and a per-author clear (hide user / ban) as
// markChatItemsByAuthorAsDeletedAction (externalChannelId = the author's
// channel id, which chat_log rows carry as userId via stream.links).
export function ytParseModerationAction(a) {
  const del = a?.markChatItemAsDeletedAction;
  if (del?.targetItemId) return { platform: 'youtube', platformMsgId: String(del.targetItemId) };
  const byAuthor = a?.markChatItemsByAuthorAsDeletedAction;
  if (byAuthor?.externalChannelId) return { platform: 'youtube', platformUserId: String(byAuthor.externalChannelId) };
  return null;
}

/**
 * Should the Data-API identity backfill run at all?
 *
 * Pure and exported for tests, same pattern as lib/ytWatchdog.js. Only the
 * 'dom' scrape lacks an inline channelId; relays (onMessage handlers)
 * never backfill regardless — their messages skip the home pipeline.
 */
export function shouldRunIdentityBackfill(readMode, isRelay) {
  return !isRelay && readMode === 'dom';
}

/**
 * An Error for a failed Data-API response that carries the API's own `reason`
 * (quotaExceeded, forbidden, …) — a bare "HTTP 403" is ambiguous between
 * quota and authorization. Exported for tests.
 */
export async function ytApiError(label, res) {
  let reason = '';
  try {
    const body = await res.json();
    reason = body?.error?.errors?.[0]?.reason || body?.error?.status || '';
  } catch { /* body unreadable — the status alone will have to do */ }
  return new Error(`${label} HTTP ${res.status}${reason ? ` (${reason})` : ''}`);
}

// Periodic displayName -> channelId resolver fed by the YouTube Data API.
// Costs 1 quota unit per stream (videos.list -> activeLiveChatId) + 5 units per
// poll (liveChatMessages.list). At the 2-min default that's ~150 units/hour.
// 'dom' mode only — see shouldRunIdentityBackfill and the header note.
function createIdentityResolver() {
  const API_KEY = instanceConfig.get('youtube.apiKey');
  const BACKFILL_MS = Math.max(30000, Number(process.env.YOUTUBE_ID_BACKFILL_MS) || 120000);
  const MAX_ENTRIES = 5000; // LRU cap so a long stream can't grow unbounded
  const nameToId = new Map();
  let liveChatId = null;
  let pageToken = null;
  let timer = null;
  let running = false;

  const remember = (name, id) => {
    if (!name || !id) return;
    if (nameToId.has(name)) nameToId.delete(name); // re-insert to refresh LRU order
    nameToId.set(name, id);
    if (nameToId.size > MAX_ENTRIES) nameToId.delete(nameToId.keys().next().value);
  };

  const resolveLiveChatId = async (videoId) => {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${videoId}&key=${API_KEY}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw await ytApiError('videos.list', res);
    const json = await res.json();
    return json.items?.[0]?.liveStreamingDetails?.activeLiveChatId || null;
  };

  const poll = async () => {
    if (!liveChatId) return;
    try {
      const params = new URLSearchParams({ liveChatId, part: 'authorDetails', maxResults: '2000', key: API_KEY });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await fetch(`https://www.googleapis.com/youtube/v3/liveChat/messages?${params}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw await ytApiError('liveChatMessages.list', res);
      const json = await res.json();
      for (const item of json.items || []) {
        remember(item.authorDetails?.displayName, item.authorDetails?.channelId);
      }
      pageToken = json.nextPageToken || pageToken; // incremental: next call returns newer messages
    } catch (err) {
      console.warn('[youtube] id backfill error:', err.message);
    }
  };

  return {
    lookup: (name) => nameToId.get(name) || '',
    start: async (videoId) => {
      if (!API_KEY || running) return;
      try {
        liveChatId = await resolveLiveChatId(videoId);
      } catch (err) {
        console.warn('[youtube] could not resolve liveChatId:', err.message);
        liveChatId = null;
      }
      if (!liveChatId) { console.warn('[youtube] identity backfill unavailable (no active live chat id)'); return; }
      running = true;
      pageToken = null;
      await poll();
      timer = setInterval(poll, BACKFILL_MS);
      if (timer.unref) timer.unref();
      console.log(`[youtube] identity backfill on (liveChatId resolved, every ${BACKFILL_MS}ms)`);
    },
    stop: () => {
      running = false;
      liveChatId = null;
      pageToken = null;
      nameToId.clear();
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
}

const PAGE_HEADERS = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1' };

// Reading a YouTube page is the shared classifier's job (config/youtube-live.mjs →
// lib/youtubeLive.generated.js, the same text web's community slot reads): owner first, then
// isLive / scheduled / isLiveNow, and a missing liveBroadcastDetails block says nothing. This file
// fetches the pages and logs; the copy is pure.

// Authoritative per-video check via the watch page's player response. Zero quota, one fetch.
// The copy's reading of it for this channel, or null when the page did not answer or carries no
// player response.
async function watchLiveState(videoId, channelId) {
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`,
    { headers: PAGE_HEADERS, signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  const html = await res.text();
  const pr = YOUTUBE_LIVE.parsePlayerResponse(html);
  if (!pr) {
    // A response that is there and will not parse is worth seeing: it is NOT "offline", and the
    // callers read null as "no data" rather than "not live".
    if (/ytInitialPlayerResponse\s*=/.test(html)) console.warn(`[yt-dom] ytInitialPlayerResponse on ${videoId}'s watch page did not parse (truncated page?)`);
    return null;
  }
  return YOUTUBE_LIVE.classifyPlayerResponse(pr, channelId);
}

// Zero-quota live detection: scrape the channel's /live page (the approach
// the website uses) instead of the Data API's search.list, which since 2026-06-01
// costs 1 unit from its own bucket of 100 calls a day — too few for a 30 s lookup
// over a multi-hour stream. No API key.
// Exported: lib/poller.js reuses this for viewer polling (same quota reasoning).
//
// The /live page is served in inconsistent variants: some have no canonical
// link, and the first "videoId" in the HTML is then a recommendation — another
// channel's live stream. So a candidate the page itself does not show live as
// ours — and, via knownId, the video already being watched — is verified against
// its own watch page: the owner channel must match AND the video must be live
// right now. A scheduled video is never live: it is `upcoming`.
//
// The difference between "YouTube said not live" and "could not ask" is kept: the
// reader's vote and the viewer poller both read it, and a failed lookup must vote
// `unknown`, never `offline` (ADR 0133 — an answered offline now counts at once).
//   live      — a video owned by this channel is live now (videoId set)
//   upcoming  — a video of this channel is scheduled (videoId set, scheduledStart when the page
//               names it): never live, and it votes offline in the night's decision
//   offline   — YouTube answered: the known video's own page says it is no longer live (the one
//               CERTAIN answer the pages give, ADR 0134 E7), or the /live page names no live video
//               of this channel (a recommended video of another channel included — what an offline
//               /live page shows; uncertain, so it needs a second reading)
//   unknown   — the page or the video check failed
// `evidence` is a code of config/platform-liveness.mjs EVIDENCE: why the answer is what it is.
/**
 * @returns {Promise<{ state: 'live'|'offline'|'unknown'|'upcoming', videoId: string, certain: boolean,
 *   evidence: string, scheduledStart: number|null }>}
 */
export async function youtubeLiveState(channelId = channelIdCfg(), { allowEnvOverride = true, knownId = '' } = {}) {
  if (allowEnvOverride && process.env.YOUTUBE_VIDEO_ID) { // manual override/testing
    return { state: 'live', videoId: process.env.YOUTUBE_VIDEO_ID.trim(), certain: false, evidence: 'is-live', scheduledStart: null };
  }
  const none = (state, evidence, certain = false) => ({ state, videoId: '', certain, evidence, scheduledStart: null });
  const on = (state, videoId, c) => ({ state, videoId, certain: false, evidence: c.evidence, scheduledStart: c.scheduledStart ?? null });
  // Sticky path: once on a video, re-verify THAT video directly and skip the flaky
  // /live scrape entirely. Its page answering, ours and not live now, is the end
  // itself — certain, no /live scrape. Ours and scheduled is the countdown (the
  // waiting room re-verifies its broadcast here too). A page that could not be read
  // (threw, or no player response), another owner, or a page with no
  // liveBroadcastDetails says nothing, and /live is asked instead.
  if (knownId) {
    const known = await watchLiveState(knownId, channelId).catch(() => null);
    if (known?.state === 'live') return on('live', knownId, known);
    if (known?.state === 'upcoming') {
      // A countdown is not a broadcast to stick to: the channel can go live on ANOTHER video (an
      // early start on a new broadcast, or a schedule left overdue) and /live is where that shows.
      // So /live is still read every tick (a free page fetch, 0 units); only a verified live video
      // of ours replaces the countdown — anything else /live says leaves it standing.
      const elsewhere = await youtubeLiveState(channelId, { allowEnvOverride: false, knownId: '' });
      return elsewhere.state === 'live' ? elsewhere : on('upcoming', knownId, known);
    }
    if (known?.evidence === 'not-live') return none('offline', 'not-live', true);
  }
  try {
    const res = await fetch(`https://www.youtube.com/channel/${channelId}/live?hl=en`,
      { headers: PAGE_HEADERS, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const page = YOUTUBE_LIVE.classifyLivePage(await res.text(), channelId);
    // The channel's own page as /live's canonical is YouTube's "no live video" page
    // (fetched 2026-10-24 off-stream: channel canonical, plus a recommended videoId).
    if (page.evidence === 'channel-canonical') return none('offline', 'channel-canonical');
    // Past a FAILED check on the known video (unreadable, bot-check, foreign owner),
    // /live can still find a NEW live video of ours, but nothing else it says is
    // about the known one — only YouTube's own no-live page is an answer. On
    // 2026-10-24 03:36–04:18, mid-stream, a failed check was followed by /live
    // pages naming foreign recommendations a dozen times; reading those as offline
    // would end a YouTube-only night on a blip once offline counts (ADR 0133).
    // A schedule /live shows is not an answer about the known video either: read
    // as `upcoming` it would vote offline, and a live night would end on a blip.
    const unsure = knownId ? 'unknown' : 'offline';
    const candidate = page.videoId;
    if (!candidate) return none(unsure, page.evidence);
    // The /live page of a live channel is that broadcast's own watch page: its player
    // response, ours and live, about the video it names, answers live.
    if (page.state === 'live') return on('live', candidate, page);
    if (page.state === 'upcoming' && (!knownId || candidate === knownId)) return on('upcoming', candidate, page);
    if (page.evidence === 'foreign-video') {
      console.warn(`[youtube] live lookup: /live resolved to foreign video ${candidate} (owner ${page.ownerChannelId || '?'}; /live: ${page.evidence}) — ignored`);
      return none(unsure, 'foreign-video');
    }
    // /live names the video whose own check just failed: while live, the canonical
    // points at exactly that id, so a failed page fetch must not end the night.
    // (An answered not-live returned above.)
    if (candidate === knownId) {
      console.warn(`[youtube] live lookup: cannot verify ${candidate} (its watch page did not answer; /live: ${page.evidence})`);
      return none('unknown', 'sticky-check-failed');
    }
    const c = await watchLiveState(candidate, channelId);
    if (!c || c.evidence === 'no-owner') { console.warn(`[youtube] live lookup: cannot verify ${candidate} (no player response)`); return none('unknown', c ? 'no-owner' : 'no-player-response'); }
    if (c.evidence === 'foreign-video') {
      console.warn(`[youtube] live lookup: /live resolved to foreign video ${candidate} (owner ${c.ownerChannelId || '?'}; /live: ${page.evidence}) — ignored`);
      // An offline channel's /live page shows a recommendation: answered, and not this channel live.
      return none(unsure, 'foreign-video');
    }
    if (c.state === 'live') return on('live', candidate, c);
    if (c.state === 'upcoming' && !knownId) return on('upcoming', candidate, c);
    return none(unsure, c.evidence);
  } catch (err) {
    console.warn('[youtube] live lookup failed:', err.message);
    return none('unknown', knownId ? 'sticky-check-failed' : 'no-player-response');
  }
}

// ── E12: with a Data API key, a state change is double-checked (ADR 0134) ────
//
// The pages above are undocumented; videos.list is YouTube's documented, exact classifier
// (snippet.liveBroadcastContent live / upcoming / none, liveStreamingDetails.actualEndTime — research
// §A2), 1 unit per call. So when the page's answer differs from the last accepted state and a video
// id is known, one call asks, and its answer wins. The key's daily quota is shared with everything
// else it pays for (cross-posting once burned a whole day of it), so the
// confirm is capped per UTC day, and pauses after YouTube says the quota is gone.
export const YT_CONFIRM_MAX_PER_DAY = 20;
export const YT_CONFIRM_PAUSE_MS = 60 * 60_000;

/**
 * One videos.list item → the observation it states, or null when it says nothing (no item: the id
 * names nothing — deleted, private — or a label this code does not know). Pure.
 *   actualEndTime set, or liveBroadcastContent none → offline, CERTAIN (ADR 0134 E7)
 *   live                                            → live
 *   upcoming                                        → upcoming, with scheduledStartTime
 * @param {any} item
 * @returns {{ raw: 'live'|'offline'|'upcoming', certain: boolean, key: string, evidence: string, scheduledStart: number|null } | null}
 */
export function classifyVideosList(item) {
  if (!item || typeof item !== 'object') return null;
  const id = typeof item.id === 'string' ? item.id : '';
  const lsd = item.liveStreamingDetails || {};
  const label = item.snippet?.liveBroadcastContent;
  const obs = (raw, certain, key, scheduledStart = null) => ({ raw, certain, key, evidence: 'api-confirmed', scheduledStart });
  if (lsd.actualEndTime || label === 'none') return obs('offline', true, '');
  if (label === 'live') return obs('live', false, id);
  if (label === 'upcoming') {
    const t = Date.parse(lsd.scheduledStartTime || '');
    return obs('upcoming', false, id, Number.isFinite(t) ? t : null);
  }
  return null;
}

/**
 * The E12 confirm, with its own day count and pause. A factory so a test runs it with its own key
 * and clock; the reader uses the one below.
 * @param {{ apiKey?: () => string, now?: () => number, maxPerDay?: number }} [o]
 */
export function createYtConfirm({ apiKey = () => instanceConfig.get('youtube.apiKey') || '', now = Date.now, maxPerDay = YT_CONFIRM_MAX_PER_DAY } = {}) {
  let day = '';
  let used = 0;
  let pausedUntil = 0;
  let capLogged = false;
  /**
   * videos.list for one id (1 unit), or null — no key, no id, over the day's cap, paused, or the
   * call failed. Never logs its URL: the key rides in it. Only `HTTP <status>` is logged.
   * @param {string} videoId
   */
  async function confirmViaApi(videoId) {
    const key = apiKey();
    if (!key || !videoId) return null;
    const t = now();
    if (t < pausedUntil) return null;
    const today = new Date(t).toISOString().slice(0, 10);
    if (today !== day) { day = today; used = 0; capLogged = false; }
    if (used >= maxPerDay) {
      if (!capLogged) { capLogged = true; console.warn(`[youtube] state confirm: today's cap of ${maxPerDay} Data API calls reached — the pages alone answer until 00:00 UTC`); }
      return null;
    }
    used += 1;
    const params = new URLSearchParams({ part: 'snippet,liveStreamingDetails', id: videoId, key });
    let res;
    try {
      res = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params}`, { signal: AbortSignal.timeout(8000) });
    } catch {
      // The error's own text can carry the URL (and with it the key): none of it is logged.
      console.warn('[youtube] state confirm: no answer (the request failed or timed out)');
      return null;
    }
    if (!res.ok) {
      let reason = '';
      try { reason = (await res.json())?.error?.errors?.[0]?.reason || ''; } catch { /* the status alone */ }
      if (res.status === 403 && reason === 'quotaExceeded') {
        pausedUntil = t + YT_CONFIRM_PAUSE_MS;
        console.warn(`[youtube] state confirm: HTTP ${res.status} — the key's daily quota is spent; confirms paused for 1 h`);
      } else {
        console.warn(`[youtube] state confirm: HTTP ${res.status}`);
      }
      return null;
    }
    try {
      const body = await res.json();
      return classifyVideosList(body?.items?.[0]);
    } catch {
      console.warn(`[youtube] state confirm: HTTP ${res.status}, unreadable body`);
      return null;
    }
  }
  return { confirmViaApi };
}

// The reader's confirm: one day count for the process (the home reader is the only caller).
const { confirmViaApi } = createYtConfirm();

// Zero-quota concurrent viewers: the InnerTube `updated_metadata` endpoint —
// the same call the watch page itself polls to refresh its "N watching now"
// line. No API key, no auth, ~14KB. Exported for lib/poller.js, which uses it
// as the PRIMARY viewer source and keeps the 1-unit videos.list as fallback.
//
// Unofficial endpoint, so the parser is strict and any doubt returns null —
// the caller then falls back to the paid call, so endpoint drift degrades to
// the quota-costing path, never to a wrong number.
// The watch page's videoDetails.viewCount is cumulative, not concurrent — never
// use it here.
const INNERTUBE_WEB_CONTEXT = {
  // hl pinned to en because the parser matches the literal "watching".
  client: { clientName: 'WEB', clientVersion: '2.20260701.00.00', hl: 'en' },
};

// Pure parser for the updated_metadata JSON; returns the concurrent count or
// null. Split out so the shapes are pinned by platforms/watchingNow.test.js.
export function parseWatchingNow(json) {
  for (const a of json?.actions || []) {
    const r = a?.updateViewershipAction?.viewCount?.videoViewCountRenderer;
    if (!r) continue;
    // After the stream ends the SAME renderer carries the cumulative total
    // ("123,456 views") — two guards keep that from ever parsing as
    // concurrent: isLive must be explicitly true AND the text must say
    // "watching". Belt and suspenders on purpose; either alone is an
    // unofficial field that could drift.
    if (r.isLive !== true) return null;
    const vc = r.viewCount || {};
    const runs = Array.isArray(vc.runs) ? vc.runs : [];
    const text = runs.map((x) => x?.text || '').join('')
      || (typeof vc.simpleText === 'string' ? vc.simpleText : '');
    // Full digits only — an abbreviated "1.2K" (never observed, but the
    // endpoint is unofficial) must fall through to the fallback, not parse
    // as 1.
    const m = /([\d,]+)\s+watching/.exec(text);
    if (!m) return null;
    const n = Number(m[1].replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export async function fetchWatchingNow(videoId) {
  const res = await fetch('https://www.youtube.com/youtubei/v1/updated_metadata?prettyPrint=false', {
    method: 'POST',
    headers: { ...PAGE_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ context: INNERTUBE_WEB_CONTEXT, videoId }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`updated_metadata HTTP ${res.status}`);
  return parseWatchingNow(await res.json());
}

// Runs in the browser: installs a MutationObserver and forwards each new
// message to the exposed Node callback. Exported so ytGiftCount.test.js can run
// it against a stub document; it must stay self-contained (page.evaluate
// serialises its source), so it may not call anything at module scope.
export function installObserver() {
  const seen = new Set();
  const parse = (renderer) => {
    const id = renderer.id || renderer.getAttribute('id') || '';
    if (id && seen.has(id)) return null;
    if (id) seen.add(id);
    const author = renderer.querySelector('#author-name')?.textContent?.trim() || '';
    if (!author) return null;
    // Avatar: the renderer embeds the author's channel thumbnail as an <img>
    // inside #author-photo (a yt-img-shadow). Free from the DOM we already read.
    const avatar = renderer.querySelector('#author-photo img')?.src || '';
    const msgEl = renderer.querySelector('#message');
    let text = '';
    const emotes = {};
    if (msgEl) {
      for (const node of msgEl.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          text += node.textContent;
        } else if (node.tagName === 'IMG') {
          const alt = node.getAttribute('alt') || node.getAttribute('shared-tooltip-text') || '';
          const src = node.getAttribute('src') || '';
          if (alt) {
            text += alt;
            if (src) emotes[alt] = src;
          }
        } else {
          text += node.textContent || '';
        }
      }
    }
    const authorType = renderer.getAttribute('author-type') || '';
    const hasMemberBadge = !!renderer.querySelector('#author-badges img, #chip-badges img');
    return {
      author,
      avatar,
      text: text.trim(),
      emotes,
      isMod: authorType === 'moderator' || authorType === 'owner',
      isMember: authorType === 'member' || hasMemberBadge,
    };
  };

  const handle = (renderer) => {
    try {
      const data = parse(renderer);
      if (data && data.text) window.__ssOnMessage(data);
    } catch {
      /* ignore malformed nodes */
    }
  };

  // Monetization renderers (Super Chat / sticker / membership / gift) → __ssOnEvent.
  const parseEvent = (r, kind) => {
    const id = r.id || r.getAttribute('id') || '';
    if (id && seen.has(id)) return null;
    if (id) seen.add(id);
    const author = r.querySelector('#author-name')?.textContent?.trim() || '';
    const avatar = r.querySelector('#author-photo img')?.src || '';
    // Field preference is expressed with `||` chains, NOT comma selector
    // lists: querySelector('a, b') returns the first match in DOCUMENT order,
    // whichever selector it satisfies — it does not prefer `a`. The innertube
    // twin (ytParseEvent) prefers subtext/chip explicitly; these must agree.
    if (kind === 'superchat') {
      const amount = r.querySelector('#purchase-amount')?.textContent?.trim() || '';
      const message = r.querySelector('#message')?.textContent?.trim() || '';
      return { kind, id, author, avatar, amount, message };
    }
    if (kind === 'supersticker') {
      const amount = r.querySelector('#purchase-amount-chip')?.textContent?.trim()
        || r.querySelector('#purchase-amount')?.textContent?.trim() || '';
      return { kind, id, author, avatar, amount };
    }
    if (kind === 'membership') {
      const subtext = r.querySelector('#header-subtext')?.textContent?.trim() || '';
      const primaryHeader = r.querySelector('#header-primary-text')?.textContent?.trim() || '';
      const header = subtext || primaryHeader;
      return { kind, id, author, avatar, header, subtext, primaryHeader };
    }
    if (kind === 'membership-gift') {
      const primary = r.querySelector('#primary-text')?.textContent?.trim()
        || r.querySelector('#message')?.textContent?.trim() || '';
      const gifter = author || (primary.split(/\s+(?:gifted|sent)\s+/i)[0] || '').trim();
      // Raw text, not a count: this function runs inside the page and cannot
      // reach lib/alerts.js, so the count is parsed on the Node side by the
      // same parseGiftCount the innertube path uses. The element id is the renderer id
      // the innertube path reads, so both paths name the same gift the same event.
      return { kind, id, author: gifter, avatar, primary };
    }
    return null;
  };
  const handleEvent = (r, kind) => {
    // Log at receipt (mirrors the Twitch MONETIZATION path) BEFORE the author
    // guard so an intermittent drop is visible. Browser-context logs reach Node
    // via the page.on('console') bridge in openChat (forwards [yt-dom] prefixes).
    console.log('[yt-dom] monetization renderer:', kind);
    try {
      const d = parseEvent(r, kind);
      if (d && d.author) window.__ssOnEvent(d);
      else console.warn('[yt-dom]', kind, 'parsed but empty author (dropped) — selector drift / degraded shell?');
    } catch (e) { console.warn('[yt-dom]', kind, 'parse error:', e && e.message); }
  };

  const list = document.querySelector('#items') || document.body;
  const obs = new MutationObserver((mutations) => {
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== 1) continue;
        switch (node.tagName) {
          case 'YT-LIVE-CHAT-TEXT-MESSAGE-RENDERER': handle(node); break;
          case 'YT-LIVE-CHAT-PAID-MESSAGE-RENDERER': handleEvent(node, 'superchat'); break;
          case 'YT-LIVE-CHAT-PAID-STICKER-RENDERER': handleEvent(node, 'supersticker'); break;
          case 'YT-LIVE-CHAT-MEMBERSHIP-ITEM-RENDERER': handleEvent(node, 'membership'); break;
          case 'YT-LIVE-CHAT-SPONSORSHIPS-GIFT-PURCHASE-ANNOUNCEMENT-RENDERER': handleEvent(node, 'membership-gift'); break;
          default:
            // Surface any monetization renderer whose tag we don't yet handle —
            // YouTube renaming a renderer would otherwise silently zero alerts.
            if (/^YT-LIVE-CHAT-(PAID|SPONSORSHIPS)/.test(node.tagName))
              console.warn('[yt-dom] UNMATCHED monetization tag (renderer drift?):', node.tagName);
            break;
        }
      }
    }
  });
  obs.observe(list, { childList: true, subtree: true });
}

// Pull a continuation token out of a get_live_chat JSON response — shared by
// the mode-switch capture below and the 'api' poller's own chaining.
function extractContinuation(json) {
  const lcc = json && json.continuationContents && json.continuationContents.liveChatContinuation;
  const c = (lcc && lcc.continuations && lcc.continuations[0]) || {};
  return (c.invalidationContinuationData && c.invalidationContinuationData.continuation)
    || (c.timedContinuationData && c.timedContinuationData.continuation)
    || (c.reloadContinuationData && c.reloadContinuationData.continuation) || null;
}

// Passively grab a continuation off the popout's own next get_live_chat poll
// (the popout client polls itself every ~15s in whatever view is active). This
// is the recovery path when the mode switch's response wasn't captured: after
// a successful switch the popout polls Live chat, so its continuation is
// live-anchored — unlike the Top-chat-frozen ytInitialData token.
function captureNextContinuation(page, timeoutMs) {
  return page
    .waitForResponse((res) => res.url().includes('/youtubei/v1/live_chat/get_live_chat'), { timeout: timeoutMs })
    .then((res) => res.json())
    .then(extractContinuation)
    .catch(() => null);
}

// Switch the pop-out from "Top chat" (YouTube's filtered view, drops messages)
// to "Live chat" (the full firehose). Best-effort: the view selector is a
// yt-dropdown-menu in the chat header; if the selectors don't match the live
// DOM we warn and proceed in whatever mode the page loaded in.
//
// Returns `{ token, needsToken }`. `token` is the fresh continuation the
// switch's own get_live_chat response yields. This matters because
// `window.ytInitialData` (what the 'api' poller bootstraps from) is captured
// at page load — always "Top chat", since that's YouTube's default — and is
// NEVER updated by this DOM-only view change. Without the switch's own
// response, the poller would silently keep chaining Top-chat continuations
// forever despite the UI (and this log line) saying it switched to Live chat.
// `needsToken:false` = the page was ALREADY in Live chat, so ytInitialData is
// live-anchored and the fallback token is fine; the caller only needs to
// recover a token when needsToken is true and token is null.
async function selectLiveChatMode(page) {
  try {
    const trigger = page
      .locator('#view-selector #trigger, #view-selector #label, yt-live-chat-view-selector #trigger')
      .first();
    const current = ((await trigger.textContent({ timeout: 8000 })) || '').trim().toLowerCase();
    if (current.includes('live chat')) {
      console.log('[youtube] already in Live chat mode');
      return { token: null, needsToken: false };
    }
    await trigger.click({ timeout: 5000 });
    await page.waitForTimeout(500);
    const option = page
      .locator('#view-selector tp-yt-paper-listbox a, #view-selector tp-yt-paper-item, tp-yt-paper-listbox a')
      .filter({ hasText: /live chat/i })
      .first();

    const freshTokenP = captureNextContinuation(page, 8000);

    await option.click({ timeout: 5000 });
    const freshToken = await freshTokenP;
    await page.waitForTimeout(1000);
    console.log(`[youtube] switched to Live chat mode${freshToken ? '' : ' (no fresh continuation captured — will try the popout\'s own next poll)'}`);
    return { token: freshToken, needsToken: true };
  } catch (err) {
    console.warn('[youtube] could not switch to Live chat mode (using default):', err.message);
    return { token: null, needsToken: true };
  }
}

// E12: a disagreement between the page and the Data API is asked again at most this often for the
// same video and the same page answer; in between the API's last answer stands. Without it a page
// that keeps saying one thing while the API says another would spend a unit every 30 s tick.
const YT_CONFIRM_REASK_MS = 2 * 60_000;

/**
 * The reader's watcher: each tick's lookup → which chat page to have (the waiting room included)
 * and the liveness observation the poller reads. Pulled out of startYouTube so it runs without a
 * browser (lib/ytWaitingRoom.test.js): the chat page is the caller's, behind `chat`.
 *
 * The chat page and the observation are kept apart (ADR 0133): `chatVideoId` is the page that is
 * open — a countdown, a live chat, or a tail being read — and never the live vote by itself.
 *
 * @param {object} o
 * @param {string}  o.channelId
 * @param {boolean} [o.relay]   another channel's chat: no countdown is read and no confirm is spent
 * @param {typeof youtubeLiveState} [o.lookup]
 * @param {(videoId: string) => Promise<ReturnType<typeof classifyVideosList>>} [o.confirm]  E12
 * @param {() => number} [o.now]
 * @param {{ open: (videoId: string, o: { live: boolean }) => Promise<void>, close: () => Promise<void>,
 *   msSinceOk: () => number, supervise: (videoId: string) => Promise<void> }} o.chat
 *   open/close the chat page; ms since the page's chat last delivered; run the stall watchdog
 *   ('' = no live or countdown page to watch)
 * @param {string} [o.tag]
 */
export function createYtWatcher({ channelId, relay = false, lookup = youtubeLiveState, confirm = confirmViaApi, now = Date.now, chat, tag = relay ? 'youtube:relay' : 'youtube' }) {
  let chatVideoId = null;  // the video whose chat page is open, or null
  let chatSeenLive = false; // that video has been live: its chat is a live chat (or its tail)
  let missCount = 0;       // consecutive counted lookup misses while a page is open
  let endHoldLogged = false; // one hold line per degraded-lookup episode, not per tick
  // The last lookup's answer; 'unknown' until the first lookup has answered.
  let last = { state: 'unknown', videoId: '', certain: false, evidence: 'yt-reader', scheduledStart: null };
  let accepted = null;     // the last accepted answered state (E12 asks on a change from it)
  let asked = null;        // the last E12 call: { videoId, pageState, at, answer }
  let noStartLogged = '';  // the last upcoming video logged as having no start time

  // E12: the page's answer, or the Data API's when the page says something new about a known video.
  const confirmed = async (page, t) => {
    const videoId = page.videoId || chatVideoId || '';
    if (relay || page.state === 'unknown' || page.state === accepted || !videoId) return page;
    if (asked && asked.videoId === videoId && asked.pageState === page.state && t - asked.at < YT_CONFIRM_REASK_MS) return asked.answer ?? page;
    const o = await confirm(videoId);
    const answer = o ? { state: o.raw, videoId: o.raw === 'offline' ? '' : o.key, certain: o.certain, evidence: o.evidence, scheduledStart: o.scheduledStart ?? null } : null;
    asked = { videoId, pageState: page.state, at: t, answer };
    return answer ?? page;
  };

  const tick = async () => {
    const t = now();
    const lookedUp = await lookup(channelId, { allowEnvOverride: !relay, knownId: chatVideoId || '' });
    const reading = await confirmed(lookedUp, t);
    last = reading;
    if (reading.state !== 'unknown') accepted = reading.state;
    if (reading.state === 'live' && reading.videoId && reading.videoId === chatVideoId) chatSeenLive = true;
    if (reading.state === 'live') endHoldLogged = false;
    const d = decideWatch({ lookup: reading, currentId: chatVideoId, missCount, msSinceChatOk: chat.msSinceOk(), relay, now: t });
    missCount = d.missCount;
    // With no start time there is no telling a countdown from a schedule a day ahead, so its chat
    // is not read (chatPlan) — said once per video, so a missing countdown is never silent.
    if (!relay && reading.state === 'upcoming' && reading.videoId && typeof reading.scheduledStart !== 'number'
      && reading.videoId !== noStartLogged && reading.videoId !== chatVideoId) {
      noStartLogged = reading.videoId;
      console.log(`[${tag}] scheduled broadcast ${reading.videoId} has no start time — countdown chat not read`);
    }
    if (d.action === 'open' && d.videoId) {
      chatVideoId = d.videoId;
      chatSeenLive = reading.state === 'live';
      if (!chatSeenLive) {
        const mins = typeof reading.scheduledStart === 'number' ? Math.round((reading.scheduledStart - t) / 60_000) : '?';
        console.log(`[${tag}] scheduled broadcast ${d.videoId} starts in ${mins} min — reading its countdown chat (it does not vote live)`);
      }
      await chat.open(d.videoId, { live: chatSeenLive });
      return;
    }
    if (d.action === 'hold') {
      // The chat page outlives a not-live lookup (lib/ytEndDecision.js): a failed lookup is
      // "unknown", and after a real end YouTube serves the chat for ~5 minutes more — goodbyes are
      // still read (ADR 0133). While the chat continuation has delivered recently, hold; otherwise
      // the 3-miss debounce. The liveness vote is separate (getLiveState): an answered end is offline now.
      if (!endHoldLogged) {
        endHoldLogged = true;
        console.log(reading.state === 'offline'
          ? `[${tag}] YouTube says the broadcast ended; reading the chat tail while it delivers (logged once per episode)`
          : `[${tag}] live lookup failing but chat is delivering — holding open (logged once per episode)`);
      }
      return;
    }
    if (d.action === 'count') return;
    if (d.action === 'close') {
      console.log(`[${tag}] stream ended; closing chat`);
      chatVideoId = null;
      chatSeenLive = false;
      missCount = 0;
      await chat.close();
      return;
    }
    await chat.supervise(chatVideoId || '');
  };

  /** The observation for the poller, plus the verified live id ('' unless live). */
  const getLiveState = () => {
    const o = watcherVote({ lookup: last, holding: chatVideoId != null && chatSeenLive });
    return { ...o, videoId: o.raw === 'live' ? chatVideoId || last.videoId || '' : '' };
  };

  return {
    tick,
    getLiveState,
    /** The video whose chat page is open (a countdown, a live chat or its tail), or null. */
    chatVideoId: () => chatVideoId,
    /** The open page's broadcast has been live: its chat polls at the 1 s self-poll. */
    chatIsLive: () => chatSeenLive,
  };
}

/**
 * @param {object} [opts]
 * @param {string} [opts.channelId] channel to watch (default: home channel from env)
 * @param {(msg:object)=>void} [opts.onMessage] relay sink. When set, messages go
 *   here instead of the home pipeline and the identity backfill is skipped
 *   (relay messages are ephemeral and carry userId:'' by construction).
 */
export async function startYouTube(opts = {}) {
  const channelId = opts.channelId || channelIdCfg();
  const onMessage = opts.onMessage || null;
  const tag = onMessage ? 'youtube:relay' : 'youtube';
  const browser = await launchBrowser({
    headless: true,
    // Latency: YouTube's live-chat client backs off get_live_chat polling when
    // the tab looks hidden. In headless the popout is treated as occluded, so
    // chat polls in slow ~8s batches. These flags stop Chromium from throttling
    // timers or backgrounding the renderer, so the popout keeps polling at
    // foreground cadence. See also the force-visible init script below.
    args: [
      '--no-sandbox',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  });
  // A realistic UA is REQUIRED: with the default headless UA, YouTube serves the
  // "you're using an older version of your browser… update it to use live chat"
  // shell (no #items, no messages) instead of the chat popout. (Affects both the
  // home ingest and the relay.) CONSENT cookie skips the EU consent interstitial.
  const context = await browser.newContext({ userAgent: UA, locale: 'en-US' });
  await context.addCookies([{ name: 'CONSENT', value: 'YES+1', domain: '.youtube.com', path: '/' }]);
  // Latency, part 2: even with throttling flags, the popout reads
  // document.visibilityState to decide its poll cadence. Force it to ALWAYS look
  // visible and swallow visibilitychange so YouTube never enters its slow "nobody's
  // watching" chat-poll mode. Runs before any page script on every navigation.
  await context.addInitScript(() => {
    try {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      Object.defineProperty(document, 'webkitVisibilityState', { configurable: true, get: () => 'visible' });
      document.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);
      document.hasFocus = () => true;
    } catch { /* defineProperty can throw if already locked — best-effort */ }
  });

  let page = null;
  // The watcher (createYtWatcher, below): the lookup, the chat plan and the liveness observation.
  // It owns which video's chat page is open; this closure owns the page itself.
  let watcher = null;
  let stopped = false;
  // Api-poller liveness (watchdog inputs). apiPollerFor holds the page whose
  // poller is running — page-identity, not a boolean, so a dying old loop
  // can't clobber the flag of the replacement poller it races with.
  let apiPollerFor = null;
  let lastPollOkAt = 0;   // last poll iteration that got a liveChatContinuation
  let apiStallCount = 0;  // consecutive stalled ticks (N-miss debounce)
  // When the current chat page finished opening. The watchdog judges liveness by
  // max(lastPollOkAt, pageOpenedAt) so a page whose poller never registered is
  // still measured from something real — see lib/ytWatchdog.js.
  let pageOpenedAt = 0;
  // Poll outcome counters, reported on the 30s cadence line, so a stalled
  // poller produces output instead of a quiet log. `txt`/`ev` are what was
  // delivered, `dropText`/`dropEvent` what was recognised and thrown away,
  // `other` unrecognised renderers, `backlog` the pre-primed first response.
  // Fetch health alone cannot show a loss that happens after the fetch; these
  // measure the drain.
  const ZERO = { ok: 0, fail: 0, noLcc: 0, httpErr: 0, txt: 0, ev: 0, dropText: 0, dropEvent: 0, other: 0, backlog: 0 };
  let cnt = { ...ZERO };
  const resetCounts = () => { cnt = { ...ZERO }; };
  // Rebuilds is deliberately NOT in `cnt`: it counts for the whole process life,
  // not per-window. It also must survive resetCounts(), which openChat() calls —
  // and openChat() is exactly what a rebuild invokes, so a per-window rebuild
  // counter would reset itself to zero every time it incremented.
  let rebuildCount = 0;
  // Identity backfill is home-only AND dom-mode-only: the 'api' and 'net' read
  // paths get authorExternalChannelId inline, so they need no Data-API quota.
  // See shouldRunIdentityBackfill.
  const identity = shouldRunIdentityBackfill(READ_MODE, !!onMessage) ? createIdentityResolver() : null;

  // Node-side delivery — shared by the 'net' response interceptor and the 'dom'
  // browser bridge. userId prefers the inline channelId ('net'), falling back to
  // the identity map ('dom').
  const deliverText = (data) => {
    const normalized = {
      platform: 'youtube',
      userId: data.channelId || identity?.lookup(data.author) || '',
      username: data.author,
      message: data.text,
      isMod: data.isMod,
      isVip: false,
      isMember: data.isMember,
      tier: '',
      emotes: data.emotes,
      avatarUrl: data.avatar || undefined,
      platformMsgId: data.id || undefined,
    };
    if (onMessage) onMessage(normalized);
    else processMessage(normalized);
  };
  const deliverEvent = (data) => {
    if (onMessage) return; // relays never fire the streamer's alerts
    try {
      const alert = normalizeYouTubeEvent(data);
      if (alert) {
        // Ids and amounts only — never the donor's name.
        console.log(`[youtube] alert ${alert.eventType} event=${alert.eventId ?? '?'} (amount=${alert.amount ?? ''} ${alert.currency ?? ''})`);
        postAlert(alert).catch((e) =>
          console.warn(`[youtube] postAlert FAILED (${alert.eventType} event=${alert.eventId ?? '?'}):`, e.message));
      } else {
        console.warn('[youtube] event: normalizeYouTubeEvent returned null for kind', data && data.kind);
      }
    } catch (e) { console.warn('[youtube] event handler:', e.message); }
  };

  // Dispatch one get_live_chat response's actions (text → deliverText, monetization
  // → deliverEvent), deduping by renderer id via the shared `seen` set. `primed`
  // gates the first batch (backlog) so we record ids without replaying old chat.
  const drainActions = (actions, seen, isPrimed) => {
    if (!Array.isArray(actions)) return;
    for (const a of actions) {
      // YouTube-side moderation → site mirror (home only; relay chats are
      // ephemeral and never persisted, so there's nothing to flag for them).
      if (!onMessage) {
        const modPayload = ytParseModerationAction(a);
        if (modPayload) {
          // Backlog guard: the first response after every reconnect is chat
          // history, not new events. Replaying its moderation actions would
          // re-purge the targeted author's messages site-wide, deleting messages
          // posted legitimately since the original ban.
          if (!isPrimed()) continue;
          // Dedupe by target so a repeated action inside one session is a no-op.
          const modKey = modPayload.platformMsgId
            ? `m:${modPayload.platformMsgId}`
            : modPayload.platformUserId ? `u:${modPayload.platformUserId}` : '';
          if (modKey) {
            if (seen.has(modKey)) continue;
            seen.add(modKey);
          }
          postPlatformDelete(modPayload)
            .catch((e) => console.warn('[youtube] moderation mirror failed:', e.message));
          continue;
        }
      }
      const item = a.addChatItemAction?.item;
      if (!item) continue;
      const id = ytRendererId(item);
      if (id) { if (seen.has(id)) continue; seen.add(id); }
      if (!isPrimed()) { cnt.backlog++; continue; } // first response = backlog: record ids, don't emit
      // Every branch is counted, so an item that arrives and produces nothing
      // leaves a trace.
      const r = ytClassifyItem(item);
      if (r.kind === 'text') { cnt.txt++; deliverText(r.data); }
      else if (r.kind === 'event') { cnt.ev++; deliverEvent(r.data); }
      else if (r.kind === 'drop-text') cnt.dropText++;
      else if (r.kind === 'drop-event') cnt.dropEvent++;
      else cnt.other++;
    }
    if (seen.size > 20000) { // bound memory on a marathon; drop oldest ids
      const it = seen.values();
      for (let i = 0; i < 5000; i++) { const v = it.next().value; if (v === undefined) break; seen.delete(v); }
    }
  };

  // 'net' read (also the 'api' fallback): passively intercept the popout's own
  // get_live_chat responses. Correct, but only as fast as the popout polls (~15s
  // for low-traffic chat → ~8s avg latency). Attach BEFORE navigation.
  const attachPassiveNetRead = (pg) => {
    const seen = new Set();
    let primed = false;
    pg.on('response', async (res) => {
      try {
        if (!res.url().includes('/youtubei/v1/live_chat/get_live_chat')) return;
        const json = await res.json().catch(() => null);
        drainActions(json?.continuationContents?.liveChatContinuation?.actions, seen, () => primed);
        primed = true;
      } catch (e) { console.warn(`[${tag}] get_live_chat parse error:`, e.message); }
    });
  };

  // 'api' read: self-driven poller. Bootstraps the innertube key + context +
  // initial continuation from the loaded popout, then POSTs get_live_chat every
  // API_POLL_MS (~1s), chaining the continuation and ignoring YouTube's ~15s
  // timeoutMs. The fetch runs inside the page so cookies/origin are automatic.
  // Falls back to the passive net read if the page doesn't expose what is
  // needed. Fire-and-forget; the loop exits when the page is closed or replaced
  // (next video / stream end).
  const startApiPoller = async (pg, overrideToken) => {
    const boot = await pg.evaluate(() => {
      const cfg = window.ytcfg;
      const key = (cfg && cfg.data_ && cfg.data_.INNERTUBE_API_KEY) || (cfg && cfg.get && cfg.get('INNERTUBE_API_KEY')) || null;
      const ctx = (cfg && cfg.data_ && cfg.data_.INNERTUBE_CONTEXT) || (cfg && cfg.get && cfg.get('INNERTUBE_CONTEXT')) || null;
      const d = window.ytInitialData || {};
      const conts = (d.contents && d.contents.liveChatRenderer && d.contents.liveChatRenderer.continuations)
        || (d.continuationContents && d.continuationContents.liveChatContinuation && d.continuationContents.liveChatContinuation.continuations)
        || [];
      const c = conts[0] || {};
      const token = (c.invalidationContinuationData && c.invalidationContinuationData.continuation)
        || (c.timedContinuationData && c.timedContinuationData.continuation)
        || (c.reloadContinuationData && c.reloadContinuationData.continuation) || null;
      return { key, ctx, token };
    }).catch(() => null);

    if (!boot || !boot.key || !boot.ctx || (!overrideToken && !boot.token)) {
      // Say WHICH piece was missing: page not loaded, ytcfg shape changed and
      // chat not yet rendered are three different failures.
      const missing = !boot
        ? 'evaluate threw'
        : [!boot.key && 'key', !boot.ctx && 'ctx', !overrideToken && !boot.token && 'continuation']
            .filter(Boolean).join('+');
      console.warn(`[${tag}] api poller bootstrap failed (${missing}) — falling back to passive net read (~8s). ` +
        `The liveness watchdog now covers this page anyway and will rebuild if chat stays dead.`);
      attachPassiveNetRead(pg);
      return;
    }

    const seen = new Set();
    let primed = false;
    // Prefer the continuation captured off the Live-chat switch itself — the
    // ytInitialData-derived boot.token is always anchored to Top chat (see
    // selectLiveChatMode's comment above) and is only a fallback here.
    let token = overrideToken || boot.token;
    const cadence = createCadenceReporter();
    let lastTimeoutMs = '?';
    console.log(`[${tag}] api poller started (self-poll ${API_POLL_MS}ms, ignoring server timeoutMs${watcher?.chatIsLive() ? '' : `; a countdown polls every ${chatPollDelay({ live: false, selfPollMs: API_POLL_MS })}ms until live`})${overrideToken ? ' [bootstrapped from Live chat switch]' : ' [bootstrapped from ytInitialData — Top chat if a switch was expected]'}`);
    apiPollerFor = pg;
    lastPollOkAt = Date.now();
    try {
      while (!stopped && pg === page && !pg.isClosed()) {
        let res = null;
        try {
          res = await pg.evaluate(async ({ key, ctx, token }) => {
            const r = await fetch('/youtubei/v1/live_chat/get_live_chat?key=' + key + '&prettyPrint=false', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ context: ctx, continuation: token }),
            });
            // Read the body ONCE as text, then try to parse. Calling r.json()
            // first and r.text() in its catch cannot work — the body stream is
            // already consumed — and a non-JSON error page (consent
            // interstitial, captcha, 5xx shell) would vanish without trace.
            const t = await r.text();
            let json = null;
            try { json = JSON.parse(t); } catch { /* not JSON — keep the snippet */ }
            return { status: r.status, ok: r.ok, json, snippet: json ? null : t.slice(0, 200) };
          }, { key: boot.key, ctx: boot.ctx, token });
        } catch (e) {
          // Page navigated/closed mid-evaluate, or a transient network blip — the
          // loop guard will catch a closed page; otherwise retry next tick.
          if (pg.isClosed()) break;
          cnt.fail++;
          // Throttled: a wedged page can fail every API_POLL_MS (~1/s), which
          // would bury the journal. First one, then every 30th.
          if (cnt.fail === 1 || cnt.fail % 30 === 0) {
            console.warn(`[${tag}] poll evaluate failed (#${cnt.fail}): ${e.message}`);
          }
        }

        // An HTTP error is NOT the same as a network blip: a 400/403 here means
        // the continuation token is dead or the client is rate-limited, and no
        // amount of retrying the SAME token will recover it. Counted separately
        // from success-with-no-messages.
        if (res && !res.ok) {
          cnt.httpErr++;
          if (cnt.httpErr === 1 || cnt.httpErr % 30 === 0) {
            const detail = res.json?.error?.message || res.snippet || '';
            console.warn(`[${tag}] get_live_chat HTTP ${res.status} (#${cnt.httpErr})${detail ? ': ' + detail : ''}`);
          }
        }

        const json = res && res.json;
        const lcc = json && json.continuationContents && json.continuationContents.liveChatContinuation;
        if (!lcc && res && res.ok) {
          // 200 with no liveChatContinuation: the token may be expired. Without
          // a counter and a log line the loop would silently re-send the same
          // dead token forever.
          cnt.noLcc++;
          if (cnt.noLcc === 1 || cnt.noLcc % 30 === 0) {
            console.warn(`[${tag}] poll returned 200 with no liveChatContinuation (#${cnt.noLcc}) — token may be expired`);
          }
        }
        if (lcc) {
          cnt.ok++;
          try {
            drainActions(lcc.actions, seen, () => primed);
          } catch (e) {
            // A parser edge case must never kill this loop — nothing restarts a
            // fire-and-forget poller until the video changes.
            console.warn(`[${tag}] drainActions error (poll continues):`, e.message);
          }
          primed = true;
          lastPollOkAt = Date.now();
          const nc = lcc.continuations && lcc.continuations[0];
          const nt = (nc && nc.invalidationContinuationData && nc.invalidationContinuationData.continuation)
            || (nc && nc.timedContinuationData && nc.timedContinuationData.continuation)
            // Reload continuations arrive on reseed/expiry, and the bootstrap
            // path accepts them too; ignoring them here would leave `token`
            // stale and stall the loop until the next video change.
            || (nc && nc.reloadContinuationData && nc.reloadContinuationData.continuation);
          if (nt) token = nt;
          lastTimeoutMs = (nc && nc.invalidationContinuationData && nc.invalidationContinuationData.timeoutMs)
            ?? (nc && nc.timedContinuationData && nc.timedContinuationData.timeoutMs) ?? '?';
        }

        // Heartbeat OUTSIDE the success branch: when chat goes silent this is
        // the line that tells a stalled poller apart from "nobody is chatting".
        // Judged every 30 s (lib/ytCadence.js); a healthy line is printed every 10 minutes with
        // the sums since the last one (one per 30 s would be a quarter of the ingest journal).
        // A window with no successful poll, or with discards, is printed at once.
        const now = Date.now();
        const due = cadence.check(now, cnt);
        if (due) {
          const line = (c, windowS) =>
            `[${tag}] api cadence (${windowS}s): self-poll=${API_POLL_MS}ms serverTimeoutMs=${lastTimeoutMs} seen=${seen.size} ` +
            `| ok=${c.ok || 0} noLcc=${c.noLcc || 0} http=${c.httpErr || 0} fail=${c.fail || 0} rebuilds=${rebuildCount} ` +
            // The drain, not the fetch. `txt` is what actually reached the
            // pipeline, so it can be compared straight against chat_log rows
            // for the same window.
            `| txt=${c.txt || 0} ev=${c.ev || 0} drop=${c.dropText || 0}/${c.dropEvent || 0} other=${c.other || 0} ` +
            `| lastOk=${lastPollOkAt ? Math.round((now - lastPollOkAt) / 1000) + 's ago' : 'never'}`;
          if (due.stalled) console.warn(line(due.stalled, due.windowS) + ' — NO SUCCESSFUL POLLS THIS WINDOW');
          if (due.healthy) console.log(line(due.healthy.counts, due.healthy.windowS));
          // Loud and greppable: a discard can hide behind a healthy-looking
          // cadence line.
          if (due.dropped) {
            console.warn(`[${tag}] DISCARDED ${cnt.dropText} text + ${cnt.dropEvent} event item(s) this window — recognised renderers that produced nothing`);
          }
          resetCounts();
        }
        // The 1 s self-poll once the broadcast is live; a countdown chat every few seconds (chatPollDelay).
        await new Promise((r) => setTimeout(r, chatPollDelay({ live: watcher?.chatIsLive() !== false, selfPollMs: API_POLL_MS })));
      }
    } finally {
      // Only clear our own registration — a replacement poller may already own it.
      if (apiPollerFor === pg) apiPollerFor = null;
    }
    console.log(`[${tag}] api poller stopped`);
  };

  const openChat = async (videoId) => {
    if (page) { await page.close().catch(() => {}); page = null; }
    page = await context.newPage();
    // Bridge browser-context logs to Node/journalctl. YouTube's own console is
    // noisy, so only forward our [yt-dom] instrumentation (scrape/parse) + page
    // errors — this is what makes the intermittent superchat drops observable.
    page.on('console', (m) => {
      const t = m.text();
      if (t.startsWith('[yt-dom]')) console.log(`[${tag}] ${t}`);
    });
    page.on('pageerror', (e) => console.warn(`[${tag}] pageerror:`, e.message));

    // 'net' + 'dom' hook BEFORE navigation; 'api' starts AFTER load (needs ytcfg).
    if (READ_MODE === 'net') {
      attachPassiveNetRead(page);
    } else if (READ_MODE === 'dom') {
      await page.exposeFunction('__ssOnMessage', deliverText);
      await page.exposeFunction('__ssOnEvent', deliverEvent);
    }

    await page.goto(`https://www.youtube.com/live_chat?is_popout=1&v=${videoId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(3000); // let the chat iframe/list render
    // Shell-health check: the degraded "older browser" shell (bad UA / missing
    // CONSENT) has no #items — chat AND superchats silently zero (applies to all
    // read modes: no shell = no get_live_chat + no ytInitialData either). Log loudly.
    const hasItems = await page.evaluate(() => !!document.querySelector('#items')).catch(() => false);
    if (!hasItems) console.warn(`[${tag}] WARNING: no #items after load — likely the degraded "older browser" shell (UA/CONSENT?); chat + alerts will be silent`);
    else console.log(`[${tag}] chat shell OK (#items present)`);
    let freshLiveToken = null;
    if (CHAT_MODE === 'live') {
      const sel = await selectLiveChatMode(page);
      freshLiveToken = sel.token;
      if (sel.needsToken && !freshLiveToken) {
        // The switch's own response wasn't captured (selector drift / timing).
        // Without it the api poller chains the Top-chat-anchored ytInitialData
        // token and silently drops messages all stream — before accepting that,
        // wait for the popout's OWN next polls (it polls the now-active view).
        for (let attempt = 1; attempt <= 2 && !freshLiveToken; attempt++) {
          console.warn(`[${tag}] no Live-chat continuation captured — waiting for the popout's own poll (attempt ${attempt}/2)`);
          freshLiveToken = await captureNextContinuation(page, 20000);
        }
        if (!freshLiveToken) {
          console.warn(`[${tag}] TOP-CHAT FALLBACK ACTIVE — no Live-chat continuation captured; messages may be filtered`);
        }
      }
    }
    if (READ_MODE === 'dom') await page.evaluate(installObserver);
    console.log(`[${tag}] watching ${watcher?.chatIsLive() === false ? 'countdown' : 'live'} chat for ${videoId} (${channelId}) [read=${READ_MODE}]`);
    // The watchdog measures liveness from max(lastPollOkAt, pageOpenedAt). Stamp
    // this BEFORE starting the poller: a page that never gets a poller at all
    // (bootstrap failure) still needs a defensible clock to be judged against,
    // and a fresh page must not inherit the previous poller's lastPollOkAt.
    pageOpenedAt = Date.now();
    resetCounts();
    // Kick off the self-poller after the mode switch so it bootstraps from the
    // Live-chat continuation. Fire-and-forget: it runs until the page is replaced.
    // The .catch is not decorative — an unawaited rejection here (e.g. the
    // bootstrap evaluate throwing outside its own catch) would otherwise surface
    // only as an unhandled rejection, with the poller silently absent.
    if (READ_MODE === 'api') {
      startApiPoller(page, freshLiveToken).catch((e) =>
        console.warn(`[${tag}] api poller crashed on startup: ${e.message}`));
    }
  };

  // Single-flight: openChat's worst-case serial budget (goto 30s + settle +
  // mode select + continuation retries) comfortably exceeds POLL_MS, and
  // setInterval doesn't wait — an overlapping tick would run the watchdog
  // against a page still MID-BOOTSTRAP (pageOpenedAt not yet restamped) and
  // could call openChat concurrently: two closures racing on `page`, and in
  // dom mode a second exposeFunction on the same page throws.
  watcher = createYtWatcher({
    channelId,
    relay: !!onMessage,
    tag,
    chat: {
      open: async (videoId) => {
        apiStallCount = 0;
        await openChat(videoId);
        identity?.stop();          // reset any prior stream's map
        await identity?.start(videoId);
      },
      close: async () => {
        apiStallCount = 0;
        identity?.stop();
        if (page) { await page.close().catch(() => {}); page = null; }
      },
      msSinceOk: () => Date.now() - lastPollOkAt,
      // Liveness watchdog over the open page (a live chat or a countdown; '' = none to watch). The
      // decision is in lib/ytWatchdog.js, pure and tested. It does not require `apiPollerFor ===
      // page`: a page in api mode that hasn't polled successfully is stalled whether the poller is
      // wedged, died, or never started.
      supervise: async (videoId) => {
        const now = Date.now();
        const wd = decideWatchdog({
          readMode: READ_MODE,
          videoId,
          hasPage: !!page,
          pollerRegistered: apiPollerFor === page,
          msSinceHealthy: now - Math.max(lastPollOkAt, pageOpenedAt),
          stallCount: apiStallCount,
          stallMs: STALL_MS,
          stallTicks: STALL_TICKS,
        });
        apiStallCount = wd.stallCount;
        const dead = Math.round((now - Math.max(lastPollOkAt, pageOpenedAt)) / 1000);
        if (wd.action === 'rebuild') {
          rebuildCount++;
          console.warn(`[${tag}] api poller stalled (${wd.reason}, ${dead}s without a successful poll) — rebuilding chat page`);
          await openChat(videoId);
        } else if (wd.action === 'count') {
          // Every strike is logged, so the dead chat before a rebuild leaves a trace.
          console.warn(stallStrikeLine(tag, wd, dead, STALL_TICKS));
        }
      },
    },
  });

  let ticking = false;
  const tick = async () => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      await watcher.tick();
    } catch (err) {
      console.warn(`[${tag}] tick error:`, err.message);
    } finally {
      ticking = false;
    }
  };

  await tick();
  const timer = setInterval(tick, POLL_MS);
  if (timer.unref) timer.unref();

  return {
    // The liveness observation for the poller (ADR 0133, lib/ytEndDecision.js watcherVote), plus
    // the verified live id ('' unless live: the viewer count and the site's embed never point at an
    // ended or scheduled broadcast). YouTube's own answer, apart from whether a chat page is open:
    // an answered end is offline while the tail is still read (certain when the known video's own
    // page, or the Data API, said so); a countdown is upcoming; a lookup that could not ask holds
    // live only while a live broadcast's page is open, else unknown.
    getLiveState: () => watcher.getLiveState(),
    getVideoId: () => watcher.getLiveState().videoId,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      identity?.stop();
      await browser.close().catch(() => {});
    },
  };
}
