// YouTube live-chat moderation via the Data API (liveChat/bans +
// liveChat/messages — both accept the already-granted
// `https://www.googleapis.com/auth/youtube` scope, so no relink is needed).
// Hard constraint: everything here works only WHILE LIVE — the API operates on
// the active liveChatId, so offline actions record a `not_live` skip (the site
// ban still stands; the next live session re-fans if the mod re-applies).
//
// The API acts as the token's owner, who must be an owner/mod of the live chat.
// A site mod who isn't a YouTube-side mod gets a per-target 403 — retried once
// with the broadcaster's token, which always has chat-owner power.
//
// Quota: each call costs Data API units from the same 10k/day budget as
// cross-post inserts. Cost is logged, never blocking.

import pool from "@/lib/db";
import { getYtLiveChatId } from "@/app/lib/platformChat";
import {
  record, targetPlatformId, getCapableToken, getBroadcasterToken,
  type PlatformModAction, type CapableToken,
} from "./shared";
import { instanceString } from "@/app/lib/instanceConfigServer";

const SCOPE_YT = "https://www.googleapis.com/auth/youtube";
// Instance key platform.youtube.channelId, read per call.
const youtubeChannelId = () => instanceString("platform.youtube.channelId");

// Two YouTube message-id spaces exist side by side: the Data API's own ids
// ("LCC." prefix — what liveChat/messages DELETE accepts; captured from
// cross-post insert responses into site.chat_message_platform_copies) and the
// innertube renderer ids the chat ingest stores in chat_log.platform_msg_id
// (matchable against markChatItemAsDeletedAction, but NOT Data-API-deletable).
// Deletes are gated on this so a doomed attempt doesn't burn 50 quota units.
const isYtApiMessageId = (id: string) => id.startsWith("LCC.");

type YtResult = { ok: boolean; status: number | null; detail: string | null; banId?: string | null };

