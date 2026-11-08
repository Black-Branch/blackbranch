// The lines a mod purge flags, and the purge itself (runPurge) — run by the Purge button
// (app/api/mod/purge/route.ts) and by a ban or timeout (app/api/mod/ban/route.ts). SERVER ONLY; dependency-free so
// `node --test` can run it against a real Postgres — the route hands it the query.
//
// A purge names a person by matrix id, or by canonical id (the ⋯ menu on a platform line). The route
// expands a canonical into its site accounts the way the ban route does it (canonicalIdentity.ts
// siteAccountsOf — one helper, both callers) and hands them here: a linked person's site lines go
// with their platform lines. Before, a purge by canonical flagged native rows
// `WHERE matrix_id = <the canonical>`, which is nothing.

import { NATIVE_PLATFORM, NATIVE_SQL, isNativePlatform } from "./nativePlatform.ts";
import { isLineId, windowLabel } from "./modRequests.ts";

/** At most this many site lines and this many platform lines per purge: one WS frame, one pass. */
const PURGE_MAX_ROWS_PER_SIDE = 250;

type Query = (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export type PurgeLines = {
  /** The site lines flagged deleted here (site.chat_messages is web's to write). */
  native: string[];
  /** The platform lines for stream-api to flag (read-only here). */
  platform: { id: string; platform: string; platform_msg_id: string | null }[];
};

/** Flag `accounts`' site lines of the last `windowMinutes` (≤ cap), and read the platform lines of
 *  every identity of theirs — and of `targetId` itself when it is a canonical — in the same window.
 *  @test-only runPurge below calls it; the purge route's test runs it against a real Postgres. */
export async function purgeLines(targetId: string, accounts: string[], windowMinutes: number, cap: number, query: Query): Promise<PurgeLines> {
  const native = accounts.length
    ? (await query(
      `UPDATE site.chat_messages SET is_deleted = true
       WHERE id IN (
         SELECT id FROM site.chat_messages
         WHERE matrix_id = ANY($1::text[]) AND NOT is_deleted
           AND created_at > now() - make_interval(mins => $2::int)
         ORDER BY created_at DESC LIMIT $3
       )
       RETURNING id`,
      [accounts, windowMinutes, cap])).rows.map((r) => String(r.id))
    : [];
  const platform = (await query(
    `${CANON_CTE}
     SELECT l.id, l.platform, l.platform_msg_id
     FROM stream.chat_log l JOIN canon ON l.user_id = canon.c
     WHERE l.platform NOT IN ${NATIVE_SQL} AND NOT l.is_deleted
       AND l.created_at > now() - make_interval(mins => $3::int)
     ORDER BY l.created_at DESC LIMIT $4`,
    [accounts, targetId, windowMinutes, cap])).rows as PurgeLines["platform"];
  return { native, platform };
}

/** Every identity of the person: $1 = their accounts, $2 = the target (a canonical counts itself). */
const CANON_CTE = `WITH canon AS (
       SELECT canonical_id AS c FROM site.platform_links WHERE matrix_id = ANY($1::text[])
       UNION
       SELECT canonical AS c FROM stream.links
         WHERE platform IN ${NATIVE_SQL} AND platform_id = ANY($1::text[])
       UNION
       SELECT id AS c FROM stream.users WHERE id = $2
     )`;

/** The line a ban was clicked on, by its id and whatever its age — only when it is the person's own
 *  (the ceiling was checked on the person, never on a line named beside them). A site line is
 *  flagged here; a platform line is read for stream-api to flag. */
async function clickedLine(targetId: string, accounts: string[], clicked: { platform: string; id: string }, query: Query): Promise<PurgeLines> {
  if (!isLineId(clicked.id)) return { native: [], platform: [] };
  if (isNativePlatform(clicked.platform)) {
    const native = accounts.length
      ? (await query(
        `UPDATE site.chat_messages SET is_deleted = true
         WHERE id = $1::bigint AND matrix_id = ANY($2::text[]) AND NOT is_deleted RETURNING id`,
        [clicked.id, accounts])).rows.map((r) => String(r.id))
      : [];
    return { native, platform: [] };
  }
  const platform = (await query(
    `${CANON_CTE}
     SELECT l.id, l.platform, l.platform_msg_id
     FROM stream.chat_log l JOIN canon ON l.user_id = canon.c
     WHERE l.id = $3::bigint AND lower(l.platform) = lower($4) AND l.platform NOT IN ${NATIVE_SQL} AND NOT l.is_deleted`,
    [accounts, targetId, clicked.id, clicked.platform])).rows as PurgeLines["platform"];
  return { native: [], platform };
}

/** What a purge does besides the database: the server wiring is modPurgeServer.ts purgeDeps. */
export type PurgeDeps = {
  query: Query;
  /** stream-api /chat/purge: flags the platform lines and sends the ONE {type:'purge'} frame. */
  broadcast: (items: { platform: string; id: number }[], batchId: string) => Promise<unknown>;
  /** The platform copies of purged site lines (site.chat_message_platform_copies), by platform. */
  copies: (nativeIds: number[]) => Promise<Map<string, string[]>>;
  log: (reason: string, batchId: string) => Promise<unknown>;
  /** The platform fan-out, fire-and-forget. */
  fanOut: (kickIds: string[], youtubeIds: string[], batchId: string, opts: { twitch: boolean }) => void;
};

export type PurgeRun = {
  targetId: string; accounts: string[]; windowMinutes: number; batchId: string;
  /** Set when a ban or timeout runs this purge (the ban route): its mod-log row names both. */
  alongside?: "ban" | "timeout";
  /** The line the ban was clicked on: removed by its id even when older than the window. */
  clicked?: { platform: string; id: string } | null;
  /** The ban named a clicked line that cannot be one (modRequests.ts clickedLineOf "invalid"). */
  clickedSkipped?: boolean;
};

/** The purge of the Purge button, and of a ban or timeout: flag the lines, ONE frame, ONE mod-log
 *  row, then the platforms. With a ban, Twitch is left to the ban itself — a Twitch ban or timeout
 *  clears the person's chat there, and the purge's 1-second timeout after it would replace a longer
 *  timeout. Every ceiling check comes before this (both routes). */
export async function runPurge(deps: PurgeDeps, run: PurgeRun): Promise<{ purged: number }> {
  const { targetId, accounts, windowMinutes, batchId, alongside, clicked, clickedSkipped } = run;
  // The clicked line first: if it fails, nothing of the window has been flagged yet.
  const one = clicked ? await clickedLine(targetId, accounts, clicked, deps.query) : { native: [], platform: [] };
  const { native, platform } = await purgeLines(targetId, accounts, windowMinutes, PURGE_MAX_ROWS_PER_SIDE, deps.query);
  native.push(...one.native.filter((id) => !native.includes(id)));
  platform.push(...one.platform.filter((r) => !platform.some((p) => String(p.id) === String(r.id))));
  const items = [
    ...native.map((id) => ({ platform: NATIVE_PLATFORM, id: Number(id) })),
    ...platform.map((r) => ({ platform: r.platform.toLowerCase(), id: Number(r.id) })),
  ];
  if (items.length > 0) await deps.broadcast(items, batchId);
  const span = windowLabel(windowMinutes);
  const skipped = clickedSkipped ? " · clicked line skipped" : "";
  await deps.log(alongside ? `${alongside} + purge ${items.length} lines / last ${span}${skipped}` : `${items.length} messages / last ${span}`, batchId);

  // Kick and YouTube delete by platform message id; a purged site line's cross-posted copies go too.
  const copyMap = await deps.copies(native.map(Number));
  const msgIdsFor = (p: string) => [
    ...platform.filter((r) => r.platform.toLowerCase() === p && r.platform_msg_id).map((r) => r.platform_msg_id as string),
    ...(copyMap.get(p) ?? []),
  ];
  deps.fanOut(msgIdsFor("kick"), msgIdsFor("youtube"), batchId, { twitch: !alongside });
  return { purged: items.length };
}

/** What a ban's purge did: the lines it removed, or null with purgeFailed when it threw. */
export type BanPurge = { purged: number | null; purgeFailed: boolean };

/** No purge (the switch off): nothing removed, nothing failed. */
export const NO_PURGE: BanPurge = { purged: null, purgeFailed: false };

/** runPurge for the ban route. It runs AFTER the ban was written, pushed and reconciled, so a throw
 *  here must never turn the ban's answer into a failure (the mod would read "Ban failed", with no
 *  Undo, for a ban that stands): it is logged on the server and the answer says the purge failed. */
export async function purgeWithBan(deps: PurgeDeps, run: PurgeRun, warn: (...a: unknown[]) => void = console.warn): Promise<BanPurge> {
  try {
    return { purged: (await runPurge(deps, run)).purged, purgeFailed: false };
  } catch (e) {
    warn(`[mod/ban] the ban's purge failed (batch ${run.batchId}, ${run.targetId}):`, e);
    return { purged: null, purgeFailed: true };
  }
}
