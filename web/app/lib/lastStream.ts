// The most recent finished stream, for Home's status card ("last stream ended
// 3h ago · ran 8h 55m"). One query; the caller decides how to cache it.

export type LastStream = { startedAt: string; endedAt: string };

type Row = { started_at: Date | string; ended_at: Date | string };

export async function getLastStream(pool: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}): Promise<LastStream | null> {
  const { rows } = await pool.query(
    `SELECT started_at, ended_at
       FROM stream.sessions
      WHERE ended_at IS NOT NULL
      ORDER BY ended_at DESC
      LIMIT 1`,
  );
  const r = rows[0] as Row | undefined;
  if (!r) return null;
  return { startedAt: new Date(r.started_at).toISOString(), endedAt: new Date(r.ended_at).toISOString() };
}
