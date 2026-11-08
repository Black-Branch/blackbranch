// A moderator's reach to the sender of a tip card that wears no account (ADR 0145). The card
// carries no public id, so the chat asks for `card:<row id>` through the same moderators-only
// batch as a public id (/api/mod/identity/resolve, modIdentity.ts), and the sender comes from the
// card's own row — server-side, never from a field a viewer's socket could read.
import { canonicalFromMatrixSql } from "./canonicalFromMatrix.ts";
import { cardSenderKey, parseCardSenderKey } from "./modCardKey.ts";

export type CardSenderQuery = (sql: string, params: unknown[]) => Promise<{ rows: { id: string; matrix_id: string; canonical: string | null }[] }>;

/** The senders behind the `card:<id>` keys among `keys` (others are ignored). Tips only, and only
 *  a row with an account: an anonymous tip's row has none. Never throws. */
export async function resolveCardSenders(keys: string[], q: CardSenderQuery): Promise<Record<string, { canonicalId: string | null; matrixId: string }>> {
  const ids = [...new Set(keys.map(parseCardSenderKey).filter((n): n is number => n !== null))];
  if (ids.length === 0) return {};
  let rows: Awaited<ReturnType<CardSenderQuery>>["rows"];
  try {
    ({ rows } = await q(
      `SELECT m.id::text AS id, m.matrix_id, ${canonicalFromMatrixSql("m.matrix_id")} AS canonical
         FROM site.chat_messages m
        WHERE m.id = ANY($1::bigint[]) AND m.event_kind = 'donation' AND m.matrix_id IS NOT NULL`,
      [ids],
    ));
  } catch {
    return {};
  }
  const out: Record<string, { canonicalId: string | null; matrixId: string }> = {};
  for (const r of rows) out[cardSenderKey(Number(r.id))] = { canonicalId: r.canonical ?? null, matrixId: r.matrix_id };
  return out;
}
