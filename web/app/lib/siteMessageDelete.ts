// Delete a NATIVE site message everywhere it exists: the site row (persistence),
// the live WS view (stream-api /chat/delete broadcast), the mod log, and every
// cross-posted platform copy (fanOutDelete's native branch, via the copies
// mapping). Shared by /api/mod/delete's native branch and the automod resolve
// route — Deny on a held cross-post must remove the origin too, and a second
// hand-rolled copy of the NATIVE four-step sequence is how one surface drifts
// from the other. (mod/delete's platform branch is deliberately not folded in:
// a twitch/kick message has no site row to flag, so its sequence is a
// different, three-step one.)

import pool from "@/lib/db";
import { appendModLog } from "@/app/lib/modlog";
import { streamApiFetch } from "@/app/lib/streamApi";
import { fanOutDelete } from "@/app/lib/platformMod";
import { NATIVE_PLATFORM } from "@/app/lib/nativePlatform";

/**
 * The WS delete frame and the mod-log target carry the site's own platform id in its
 * written form (nativePlatform.ts).
 */
export async function deleteSiteMessageEverywhere(
  mod: string,
  siteMsgId: number,
): Promise<void> {
  const platform = NATIVE_PLATFORM;
  // The site flag is the one step that must not be best-effort — it is what
  // makes the deletion survive a refresh. The `is_deleted = false` condition is
  // the idempotence guard: a second call for the same message (a deny racing a
  // manual mod delete, or a retried resolve) must not re-broadcast, double-log,
  // or re-fire the platform fan-out — those all already happened.
  const { rowCount } = await pool.query(
    `UPDATE site.chat_messages SET is_deleted = true WHERE id = $1 AND is_deleted = false`,
    [siteMsgId]
  );
  if (!rowCount) return;

  // Live-view broadcast; best-effort (the flag above already hides it on load).
  await streamApiFetch(`/chat/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messageId: siteMsgId, platform }),
  }).catch(() => null);

  await appendModLog({ action: "delete", target: `${platform}:${siteMsgId}`, by: mod });

  // Cross-posted platform copies (fire-and-forget by design).
  fanOutDelete(mod, String(siteMsgId), platform);
}
