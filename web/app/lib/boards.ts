// The Leaderboard's data: one SQL statement per face, run per
// window inside per-window caches (a slow `all` never holds the stream
// window, and never the Home body — homeCache calls getBoards() through the
// same settle() every part gets). The FULL ranked lists (500 per people face)
// stay in memory so a signed-in caller's own rank is a lookup, not SQL.
// Money fence: no money table is read here and the ledger filter is earn_
// kinds only — boards.test.ts fails if that changes.
// The pool comes in by relative path (as activeChatters.ts does) so the test
// can import the pure parts without an alias loader.
import { messageVisibleSql } from "./instanceSchema.generated.mjs";
import pool from "../../lib/db.ts";
import { createTtlCache } from "./ttlCache.ts";
import {
  FACE_IDS, WINDOW_IDS, windowsFor, isPeopleFace, floorFor,
  type FaceId, type WindowId, type BoardRow, type HomeBoards,
} from "./boardFaces.ts";
import type { EquippedStyle } from "./usernameStyles.ts";
import { NATIVE_SQL } from "./nativePlatform.ts";
import { publicIdFor } from "./publicIdServer.ts";
import { ERASED_CANONICAL } from "./erasedPerson.ts";
import { noOptOutSql } from "./linkConsent.ts";

type Session = { started_at: Date; ended_at: Date | null };
type Bounds = [Date | null, Date | null];

/** [from, to] for a window; null when the window does not exist (no session ever).
 *  @test-only exported for the unit test; the caller is resolveWindow below (check-orphans does not count in-file references). */
export function windowBounds(w: WindowId, session: Session | null, nowMs: number): Bounds | null {
  const now = new Date(nowMs);
  if (w === "all") return [null, null];
  if (w === "week") return [new Date(nowMs - 7 * 86_400_000), now];
  if (w === "month") return [new Date(nowMs - 30 * 86_400_000), now];
  if (!session) return null;
  return [session.started_at, session.ended_at ?? now];
}

/** The newest session by started_at: live (ended_at NULL) → started_at..now; else its own span. */
async function resolveWindow(w: WindowId, nowMs = Date.now()): Promise<Bounds | null> {
  if (w !== "stream") return windowBounds(w, null, nowMs);
  const { rows } = await pool.query<Session>(`SELECT started_at, ended_at FROM stream.sessions ORDER BY started_at DESC LIMIT 1`);
  return windowBounds(w, rows[0] ?? null, nowMs);
}

// `$1`/`$2` are the bounds (NULL = unbounded on that side), always both present;
// `$3` is the rate boards' floor for the window (floorFor).
const W = (col: string) => `($1::timestamptz IS NULL OR ${col} >= $1) AND ($2::timestamptz IS NULL OR ${col} < $2)`;
// A bot ACCOUNT (the chat bot, the reader) never ranks; bot chat rows carry is_bot themselves.
const NOT_BOT_ACCOUNT = (key: string) => `NOT EXISTS (SELECT 1 FROM site.users b WHERE b.matrix_id = ${key} AND b.is_bot)`;

// canonical → its site account by either link table, and whether it may show the link: only when
// it has an account and NO site account linked to it (either table) has opted out — another
// account's choice is never this person's consent (linkConsent.ts, the one predicate).
// NULLIF: a link row with an EMPTY matrix id can exist (it shows as a nameless
// second row on the credit board) — MIN() would pick '' over a real id, so an
// empty one counts as no link.
const PERSON = `person AS (
  SELECT i.canonical, MIN(i.matrix_id) AS matrix_id, (MIN(i.matrix_id) IS NOT NULL AND ${noOptOutSql("i.canonical")}) AS show_links FROM (
    SELECT canonical_id AS canonical, NULLIF(matrix_id, '') AS matrix_id FROM site.platform_links
    UNION ALL
    SELECT canonical, NULLIF(platform_id, '') AS matrix_id FROM stream.links WHERE platform IN ${NATIVE_SQL}
  ) i GROUP BY i.canonical
)`;
// Whose row a chat line counts for. A board is public, and one row adding up a person's Twitch,
// YouTube and site lines under their site name publishes the link between them.
// So a platform line counts for its site account only when that account shows its
// links; otherwise it counts for that ONE platform identity — 'c:<canonical>|<platform>', an
// internal key the board turns into the identity's public id before anything leaves (publicKey).
// A site line (the site's own platform) counts for the site account.
const PKEY = `CASE WHEN cl.platform IN ${NATIVE_SQL} OR p.show_links
       THEN COALESCE(p.matrix_id, 'c:' || cl.user_id || '|' || lower(cl.platform))
       ELSE 'c:' || cl.user_id || '|' || lower(cl.platform) END`;
