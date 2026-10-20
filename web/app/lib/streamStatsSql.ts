// The Stream tab's reads. READ-ONLY by contract: nothing in this file writes. Every loader takes
// the query function instead of importing the pool, so streamStatsSql.test.ts runs the same SQL
// against a replayed schema (SQL_PARSE_DATABASE_URL). Every chat count excludes bots. Money is
// take-home cents from stream.support_events.amount_usd — written once by stream-api's
// economics.takeHome — never recomputed here; spends of the site's points are not income (the
// same rule as Payment history, paymentHistory.ts).
import { NATIVE_SQL } from "./nativePlatform.ts";
import { SPEND_SINKS } from "./coins.ts";
import { groupSessions, visibleGroups, type SessionGroup, type SessionRow } from "./streamGroups.ts";
import {
  int, fillMinuteBuckets, byPlatform, sortSessions,
  type CurvePoint, type ChatPoint, type LiveDashboard, type SessionDetail, type SessionSort, type SessionSummary,
  type StreamIncome, type StreamLive, type SupportEvent,
} from "./streamStats.ts";

export type Query = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

/** A received payment that is income: not a spend of the site's points. `event_type` is coalesced —
 *  a NULL there would make the whole NOT(…) NULL and drop a real payment. */
const incomeSql = (sinksParam: number) => `NOT (se.platform IN ${NATIVE_SQL} AND coalesce(se.event_type, '') = ANY($${sinksParam}::text[]))`;
const SINKS: string[] = [...SPEND_SINKS];

const ms = (col: string) => `(extract(epoch FROM ${col}) * 1000)::bigint`;

function mapCurve(rows: readonly Record<string, unknown>[]): CurvePoint[] {
  return rows.map((r) => ({
    ms: int(r.ms, "curve ms"),
    total: r.total === null ? 0 : int(r.total, "curve total"),
    twitch: int(r.twitch, "curve twitch"),
    youtube: int(r.youtube, "curve youtube"),
    kick: int(r.kick, "curve kick"),
    streamplace: int(r.streamplace, "curve streamplace"),
  }));
}

const CURVE_SQL = `SELECT ${ms("recorded_at")} AS ms, total,
         coalesce(twitch, 0) AS twitch, coalesce(youtube, 0) AS youtube,
         coalesce(kick, 0) AS kick, coalesce(streamplace, 0) AS streamplace
    FROM stream.viewer_snapshots WHERE stream_id = ANY($1::text[]) ORDER BY recorded_at`;

/** Every session with its last snapshot's time, grouped into logical streams, newest first.
 *  @test-only exported so streamStatsSql.test.ts can see the grouping through the real SQL; the routes reach it through the loaders below */
export async function loadGroups(q: Query): Promise<SessionGroup[]> {
  const r = await q(
    `SELECT s.stream_id, ${ms("s.started_at")} AS started_ms, ${ms("s.ended_at")} AS ended_ms, ${ms("v.last")} AS last_snap_ms
       FROM stream.sessions s
       LEFT JOIN (SELECT stream_id, max(recorded_at) AS last FROM stream.viewer_snapshots GROUP BY stream_id) v
         ON v.stream_id = s.stream_id`,
  );
  const rows: SessionRow[] = r.rows.map((row) => ({
    streamId: String(row.stream_id),
    startedMs: int(row.started_ms, "started_ms"),
    endedMs: row.ended_ms === null ? null : int(row.ended_ms, "ended_ms"),
    lastSnapMs: row.last_snap_ms === null ? null : int(row.last_snap_ms, "last_snap_ms"),
  }));
  return groupSessions(rows);
}

/** Liveness when stream-api cannot be asked: the newest open session with a snapshot in the last
 *  10 minutes (stream-api's own heartbeat rule, lifecycle.js liveState). */
