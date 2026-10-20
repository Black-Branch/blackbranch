// A report filed from a chat message: the message names the person, so anyone in chat can be
// reported — a site account or a chatter who only ever spoke from a platform. The author is
// resolved HERE, from the stored message, never taken from the reporter: a report cannot be
// pointed at someone who did not write the line.
//
// Pure over an injected query (node --test); /api/support/report hands it the pool.
// Relative imports only: node --test loads this with no "@/" alias.
import { isNativePlatform, normalizePlatform } from "./nativePlatform.ts";
import { matrixIdForCanonical, type LinkQuery } from "./canonicalIdentity.ts";

export type MessageReport = { platform: string; messageId: number; reason: string };

const REASON_MAX = 500;

/** The body of a report about a message, or null. */
export function clampMessageReport(raw: unknown): MessageReport | null {
  const b = (raw ?? {}) as { platform?: unknown; messageId?: unknown; reason?: unknown };
  const platform = typeof b.platform === "string" ? String(normalizePlatform(b.platform.trim().toLowerCase())) : "";
  const messageId = Number(b.messageId);
  const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, REASON_MAX) : "";
  if (!platform || !/^[a-z0-9_.-]{1,32}$/.test(platform) || !Number.isSafeInteger(messageId) || messageId <= 0 || !reason) return null;
  return { platform, messageId, reason };
}

export type ReportedAuthor = { matrixId: string | null; canonicalId: string | null };

type Query = (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

/**
 * Who wrote the message: a site account (matrixId) when there is one — the ONE preferred
 * account behind a platform identity, the first `matrixIdForCanonical` finds, since a report is
 * read by a person and names one — else the platform-only chatter's canonical id. Null when the
 * message does not exist.
 */
export async function reportedAuthor(q: Query, platform: string, messageId: number): Promise<ReportedAuthor | null> {
  if (isNativePlatform(platform)) {
    const { rows } = await q(`SELECT matrix_id FROM site.chat_messages WHERE id = $1`, [messageId]);
    const m = rows[0]?.matrix_id;
    return typeof m === "string" && m ? { matrixId: m, canonicalId: null } : null;
  }
  const { rows } = await q(`SELECT user_id FROM stream.chat_log WHERE id = $1 AND lower(platform) = $2`, [messageId, platform]);
  const canonical = rows[0]?.user_id;
  if (typeof canonical !== "string" || !canonical) return null;
  const links: LinkQuery = (sql, p) => q(sql, p).then((r) => ({ rows: r.rows.map((x) => ({ matrix_id: String(x.matrix_id ?? "") })) }));
  const matrixId = await matrixIdForCanonical(canonical, links);
  return matrixId ? { matrixId, canonicalId: null } : { matrixId: null, canonicalId: canonical };
}