// The erased-person row (every deleted person's kept lines point at it) is no one and never ranks.
const NOT_ERASED = (col: string) => `${col} <> '${ERASED_CANONICAL}'`;

// Votes received, each row one vote with the receiver's key (the three sums of
// lib/socialCredit.ts getSocialCredit, windowed on the vote). Native EVENT rows
// (alerts, donations, polls, stickers) have no author — matrix_id can be NULL
// despite the schema's NOT NULL — and votes on them belong to nobody (they
// would make a nameless board row). An event row WITH an author (a signed-in
// person's donation card) is left out too: upvotes on donation cards would
// make the board money-ranked. The card's Credit pill still counts those
// votes, so the board reads lower than the pill — by design.
const VOTES = `votes AS (
  SELECT m.matrix_id AS key, v.vote
    FROM site.message_votes v
    JOIN site.chat_messages m ON v.platform IN ${NATIVE_SQL} AND v.message_id = m.id
   WHERE m.matrix_id IS NOT NULL AND m.event_kind IS NULL AND ${W("v.created_at")}
  UNION ALL
  SELECT ${PKEY}, v.vote
    FROM site.message_votes v
    JOIN stream.chat_log cl ON v.platform = cl.platform AND v.message_id = cl.id
    LEFT JOIN person p ON p.canonical = cl.user_id
   WHERE v.platform NOT IN ${NATIVE_SQL} AND cl.platform NOT IN ${NATIVE_SQL} AND NOT cl.is_bot AND ${NOT_ERASED("cl.user_id")} AND ${W("v.created_at")}
  UNION ALL
  SELECT fv.author_matrix_id, fv.vote FROM site.forum_votes fv WHERE ${W("fv.created_at")}
)`;

const avgFace = (col: "karma" | "intelligence", dir: "DESC" | "ASC") => `WITH ${PERSON}
SELECT ${PKEY} AS key,
       ROUND(${dir === "DESC" ? `AVG(cl.${col})` : `(1 - AVG(cl.${col}))`} * 100)::int AS value
  FROM stream.chat_log cl
  LEFT JOIN person p ON p.canonical = cl.user_id
 WHERE cl.${col} IS NOT NULL AND NOT cl.is_bot AND ${NOT_ERASED("cl.user_id")} AND ${messageVisibleSql("cl")} AND ${W("cl.created_at")}
 GROUP BY 1 HAVING COUNT(*) >= $3::int
 ORDER BY AVG(cl.${col}) ${dir}
 LIMIT 500`;