export async function liveFromDatabase(q: Query): Promise<StreamLive> {
  const r = await q(
    `SELECT s.stream_id, ${ms("s.started_at")} AS started_ms, v.twitch, v.youtube, v.kick, v.streamplace, v.total,
            (v.recorded_at > now() - interval '10 minutes') AS fresh
       FROM stream.sessions s
       LEFT JOIN LATERAL (SELECT * FROM stream.viewer_snapshots vs WHERE vs.stream_id = s.stream_id
                          ORDER BY vs.recorded_at DESC LIMIT 1) v ON true
      WHERE s.ended_at IS NULL ORDER BY s.started_at DESC LIMIT 1`,
  );
  const row = r.rows[0];
  if (!row || row.fresh !== true) return { live: false };
  const n = (v: unknown) => (v === null || v === undefined ? null : int(v, "viewers"));
  return {
    live: true, viaSnapshot: true, streamId: String(row.stream_id), startedMs: int(row.started_ms, "started_ms"),
    viewers: row.total === null ? null : { twitch: n(row.twitch), youtube: n(row.youtube), kick: n(row.kick), streamplace: n(row.streamplace), total: int(row.total, "total") },
  };
}

function mapEvents(rows: readonly Record<string, unknown>[]): SupportEvent[] {
  return rows.map((r) => ({
    id: int(r.id, "event id"),
    ms: int(r.ms, "event ms"),
    platform: String(r.platform),
    username: String(r.username),
    eventType: r.event_type === null ? null : String(r.event_type),
    cents: int(r.cents, "event cents"),
  }));
}

/** The window an off-stream payment counts toward: after the stream before this one ended (or 30
 *  days before this one started, for the first), up to this one's end (or now, while live). */
function offStreamWindow(groups: readonly SessionGroup[], g: SessionGroup, nowMs: number): [number, number] {
  const i = groups.indexOf(g);
  const prev = i >= 0 ? groups[i + 1] : undefined;
  const from = prev ? (prev.endedMs ?? prev.startedMs) : g.startedMs - 30 * 86_400_000;
  return [from, g.endedMs ?? nowMs];
}

async function loadIncome(q: Query, ids: readonly string[], window: [number, number]): Promise<StreamIncome> {
  const [events, off] = await Promise.all([
    q(
      `SELECT se.id, ${ms("se.created_at")} AS ms, se.platform, se.username, se.event_type,
              round(se.amount_usd * 100)::bigint AS cents
         FROM stream.support_events se
        WHERE se.stream_id = ANY($1::text[]) AND ${incomeSql(2)}
        ORDER BY se.created_at DESC`,
      [ids, SINKS],
    ),
    q(
      `SELECT coalesce(round(sum(se.amount_usd) * 100), 0)::bigint AS cents
         FROM stream.support_events se
        WHERE se.stream_id IS NULL AND ${incomeSql(1)}
          AND se.created_at > to_timestamp($2::double precision / 1000)
          AND se.created_at <= to_timestamp($3::double precision / 1000)`,
      [SINKS, window[0], window[1]],
    ),
  ]);
  const ev = mapEvents(events.rows);
  return {
    earnedCents: ev.reduce((a, e) => a + e.cents, 0),
    byPlatform: byPlatform(ev),
    events: ev,
    offStreamCents: int(off.rows[0]?.cents ?? 0, "off-stream cents"),
  };
}

/** The live view: the whole logical stream's curve (a reconnect mid-stream must not reset it), chat
 *  per minute for the last 30 minutes, and — only when asked — its money. */
export async function loadLiveDashboard(q: Query, streamId: string, nowMs: number, income: boolean): Promise<LiveDashboard> {
  const groups = await loadGroups(q);
  const g = groups.find((x) => x.streamIds.includes(streamId));
  const ids = g?.streamIds ?? [streamId];
  const [curve, vel, money] = await Promise.all([
    q(CURVE_SQL, [ids]),
    q(
      `SELECT ${ms("date_trunc('minute', created_at)")} AS minute_ms, count(*)::bigint AS n
         FROM stream.chat_log WHERE created_at > now() - interval '30 minutes' AND NOT is_bot GROUP BY 1`,
    ),
    income && g ? loadIncome(q, ids, offStreamWindow(groups, g, nowMs)) : Promise.resolve(null),
  ]);
  return {
    curve: mapCurve(curve.rows),
    velocity: fillMinuteBuckets(vel.rows.map((r) => ({ minuteMs: int(r.minute_ms, "minute"), count: int(r.n, "count") })), nowMs, 30),
    income: money,
  };
}

type MemberAgg = { peak: number; sumViewers: number; snapshots: number; messages: number; cents: number };

/** Per-session sums for a set of sessions: ONE grouped query per table (EXPLAIN: the chat count is
 *  a 50 ms parallel scan over 242k rows), never one per session. */
