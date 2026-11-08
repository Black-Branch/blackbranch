// 30-day emote usage ranks for /api/emotes.
// The client warms the most-used emotes first (emoteWarmer.ts), so this answers
// "which emotes does this chat actually type", from the words of its messages.
//
// Counted from `stream.chat_log.message` TOKENS, not the `emotes` jsonb column:
// that column holds only per-message PLATFORM emotes and never sees a
// 7TV/BTTV/FFZ catalog emote, which a chatter simply types as a word.
// chat_log carries native site messages too.
//
// Cost: a few hundred ms over tens of thousands of lines. It runs at most once
// per TTL, in the background — a request never waits for it: before the first
// answer lands (and if the query fails) the manifest simply carries no ranks and
// the warmer falls back to its catalog order.
// The pool comes in by relative path (as boards.ts does) so the test can import
// the pure part without an alias loader.
import pool from "../../lib/db.ts";
import type { EmoteMap } from "./emoteMap.ts";

const TTL_MS = 6 * 60 * 60 * 1000;

// Filtered to the catalog's names ($1) in SQL: an unfiltered "top N tokens" cut
// would rank only the emotes that out-count ordinary words (a small fraction of
// the emotes actually used).
const USAGE_SQL = `SELECT tok
  FROM stream.chat_log cl, regexp_split_to_table(cl.message, '\\s+') tok
 WHERE cl.created_at > now() - interval '30 days' AND NOT cl.is_bot AND NOT cl.is_deleted
   AND tok = ANY($1::text[])
 GROUP BY tok
 ORDER BY count(*) DESC, tok`;

/** Pure: tokens in descending use → rank (1 = most used) for the catalog names only.
 *  @test-only exported so the rank rule is tested directly; mergeRanks is its caller. */
export function rankByUsage(tokens: readonly string[], names: ReadonlySet<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of tokens) if (names.has(t) && !out.has(t)) out.set(t, out.size + 1);
  return out;
}

/** Pure: the manifest with `r` (usage rank) and `s` (sticker rank) merged in — a new object;
 *  emotes with neither keep their own info object. */
export function mergeRanks(base: EmoteMap, tokens: readonly string[] | null, stickers: readonly string[] | null): EmoteMap {
  const names = new Set(Object.keys(base));
  const ranks = rankByUsage(tokens ?? [], names);
  const sRanks = rankByUsage(stickers ?? [], names);
  const map: EmoteMap = {};
  for (const [name, info] of Object.entries(base)) {
    const r = ranks.get(name);
    const s = sRanks.get(name);
    map[name] = r || s ? { ...info, ...(r ? { r } : {}), ...(s ? { s } : {}) } : info;
  }
  return map;
}

// The same ranks for STICKERS (a coin spend whose body is one big emote): which emotes this chat
// has sent as stickers lately. The warmer fetches their sticker rung, which chat never renders.
const STICKER_SQL = `SELECT meta->>'emote' AS tok
  FROM site.coin_ledger
 WHERE sink = 'sticker' AND created_at > now() - interval '30 days'
   AND meta->>'emote' = ANY($1::text[])
 GROUP BY 1
 ORDER BY count(*) DESC, 1`;

/** A ranked token list loaded in the background, at most once per TTL (header). */
function rankLoader(sql: string, label: string) {
  let tokens: string[] | null = null;
  let loadedAt = 0;
  let inflight: Promise<void> | null = null;

  /** The list as it stands (null before the first load), refreshing in the background when stale. */
  function current(names: readonly string[]): string[] | null {
    if ((!tokens || Date.now() - loadedAt > TTL_MS) && !inflight) {
      inflight = pool.query<{ tok: string }>(sql, [names])
        .then(({ rows }) => { tokens = rows.map((r) => r.tok); loadedAt = Date.now(); })
        .catch((err) => { console.warn(`[emotes] ${label} ranks failed:`, (err as Error).message); loadedAt = Date.now() - TTL_MS + 10 * 60_000; })
        .finally(() => { inflight = null; });
    }
    return tokens;
  }

  /** current(), but on a cold server waits up to `ms` for the first load — so the first
   *  manifest after a deploy carries ranks (browsers keep it for 5 minutes). */
  return async function within(names: readonly string[], ms = 800): Promise<string[] | null> {
    const now = current(names);
    if (now || !inflight) return now;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([inflight, new Promise<void>((r) => { timer = setTimeout(r, ms); })]);
    clearTimeout(timer);
    return tokens;
  };
}

export const usageTokensWithin = rankLoader(USAGE_SQL, "usage");
export const stickerTokensWithin = rankLoader(STICKER_SQL, "sticker");