// earn_bonus is the 2× clock bonus, and the clock is lit by money
// (stream-api/sponsors.js) — so it is not "earned" for ruling 5.
const SQL: Record<FaceId, string> = {
  points: `SELECT l.matrix_id AS key, SUM(l.delta)::bigint AS value
  FROM site.coin_ledger l
 WHERE l.kind LIKE 'earn\\_%' AND l.kind <> 'earn_bonus' AND ${W("l.created_at")} AND ${NOT_BOT_ACCOUNT("l.matrix_id")}
 GROUP BY 1 HAVING SUM(l.delta) > 0
 ORDER BY 2 DESC
 LIMIT 500`,
  credit: `WITH ${PERSON}, ${VOTES}
SELECT v.key, SUM(v.vote)::int AS value FROM votes v
 WHERE ${NOT_BOT_ACCOUNT("v.key")}
 GROUP BY v.key HAVING SUM(v.vote) > 0
 ORDER BY 2 DESC
 LIMIT 500`,
  creditRate: `WITH ${PERSON}, ${VOTES}, msgs AS (
  SELECT m.matrix_id AS key, COUNT(*) AS n FROM site.chat_messages m
   WHERE m.matrix_id IS NOT NULL AND m.event_kind IS NULL AND ${messageVisibleSql("m")} AND ${W("m.created_at")} GROUP BY 1
  UNION ALL
  SELECT ${PKEY}, COUNT(*) FROM stream.chat_log cl
    LEFT JOIN person p ON p.canonical = cl.user_id
   WHERE cl.platform NOT IN ${NATIVE_SQL} AND NOT cl.is_bot AND ${NOT_ERASED("cl.user_id")} AND ${messageVisibleSql("cl")} AND ${W("cl.created_at")} GROUP BY 1
), n AS (SELECT key, SUM(n) AS n FROM msgs GROUP BY key HAVING SUM(n) >= $3::int),
c AS (SELECT key, SUM(vote) AS credit FROM votes GROUP BY key)
SELECT n.key, ROUND(COALESCE(c.credit, 0) * 100.0 / n.n, 1)::float AS value
  FROM n LEFT JOIN c USING (key)
 WHERE ${NOT_BOT_ACCOUNT("n.key")}
 ORDER BY 2 DESC
 LIMIT 500`,
  streams: `WITH ${PERSON}
SELECT ${PKEY} AS key, COUNT(DISTINCT cl.stream_id)::int AS value
  FROM stream.chat_log cl
  LEFT JOIN person p ON p.canonical = cl.user_id
 WHERE cl.stream_id IS NOT NULL AND NOT cl.is_bot AND ${NOT_ERASED("cl.user_id")} AND ${W("cl.created_at")}
 GROUP BY 1
 ORDER BY 2 DESC
 LIMIT 500`,
  wholesome: avgFace("karma", "DESC"),
  toxic: avgFace("karma", "ASC"),
  bigBrain: avgFace("intelligence", "DESC"),
  smallBrain: avgFace("intelligence", "ASC"),
  messages: `WITH ${PERSON}, s AS (
  SELECT platform, message_id, SUM(vote)::int AS score
    FROM site.message_votes WHERE ${W("created_at")}
   GROUP BY 1, 2 HAVING SUM(vote) > 0
   ORDER BY 3 DESC LIMIT 100
)
SELECT s.platform || ':' || s.message_id AS key, s.score AS value,
       COALESCE(m.message, cl.message) AS text, COALESCE(m.emotes, cl.emotes) AS emotes,
       COALESCE(m.matrix_id, CASE WHEN p.show_links THEN p.matrix_id END, 'c:' || cl.user_id || '|' || lower(cl.platform)) AS person_key
  FROM s
  LEFT JOIN site.chat_messages m ON s.platform IN ${NATIVE_SQL} AND m.id = s.message_id AND ${messageVisibleSql("m")}
       AND m.event_kind IS NULL AND m.message <> '' AND m.encrypted_text IS NULL
  LEFT JOIN stream.chat_log cl ON s.platform NOT IN ${NATIVE_SQL} AND cl.platform = s.platform AND cl.id = s.message_id AND ${messageVisibleSql("cl")} AND NOT cl.is_bot AND cl.message <> ''
  LEFT JOIN person p ON p.canonical = cl.user_id
 WHERE (m.id IS NOT NULL OR cl.id IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM site.users b WHERE b.matrix_id = m.matrix_id AND b.is_bot)
 ORDER BY s.score DESC
 LIMIT 10`,
  emotes: `SELECT e.key AS key, MIN(e.value) AS url, COUNT(*)::int AS value
  FROM (
    SELECT cl.emotes FROM stream.chat_log cl
     WHERE cl.emotes IS NOT NULL AND cl.platform NOT IN ${NATIVE_SQL} AND NOT cl.is_bot AND ${messageVisibleSql("cl")} AND ${W("cl.created_at")}
    UNION ALL
    SELECT m.emotes FROM site.chat_messages m
     WHERE m.emotes IS NOT NULL AND ${messageVisibleSql("m")} AND ${W("m.created_at")}
  ) x, jsonb_each_text(x.emotes) e
 GROUP BY e.key
 ORDER BY 3 DESC
 LIMIT 10`,
};

/** @test-only the statement for a face, so the tests can pin its shape without a database. */
export function faceSql(face: FaceId): string { return SQL[face]; }

type Raw = { key: string; value: number | string; text?: string | null; emotes?: Record<string, string> | null; person_key?: string; url?: string };
type Who = { name: string; color: string | null; style: EquippedStyle | null; avatarUrl: string | null };