async function aggregate(q: Query, ids: readonly string[], income: boolean): Promise<Map<string, MemberAgg>> {
  const out = new Map<string, MemberAgg>();
  if (!ids.length) return out;
  const [v, c, e] = await Promise.all([
    q(`SELECT stream_id, max(total)::bigint AS peak, sum(total)::bigint AS sum_v, count(total)::bigint AS n_v
         FROM stream.viewer_snapshots WHERE stream_id = ANY($1::text[]) GROUP BY stream_id`, [ids]),
    q(`SELECT stream_id, count(*)::bigint AS msgs FROM stream.chat_log
        WHERE stream_id = ANY($1::text[]) AND NOT is_bot GROUP BY stream_id`, [ids]),
    income
      ? q(`SELECT se.stream_id, round(sum(se.amount_usd) * 100)::bigint AS cents FROM stream.support_events se
            WHERE se.stream_id = ANY($1::text[]) AND ${incomeSql(2)} GROUP BY se.stream_id`, [ids, SINKS])
      : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
  ]);
  const get = (id: string) => {
    let a = out.get(id);
    if (!a) { a = { peak: 0, sumViewers: 0, snapshots: 0, messages: 0, cents: 0 }; out.set(id, a); }
    return a;
  };
  for (const r of v.rows) {
    const a = get(String(r.stream_id));
    a.peak = r.peak === null ? 0 : int(r.peak, "peak");
    a.sumViewers = r.sum_v === null ? 0 : int(r.sum_v, "viewer sum");
    a.snapshots = int(r.n_v, "snapshots");
  }
  for (const r of c.rows) get(String(r.stream_id)).messages = int(r.msgs, "messages");
  for (const r of e.rows) get(String(r.stream_id)).cents = int(r.cents, "cents");
  return out;
}

function summarize(g: SessionGroup, agg: Map<string, MemberAgg>, income: boolean): SessionSummary {
  let peak = 0, sumV = 0, nV = 0, messages = 0, cents = 0;
  for (const id of g.streamIds) {
    const a = agg.get(id);
    if (!a) continue;
    peak = Math.max(peak, a.peak);
    sumV += a.sumViewers;
    nV += a.snapshots;
    messages += a.messages;
    cents += a.cents;
  }
  return {
    streamId: g.streamIds[0]!, segments: g.segments, startedMs: g.startedMs, endedMs: g.endedMs, durationMs: g.durationMs,
    peakViewers: peak, avgViewers: nV === 0 ? 0 : Math.round(sumV / nV), messages, earnedCents: income ? cents : null,
  };
}

/** The picker's list: the `limit` newest visible logical streams, then sorted. */
export async function loadSessions(q: Query, opts: { income: boolean; sort: SessionSort; limit: number }): Promise<SessionSummary[]> {
  const groups = visibleGroups(await loadGroups(q)).slice(0, opts.limit);
  const agg = await aggregate(q, groups.flatMap((g) => g.streamIds), opts.income);
  return sortSessions(groups.map((g) => summarize(g, agg, opts.income)), opts.sort);
}

/** One stream's review. Any member session id resolves its whole group (not only visible ones — an
 *  old blip's id still opens). null when no session has that id. */
export async function loadSessionDetail(q: Query, streamId: string, income: boolean, nowMs: number): Promise<SessionDetail | null> {
  const groups = await loadGroups(q);
  const g = groups.find((x) => x.streamIds.includes(streamId));
  if (!g) return null;
  const ids = g.streamIds;
  const [agg, curve, chat, money] = await Promise.all([
    aggregate(q, ids, income),
    q(CURVE_SQL, [ids]),
    q(`SELECT (floor(extract(epoch FROM created_at) / 300) * 300 * 1000)::bigint AS ms, count(*)::bigint AS n
         FROM stream.chat_log WHERE stream_id = ANY($1::text[]) AND NOT is_bot GROUP BY 1 ORDER BY 1`, [ids]),
    income ? loadIncome(q, ids, offStreamWindow(groups, g, nowMs)) : Promise.resolve(null),
  ]);
  return {
    summary: summarize(g, agg, income),
    curve: mapCurve(curve.rows),
    chat: chat.rows.map((r): ChatPoint => ({ ms: int(r.ms, "chat ms"), count: int(r.n, "chat count") })),
    income: money,
  };
}
