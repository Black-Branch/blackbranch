// site.chat_message_platform_copies (migrate-v71): which platform message ids a
// cross-posted site message produced. Written by /api/chat/send (from each
// platform send's response), read by platformMod so a site-side delete/purge
// can remove the cross-posted copies too — the platform echo of an outbound
// send is suppressed by stream-api's allSendDedup before any chat_log insert,
// so this table is the ONLY record tying a site message to its copies.

import pool from "@/lib/db";
import { streamApiFetch } from "@/app/lib/streamApi";

export type PlatformCopy = { platform: string; platformMsgId: string };

/**
 * Tell stream-api the id a platform gave our outbound copy, so it can suppress
 * that copy's echo by EXACT ID instead of guessing from the message text.
 *
 * Call this per send, the moment that send resolves — not batched after the
 * whole fan-out. Twitch answers in ~200ms and echoes within a second, so waiting
 * on a slower platform registers the Twitch id after its echo has already
 * rendered as a duplicate, which is the bug this is here to fix.
 *
 * Best-effort in both directions: a failure here costs us the exact path and
 * falls back to the text/identity window, so it must never fail or delay a send
 * that has already been delivered.
 */
export function registerEchoCopy(nativeMsgId: number, copies: PlatformCopy[]): Promise<void> {
  if (!Number.isInteger(nativeMsgId) || copies.length === 0) return Promise.resolve();
  return streamApiFetch("/chat/echo-copies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nativeMsgId, copies }),
  })
    .then(() => undefined)
    .catch(() => undefined);
}

// Best-effort append: mapping failures must never fail or delay the send that
// produced them (the message is already delivered everywhere at this point).
export async function recordPlatformCopies(
  siteMsgId: number,
  copies: PlatformCopy[]
): Promise<void> {
  if (!Number.isInteger(siteMsgId) || copies.length === 0) return;
  try {
    await pool.query(
      `INSERT INTO site.chat_message_platform_copies (site_msg_id, platform, platform_msg_id)
       SELECT $1, p, m FROM unnest($2::text[], $3::text[]) AS c(p, m)
       ON CONFLICT (site_msg_id, platform) DO NOTHING`,
      [siteMsgId, copies.map((c) => c.platform.toLowerCase()), copies.map((c) => c.platformMsgId)]
    );
  } catch (e) {
    console.warn("[platformCopies] record failed:", e);
  }
}

/** The platform copies of one site message (for fanOutDelete's native branch). */
export async function copiesForMessage(siteMsgId: number): Promise<PlatformCopy[]> {
  if (!Number.isInteger(siteMsgId)) return [];
  const { rows } = await pool.query<{ platform: string; platform_msg_id: string }>(
    `SELECT platform, platform_msg_id FROM site.chat_message_platform_copies
     WHERE site_msg_id = $1`,
    [siteMsgId]
  ).catch(() => ({ rows: [] as { platform: string; platform_msg_id: string }[] }));
  return rows.map((r) => ({ platform: r.platform, platformMsgId: r.platform_msg_id }));
}

/** Platform copies of MANY site messages, grouped by platform (purge fan-out). */
export async function copiesForMessages(siteMsgIds: number[]): Promise<Map<string, string[]>> {
  const byPlatform = new Map<string, string[]>();
  if (siteMsgIds.length === 0) return byPlatform;
  const { rows } = await pool.query<{ platform: string; platform_msg_id: string }>(
    `SELECT platform, platform_msg_id FROM site.chat_message_platform_copies
     WHERE site_msg_id = ANY($1::bigint[])`,
    [siteMsgIds]
  ).catch(() => ({ rows: [] as { platform: string; platform_msg_id: string }[] }));
  for (const r of rows) {
    const list = byPlatform.get(r.platform) ?? [];
    list.push(r.platform_msg_id);
    byPlatform.set(r.platform, list);
  }
  return byPlatform;
}
