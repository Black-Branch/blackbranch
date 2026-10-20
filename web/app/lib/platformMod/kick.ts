// Kick public-API moderation on the home channel (api.kick.com/public/v1,
// verified against the swagger doc). Ban and timeout share one endpoint —
// `duration` (MINUTES, 1–10080) present = timeout, absent = permanent.
// Requires links that granted `moderation:ban` / `moderation:chat_message:manage`
// (older links carry the defunct `channel:moderate` and degrade to the
// broadcaster fallback via the scope check).

import pool from "@/lib/db";
import {
  record, targetPlatformId, getCapableToken,
  type PlatformModAction, type CapableToken,
} from "./shared";
import { instanceString } from "@/app/lib/instanceConfigServer";

const SCOPE_BAN = "moderation:ban";
const SCOPE_MSG = "moderation:chat_message:manage";

// The home channel's numeric Kick user id. Fail-closed like twitchBroadcasterId():
// a non-numeric or missing env must not silently target the wrong channel. (The
// legacy KICK_CHANNEL slug fallback is deliberately NOT accepted here — the
// moderation endpoints take only the numeric id.)
function kickBroadcasterUserId(): number | null {
  const n = parseInt(instanceString("platform.kick.userId") ?? "", 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function kickApi(
  cap: CapableToken,
  method: "POST" | "DELETE",
  path: string,
  body?: unknown
): Promise<{ ok: boolean; status: number | null; detail: string | null }> {
  try {
    const res = await fetch(`https://api.kick.com/public/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cap.token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8_000),
    });
    const detail = res.ok ? null : (await res.text().catch(() => "")).slice(0, 500);
    return { ok: res.ok, status: res.status, detail };
  } catch (e) {
    return { ok: false, status: null, detail: (e as Error).message };
  }
}

// Ban (durationSeconds null) or timeout a user on the home Kick channel.
export async function banOnKick(
  modMatrixId: string,
  targetMatrixId: string,
  durationSeconds: number | null,
  reason: string | null,
  batchId: string | null = null
): Promise<void> {
  const action: PlatformModAction = durationSeconds ? "timeout" : "ban";
  const base = { action, platform: "kick", performedBy: modMatrixId, targetId: targetMatrixId, durationSeconds, batchId };

  const broadcasterId = kickBroadcasterUserId();
  if (!broadcasterId) {
    console.error("[platformMod] numeric KICK_USER_ID unset — refusing Kick ban/timeout");
    await record({ ...base, ok: false, detail: "kick_broadcaster_unset" });
    return;
  }

  const cap = await getCapableToken(modMatrixId, "kick", SCOPE_BAN);
  if (!cap) {
    await record({ ...base, broadcasterId: String(broadcasterId), ok: false, detail: "no_capable_token" });
    return;
  }

  const rawTarget = await targetPlatformId(targetMatrixId, "kick");
  const userId = rawTarget ? parseInt(rawTarget, 10) : NaN;
  if (!Number.isInteger(userId)) {
    await record({ ...base, broadcasterId: String(broadcasterId), actedVia: cap.actedVia,
      ok: false, detail: "target_no_kick_id" });
    return;
  }

  // Kick durations are MINUTES 1–10080 (7 days); record when the clamp bites so
  // the audit shows the platform got a shorter timeout than the site did.
  const body: Record<string, unknown> = { broadcaster_user_id: broadcasterId, user_id: userId };
  let clampNote: string | null = null;
  if (durationSeconds) {
    const minutes = Math.min(Math.max(Math.ceil(durationSeconds / 60), 1), 10_080);
    body.duration = minutes;
    if (minutes === 10_080 && durationSeconds > 10_080 * 60) clampNote = "clamped_to_7d";
  }
  if (reason) body.reason = reason.slice(0, 100);

  const r = await kickApi(cap, "POST", "/moderation/bans", body);
  await record({ ...base, targetPlatformId: String(userId), broadcasterId: String(broadcasterId),
    actedVia: cap.actedVia, ok: r.ok, status: r.status,
    detail: r.detail ?? clampNote });
}

// Lift a Kick ban/timeout — DELETE on the same endpoint.
export async function unbanOnKick(modMatrixId: string, targetMatrixId: string, batchId: string | null = null): Promise<void> {
  const base = { action: "unban" as const, platform: "kick", performedBy: modMatrixId, targetId: targetMatrixId, batchId };

  const broadcasterId = kickBroadcasterUserId();
  if (!broadcasterId) {
    console.error("[platformMod] numeric KICK_USER_ID unset — refusing Kick unban");
    await record({ ...base, ok: false, detail: "kick_broadcaster_unset" });
    return;
  }

  const cap = await getCapableToken(modMatrixId, "kick", SCOPE_BAN);
  if (!cap) {
    await record({ ...base, broadcasterId: String(broadcasterId), ok: false, detail: "no_capable_token" });
    return;
  }

  const rawTarget = await targetPlatformId(targetMatrixId, "kick");
  const userId = rawTarget ? parseInt(rawTarget, 10) : NaN;
  if (!Number.isInteger(userId)) {
    await record({ ...base, broadcasterId: String(broadcasterId), actedVia: cap.actedVia,
      ok: false, detail: "target_no_kick_id" });
    return;
  }

  const r = await kickApi(cap, "DELETE", "/moderation/bans", {
    broadcaster_user_id: broadcasterId, user_id: userId,
  });
  await record({ ...base, targetPlatformId: String(userId), broadcasterId: String(broadcasterId),
    actedVia: cap.actedVia, ok: r.ok, status: r.status, detail: r.detail });
}

// Purge a user's recent Kick messages. Kick has no bulk clear, so this is
// per-message deletes — capped at 50, ~150ms apart (polite pacing, and a purge
// is fire-and-forget so the wall-clock cost doesn't block anything). One
// summary audit row for the whole batch.
export async function purgeOnKick(
  modMatrixId: string,
  targetMatrixId: string,
  messageIds: string[],
  batchId: string
): Promise<void> {
  const base = { action: "purge" as const, platform: "kick", performedBy: modMatrixId,
    targetId: targetMatrixId, batchId };

  const broadcasterId = kickBroadcasterUserId();
  if (!broadcasterId) {
    await record({ ...base, ok: false, detail: "kick_broadcaster_unset" });
    return;
  }
  if (messageIds.length === 0) {
    await record({ ...base, broadcasterId: String(broadcasterId), ok: true, detail: "no_messages" });
    return;
  }

  const cap = await getCapableToken(modMatrixId, "kick", SCOPE_MSG);
  if (!cap) {
    await record({ ...base, broadcasterId: String(broadcasterId), ok: false, detail: "no_capable_token" });
    return;
  }

  const batch = messageIds.slice(0, 50);
  let deleted = 0;
  let lastStatus: number | null = null;
  for (const id of batch) {
    const r = await kickApi(cap, "DELETE", `/chat/${encodeURIComponent(id)}`);
    lastStatus = r.status;
    if (r.ok) deleted++;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  await record({ ...base, broadcasterId: String(broadcasterId), actedVia: cap.actedVia,
    ok: deleted === batch.length, status: lastStatus,
    detail: `deleted ${deleted}/${batch.length}${messageIds.length > 50 ? " (capped_50)" : ""}` });
}

// Delete a single Kick message. Needs the Kick-native message UUID from
// stream.chat_log.platform_msg_id.
export async function deleteOnKick(modMatrixId: string, chatLogId: string): Promise<void> {
  const { rows } = await pool.query<{ platform_msg_id: string | null }>(
    `SELECT platform_msg_id FROM stream.chat_log
     WHERE id = $1 AND platform ILIKE 'kick' LIMIT 1`,
    [chatLogId]
  );
  const nativeId = rows[0]?.platform_msg_id;
  if (!nativeId) {
    await record({ action: "delete", platform: "kick", performedBy: modMatrixId,
      messageId: chatLogId, ok: false, detail: "no_native_message_id" });
    return;
  }
  await deleteOnKickByNativeId(modMatrixId, nativeId);
}

// Id-direct variant: delete by the Kick message UUID itself — used by the
// fanOutDelete's native branch (ids from site.chat_message_platform_copies).
export async function deleteOnKickByNativeId(modMatrixId: string, nativeId: string): Promise<void> {
  const base = { action: "delete" as const, platform: "kick", performedBy: modMatrixId };

  const broadcasterId = kickBroadcasterUserId();
  if (!broadcasterId) {
    console.error("[platformMod] numeric KICK_USER_ID unset — refusing Kick delete");
    await record({ ...base, messageId: nativeId, ok: false, detail: "kick_broadcaster_unset" });
    return;
  }

  const cap = await getCapableToken(modMatrixId, "kick", SCOPE_MSG);
  if (!cap) {
    await record({ ...base, messageId: nativeId, broadcasterId: String(broadcasterId),
      ok: false, detail: "no_capable_token" });
    return;
  }

  const r = await kickApi(cap, "DELETE", `/chat/${encodeURIComponent(nativeId)}`);
  await record({ ...base, messageId: nativeId, broadcasterId: String(broadcasterId),
    actedVia: cap.actedVia, ok: r.ok, status: r.status, detail: r.detail });
}