/** Names, colours, styles and avatars for a set of person keys, in two bulk reads. */
async function resolvePeople(keys: string[]): Promise<Map<string, Who>> {
  const out = new Map<string, Who>();
  const matrix = keys.filter((k) => k.startsWith("@"));
  // 'c:<canonical>|<platform>' — one platform identity.
  const canon = keys.filter((k) => k.startsWith("c:")).map((k) => k.slice(2));
  if (matrix.length) {
    const { rows } = await pool.query<{ key: string; name: string | null; color: string | null; style: EquippedStyle | null; avatar_url: string | null; platform_avatar: string | null }>(
      `SELECT u.matrix_id AS key, u.display_name AS name, u.username_color AS color, u.username_style AS style, u.avatar_url,
              -- A linked platform's picture on the site row would show the link: only by opt-in.
              -- And only from a canonical every one of whose accounts shows its links.
              CASE WHEN u.show_links THEN
              (SELECT su.avatar_url FROM site.platform_links pl JOIN stream.users su ON su.id = pl.canonical_id
                WHERE pl.matrix_id = u.matrix_id AND su.avatar_url IS NOT NULL
                  AND ${noOptOutSql("pl.canonical_id")}
                ORDER BY su.last_seen DESC NULLS LAST LIMIT 1) END AS platform_avatar
         FROM site.users u WHERE u.matrix_id = ANY($1)`, [matrix]);
    // avatar_url is an mxc:// URI; the picture is served by /api/avatar/user
    // (avatarSrc.ts). No site avatar → the picture their linked platform last
    // showed (stream.users.avatar_url, v127), else none (the widget draws a letter).
    for (const r of rows) out.set(r.key, { name: r.name ?? r.key.slice(1).split(":")[0] ?? r.key, color: r.color, style: r.style, avatarUrl: r.avatar_url ? `/api/avatar/user/${encodeURIComponent(r.key)}` : r.platform_avatar ?? null });
  }
  if (canon.length) {
    const { rows } = await pool.query<{ key: string; name: string; color: string | null; avatar_url: string | null }>(
      // A name lookup, not a ranking read — hence no bot filter and no `cl` alias. The name this
      // identity goes by on ITS platform; the canonical's avatar only when the canonical has no
      // other platform (it is the last picture ANY of its platforms showed).
      `SELECT DISTINCT ON (c.user_id, lower(c.platform)) 'c:' || c.user_id || '|' || lower(c.platform) AS key,
              c.username AS name, c.username_color AS color,
              CASE WHEN NOT EXISTS (SELECT 1 FROM stream.links ol WHERE ol.canonical = c.user_id
                                      AND ol.platform NOT IN ${NATIVE_SQL} AND lower(ol.platform) <> lower(c.platform))
                   THEN su.avatar_url END AS avatar_url
         FROM stream.chat_log c JOIN stream.users su ON su.id = c.user_id
        WHERE c.user_id || '|' || lower(c.platform) = ANY($1)
        ORDER BY c.user_id, lower(c.platform), c.created_at DESC`, [canon]);
    for (const r of rows) out.set(r.key, { name: r.name, color: r.color, style: null, avatarUrl: r.avatar_url ?? null });
  }
  return out;
}

const NOBODY: Who = { name: "someone", color: null, style: null, avatarUrl: null };

/** A board row's key as it leaves (the public Home payload): a site account's Matrix id as it
 *  is, a platform identity's internal 'c:<canonical>|<platform>' as that identity's public id.
 *  Never a canonical id.
 *  @test-only exported for the unit test; the caller is loadFace above (check-orphans does not count in-file references). */
export function publicKey(key: string): string {
  if (!key.startsWith("c:")) return key;
  const bar = key.lastIndexOf("|");
  return (bar > 2 ? publicIdFor(key.slice(2, bar), key.slice(bar + 1)) : null) ?? "";
}

async function loadFace(face: FaceId, w: WindowId, bounds: Bounds): Promise<BoardRow[]> {
  // Only the rate faces reference $3. pg infers a statement's parameter count
  // from the placeholders it USES, so a third value on a two-placeholder
  // statement is refused at bind time ("supplies 3 parameters, but prepared
  // statement requires 2"), taking every non-rate board down. A declared
  // PREPARE tolerates an unused parameter, so a schema-replay proof does not
  // catch it — prove SQL through the runtime driver.
  const params = SQL[face].includes("$3") ? [...bounds, floorFor(w)] : bounds;
  const { rows } = await pool.query<Raw>(SQL[face], params);
  if (face === "emotes") {
    return rows.map((r, i) => ({ key: r.key, rank: i + 1, name: r.key, color: null, style: null, avatarUrl: null, value: Number(r.value), emoteUrl: r.url }));
  }
  const personKey = (r: Raw) => (face === "messages" ? r.person_key ?? "" : r.key);
  // Names for the ten rows a face SHOWS (top 10); the rest of the list exists only for
  // rank lookups, which read key and value.
  const who = await resolvePeople([...new Set(rows.slice(0, 10).map(personKey).filter(Boolean))]);
  return rows.map((r, i) => {
    const w = who.get(personKey(r)) ?? NOBODY;
    const row: BoardRow = { key: face === "messages" ? r.key : publicKey(r.key), rank: i + 1, name: w.name, color: w.color, style: w.style, avatarUrl: w.avatarUrl, value: Number(r.value) };
    if (face === "messages") { row.text = r.text ?? ""; row.emotes = r.emotes ?? null; }
    return row;
  });
}

