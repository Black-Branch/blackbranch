// Send a chat message to a streaming platform via the user's linked OAuth token.
// Called from /api/chat/send when the user replies to a platform message.

import pool from "@/lib/db";
import { getAccessToken } from "@/app/lib/platformTokens";
import { getAtprotoClient } from "@/app/lib/atprotoClient";
import { Agent } from "@atproto/api";
import { twitchBroadcasterId, twitchClientId } from "@/app/lib/twitch";
import { escapeLeadingCommand } from "@/app/lib/outgoingText";
import { getManifest } from "@/app/api/emotes/route";
import { instanceString } from "@/app/lib/instanceConfigServer";
import {
  twitchSendOutcome, kickSendOutcome, kickErrorOutcome, httpUnavailable, youtubeErrorOutcome, thrownFailure,
  kickKnownRefusal, kickForbiddenOutcome, bodyShape,
  type Unavailable,
} from "@/app/lib/sendDelivery";

// Instance keys, read per call (env first, then the stored values).
const streamplaceDid = () => instanceString("platform.streamplace.did");

// The home Kick channel: its numeric user id, else (as this line always did) the slug.
const kickBroadcasterId = () => instanceString("platform.kick.userId") ?? instanceString("platform.kick.slug") ?? "";
// Deliberately NOT non-null-asserted: a missing YouTube config must read as a
// loud config error, not silently build ".../channel/undefined/live" and
// masquerade as "not_live" (which is what the old `!` asserts did).
const youtubeChannelId = () => instanceString("platform.youtube.channelId");
const youtubeApiKey = () => instanceString("youtube.apiKey");

export type PlatformSendResult =
  // platformMsgId = the platform's own id for the message we just posted (when
  // the send API returns one). /api/chat/send persists it in
  // site.chat_message_platform_copies so a later site-side delete/purge can
  // remove the cross-posted copies (platformMod's fanOutDelete native branch).
  | { ok: true; platformMsgId?: string }
  // "refused" = the platform answered and declined this message (followers-only,
  // AutoMod, duplicate…); `reason` is a short phrase for the sender (sendDelivery.ts).
  | { ok: false; error: "not_linked" | "not_live" | "send_failed" | "missing_scope" | "unsupported_platform" | "refused"; reason?: string }
  // Infrastructure — quota, rate limit, 5xx, timeout, our own config/throw: nothing
  // the viewer can act on (sendDelivery.ts). `code` is for the journal only.
  | ({ ok: false } & Unavailable);

// ─── Twitch ──────────────────────────────────────────────────────────────────

// Resolve a Twitch login to its numeric user id (Helix users — any valid token
// + our client-id works). Cached briefly so a relay session doesn't re-resolve
// the same login every message.
const twitchIdCache = new Map<string, { id: string; ts: number }>();
const TWITCH_ID_CACHE_MS = 30 * 60 * 1000;

