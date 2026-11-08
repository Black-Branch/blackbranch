// The community's run log (site.community_runs) as the doctor's facts: the newest run and the
// newest finished one, as counts, times and a clock time in the site's own zone. The verdicts are
// config/doctor.mjs's (community.drift, community.lastRun). Never a run's error text or its
// entries: those can name rooms and the server, and the doctor's facts hold fixed words only.

type Queryable = { query: <R extends object>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> };

/** One run as the doctor reads it. `putBack`: what the run put back the way the Community page has
 *  it; `left`: what it found changed and left as it is (a check, or put-back switched off); `warns`:
 *  its notes counted by code (fixed words: cannot_read, no_hub_access, bridge_accounts_unknown, …). */
export type RunFact = {
  mode: string; startedAt: string; finishedAt: string | null; ok: boolean | null; putBack: number; left: number;
  warns: Record<string, number>; clock: string;
};
export type RunFacts = { latest: RunFact | null; lastFinished: RunFact | null };

type RunRow = { mode: string; started_at: Date | string; finished_at: Date | string | null; ok: boolean | null; put_back: number; left_as_is: number; warns: unknown };

// Counted in the database, so a run that touched a whole community is two numbers here. An entry
// put back carries `putBack: true` (install/matrix/reconcile-core.mjs); a note is op "warn".
const RUN_COLUMNS = `
  SELECT mode, started_at, finished_at, ok,
         (SELECT count(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(applied) = 'array' THEN applied ELSE '[]'::jsonb END) e
           WHERE e->>'putBack' = 'true')::int AS put_back,
         (SELECT count(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(drift) = 'array' THEN drift ELSE '[]'::jsonb END) e
           WHERE COALESCE(e->>'op', '') <> 'warn')::int AS left_as_is,
         (SELECT COALESCE(jsonb_object_agg(code, n), '{}'::jsonb) FROM (
            SELECT e->>'code' AS code, count(*)::int AS n
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(drift) = 'array' THEN drift ELSE '[]'::jsonb END) e
             WHERE e->>'op' = 'warn' AND e->>'code' ~ '^[a-z_]{1,40}$'
             GROUP BY 1) w) AS warns
    FROM site.community_runs`;
const LATEST_SQL = `${RUN_COLUMNS} ORDER BY id DESC LIMIT 1`;
const LAST_FINISHED_SQL = `${RUN_COLUMNS} WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1`;

const iso = (v: Date | string) => new Date(v).toISOString();
const CODE = /^[a-z_]{1,40}$/;
/** The warn counts as stored: fixed-word codes to whole counts, anything else dropped. */
function warnCounts(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, n] of Object.entries(v)) if (CODE.test(k) && Number.isInteger(n) && (n as number) > 0) out[k] = n as number;
  return out;
}

/** "14:02" in the site's time zone; "14:02 UTC" when it has none (or one this runtime does not know).
 *  @test-only exported so its zones are tested directly; communityRunFacts is its caller here */
export function clockOf(at: string, timeZone: string | null): string {
  const d = new Date(at);
  const fmt = (zone: string) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: zone }).format(d);
  if (timeZone) {
    try { return fmt(timeZone); } catch { /* an unknown zone: UTC below, said */ }
  }
  return `${fmt("UTC")} UTC`;
}

function fact(r: RunRow | undefined, timeZone: string | null): RunFact | null {
  if (!r) return null;
  const startedAt = iso(r.started_at);
  const finishedAt = r.finished_at === null ? null : iso(r.finished_at);
  return { mode: r.mode, startedAt, finishedAt, ok: r.ok, putBack: Number(r.put_back) || 0, left: Number(r.left_as_is) || 0,
    warns: warnCounts(r.warns), clock: clockOf(finishedAt ?? startedAt, timeZone) };
}

/** The two runs the doctor judges; null when the log could not be read. */
export async function communityRunFacts(db: Queryable, o: { timeZone: string | null }): Promise<RunFacts | null> {
  try {
    const latest = (await db.query<RunRow>(LATEST_SQL)).rows[0];
    const finished = (await db.query<RunRow>(LAST_FINISHED_SQL)).rows[0];
    return { latest: fact(latest, o.timeZone), lastFinished: fact(finished, o.timeZone) };
  } catch {
    return null;
  }
}