async function ytApi(
  cap: CapableToken,
  method: "POST" | "DELETE",
  pathAndQuery: string,
  body?: unknown
): Promise<YtResult> {
  try {
    const res = await fetch(`https://www.googleapis.com/youtube/v3${pathAndQuery}`, {
      method,
      headers: {
        Authorization: `Bearer ${cap.token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 500);
      return { ok: false, status: res.status, detail };
    }
    // liveChatBans.insert returns the ban resource — its id is required to lift
    // the ban later. Deletes return 204 No Content.
    const banId = method === "POST"
      ? ((await res.json().catch(() => null)) as { id?: string } | null)?.id ?? null
      : null;
    return { ok: true, status: res.status, detail: null, banId };
  } catch (e) {
    return { ok: false, status: null, detail: (e as Error).message };
  }
}

// Ban (durationSeconds null) or timeout a user in the home channel's live chat.
// (No reason parameter — liveChatBans has no reason field.)
export async function banOnYouTube(
  modMatrixId: string,
  targetMatrixId: string,
  durationSeconds: number | null,
  batchId: string | null = null
): Promise<void> {
  const action: PlatformModAction = durationSeconds ? "timeout" : "ban";
  const base = { action, platform: "youtube", performedBy: modMatrixId, targetId: targetMatrixId, durationSeconds, batchId };

  const channelId = youtubeChannelId();
  if (!channelId) {
    console.error("[platformMod] YOUTUBE_CHANNEL_ID unset — refusing YouTube ban/timeout");
    await record({ ...base, ok: false, detail: "youtube_channel_unset" });
    return;
  }

  let cap = await getCapableToken(modMatrixId, "youtube", SCOPE_YT);
  if (!cap) {
    await record({ ...base, broadcasterId: channelId, ok: false, detail: "no_capable_token" });
    return;
  }

  const targetChannelId = await targetPlatformId(targetMatrixId, "youtube");
  if (!targetChannelId) {
    await record({ ...base, broadcasterId: channelId, actedVia: cap.actedVia,
      ok: false, detail: "target_no_youtube_id" });
    return;
  }

  const liveChatId = await getYtLiveChatId(channelId);
  if (!liveChatId) {
    await record({ ...base, targetPlatformId: targetChannelId, broadcasterId: channelId,
      actedVia: cap.actedVia, ok: false, detail: "not_live" });
    return;
  }

  const snippet: Record<string, unknown> = {
    liveChatId,
    type: durationSeconds ? "temporary" : "permanent",
    bannedUserDetails: { channelId: targetChannelId },
  };
  if (durationSeconds) snippet.banDurationSeconds = durationSeconds;

  let r = await ytApi(cap, "POST", "/liveChat/bans?part=snippet", { snippet });

  // Per-target 403 = the acting mod's YT account isn't a mod of this live chat
  // (site mod list ≠ YouTube mod list). Retry once as the broadcaster.
  if (!r.ok && r.status === 403 && cap.actedVia === "self") {
    const bc = await getBroadcasterToken("youtube", SCOPE_YT, modMatrixId);
    if (bc) {
      cap = bc;
      r = await ytApi(cap, "POST", "/liveChat/bans?part=snippet", { snippet });
    }
  }

  await record({ ...base, targetPlatformId: targetChannelId, broadcasterId: channelId,
    actedVia: cap.actedVia, ok: r.ok, status: r.status, detail: r.detail,
    platformRef: r.banId ?? null });
}

// Lift a YouTube live-chat ban. liveChatBans.delete takes the BAN RESOURCE id
// (not the user), so we look up the most recent successful ban row's
// platform_ref for this target.
export async function unbanOnYouTube(modMatrixId: string, targetMatrixId: string, batchId: string | null = null): Promise<void> {
  const base = { action: "unban" as const, platform: "youtube", performedBy: modMatrixId, targetId: targetMatrixId, batchId };

  const channelId = youtubeChannelId();
  if (!channelId) {
    await record({ ...base, ok: false, detail: "youtube_channel_unset" });
    return;
  }

  const { rows } = await pool.query<{ platform_ref: string }>(
    `SELECT platform_ref FROM site.platform_mod_actions
     WHERE platform = 'youtube' AND action IN ('ban','timeout')
       AND target_id = $1 AND ok AND platform_ref IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
    [targetMatrixId]
  );
  const banRef = rows[0]?.platform_ref;
  if (!banRef) {
    // Nothing we banned on YouTube (or a pre-v66 ban with no stored ref) —
    // nothing to lift. Recorded so the propagation panel shows why.
    await record({ ...base, broadcasterId: channelId, ok: false, detail: "no_ban_ref" });
    return;
  }

  let cap = await getCapableToken(modMatrixId, "youtube", SCOPE_YT);
  if (!cap) {
    await record({ ...base, broadcasterId: channelId, ok: false, detail: "no_capable_token" });
    return;
  }

  let r = await ytApi(cap, "DELETE", `/liveChat/bans?id=${encodeURIComponent(banRef)}`);
  if (!r.ok && r.status === 403 && cap.actedVia === "self") {
    const bc = await getBroadcasterToken("youtube", SCOPE_YT, modMatrixId);
    if (bc) {
      cap = bc;
      r = await ytApi(cap, "DELETE", `/liveChat/bans?id=${encodeURIComponent(banRef)}`);
    }
  }

  await record({ ...base, broadcasterId: channelId, actedVia: cap.actedVia,
    ok: r.ok, status: r.status, detail: r.detail, platformRef: banRef });
}

// Purge a user's recent YouTube messages — per-message deletes, capped at 25
// (each costs Data API quota), only while live. One summary audit row.
export async function purgeOnYouTube(
  modMatrixId: string,
  targetMatrixId: string,
  messageIds: string[],
  batchId: string
): Promise<void> {
  const base = { action: "purge" as const, platform: "youtube", performedBy: modMatrixId,
    targetId: targetMatrixId, batchId };

  const channelId = youtubeChannelId();
  if (!channelId) {
    await record({ ...base, ok: false, detail: "youtube_channel_unset" });
    return;
  }
  if (messageIds.length === 0) {
    await record({ ...base, broadcasterId: channelId, ok: true, detail: "no_messages" });
    return;
  }
  // Only Data-API ids are deletable (see isYtApiMessageId) — ingest-captured
  // innertube ids are dropped up front instead of burning quota on 4xx's.
  const apiIds = messageIds.filter(isYtApiMessageId);
  if (apiIds.length === 0) {
    await record({ ...base, broadcasterId: channelId, ok: true,
      detail: `no_api_message_ids (${messageIds.length} innertube-only)` });
    return;
  }

  let cap = await getCapableToken(modMatrixId, "youtube", SCOPE_YT);
  if (!cap) {
    await record({ ...base, broadcasterId: channelId, ok: false, detail: "no_capable_token" });
    return;
  }

  // Deleting live-chat messages only works while the chat is active — gate once
  // up front instead of burning quota on a batch of guaranteed failures.
  const liveChatId = await getYtLiveChatId(channelId);
  if (!liveChatId) {
    await record({ ...base, broadcasterId: channelId, actedVia: cap.actedVia,
      ok: false, detail: "not_live" });
    return;
  }

  const batch = apiIds.slice(0, 25);
  let deleted = 0;
  let lastStatus: number | null = null;
  let retriedAsBroadcaster = false;
  for (const id of batch) {
    let r = await ytApi(cap, "DELETE", `/liveChat/messages?id=${encodeURIComponent(id)}`);
    // Same per-target 403 story as single deletes — switch to the broadcaster
    // token once and stay on it for the rest of the batch.
    if (!r.ok && r.status === 403 && cap.actedVia === "self" && !retriedAsBroadcaster) {
      retriedAsBroadcaster = true;
      const bc = await getBroadcasterToken("youtube", SCOPE_YT, modMatrixId);
      if (bc) {
        cap = bc;
        r = await ytApi(cap, "DELETE", `/liveChat/messages?id=${encodeURIComponent(id)}`);
      }
    }
    lastStatus = r.status;
    if (r.ok) deleted++;
  }
  console.log(`[platformMod:youtube] purge quota cost ~${batch.length * 50} units (${deleted}/${batch.length} deleted)`);
  await record({ ...base, broadcasterId: channelId, actedVia: cap.actedVia,
    ok: deleted === batch.length, status: lastStatus,
    detail: `deleted ${deleted}/${batch.length}${apiIds.length > 25 ? " (capped_25)" : ""}` });
}

// Delete a single YouTube live-chat message. Needs the YT-native message id from
// stream.chat_log.platform_msg_id; works only while the chat is live.
export async function deleteOnYouTube(modMatrixId: string, chatLogId: string): Promise<void> {
  const { rows } = await pool.query<{ platform_msg_id: string | null }>(
    `SELECT platform_msg_id FROM stream.chat_log
     WHERE id = $1 AND platform ILIKE 'youtube' LIMIT 1`,
    [chatLogId]
  );
  const nativeId = rows[0]?.platform_msg_id;
  if (!nativeId) {
    await record({ action: "delete", platform: "youtube", performedBy: modMatrixId,
      messageId: chatLogId, ok: false, detail: "no_native_message_id" });
    return;
  }
  await deleteOnYouTubeByNativeId(modMatrixId, nativeId);
}

// Id-direct variant: delete by the platform's own message id — used by the
// fanOutDelete's native branch, whose ids come from the copies mapping (always
// Data-API "LCC." ids) rather than a chat_log row.
export async function deleteOnYouTubeByNativeId(modMatrixId: string, nativeId: string): Promise<void> {
  const base = { action: "delete" as const, platform: "youtube", performedBy: modMatrixId };

  if (!isYtApiMessageId(nativeId)) {
    // An ingest-captured innertube id — not deletable via the Data API; skip
    // instead of burning 50 quota units on a guaranteed 4xx.
    await record({ ...base, messageId: nativeId, ok: false, detail: "innertube_id_not_api_deletable" });
    return;
  }

  let cap = await getCapableToken(modMatrixId, "youtube", SCOPE_YT);
  if (!cap) {
    await record({ ...base, messageId: nativeId, ok: false, detail: "no_capable_token" });
    return;
  }

  let r = await ytApi(cap, "DELETE", `/liveChat/messages?id=${encodeURIComponent(nativeId)}`);
  if (!r.ok && r.status === 403 && cap.actedVia === "self") {
    const bc = await getBroadcasterToken("youtube", SCOPE_YT, modMatrixId);
    if (bc) {
      cap = bc;
      r = await ytApi(cap, "DELETE", `/liveChat/messages?id=${encodeURIComponent(nativeId)}`);
    }
  }

  await record({ ...base, messageId: nativeId, actedVia: cap.actedVia,
    ok: r.ok, status: r.status, detail: r.detail });
}