async function resolveTwitchId(login: string, token: string): Promise<string | null> {
  const key = login.toLowerCase();
  const cached = twitchIdCache.get(key);
  if (cached && Date.now() - cached.ts < TWITCH_ID_CACHE_MS) return cached.id;
  const res = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}`, "Client-Id": twitchClientId() },
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);
  if (!res?.ok) return null;
  const data = await res.json() as { data?: { id: string }[] };
  const id = data.data?.[0]?.id ?? null;
  if (id) twitchIdCache.set(key, { id, ts: Date.now() });
  return id;
}

async function sendTwitch(
  matrixId: string,
  message: string,
  broadcasterLogin?: string,
  replyParentId?: string
): Promise<PlatformSendResult> {
  const token = await getAccessToken(matrixId, "twitch");
  if (!token) return { ok: false, error: "not_linked" };

  const { rows } = await pool.query<{ provider_account_id: string }>(
    `SELECT provider_account_id FROM site.accounts
     WHERE matrix_id = $1 AND provider = 'twitch' AND type = 'oauth' LIMIT 1`,
    [matrixId]
  );
  const senderId = rows[0]?.provider_account_id;
  if (!senderId) return { ok: false, error: "not_linked" };

  // Default target is the home channel; a relay supplies the featured streamer's login.
  const broadcasterId = broadcasterLogin
    ? await resolveTwitchId(broadcasterLogin, token)
    : twitchBroadcasterId();
  if (!broadcasterId) return { ok: false, error: "not_live" };

  const res = await fetch("https://api.twitch.tv/helix/chat/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Client-Id": twitchClientId(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      broadcaster_id: broadcasterId,
      sender_id: senderId,
      // Twitch ALONE reads a leading `.` as a command and posts only the rest
      // — see lib/outgoingText. Applied here rather than in sendToPlatform so
      // Kick/YouTube/Streamplace, which have no such bug, keep the exact text.
      message: escapeLeadingCommand(message),
      ...(replyParentId && { reply_parent_message_id: replyParentId }),
    }),
    signal: AbortSignal.timeout(8_000),
  });

  if (!res.ok) {
    // 429/5xx: Twitch, not the viewer — logged rate-limited by the route.
    const down = httpUnavailable("twitch", res.status);
    if (down) return { ok: false, ...down };
    console.error("[platformChat:twitch]", res.status, await res.text().catch(() => ""));
    return { ok: false, error: "send_failed" };
  }
  // A 200 is not delivery: Helix answers is_sent:false (with a drop_reason) for a
  // message it dropped — AutoMod, followers-only, a duplicate.
  const outcome = twitchSendOutcome(await res.json().catch(() => null));
  if (!outcome.sent) return { ok: false, error: "refused", ...(outcome.reason ? { reason: outcome.reason } : {}) };
  return { ok: true, ...(outcome.id ? { platformMsgId: outcome.id } : {}) };
}

// ─── Kick ─────────────────────────────────────────────────────────────────────

// Resolve a Kick slug to its numeric broadcaster_user_id via the v2 channel
// endpoint (best-effort: Kasada may 403 from the server). Cached per slug.
const kickIdCache = new Map<string, { id: number; ts: number }>();
const KICK_ID_CACHE_MS = 30 * 60 * 1000;

async function resolveKickBroadcasterId(slug: string): Promise<number | null> {
  const key = slug.toLowerCase();
  const cached = kickIdCache.get(key);
  if (cached && Date.now() - cached.ts < KICK_ID_CACHE_MS) return cached.id;
  const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(key)}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);
  if (!res?.ok) return null;
  const data = await res.json().catch(() => null) as { user_id?: number; user?: { id?: number } } | null;
  const id = data?.user_id ?? data?.user?.id ?? null;
  if (id) kickIdCache.set(key, { id, ts: Date.now() });
  return id;
}

// Whether a Kick channel's chat is followers-only, as Kick's channel page says (chatroom
// .followers_mode) — the per-channel fact a bare 403 is classified by (contract 10). Cached 10
// minutes; an unreadable answer (bot protection, a timeout) is null for 2 minutes — never assumed.
const kickModeCache = new Map<string, { at: number; ttl: number; value: boolean | null }>();
async function kickFollowersOnly(slug: string | null | undefined): Promise<boolean | null> {
  const key = (slug ?? "").trim().toLowerCase();
  if (!key) return null;
  const hit = kickModeCache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(key)}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null);
  const data = res?.ok ? await res.json().catch(() => null) as { chatroom?: { followers_mode?: unknown } } | null : null;
  const mode = data?.chatroom?.followers_mode;
  const value = typeof mode === "boolean" ? mode : null;
  kickModeCache.set(key, { at: Date.now(), ttl: value === null ? 2 * 60_000 : 10 * 60_000, value });
  return value;
}

// One line per status + body shape per 10 minutes: the SHAPE only, never Kick's text (contract 10,
// the round-7 shape-only rule). 1,265 identical lines in 14 days said nothing the first did not.
const kickShapeLogged = new Map<string, number>();
function logKickShape(status: number, body: unknown): void {
  const shape = bodyShape(body);
  const key = `${status} ${shape}`;
  const last = kickShapeLogged.get(key);
  if (last !== undefined && Date.now() - last < 10 * 60_000) return;
  kickShapeLogged.set(key, Date.now());
  console.warn(`[platformChat:kick] ${status} ${shape} (shape only; repeats are not logged for 10 min)`);
}

async function sendKick(
  matrixId: string,
  message: string,
  slug?: string,
  replyParentId?: string
): Promise<PlatformSendResult> {
  const token = await getAccessToken(matrixId, "kick");
  if (!token) return { ok: false, error: "not_linked" };

  // `slug` exists for a relay to target the featured streamer's channel, but no
  // caller supplies one: the community embed has no cross-post path. The only
  // live path is the fallback: the home channel's kickBroadcasterId().
  const broadcasterId = slug
    ? await resolveKickBroadcasterId(slug)
    : parseInt(kickBroadcasterId(), 10);
  if (!broadcasterId || Number.isNaN(broadcasterId)) return { ok: false, error: "not_live" };

  const res = await fetch("https://api.kick.com/public/v1/chat", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      broadcaster_user_id: broadcasterId,
      content: message,
      type: "user",
      ...(replyParentId && { reply_to_message_id: replyParentId }),
    }),
    signal: AbortSignal.timeout(8_000),
  });

  if (res.status === 404) {
    console.warn("[platformChat:kick] 404 — channel likely offline");
    return { ok: false, error: "not_live" };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* not JSON — a failure to reach it */ }
    // A KNOWN refusal sentence first — a 429 can say "slow mode", which is the channel's mode,
    // not Kick failing.
    const known = kickKnownRefusal(body);
    if (known) return { ok: false, error: "refused", reason: known };
    // 429/5xx with no such sentence: Kick, not the viewer.
    const down = httpUnavailable("kick", res.status);
    if (down) { logKickShape(res.status, body); return { ok: false, ...down }; }
    // A bare 403 ("Forbidden"): followers-only on THIS channel, or not known (contract 10).
    if (res.status === 403 && kickKnownRefusal(body) === null) {
      const out = kickForbiddenOutcome(await kickFollowersOnly(slug ?? instanceString("platform.kick.slug")));
      if ("refused" in out) return { ok: false, error: "refused", reason: out.reason };
      logKickShape(res.status, body);
      return { ok: false, ...out };
    }
    logKickShape(res.status, body);
    // A 4xx with a sentence is the channel declining the message.
    const err = kickErrorOutcome(res.status, body);
    if (err.refused) return { ok: false, error: "refused", ...(err.reason ? { reason: err.reason } : {}) };
    return { ok: false, error: "send_failed" };
  }
  // Kick's v1 chat POST returns { data: { is_sent, message_id } }; is_sent:false is a refusal.
  const outcome = kickSendOutcome(await res.json().catch(() => null));
  if (!outcome.sent) return { ok: false, error: "refused", ...(outcome.reason ? { reason: outcome.reason } : {}) };
  return { ok: true, ...(outcome.id ? { platformMsgId: outcome.id } : {}) };
}

// ─── YouTube ──────────────────────────────────────────────────────────────────
// liveChatId is per-broadcast; fetched from the channel's /live page (zero quota)
// then confirmed via the Data API. Cached for 5 minutes.

type YtChatCache = { liveChatId: string; videoId: string; ts: number };
const ytCache = new Map<string, YtChatCache>(); // keyed by channelId
const YT_CACHE_MS = 5 * 60 * 1000;

// Exported for platformMod/youtube.ts — liveChat moderation needs the same
// active liveChatId (and the same ownership/started gates) as chat sends.
export async function getYtLiveChatId(channelId: string): Promise<string | null> {
  const chat = await resolveYtLiveChat(channelId);
  return typeof chat === "string" ? chat : null;
}

// The live chat id; null when the channel is not live; `Unavailable` when YouTube
// could not be asked (the quota is spent, a 5xx, a timeout, no API key) — which a
// send must NOT report as "not live": on a quota-out night that is every send.
async function resolveYtLiveChat(channelId: string): Promise<string | null | Unavailable> {
  if (!youtubeApiKey()) {
    console.error("[platformChat:youtube] YOUTUBE_API_KEY not configured");
    return { error: "unavailable", reason: "internal", code: "youtube.no_api_key" };
  }
  const cached = ytCache.get(channelId);
  if (cached && Date.now() - cached.ts < YT_CACHE_MS) return cached.liveChatId;

  // Step 1: scrape the channel's /live page for the video ID. YouTube serves
  // this page in inconsistent variants (the canonical link is sometimes
  // absent MID-STREAM), so an expired cache entry's videoId stays as fallback
  // candidate — step 2 re-verifies whatever we pick authoritatively.
  let videoId = cached?.videoId ?? null;
  const pageRes = await fetch(`https://www.youtube.com/channel/${channelId}/live`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);

  if (pageRes?.ok) {
    const scraped = /<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})"/
      .exec(await pageRes.text())?.[1];
    if (scraped) videoId = scraped;
  }
  // The /live page could not be READ and there is no earlier video to re-check: YouTube was not
  // reached — not "not live" (infrastructure failures stay silent unless YouTube alone was picked).
  if (!videoId && !pageRes?.ok) {
    return pageRes
      ? (httpUnavailable("youtube", pageRes.status) ?? { error: "unavailable", reason: "upstream", code: `youtube.live_page_${pageRes.status}` })
      : { error: "unavailable", reason: "upstream", code: "youtube.live_page" };
  }
  if (!videoId) return null;

  // Step 2: verify via Data API (1 unit — videos.list). Two gates:
  //  • OWNERSHIP — the /live scrape can resolve to a *recommended* (foreign)
  //    video on degraded page variants; sends must never route to a stranger's
  //    live chat.
  //  • STARTED — a scheduled (waiting-room) broadcast already carries an
  //    activeLiveChatId, but liveChatMessages.insert 404s until the stream
  //    actually starts — only a started, un-ended broadcast counts.
  const apiRes = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${videoId}&key=${youtubeApiKey()}`,
    { signal: AbortSignal.timeout(8_000) }
  ).catch((err: unknown) => thrownFailure(err));

  if (!(apiRes instanceof Response)) return apiRes;
  if (!apiRes.ok) {
    const out = youtubeErrorOutcome(apiRes.status, await apiRes.text().catch(() => ""));
    return out.error === "unavailable" ? out : null;
  }
  const data = await apiRes.json() as {
    items?: {
      snippet?: { channelId?: string };
      liveStreamingDetails?: {
        activeLiveChatId?: string; actualStartTime?: string; actualEndTime?: string;
      };
    }[];
  };

  const item = data.items?.[0];
  if (item?.snippet?.channelId !== channelId) {
    console.warn(`[platformChat:youtube] /live resolved to foreign video ${videoId} (owner ${item?.snippet?.channelId ?? "?"}) — ignored`);
    return null;
  }
  const details = item.liveStreamingDetails;
  if (!details?.actualStartTime || details.actualEndTime) return null;
  const liveChatId = details.activeLiveChatId ?? null;
  if (liveChatId) ytCache.set(channelId, { liveChatId, videoId, ts: Date.now() });
  return liveChatId;
}

// YouTube has no concept of our 7TV/BTTV/FFZ/Twitch emotes — they cross over
// as literal text. Names over 20 chars are novelty/joke emote names that will
// never read as an intentional word to a YouTube viewer, so drop just those
// tokens (short emote names at least still read as plausible words/slang).
// Exported for chat/send/route.ts: the caller must strip BEFORE arming the
// echo-dedup window (stream-api's allSendDedup keys on a single shared
// normalized text — see the "all" fan-out path, which does NOT use this,
// since a single armed key can't match one platform's stripped text and
// another's raw text; only single-explicit-target YouTube sends are safe to
// pre-strip).
const MAX_YT_EMOTE_NAME_LEN = 20;

export async function stripLongEmoteNames(text: string): Promise<string> {
  const manifest = await getManifest();
  return text
    .split(/(\s+)/)
    .filter((tok) => !(manifest[tok] && tok.length > MAX_YT_EMOTE_NAME_LEN))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

async function sendYouTube(
  matrixId: string,
  message: string,
  channelId?: string
): Promise<PlatformSendResult> {
  const target = channelId ?? youtubeChannelId();
  if (!target) {
    console.error("[platformChat:youtube] YOUTUBE_CHANNEL_ID not configured");
    return { ok: false, error: "unavailable", reason: "internal", code: "youtube.no_channel" };
  }
  const token = await getAccessToken(matrixId, "youtube");
  if (!token) return { ok: false, error: "not_linked" };

  const liveChatId = await resolveYtLiveChat(target);
  if (liveChatId && typeof liveChatId === "object") return { ok: false, ...liveChatId };
  if (!liveChatId) return { ok: false, error: "not_live" };

  // NB: the REST path is liveChat/messages (with a slash) — liveChatMessages is
  // only the resource's docs name and 404s with an empty body. part=id makes
  // the response carry the created message's Data-API id ("LCC." format — the
  // one liveChat/messages DELETE accepts), captured for the copies mapping.
  const res = await fetch("https://www.googleapis.com/youtube/v3/liveChat/messages?part=id,snippet", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      snippet: {
        liveChatId,
        type: "textMessageEvent",
        textMessageDetails: { messageText: message },
      },
    }),
    signal: AbortSignal.timeout(8_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // 404 = liveChatNotFound: the cached chat id is stale (broadcast restarted
    // or ended) — drop it so the next attempt re-resolves instead of retrying
    // a dead chat for the rest of the cache window.
    if (res.status === 404) ytCache.delete(target);
    // youtube.quota / rate limit / 5xx → `unavailable` (the route logs it, rate-
    // limited); insufficient scope → re-link; anything else → send_failed.
    const out = youtubeErrorOutcome(res.status, body);
    if (out.error !== "unavailable") console.error("[platformChat:youtube]", res.status, body);
    return { ok: false, ...out };
  }
  const sent = await res.json().catch(() => null) as { id?: string } | null;
  return { ok: true, ...(sent?.id ? { platformMsgId: sent.id } : {}) };
}

// ─── stream.place (AT Protocol) ────────────────────────────────────────────────
// Posting = writing a place.stream.chat.message record to the user's repo via
// their DPoP OAuth session, with streamer = the channel DID.

async function sendStreamplace(matrixId: string, message: string): Promise<PlatformSendResult> {
  const { rows } = await pool.query<{ provider_account_id: string }>(
    `SELECT provider_account_id FROM site.accounts
     WHERE matrix_id = $1 AND provider = 'streamplace' AND type = 'atproto' LIMIT 1`,
    [matrixId]
  );
  const did = rows[0]?.provider_account_id;
  if (!did) return { ok: false, error: "not_linked" };

  try {
    const client = await getAtprotoClient();
    const oauthSession = await client.restore(did);
    const agent = new Agent(oauthSession);
    // createRecord returns the new record's AT-URI, which is exactly the id
    // stream-ingest reports for the echo (platforms/streamplace.js sends
    // `platformMsgId: e.uri`). Discarding it costs two things at once: the
    // echo can only be matched by text, and recordPlatformCopies never gets a
    // stream.place row, so a site-side delete cannot reach the stream.place
    // copy.
    const created = await agent.com.atproto.repo.createRecord({
      repo: did,
      collection: "place.stream.chat.message",
      record: {
        $type: "place.stream.chat.message",
        text: message,
        streamer: streamplaceDid() ?? "",
        createdAt: new Date().toISOString(),
      },
    });
    const uri = created?.data?.uri;
    return { ok: true, ...(uri ? { platformMsgId: uri } : {}) };
  } catch (e) {
    console.error("[platformChat:streamplace]", e);
    return { ok: false, error: "send_failed" };
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

// Routing predicate lives in the shared, server-safe platforms module; re-export
// here so existing server-side importers of platformChat keep working.
export { isRoutablePlatform } from "@/app/lib/platforms";

// Optional target channel. Omitted → the home channel (the streamer's). Supplied by
// /api/chat/send when a community streamer is featured, so outbound chat goes
// to whoever is being relayed. Only ever resolved server-side from the current
// stream/status — never from client input.
export type SendTarget = {
  youtubeChannelId?: string;
  twitchLogin?: string;
  kickSlug?: string;
};

// The exact text a platform receives for a (possibly reply) send. Only used as
// a FALLBACK when no native reply_parent_message_id is available for the
// target platform (YouTube always; Twitch/Kick when the replied-to message has
// no platform_msg_id on file) — a real native reply must NOT also get this
// text prefix, since the platform's own reply UI already shows who it's to.
// /api/chat/send arms stream-api's echo-dedup window on this same text so the
// reply's platform copy is suppressed instead of double-posting.
export function platformOutgoingText(message: string, replyToUsername?: string | null): string {
  return replyToUsername ? `@${replyToUsername} ${message}` : message;
}

export async function sendToPlatform(
  matrixId: string,
  platform: string,
  message: string,
  replyToUsername?: string,
  target?: SendTarget,
  replyParentId?: string
): Promise<PlatformSendResult> {
  // A native reply thread (Twitch/Kick) carries the plain message — the
  // @-mention prefix is only needed when there's no native field to lean on.
  const msg = replyParentId ? message : platformOutgoingText(message, replyToUsername);
  switch (platform) {
    case "twitch":      return sendTwitch(matrixId, msg, target?.twitchLogin, replyParentId);
    case "kick":        return sendKick(matrixId, msg, target?.kickSlug, replyParentId);
    case "youtube":     return sendYouTube(matrixId, msg, target?.youtubeChannelId);
    case "streamplace": return sendStreamplace(matrixId, msg);
    default:            return { ok: false, error: "unsupported_platform" };
  }
}
