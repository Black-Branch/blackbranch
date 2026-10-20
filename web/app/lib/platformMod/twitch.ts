// Twitch Helix moderation on the home channel. The Helix moderator_id must be
// the token owner's own user id, so the CapableToken's actorPlatformId is used
// for whichever account (mod's own or broadcaster fallback) ends up acting.

import pool from "@/lib/db";
import { twitchBroadcasterId, twitchClientId } from "@/app/lib/twitch";
import {
  record, targetPlatformId, getCapableToken,
  type PlatformModAction, type CapableToken,
} from "./shared";

const SCOPE_BANS = "moderator:manage:banned_users";
const SCOPE_CHAT = "moderator:manage:chat_messages";
const SCOPE_SETTINGS = "moderator:manage:chat_settings";

type HelixCallOpts = {
  method: "POST" | "DELETE" | "PATCH";
  path: string; // path + query, without host
  cap: CapableToken;
  body?: unknown;
};

async function helix(opts: HelixCallOpts): Promise<{ ok: boolean; status: number | null; detail: string | null }> {
  try {
    const res = await fetch(`https://api.twitch.tv/helix${opts.path}`, {
      method: opts.method,
      headers: {
        Authorization: `Bearer ${opts.cap.token}`,
        "Client-Id": twitchClientId(),
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(8_000),
    });
    const detail = res.ok ? null : (await res.text().catch(() => "")).slice(0, 500);
    return { ok: res.ok, status: res.status, detail };
  } catch (e) {
    return { ok: false, status: null, detail: (e as Error).message };
  }
}

// Ban (durationSeconds null) or timeout (durationSeconds set) a user on the home
// Twitch channel. Helix has a single /moderation/bans endpoint where the optional
// `duration` distinguishes timeout from ban.
export async function banOnTwitch(
  modMatrixId: string,
  targetMatrixId: string,
  durationSeconds: number | null,
  reason: string | null,
  batchId: string | null = null
): Promise<void> {
  const action: PlatformModAction = durationSeconds ? "timeout" : "ban";
  const base = { action, platform: "twitch", performedBy: modMatrixId, targetId: targetMatrixId, durationSeconds, batchId };

  const broadcasterId = twitchBroadcasterId();
  if (!broadcasterId) {
    console.error("[platformMod] TWITCH_USER_ID unset — refusing Twitch ban/timeout");
    await record({ ...base, ok: false, detail: "twitch_broadcaster_unset" });
    return;
  }

  const cap = await getCapableToken(modMatrixId, "twitch", SCOPE_BANS);
  if (!cap) {
    await record({ ...base, broadcasterId, ok: false, detail: "no_capable_token" });
    return;
  }

  const userId = await targetPlatformId(targetMatrixId, "twitch");
  if (!userId) {
    await record({ ...base, broadcasterId, actedVia: cap.actedVia, ok: false, detail: "target_no_twitch_id" });
    return;
  }

  // Twitch caps timeouts at 1,209,600s (2 weeks); permanent ban omits `duration`.
  const data: Record<string, unknown> = { user_id: userId };
  if (durationSeconds) data.duration = Math.min(durationSeconds, 1_209_600);
  if (reason) data.reason = reason.slice(0, 500);

  const r = await helix({
    method: "POST",
    path: `/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${cap.actorPlatformId}`,
    cap,
    body: { data },
  });
  await record({ ...base, targetPlatformId: userId, broadcasterId, actedVia: cap.actedVia,
    ok: r.ok, status: r.status, detail: r.detail });
}

// Lift a Twitch ban/timeout on the home channel — the inverse of banOnTwitch so
// a site unban doesn't leave the person Twitch-banned.
export async function unbanOnTwitch(modMatrixId: string, targetMatrixId: string, batchId: string | null = null): Promise<void> {
  const base = { action: "unban" as const, platform: "twitch", performedBy: modMatrixId, targetId: targetMatrixId, batchId };

  const broadcasterId = twitchBroadcasterId();
  if (!broadcasterId) {
    console.error("[platformMod] TWITCH_USER_ID unset — refusing Twitch unban");
    await record({ ...base, ok: false, detail: "twitch_broadcaster_unset" });
    return;
  }

  const cap = await getCapableToken(modMatrixId, "twitch", SCOPE_BANS);
  if (!cap) {
    await record({ ...base, broadcasterId, ok: false, detail: "no_capable_token" });
    return;
  }

  const userId = await targetPlatformId(targetMatrixId, "twitch");
  if (!userId) {
    await record({ ...base, broadcasterId, actedVia: cap.actedVia, ok: false, detail: "target_no_twitch_id" });
    return;
  }

  const r = await helix({
    method: "DELETE",
    path: `/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${cap.actorPlatformId}&user_id=${userId}`,
    cap,
  });
  // 400 "user is not banned" is a benign no-op (e.g. the ban expired on Twitch
  // already); treat any 2xx OR that case as success so it isn't flagged.
  const benign = r.status === 400 && /not banned/i.test(r.detail ?? "");
  await record({ ...base, targetPlatformId: userId, broadcasterId, actedVia: cap.actedVia,
    ok: r.ok || benign, status: r.status, detail: benign ? null : r.detail });
}

// Purge a user's recent Twitch messages — the idiomatic Helix mechanism is a
// 1-second timeout, which clears their recent chat lines in one call (there is
// no bulk per-message delete).
export async function purgeOnTwitch(
  modMatrixId: string,
  targetMatrixId: string,
  batchId: string
): Promise<void> {
  const base = { action: "purge" as const, platform: "twitch", performedBy: modMatrixId,
    targetId: targetMatrixId, batchId };

  const broadcasterId = twitchBroadcasterId();
  if (!broadcasterId) {
    await record({ ...base, ok: false, detail: "twitch_broadcaster_unset" });
    return;
  }

  const cap = await getCapableToken(modMatrixId, "twitch", SCOPE_BANS);
  if (!cap) {
    await record({ ...base, broadcasterId, ok: false, detail: "no_capable_token" });
    return;
  }

  const userId = await targetPlatformId(targetMatrixId, "twitch");
  if (!userId) {
    await record({ ...base, broadcasterId, actedVia: cap.actedVia, ok: false, detail: "target_no_twitch_id" });
    return;
  }

  const r = await helix({
    method: "POST",
    path: `/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${cap.actorPlatformId}`,
    cap,
    body: { data: { user_id: userId, duration: 1, reason: "message purge" } },
  });
  await record({ ...base, targetPlatformId: userId, broadcasterId, actedVia: cap.actedVia,
    durationSeconds: 1, ok: r.ok, status: r.status, detail: r.detail ?? "1s_timeout_clear" });
}

// Mirror the site's slow mode to the home Twitch channel. Twitch's wait range is
// 3–120s (the site allows up to 3600) — the clamp is recorded so the audit shows
// Twitch got a shorter wait. seconds = 0 turns slow mode off.
export async function setSlowModeOnTwitch(modMatrixId: string, seconds: number): Promise<void> {
  const base = { action: "slowmode" as const, platform: "twitch", performedBy: modMatrixId, durationSeconds: seconds };

  const broadcasterId = twitchBroadcasterId();
  if (!broadcasterId) {
    console.error("[platformMod] TWITCH_USER_ID unset — refusing Twitch slow mode");
    await record({ ...base, ok: false, detail: "twitch_broadcaster_unset" });
    return;
  }

  const cap = await getCapableToken(modMatrixId, "twitch", SCOPE_SETTINGS);
  if (!cap) {
    await record({ ...base, broadcasterId, ok: false, detail: "no_capable_token" });
    return;
  }

  const wait = seconds > 0 ? Math.min(Math.max(seconds, 3), 120) : 0;
  const body: Record<string, unknown> = { slow_mode: wait > 0 };
  if (wait > 0) body.slow_mode_wait_time = wait;

  const r = await helix({
    method: "PATCH",
    path: `/chat/settings?broadcaster_id=${broadcasterId}&moderator_id=${cap.actorPlatformId}`,
    cap,
    body,
  });
  await record({ ...base, broadcasterId, actedVia: cap.actedVia, ok: r.ok, status: r.status,
    detail: r.detail ?? (wait !== seconds && seconds > 0 ? `clamped_to_${wait}s` : null) });
}

// Delete a single Twitch message on the home channel. Needs the Twitch-native
// message id, which the ingest stores in stream.chat_log.platform_msg_id when the
// upstream forwards it. If we don't have one for this row, we skip (best-effort).
export async function deleteOnTwitch(modMatrixId: string, chatLogId: string): Promise<void> {
  const { rows } = await pool.query<{ platform_msg_id: string | null }>(
    `SELECT platform_msg_id FROM stream.chat_log
     WHERE id = $1 AND platform ILIKE 'twitch' LIMIT 1`,
    [chatLogId]
  );
  const nativeId = rows[0]?.platform_msg_id;
  if (!nativeId) {
    await record({ action: "delete", platform: "twitch", performedBy: modMatrixId,
      messageId: chatLogId, ok: false, detail: "no_native_message_id" });
    return;
  }
  await deleteOnTwitchByNativeId(modMatrixId, nativeId);
}

// Id-direct variant: delete by the Twitch message id itself — used by the
// fanOutDelete's native branch (ids from site.chat_message_platform_copies).
export async function deleteOnTwitchByNativeId(modMatrixId: string, nativeId: string): Promise<void> {
  const base = { action: "delete" as const, platform: "twitch", performedBy: modMatrixId };

  const broadcasterId = twitchBroadcasterId();
  if (!broadcasterId) {
    console.error("[platformMod] TWITCH_USER_ID unset — refusing Twitch delete");
    await record({ ...base, messageId: nativeId, ok: false, detail: "twitch_broadcaster_unset" });
    return;
  }

  const cap = await getCapableToken(modMatrixId, "twitch", SCOPE_CHAT);
  if (!cap) {
    await record({ ...base, messageId: nativeId, broadcasterId, ok: false, detail: "no_capable_token" });
    return;
  }

  const r = await helix({
    method: "DELETE",
    path: `/moderation/chat?broadcaster_id=${broadcasterId}&moderator_id=${cap.actorPlatformId}&message_id=${encodeURIComponent(nativeId)}`,
    cap,
  });
  await record({ ...base, messageId: nativeId, broadcasterId, actedVia: cap.actedVia,
    ok: r.ok, status: r.status, detail: r.detail });
}
