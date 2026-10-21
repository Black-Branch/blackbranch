// stream-ingest's health (contract 1): GET <ingest>/health → { ok, readers: { <platform>: { state,
// since, error } }, bot }. SERVER ONLY. The Stream tab shows each reader's state from it.
//
// The body is read whether `ok` is true or false — a 503 with a failed reader is the answer the
// tab exists to show. Unreachable (no ingest, a timeout, not JSON) = { reachable: false }.

const TIMEOUT_MS = 3_000;

/** Where stream-ingest answers: STREAM_INGEST_URL (compose sets it), else the same box. */
function ingestBase(env: Record<string, string | undefined> = process.env): string {
  return (env.STREAM_INGEST_URL ?? "http://127.0.0.1:3010").replace(/\/$/, "");
}

export type IngestHealthAnswer = { reachable: true; health: unknown } | { reachable: false };

/** Read the ingest's health once. Never throws. `fetchImpl`/`env` are injectable for tests. */
export async function readIngestHealth(
  fetchImpl: typeof fetch = fetch,
  env: Record<string, string | undefined> = process.env,
): Promise<IngestHealthAnswer> {
  try {
    const res = await fetchImpl(`${ingestBase(env)}/health`, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const health: unknown = await res.json();
    if (!health || typeof health !== "object") return { reachable: false };
    return { reachable: true, health };
  } catch {
    return { reachable: false };
  }
}
