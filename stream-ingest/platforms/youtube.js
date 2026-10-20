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

import { chromium } from 'playwright';
import { processMessage } from '../lib/pipeline.js';
import { normalizeYouTubeEvent } from '../lib/alerts.js';
import { postAlert, postPlatformDelete } from '../lib/api.js';
import { decideWatchdog, STALL_MS, STALL_TICKS } from '../lib/ytWatchdog.js';
import { decideEnd } from '../lib/ytEndDecision.js';
import { instanceConfig } from '../lib/instanceConfig.js';

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
function ytParseEvent(item) {
  if (item.liveChatPaidMessageRenderer) {
    const r = item.liveChatPaidMessageRenderer;
    return { kind: 'superchat', author: r.authorName?.simpleText || '', avatar: ytAvatar(r),
      amount: r.purchaseAmountText?.simpleText || '', message: ytRunsToText(r.message?.runs).text };
  }
  if (item.liveChatPaidStickerRenderer) {
    const r = item.liveChatPaidStickerRenderer;
    return { kind: 'supersticker', author: r.authorName?.simpleText || '', avatar: ytAvatar(r),
      amount: r.purchaseAmountText?.simpleText || '' };
  }
  if (item.liveChatMembershipItemRenderer) {
    const r = item.liveChatMembershipItemRenderer;
    const subtext = ytRunsToText(r.headerSubtext?.runs).text || '';
    const primaryHeader = ytRunsToText(r.headerPrimaryText?.runs).text || '';
    const header = subtext || primaryHeader;
    // `subtext`/`primaryHeader` ride along so lib/alerts.js can read the membership LEVEL name
    // ("Welcome to <level>!", or a milestone's subtext) — `header` keeps its old meaning.
    return { kind: 'membership', author: r.authorName?.simpleText || '', avatar: ytAvatar(r), header, subtext, primaryHeader };
  }
  if (item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer) {
    const r = item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer;
    const hdr = r.header?.liveChatSponsorshipsHeaderRenderer;
    const primary = ytRunsToText(hdr?.primaryText?.runs).text || '';
    const author = r.authorName?.simpleText || hdr?.authorName?.simpleText || (primary.split(/\s+(?:gifted|sent)\s+/i)[0] || '').trim();
    // The count is read from `primary` by normalizeYouTubeEvent (lib/alerts.js
    // parseGiftCount), the one parser both scrape paths share.
    return { kind: 'membership-gift', author, avatar: ytAvatar(hdr) || ytAvatar(r), primary };
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

// Extract + parse ytInitialPlayerResponse from a watch-page HTML blob.
//
// Scans for the matching close brace, tracking string state and escapes so
// braces inside strings never affect depth. A lazy regex to the first `};var`
// or `};</script>` truncates the JSON when a title or description contains that
// sequence, and the parse failure then reads as "no player response", i.e. as
// the stream having ended.
export function parsePlayerResponse(html) {
  const key = 'ytInitialPlayerResponse';
  const at = html.indexOf(key);
  if (at === -1) return null;
  const start = html.indexOf('{', at);
  if (start === -1) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch (e) {
          // A real parse failure is worth seeing — it is NOT the same as "offline",
          // and callers treat null as "no data" rather than "not live".
          console.warn('[yt-dom] ytInitialPlayerResponse parse failed:', e.message);
          return null;
        }
      }
    }
  }
  console.warn('[yt-dom] ytInitialPlayerResponse never closed — truncated page?');
  return null;
}

