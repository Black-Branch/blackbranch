// Kick connector — chat, Kick-side moderation and monetization over Kick's realtime socket.
// No browser, except as the fallback for the one-time channel-id lookup.
//
// Transport: Kick runs its own realtime service on Centrifugo (JSON protocol). Kick names the
// transport per connection, so that is the place to look when Kick chat stops arriving:
//   1. POST web.kick.com/api/v1/realtime/channels/{channelId}/chat/connection — the descriptor:
//      which provider to speak and the socket URL (its region depends on where the caller is).
//   2. POST web.kick.com/api/v1/realtime/auth/connection — a short-lived guest JWT for that client.
//   3. Open the socket, `connect` with the token, `subscribe` to the channels, answer pings, and
//      `refresh` the token before its ttl runs out.
// The descriptor is how the move off Pusher was found: the old Pusher app key began refusing new
// connections (close 4001, "not in this cluster") while sockets already open kept working, so the
// break showed only at the next restart. A descriptor naming another provider is logged as an error.

import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { processMessage } from '../lib/pipeline.js';
import { normalizeKickEvent } from '../lib/alerts.js';
import { postAlert, postPlatformDelete } from '../lib/api.js';
import { instanceConfig } from '../lib/instanceConfig.js';
import { payloadShape } from '../lib/logShape.js';

const REALTIME_API = 'https://web.kick.com/api/v1/realtime';
const KICK_ORIGIN = 'https://kick.com';
const KICK_EMOTE_RE = /\[emote:(\d+):([^\]]+)\]/g;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function idsFrom(data) {
  const chatroomId = data?.chatroom?.id;
  if (!chatroomId) throw new Error('no chatroom.id in response');
  // Both are needed: the channel id names the realtime descriptor and the `channel.{id}`
  // subscription (subs, gifts, Kicks); chat itself is on `chatrooms.{chatroomId}.v2`.
  if (data?.id == null) throw new Error('no channel id in response');
  return { chatroomId: String(chatroomId), channelId: String(data.id) };
}

// Current live viewer count (poll-cadence, called by lib/poller.js).
// PRIMARY: the official public API (api.kick.com) with a client-credentials app
// token — the unauthenticated v2 endpoint is Kasada-guarded and can 403 on
// every tick. The v2 fetch is kept as the fallback for environments without KICK_CLIENT_* creds
// or when the official API errors. A failure reuses the last-good count if it's
// fresh enough, else returns null (unknown — the snapshot column stays NULL and
// doesn't drag `total` down). Deliberately NEVER escalates to the Chromium
// fallback: too heavy for a 60s tick.
let lastGoodViewers = null; // { count, at }
let loggedViewerShape = false;
let loggedOfficialShape = false;
const KICK_VIEWER_STALE_MS = 5 * 60 * 1000;