type WindowLists = Partial<Record<FaceId, BoardRow[]>>;

/** One window's lists. A face that fails is ABSENT (not empty), and the whole
 *  answer is then not cacheable, so the next read retries while serveWarm keeps
 *  serving that face's last good list. */
async function loadWindow(w: WindowId): Promise<{ lists: WindowLists; complete: boolean }> {
  const bounds = await resolveWindow(w);
  const lists: WindowLists = {};
  if (bounds === null) return { lists, complete: true };
  let complete = true;
  await Promise.all(FACE_IDS.filter((f) => windowsFor(f).includes(w)).map(async (f) => {
    try { lists[f] = await loadFace(f, w, bounds); } catch (err) { complete = false; console.warn(`[boards] ${f}/${w} failed:`, (err as Error).message); }
  }));
  return { lists, complete };
}

// Per-window TTLs: the stream window moves every minute, all-time barely at all.
const TTL: Record<WindowId, number> = { stream: 60_000, week: 5 * 60_000, month: 15 * 60_000, all: 60 * 60_000 };
const caches = Object.fromEntries(WINDOW_IDS.map((w) => [w, createTtlCache<WindowLists>({
  ttlMs: TTL[w],
  load: async () => { const { lists, complete } = await loadWindow(w); return { data: lists, cacheable: complete }; },
})])) as Record<WindowId, ReturnType<typeof createTtlCache<WindowLists>>>;

type Slot<T> = { last: T | null; inflight: Promise<void> | null };
const slots = Object.fromEntries(WINDOW_IDS.map((w) => [w, { last: null, inflight: null }])) as Record<WindowId, Slot<WindowLists>>;

/** Stale-while-revalidate over a TTL cache, WITHOUT waiting: fresh → the
 *  cache's value; otherwise the last value we saw (null when cold) while ONE
 *  background load runs. The Home body is built on this, so a cold or slow
 *  window can never hold the page. A load's answer is merged
 *  over the last one, so a face missing from it (failed) keeps its last list.
 *  @test-only exported for the unit test; the caller is getBoards below (check-orphans does not count in-file references). */
export function serveWarm<T extends object>(cache: { peek(): T | null; get(): Promise<T> }, slot: Slot<T>): T | null {
  const fresh = cache.peek();
  if (fresh) { slot.last = fresh; return fresh; }
  if (!slot.inflight) {
    slot.inflight = cache.get()
      .then((d) => { slot.last = { ...(slot.last ?? {}), ...d } as T; })
      .catch(() => {})
      .finally(() => { slot.inflight = null; });
  }
  return slot.last;
}

/** The public body: the top ten of every face × window; a cold window is null. */
export async function getBoards(): Promise<HomeBoards> {
  const out = {} as HomeBoards;
  for (const f of FACE_IDS) {
    out[f] = {} as Record<WindowId, BoardRow[] | null>;
    for (const w of WINDOW_IDS) {
      const lists = serveWarm(caches[w], slots[w]);
      const l = lists?.[f] ?? null;
      out[f][w] = l ? l.slice(0, 10) : null;
    }
  }
  return out;
}

/** The caller's place by any of their identity keys; null when unranked.
 *  @test-only exported for the unit test; the caller is findRank below (check-orphans does not count in-file references). */
export function rankOf(rows: BoardRow[], keys: string[]): { rank: number; value: number; key: string } | null {
  if (keys.length === 0) return null;
  const set = new Set(keys);
  const hit = rows.find((r) => set.has(r.key));
  return hit ? { rank: hit.rank, value: hit.value, key: hit.key } : null;
}

export async function findRank(face: FaceId, w: WindowId, keys: string[]): Promise<{ rank: number; value: number; key: string } | null> {
  if (!isPeopleFace(face) || !windowsFor(face).includes(w)) return null;
  const lists = await caches[w].get();
  return rankOf(lists[face] ?? [], keys);
}