// Authoritative per-video check via the watch page's player microformat: who
// owns the video and whether it is live RIGHT NOW. Zero quota, one fetch.
async function watchLiveState(videoId) {
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`,
    { headers: PAGE_HEADERS, signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  const pr = parsePlayerResponse(await res.text());
  const mf = pr?.microformat?.playerMicroformatRenderer;
  if (!pr?.videoDetails && !mf) return null;
  return {
    channelId: pr?.videoDetails?.channelId || mf?.externalChannelId || '',
    isLiveNow: !!mf?.liveBroadcastDetails?.isLiveNow,
  };
}

// Zero-quota live detection: scrape the channel's /live page (the approach
// the website uses) instead of the YouTube Data API search, which costs 100 quota
// units per call and exhausts the daily quota on a multi-hour stream. No API key.
// Exported: lib/poller.js reuses this for viewer polling (same quota reasoning).
//
// The /live page is served in inconsistent variants: some have no canonical
// link, and the first "videoId" in the HTML is then a recommendation — another
// channel's live stream. So every candidate — and, via knownId, the video
// already being watched — is verified against its own watch page: the owner
// channel must match AND the video must be live right now.
export async function findLiveVideoId(channelId = channelIdCfg(), { allowEnvOverride = true, knownId = '' } = {}) {
  if (allowEnvOverride && process.env.YOUTUBE_VIDEO_ID) return process.env.YOUTUBE_VIDEO_ID.trim(); // manual override/testing
  // Sticky path: once live on a video, re-verify THAT video directly and skip
  // the flaky /live scrape entirely while it stays live.
  if (knownId) {
    const st = await watchLiveState(knownId).catch(() => null);
    if (st && st.channelId === channelId && st.isLiveNow) return knownId;
  }
  try {
    const res = await fetch(`https://www.youtube.com/channel/${channelId}/live?hl=en`,
      { headers: PAGE_HEADERS, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const m = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})">/)
           || html.match(/"videoId":"([\w-]{11})"/);
    const candidate = m ? m[1] : null;
    if (!candidate || candidate === knownId) return null; // knownId already failed verification above
    const st = await watchLiveState(candidate);
    if (!st) { console.warn(`[youtube] live lookup: cannot verify ${candidate} (no player response)`); return null; }
    if (st.channelId !== channelId) {
      console.warn(`[youtube] live lookup: /live resolved to foreign video ${candidate} (owner ${st.channelId || '?'}) — ignored`);
      return null;
    }
    return st.isLiveNow ? candidate : null;
  } catch (err) {
    console.warn('[youtube] live lookup failed:', err.message);
    return null;
  }
}

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
      return { kind, author, avatar, amount, message };
    }
    if (kind === 'supersticker') {
      const amount = r.querySelector('#purchase-amount-chip')?.textContent?.trim()
        || r.querySelector('#purchase-amount')?.textContent?.trim() || '';
      return { kind, author, avatar, amount };
    }
    if (kind === 'membership') {
      const subtext = r.querySelector('#header-subtext')?.textContent?.trim() || '';
      const primaryHeader = r.querySelector('#header-primary-text')?.textContent?.trim() || '';
      const header = subtext || primaryHeader;
      return { kind, author, avatar, header, subtext, primaryHeader };
    }
    if (kind === 'membership-gift') {
      const primary = r.querySelector('#primary-text')?.textContent?.trim()
        || r.querySelector('#message')?.textContent?.trim() || '';
      const gifter = author || (primary.split(/\s+(?:gifted|sent)\s+/i)[0] || '').trim();
      // Raw text, not a count: this function runs inside the page and cannot
      // reach lib/alerts.js, so the count is parsed on the Node side by the
      // same parseGiftCount the innertube path uses.
      return { kind, author: gifter, avatar, primary };
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
  const browser = await chromium.launch({
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
  let currentVideoId = null;
  let missCount = 0;   // consecutive failed live-lookups while watching a video
  let endHoldLogged = false; // one hold line per degraded-lookup episode, not per tick
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
        // Ids and amounts only — never the donor's name (review round 5, L14).
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
    let lastCadenceLog = 0;
    let lastTimeoutMs = '?';
    console.log(`[${tag}] api poller started (self-poll ${API_POLL_MS}ms, ignoring server timeoutMs)${overrideToken ? ' [bootstrapped from Live chat switch]' : ' [bootstrapped from ytInitialData — Top chat if a switch was expected]'}`);
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
        const now = Date.now();
        if (now - lastCadenceLog > 30000) {
          lastCadenceLog = now;
          const healthy = cnt.ok > 0;
          const line =
            `[${tag}] api cadence: self-poll=${API_POLL_MS}ms serverTimeoutMs=${lastTimeoutMs} seen=${seen.size} ` +
            `| ok=${cnt.ok} noLcc=${cnt.noLcc} http=${cnt.httpErr} fail=${cnt.fail} rebuilds=${rebuildCount} ` +
            // The drain, not the fetch. `txt` is what actually reached the
            // pipeline, so it can be compared straight against chat_log rows
            // for the same window.
            `| txt=${cnt.txt} ev=${cnt.ev} drop=${cnt.dropText}/${cnt.dropEvent} other=${cnt.other} ` +
            `| lastOk=${lastPollOkAt ? Math.round((now - lastPollOkAt) / 1000) + 's ago' : 'never'}`;
          if (healthy) console.log(line);
          else console.warn(line + ' — NO SUCCESSFUL POLLS THIS WINDOW');
          // Loud and greppable: a discard can hide behind a healthy-looking
          // cadence line.
          if (cnt.dropText || cnt.dropEvent) {
            console.warn(`[${tag}] DISCARDED ${cnt.dropText} text + ${cnt.dropEvent} event item(s) this window — recognised renderers that produced nothing`);
          }
          resetCounts();
        }
        await new Promise((r) => setTimeout(r, API_POLL_MS));
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
    console.log(`[${tag}] watching live chat for ${videoId} (${channelId}) [read=${READ_MODE}]`);
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
  let ticking = false;
  const tick = async () => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      const videoId = await findLiveVideoId(channelId, { allowEnvOverride: !onMessage, knownId: currentVideoId || '' });
      if (videoId) { missCount = 0; endHoldLogged = false; }
      if (videoId && videoId !== currentVideoId) {
        currentVideoId = videoId;
        apiStallCount = 0;
        await openChat(videoId);
        identity?.stop();          // reset any prior stream's map
        await identity?.start(videoId);
      } else if (!videoId && currentVideoId) {
        // A failed lookup is "unknown", not "ended" (lib/ytEndDecision.js): the
        // /live lookup can fail while the chat poller is still answering every
        // second. While the chat continuation has delivered recently, hold;
        // otherwise apply the 3-miss debounce.
        const d = decideEnd({ missCount, msSinceChatOk: Date.now() - lastPollOkAt });
        missCount = d.missCount;
        if (d.action === 'hold') {
          if (!endHoldLogged) {
            endHoldLogged = true;
            console.log(`[${tag}] live lookup failing but chat is delivering — holding open (logged once per episode)`);
          }
          return;
        }
        if (d.action === 'count') return;
        console.log(`[${tag}] stream ended; closing chat`);
        currentVideoId = null;
        missCount = 0;
        apiStallCount = 0;
        identity?.stop();
        if (page) { await page.close().catch(() => {}); page = null; }
      } else {
        // Liveness watchdog. The decision is in lib/ytWatchdog.js, pure and
        // tested. It does not require `apiPollerFor === page`: a live page in
        // api mode that hasn't polled successfully is stalled whether the
        // poller is wedged, died, or never started.
        const now = Date.now();
        const d = decideWatchdog({
          readMode: READ_MODE,
          videoId,
          hasPage: !!page,
          pollerRegistered: apiPollerFor === page,
          msSinceHealthy: now - Math.max(lastPollOkAt, pageOpenedAt),
          stallCount: apiStallCount,
          stallMs: STALL_MS,
          stallTicks: STALL_TICKS,
        });
        apiStallCount = d.stallCount;
        const dead = Math.round((now - Math.max(lastPollOkAt, pageOpenedAt)) / 1000);
        if (d.action === 'rebuild') {
          rebuildCount++;
          console.warn(`[${tag}] api poller stalled (${d.reason}, ${dead}s without a successful poll) — rebuilding chat page`);
          await openChat(currentVideoId);
        } else if (d.action === 'count') {
          // Every strike is logged, so the dead chat before a rebuild leaves a trace.
          console.warn(`[${tag}] api poller looks stalled (${d.reason}, ${dead}s) — strike ${d.stallCount}/${STALL_TICKS}`);
        }
      }
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
    // Authoritative live videoId for the poller: ownership+isLiveNow verified
    // and 3-miss debounced by this watcher's own tick. '' when not live.
    getVideoId: () => currentVideoId || '',
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      identity?.stop();
      await browser.close().catch(() => {});
    },
  };
}