// App access token for the official public API (client credentials — no user).
let appToken = null; // { token, expiresAt }
async function getKickAppToken() {
  const id = instanceConfig.get('kick.clientId');
  const secret = instanceConfig.get('kick.clientSecret');
  if (!id || !secret) return null;
  if (appToken && Date.now() < appToken.expiresAt - 60_000) return appToken.token;
  const res = await fetch('https://id.kick.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`token HTTP ${res.status}`);
  const j = await res.json();
  if (!j.access_token) throw new Error('token response missing access_token');
  appToken = { token: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return appToken.token;
}

// Official API: GET /public/v1/channels?slug= → data[0].stream.{is_live,viewer_count}.
// Returns {live, viewers}. Throws on HTTP/token errors so the caller can fall back to v2.
async function viewersViaOfficial(slug, token) {
  const res = await fetch(`https://api.kick.com/public/v1/channels?slug=${encodeURIComponent(slug)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 401) { appToken = null; throw new Error('HTTP 401 (app token rejected)'); }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ch = (await res.json())?.data?.[0];
  if (!ch) throw new Error('no channel in official response');
  const st = ch.stream;
  if (!st || st.is_live === false) return { live: false, viewers: null }; // confirmed offline
  const n = Number(st.viewer_count ?? st.viewers);
  if (!Number.isFinite(n)) {
    if (!loggedOfficialShape) {
      loggedOfficialShape = true;
      console.log(`[kick] official stream shape (map viewer field): ${payloadShape(st)}`);
    }
    return { live: true, viewers: null }; // confirmed live, count unparseable
  }
  return { live: true, viewers: n };
}

// Legacy v2 scrape — works only when Kasada isn't challenging.
async function viewersViaV2(slug) {
  const res = await fetch(`https://kick.com/api/v2/channels/${slug}`, {
    headers: { Accept: 'application/json', 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ls = (await res.json())?.livestream;
  if (!ls || ls.is_live === false) return { live: false, viewers: null }; // confirmed offline
  const n = Number(ls.viewer_count ?? ls.viewers);
  if (!Number.isFinite(n)) {
    if (!loggedViewerShape) {
      loggedViewerShape = true;
      console.log(`[kick] livestream shape (map viewer field): ${payloadShape(ls)}`);
    }
    return { live: true, viewers: null }; // confirmed live, count unparseable
  }
  return { live: true, viewers: n };
}

// Current live state + viewer count (poll-cadence, called by lib/poller.js).
// Returns { state: 'live'|'offline'|'unknown', viewers: number|null }. 'offline'
// is a genuine is_live:false answer from Kick; 'unknown' means every fetch path
// errored and there's no fresh last-good count to smooth over it. The caller
// must NOT treat 'unknown' as 'offline' — that would make a network blip
// indistinguishable from Kick actually ending.
export async function fetchKickState(slug = instanceConfig.get('platform.kick.slug')) {
  let usedOfficial = false;
  try {
    const token = await getKickAppToken().catch((e) => {
      console.warn('[kick] app token:', e.message);
      return null;
    });
    usedOfficial = token != null;
    const r = usedOfficial ? await viewersViaOfficial(slug, token) : await viewersViaV2(slug);
    if (r.live && r.viewers != null) lastGoodViewers = { count: r.viewers, at: Date.now() };
    return { state: r.live ? 'live' : 'offline', viewers: r.viewers };
  } catch (e) {
    if (usedOfficial) {
      try {
        const r = await viewersViaV2(slug);
        if (r.live && r.viewers != null) lastGoodViewers = { count: r.viewers, at: Date.now() };
        return { state: r.live ? 'live' : 'offline', viewers: r.viewers };
      } catch { /* fall through to last-good/unknown */ }
    }
    if (lastGoodViewers && Date.now() - lastGoodViewers.at < KICK_VIEWER_STALE_MS) {
      return { state: 'unknown', viewers: lastGoodViewers.count };
    }
    console.warn('[kick] viewer fetch:', e.message);
    return { state: 'unknown', viewers: null };
  }
}

// Plain fetch — works when Kick's API isn't actively challenging.
async function resolveViaApi(slug) {
  const res = await fetch(`https://kick.com/api/v2/channels/${slug}`, {
    headers: { Accept: 'application/json', 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return idsFrom(await res.json());
}

// Fallback: hit the same JSON endpoint inside a real Chromium context, which
// satisfies Kick's Kasada bot check far more often than a bare fetch. Reuses the
// Playwright dependency already needed for YouTube. One-shot at startup.
async function resolveViaBrowser(slug) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  try {
    const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US' });
    const page = await ctx.newPage();
    await page.goto(`https://kick.com/api/v2/channels/${slug}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
    const text = await page.evaluate(() => document.body.innerText);
    return idsFrom(JSON.parse(text));
  } finally {
    await browser.close().catch(() => {});
  }
}

async function resolveIds(slug, { allowEnvOverride = true } = {}) {
  // KICK_CHATROOM_ID + KICK_CHANNEL_ID override the HOME channel only; a relay for another
  // streamer must resolve its own ids. Chat needs both (the channel id names the realtime
  // descriptor), so a chatroom id on its own is not enough to skip the lookup.
  if (allowEnvOverride && process.env.KICK_CHATROOM_ID) {
    if (process.env.KICK_CHANNEL_ID) {
      return { chatroomId: process.env.KICK_CHATROOM_ID.trim(), channelId: process.env.KICK_CHANNEL_ID.trim() };
    }
    console.warn('[kick] KICK_CHATROOM_ID is set without KICK_CHANNEL_ID — chat needs the channel id too, so looking both up');
  }
  try {
    return await resolveViaApi(slug);
  } catch (e1) {
    console.warn(`[kick] api channel lookup failed (${e1.message}); retrying via browser`);
    try {
      return await resolveViaBrowser(slug);
    } catch (e2) {
      console.warn(`[kick] browser channel lookup failed (${e2.message}); set KICK_CHATROOM_ID and KICK_CHANNEL_ID in .env to override (stable per channel)`);
      return null;
    }
  }
}

// Map a raw Kick monetization event → /alert. Home connection only. Field names vary and can't
// be tested synthetically, so every event logs its SHAPE — the event id and the payload's
// top-level keys (lib/logShape.js) — which is enough to see where a field moved and to find the
// event again on Kick's side. Never the values: until round 7 this line printed the first 400
// characters of the raw payload, which names the subscriber, the gifter and every giftee, and the
// journal keeps that for months. Exported for platforms/kickLogs.test.js.
export function handleKickMonetization(eventName, dataStr) {
  let d;
  try { d = JSON.parse(dataStr); } catch { d = {}; }
  console.log(`[kick] monetization ${eventName} ${payloadShape(dataStr)}`);
  let evt = null;
  if (eventName.endsWith('SubscriptionEvent')) {
    evt = { kind: 'sub', username: d.username || d.user?.username, months: d.months ?? d.duration, id: d.id };
  } else if (eventName.endsWith('GiftedSubscriptionsEvent')) {
    const giftees = d.gifted_usernames || d.giftees || d.usernames || [];
    evt = { kind: 'giftsub',
      gifter: d.gifter_username || d.gifter?.username || d.username,
      count: Array.isArray(giftees) && giftees.length ? giftees.length : (Number(d.gifted_quantity) || 1),
      recipient: Array.isArray(giftees) && giftees.length === 1 ? giftees[0] : '',
      id: d.id };
  } else if (eventName.includes('Kicks')) {
    evt = { kind: 'kicks', username: d.sender?.username || d.username, kicks: d.amount ?? d.gift?.amount ?? d.kicks, id: d.id };
  }
  const alert = evt && normalizeKickEvent(evt);
  if (alert) {
    console.log(`[kick] alert ${alert.eventType} event=${alert.eventId ?? '?'}`);
    postAlert(alert).catch((e) => console.error(`[kick] postAlert FAILED type=${alert.eventType} id=${evt.id ?? '?'} ${evt.kind === 'kicks' ? `kicks=${evt.kicks}` : evt.kind === 'giftsub' ? `count=${evt.count}` : ''}: ${e.message}`));
  }
}

// Kick-side moderation → site mirror. These ride the chatrooms.{id}.v2 channel
// (same as chat). Parsed defensively — payload shapes come from observed
// frames and Kick can drift them; an unparsable frame is logged, never thrown.
const KICK_MODERATION_EVENTS = new Set([
  'App\\Events\\MessageDeletedEvent',
  'App\\Events\\UserBannedEvent',
]);

// Pure parser (exported for tests): Kick moderation event → the
// postPlatformDelete payload, or null for shapes we don't mirror.
export function parseKickModeration(eventName, dataStr) {
  let d;
  try { d = JSON.parse(dataStr); } catch { return null; }
  if (eventName === 'App\\Events\\MessageDeletedEvent') {
    // Observed shape: { id: <event id>, message: { id: <deleted msg uuid> } }.
    const msgId = d?.message?.id ?? d?.messageId ?? null;
    return msgId ? { platform: 'kick', platformMsgId: String(msgId) } : null;
  }
  if (eventName === 'App\\Events\\UserBannedEvent') {
    // Observed shape: { id, user: {id, username, slug}, banned_by, expires_at? }.
    const userId = d?.user?.id != null ? String(d.user.id) : undefined;
    const username = d?.user?.username || d?.user?.slug || undefined;
    return (userId || username) ? { platform: 'kick', platformUserId: userId, username } : null;
  }
  return null;
}

const KICK_MONETIZATION_EVENTS = new Set([
  'App\\Events\\SubscriptionEvent',
  'App\\Events\\GiftedSubscriptionsEvent',
  'App\\Events\\LuckyUsersWhoGotGiftSubEvent',
  'App\\Events\\KicksGifted',
]);

// Replace [emote:id:name] markup with the bare name; collect {name:url}.
function extractEmotes(content) {
  const emotes = {};
  const text = String(content || '').replace(KICK_EMOTE_RE, (_m, id, name) => {
    emotes[name] = `https://files.kick.com/emotes/${id}/fullsize`;
    return name;
  });
  return { text, emotes };
}

function flagsFromBadges(identity) {
  const badges = identity?.badges || [];
  const types = new Set(badges.map((b) => (b?.type || '').toLowerCase()));
  const info = identity?.badge_info || {};
  return {
    isMod: types.has('moderator') || Boolean(info.moderator || info.mod),
    isVip: types.has('vip') || Boolean(info.vip),
    isMember: types.has('subscriber') || types.has('founder') || types.has('og'),
    tier: types.has('founder') ? 'founder' : types.has('subscriber') ? 'subscriber' : '',
  };
}

function handleChatEvent(dataStr, sink) {
  let payload;
  try {
    payload = JSON.parse(dataStr);
  } catch {
    return;
  }
  const sender = payload.sender || {};
  const { text, emotes } = extractEmotes(payload.content);
  const flags = flagsFromBadges(sender.identity);
  // Kick delivers reply context inline when a message is a reply.
  // (Shape per Kick's ChatMessageEvent — verify against a live reply frame.)
  const meta = payload.metadata || {};
  const replyToUsername = meta.original_sender?.username || undefined;
  const replyToText = meta.original_message?.content
    ? extractEmotes(meta.original_message.content).text
    : undefined;
  sink({
    platform: 'kick',
    userId: sender.id != null ? String(sender.id) : '',
    username: sender.username || sender.slug || 'Kick viewer',
    message: text,
    ...flags,
    emotes,
    replyToUsername,
    replyToText,
    platformMsgId: payload.id != null ? String(payload.id) : undefined,
    usernameColor: sender.identity?.color || undefined,
  });
}

// ── Realtime transport ──────────────────────────────────────────────────────────────────────

function realtimeHeaders() {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': UA,
    Origin: KICK_ORIGIN,
    Referer: `${KICK_ORIGIN}/`,
  };
}

// `what` leads the message so a journal line says which step failed: "descriptor 403 …", "token …".
async function postRealtime(what, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: realtimeHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new Error(`${what} request failed: ${e.cause?.message || e.message}`, { cause: e });
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`${what} ${res.status} ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} ${res.status} answered non-JSON: ${text.slice(0, 200)}`);
  }
}

// Step 1. Both providers are offered because that is what Kick's own page offers: the answer is
// then the one the site gets, and a switch of provider shows up here instead of as a dead socket.
async function fetchSocketUrl(channelId, clientId) {
  const j = await postRealtime('descriptor', `${REALTIME_API}/channels/${encodeURIComponent(channelId)}/chat/connection`, {
    client: { id: clientId, type: 'web' },
    capabilities: { accepted_providers: [{ provider: 'pusher' }, { provider: 'centrifugo' }] },
  });
  const conns = Array.isArray(j?.data?.connections) ? j.data.connections : [];
  const ours = conns.find((c) => c?.provider === 'centrifugo' && typeof c?.credentials?.url === 'string');
  if (ours) return ours.credentials.url;
  const offered = conns.map((c) => c?.provider ?? '?').join(', ') || 'nothing';
  const e = new Error(`descriptor offers ${offered}, and this reader speaks only centrifugo — Kick has changed its chat transport; see the header of platforms/kick.js (${JSON.stringify(j).slice(0, 200)})`);
  e.unsupported = true;
  throw e;
}

// Step 2: a guest token (HS256 JWT, sub `guest:<clientId>`). Fetched again for every refresh.
async function fetchToken(clientId) {
  const j = await postRealtime('token', `${REALTIME_API}/auth/connection`, { client_id: clientId });
  const token = j?.data?.token;
  if (typeof token !== 'string' || !token) throw new Error(`token: no data.token in ${JSON.stringify(j).slice(0, 200)}`);
  return token;
}

// Before the server's connect reply states its ping interval: two of Centrifugo's default 25 s
// pings plus slack. After it, the same rule applied to the interval the server states.
const DEFAULT_STALE_MS = 65_000;
const staleFromPing = (pingSec) => (pingSec * 2 + 15) * 1000;
// Refresh a minute before expiry (half-way when the ttl is shorter) so a slow token fetch still lands.
const refreshDelayMs = (ttlSec) => (ttlSec > 120 ? ttlSec - 60 : ttlSec / 2) * 1000;

/**
 * @param {object} [opts]
 * @param {string} [opts.slug] channel slug (default: home channel from env)
 * @param {(msg:object)=>void} [opts.onMessage] relay sink. When set, messages
 *   go here instead of the home pipeline and the env chatroom override is ignored.
 */
export async function startKick(opts = {}) {
  const slug = opts.slug || instanceConfig.get('platform.kick.slug');
  if (!slug) throw new Error('platform.kick.slug is not set (KICK_CHANNEL_SLUG)');
  const onMessage = opts.onMessage || null;
  const sink = onMessage || ((m) => processMessage(m));
  const tag = onMessage ? 'kick:relay' : 'kick';
  // Resolution is retried, never surrendered: a single attempt would let ONE
  // transient Kick API blip during boot disable Kick chat for the lifetime of the
  // process. Resolution runs in the background with capped backoff so a slow or
  // briefly unavailable Kick API self-heals. startKick still returns immediately, so a
  // failing Kick never delays the boot of the other connectors.
  let chatroomId = null;
  let channelId = null;
  // Monetization (subs/gifts/Kicks) is HOME-only and lives on the channel.{id}
  // subscription; relays skip it (chat still works).
  let wantMonetization = false;

  let ws = null;
  let stopped = false;
  let backoff = 1000;
  let reconnectTimer = null;
  let refreshTimer = null;
  let watchdog = null;
  let resolveTimer = null;
  let resolveWake = null; // resolver of the current retry sleep — called by stop()
  const STALE_OVERRIDE_MS = Number(process.env.KICK_STALE_MS) || 0;

  const clearSocketTimers = () => {
    clearTimeout(refreshTimer);
    refreshTimer = null;
    clearInterval(watchdog);
    watchdog = null;
  };

  // The ONLY place a reconnect is scheduled, and it holds at most one pending: a failed setup
  // step and a socket close can both ask, and one start must never end up with two sockets.
  // The descriptor and token calls ride the same capped ladder as the socket, so a Kick API
  // outage is retried forever and never surrendered.
  const scheduleReconnect = (why, level = 'warn') => {
    if (stopped || reconnectTimer) return;
    console[level](`[${tag}] ${why}; reconnecting in ${backoff}ms`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch((e) => scheduleReconnect(`connect threw: ${e.message}`));
    }, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  };

  // One raw Kick event — `{event, data, channel}`, `data` a JSON string. Kick's events kept this
  // shape across the change of transport, so the handlers above are transport-independent.
  const dispatch = ({ event, data, channel }) => {
    if (event === 'App\\Events\\ChatMessageEvent') {
      handleChatEvent(data, sink);
    } else if (!onMessage && KICK_MODERATION_EVENTS.has(event)) {
      // Home connection only: mirror Kick-side deletes/bans into site chat.
      const payload = parseKickModeration(event, data);
      if (payload) {
        postPlatformDelete(payload)
          .catch((e) => console.warn(`[kick] moderation mirror failed event=${event} id=${payload.platformMsgId ?? payload.platformUserId ?? '?'} keys=[${Object.keys(payload).join(',')}]: ${e.message}`));
      } else {
        console.log(`[kick] moderation event ${event} unparsed (shape drift?): ${payloadShape(data)}`);
      }
    } else if (wantMonetization && KICK_MONETIZATION_EVENTS.has(event)) {
      handleKickMonetization(event, data);
    } else if (wantMonetization && event) {
      // Discovery net: any other non-chat event (so a real sub/gift/Kicks whose
      // exact event name we don't yet bind still surfaces in journalctl).
      console.log(`[${tag}] unbound event ${event} on ${channel || '?'}: ${payloadShape(data)}`);
    }
  };

  const openSocket = (url, clientId, token) => {
    // handshakeTimeout: a socket that never completes the handshake (SYN blackhole, TLS stall)
    // emits neither 'open' nor 'close'; with the timeout ws emits error+close and the ladder runs.
    const sock = new WebSocket(url, { handshakeTimeout: 15_000, headers: { Origin: KICK_ORIGIN, 'User-Agent': UA } });
    ws = sock;
    const host = (() => { try { return new URL(url).host; } catch { return url; } })();
    let nextId = 1;
    const pending = new Map(); // command id → what it was, so a reply (or an error) can name it
    const send = (cmd, what) => {
      const id = nextId++;
      pending.set(id, what);
      sock.send(JSON.stringify({ ...cmd, id }));
    };

    // Liveness: a half-open socket stays readyState===OPEN while receiving nothing. The server
    // pings every `ping` seconds, so silence well past two pings means the socket is dead even
    // though nothing has said so; terminate() makes 'close' run, which reconnects.
    let lastFrameAt = Date.now();
    let staleMs = STALE_OVERRIDE_MS || DEFAULT_STALE_MS;
    watchdog = setInterval(() => {
      if (Date.now() - lastFrameAt <= staleMs) return;
      console.warn(`[${tag}] no frames for ${Math.round((Date.now() - lastFrameAt) / 1000)}s — socket is half-open, forcing reconnect`);
      try { sock.terminate(); } catch { /* already gone */ }
    }, Math.min(5_000, Math.max(250, staleMs / 2)));

    const scheduleRefresh = (ttlSec) => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(async () => {
        refreshTimer = null;
        try {
          const fresh = await fetchToken(clientId);
          if (stopped || ws !== sock || sock.readyState !== WebSocket.OPEN) return;
          send({ refresh: { token: fresh } }, 'refresh');
        } catch (e) {
          // Not fatal: at expiry the server closes the socket and the ladder reconnects with a new token.
          console.warn(`[${tag}] ${e.message} — token refresh failed; the socket will be closed at expiry and reconnect`);
        }
      }, refreshDelayMs(ttlSec));
    };

    const onConnected = (c) => {
      backoff = 1000;
      if (!STALE_OVERRIDE_MS && Number(c.ping) > 0) staleMs = staleFromPing(Number(c.ping));
      console.log(`[${tag}] connected to ${host} (centrifugo ${c.version || '?'}, ping ${c.ping ?? '?'}s, token ttl ${c.ttl ?? 'none'}s)`);
      // `flag: 1` as Kick's own page sends it.
      send({ subscribe: { channel: `chatrooms.${chatroomId}.v2`, flag: 1 } }, `chatrooms.${chatroomId}.v2`);
      if (wantMonetization) send({ subscribe: { channel: `channel.${channelId}`, flag: 1 } }, `channel.${channelId}`);
      if (c.expires && Number(c.ttl) > 0) scheduleRefresh(Number(c.ttl));
    };

    const handleFrame = (frame) => {
      if (!frame || typeof frame !== 'object') return;
      // A bare {} is the server's ping; the connect reply says `pong: true`, so it must be answered.
      if (Object.keys(frame).length === 0) {
        sock.send('{}');
        return;
      }
      if (frame.error) {
        const what = pending.get(frame.id) || 'unknown command';
        pending.delete(frame.id);
        console.error(`[${tag}] error reply to ${what} (id ${frame.id ?? '?'}): code ${frame.error.code} ${frame.error.message || ''}`.trimEnd());
        // A refused connect leaves a socket that will never carry chat; drop it and start over.
        if (what === 'connect') { try { sock.terminate(); } catch { /* already gone */ } }
        return;
      }
      const disconnect = frame.disconnect || frame.push?.disconnect;
      if (disconnect) {
        console.warn(`[${tag}] server disconnect: code ${disconnect.code} ${disconnect.reason || ''}`.trimEnd());
        return;
      }
      if (frame.id != null) {
        const what = pending.get(frame.id);
        pending.delete(frame.id);
        if (frame.connect) onConnected(frame.connect);
        else if (frame.subscribe) console.log(`[${tag}] subscribed ${what}${what?.startsWith('channel.') ? ' for monetization' : ''}`);
        else if (frame.refresh) {
          console.log(`[${tag}] token refreshed (ttl ${frame.refresh.ttl ?? 'none'}s)`);
          if (frame.refresh.expires && Number(frame.refresh.ttl) > 0) scheduleRefresh(Number(frame.refresh.ttl));
        }
        return;
      }
      const push = frame.push;
      if (!push) return;
      const pub = push.pub?.data;
      if (pub?.event) {
        // `data` has always been a JSON string; re-encode an object so the handlers see one shape.
        dispatch({ event: pub.event, data: typeof pub.data === 'string' ? pub.data : JSON.stringify(pub.data ?? {}), channel: push.channel });
      } else if (push.unsubscribe) {
        console.warn(`[${tag}] server unsubscribed ${push.channel}: code ${push.unsubscribe.code} ${push.unsubscribe.reason || ''}`.trimEnd());
      }
    };

    sock.on('open', () => {
      lastFrameAt = Date.now();
      send({ connect: { token, name: 'js' } }, 'connect');
    });

    // One websocket message may carry several commands, one JSON document per line.
    sock.on('message', (buf) => {
      lastFrameAt = Date.now();
      for (const line of String(buf).split('\n')) {
        if (!line.trim()) continue;
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          console.warn(`[${tag}] unparsable frame: ${line.slice(0, 200)}`);
          continue;
        }
        handleFrame(frame);
      }
    });

    sock.on('close', (code, reason) => {
      clearSocketTimers();
      if (ws === sock) ws = null;
      if (stopped) return;
      const why = reason?.length ? ` ${String(reason).slice(0, 200)}` : '';
      scheduleReconnect(`disconnected (close ${code}${why})`);
    });

    sock.on('error', (e) => console.warn(`[${tag}] ws error: ${e.message}`));
  };

  // One attempt: descriptor → token → socket. A fresh client id each time, as a fresh page load has.
  const connect = async () => {
    if (stopped) return;
    const clientId = randomUUID();
    let url;
    let token;
    try {
      url = await fetchSocketUrl(channelId, clientId);
      token = await fetchToken(clientId);
    } catch (e) {
      scheduleReconnect(e.message, e.unsupported ? 'error' : 'warn');
      return;
    }
    if (stopped) return;
    openSocket(url, clientId, token);
  };

  // Resolve (retrying forever, capped at 60s) then connect. Runs detached so a
  // failing Kick API never blocks startup of the other platform connectors.
  const resolveThenConnect = async () => {
    for (let attempt = 1; !stopped; attempt++) {
      const ids = await resolveIds(slug, { allowEnvOverride: !onMessage }).catch((e) => {
        console.warn(`[${tag}] resolveIds threw: ${e.message}`);
        return null;
      });
      if (stopped) return;
      if (ids?.chatroomId && ids?.channelId) {
        chatroomId = ids.chatroomId;
        channelId = ids.channelId;
        wantMonetization = !onMessage;
        console.log(`[${tag}] chatroom ${chatroomId}, channel ${channelId} (${slug})`);
        await connect().catch((e) => scheduleReconnect(`connect threw: ${e.message}`));
        return;
      }
      const wait = Math.min(60_000, 5_000 * attempt);
      console.warn(`[${tag}] no chatroom/channel id for ${slug} — retrying in ${Math.round(wait / 1000)}s (attempt ${attempt})`);
      await new Promise((r) => { resolveTimer = setTimeout(r, wait); resolveWake = r; });
      resolveWake = null;
    }
  };
  resolveThenConnect();

  return {
    stop: () => {
      stopped = true;
      // Resolve (not just clear) the retry sleep: clearing alone would leave the
      // await pending forever, leaking resolveThenConnect's async frame on
      // every start/stop cycle. The loop then exits on `stopped`.
      if (resolveTimer) clearTimeout(resolveTimer);
      if (resolveWake) resolveWake();
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      clearSocketTimers();
      if (ws) ws.close();
    },
  };
}
