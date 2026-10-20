// Whether a chat message may be shown to the public — the shared rule (messageVisibleSql, from
// config/instance-schema.mjs, the same text in every package) applied to one message by id.
// SERVER ONLY. Pins are SNAPSHOTS, so a pinned message deleted afterwards (by a mod, or with its
// account) must be re-checked at read time; this is that check.

import { messageVisibleSql } from "./instanceSchema.generated.mjs";
import { isNativePlatform } from "./nativePlatform.ts";

type Query = (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;

/** Is this message (a site row, or a platform chat_log row) still visible? */
export async function sourceVisible(platform: string, messageId: number, query: Query): Promise<boolean> {
  const r = isNativePlatform(platform)
    ? await query(`SELECT 1 FROM site.chat_messages m WHERE m.id = $1 AND ${messageVisibleSql("m")}`, [messageId])
    : await query(`SELECT 1 FROM stream.chat_log cl WHERE cl.id = $1 AND cl.platform = $2 AND ${messageVisibleSql("cl")}`, [messageId, platform]);
  return r.rows.length > 0;
}
