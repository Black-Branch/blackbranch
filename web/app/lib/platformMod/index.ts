// Fan a site moderation action out to the streaming platforms' own moderation
// APIs. Import path `@/app/lib/platformMod` is unchanged from the old
// single-file module; the per-platform implementations live in
// {twitch,kick,youtube}.ts with shared plumbing in shared.ts.
//
// Token selection (shared.getCapableToken): act as the mod who performed it
// when their stored scope grant covers the action, else fall back to the
// broadcaster's token (BROADCASTER_MATRIX_ID) — `acted_via` records which,
// `performed_by` stays the real mod either way.
//
// Design rules:
//  - NEVER throws. Callers fire-and-forget after the site action has already
//    persisted, so a platform failure can't break or slow the site action.
//  - Acts only on the HOME channel — the site's community mirrors the streamer's
//    stream. We trust each platform to 401/403 if the actor lacks power there,
//    and record it.
//  - The target's platform user ids are resolved server-side from our identity
//    graph (site.platform_links → stream.links); never from client input.
//  - Every attempt — success, failure, or skip — is recorded in
//    site.platform_mod_actions for the mod panel's propagation view.

import { banOnTwitch, unbanOnTwitch, deleteOnTwitch, deleteOnTwitchByNativeId, purgeOnTwitch } from "./twitch";
import { banOnKick, unbanOnKick, deleteOnKick, deleteOnKickByNativeId, purgeOnKick } from "./kick";
import { banOnYouTube, unbanOnYouTube, deleteOnYouTube, deleteOnYouTubeByNativeId, purgeOnYouTube } from "./youtube";
import { copiesForMessage } from "@/app/lib/platformCopies";
import { record } from "./shared";
import { normalizePlatform } from "@/app/lib/nativePlatform";

/**
 * Fan a site ban/timeout out to every platform with a moderation API. Fire-and-
 * forget: call WITHOUT awaiting after the site ban has persisted.
 * `durationMinutes` null = permanent. Every row carries `batchId`, so the mod who acted can
 * read back how each platform answered (/api/mod/platform-actions?batchId=). Returns the
 * platforms a row will be written for.
 */
export function fanOutBan(
  modMatrixId: string,
  targetMatrixId: string,
  durationMinutes: number | null,
  reason: string | null,
  batchId: string | null = null
): string[] {
  const durationSeconds = durationMinutes ? Math.round(durationMinutes * 60) : null;
  void banOnTwitch(modMatrixId, targetMatrixId, durationSeconds, reason, batchId);
  void banOnKick(modMatrixId, targetMatrixId, durationSeconds, reason, batchId);
  void banOnYouTube(modMatrixId, targetMatrixId, durationSeconds, batchId);
  // stream.place has no moderation API — recorded so the propagation view can
  // show the gap honestly instead of implying coverage.
  void record({ action: durationMinutes ? "timeout" : "ban", platform: "streamplace",
    performedBy: modMatrixId, targetId: targetMatrixId, durationSeconds,
    ok: false, detail: "unsupported", batchId });
  return ["twitch", "kick", "youtube", "streamplace"];
}

/**
 * Fan a site UNban out — the inverse of fanOutBan, so lifting a ban on the site
 * also lifts it platform-side. Fire-and-forget after the site row is cleared.
 */
export function fanOutUnban(modMatrixId: string, targetMatrixId: string, batchId: string | null = null): string[] {
  void unbanOnTwitch(modMatrixId, targetMatrixId, batchId);
  void unbanOnKick(modMatrixId, targetMatrixId, batchId);
  void unbanOnYouTube(modMatrixId, targetMatrixId, batchId);
  return ["twitch", "kick", "youtube"];
}

/**
 * Fan a site message-delete out to the originating platform. Fire-and-forget.
 * `platform` and `messageId` are the same values /api/mod/delete already has.
 * Native/streamplace messages have no platform-side copy to remove — no-op.
 */
/**
 * Fan a purge out to the platforms. Twitch clears via a 1-second timeout (one
 * call); Kick/YouTube get the target's platform-native message ids collected by
 * /api/mod/purge (already window-bounded and capped). Fire-and-forget.
 */
export function fanOutPurge(
  modMatrixId: string,
  targetMatrixId: string,
  kickMessageIds: string[],
  youtubeMessageIds: string[],
  batchId: string
): void {
  void purgeOnTwitch(modMatrixId, targetMatrixId, batchId);
  void purgeOnKick(modMatrixId, targetMatrixId, kickMessageIds, batchId);
  void purgeOnYouTube(modMatrixId, targetMatrixId, youtubeMessageIds, batchId);
}

export function fanOutDelete(modMatrixId: string, messageId: string, platform: string): void {
  switch (normalizePlatform(platform?.toLowerCase())) {
    case "twitch":  void deleteOnTwitch(modMatrixId, messageId); break;
    case "kick":    void deleteOnKick(modMatrixId, messageId); break;
    case "youtube": void deleteOnYouTube(modMatrixId, messageId); break;
    // A native site message may have been cross-posted ("send to" / "all") —
    // delete each recorded platform copy by its own id. The mapping exists
    // because /api/chat/send captures the send responses' message ids; a
    // message with no copies (the common case) is a cheap no-op here.
    case "native":
      void deleteSiteMessageCopies(modMatrixId, messageId);
      break;
  }
}

async function deleteSiteMessageCopies(modMatrixId: string, siteMsgId: string): Promise<void> {
  try {
    const copies = await copiesForMessage(Number(siteMsgId));
    for (const c of copies) {
      switch (c.platform) {
        case "twitch":  void deleteOnTwitchByNativeId(modMatrixId, c.platformMsgId); break;
        case "kick":    void deleteOnKickByNativeId(modMatrixId, c.platformMsgId); break;
        case "youtube": void deleteOnYouTubeByNativeId(modMatrixId, c.platformMsgId); break;
      }
    }
  } catch (e) {
    console.warn(`[platformMod] copy-delete fan-out failed siteMsgId=${siteMsgId} mod=${modMatrixId}:`, e);
  }
}
