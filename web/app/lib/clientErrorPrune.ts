// The daily client-error prune. SERVER ONLY; started once at boot (instrumentation.ts).
//
// The legal page says error reports go after CLIENT_ERROR_RETENTION_DAYS. POST /api/client-error
// prunes only on every 50th report per process, so a quiet install — few reports, or a restart
// before the 50th — never pruned at all. This runs the same statement (clientErrorRetention.ts)
// once a day, the first time a minute after boot. A failure is logged and the next day tries again;
// it never throws into the server.

import { CLIENT_ERROR_PRUNE_SQL } from "./clientErrorRetention.ts";

type Timer = { unref?: () => void };
type Deps = {
  query: (sql: string) => Promise<{ rowCount?: number | null }>;
  setTimeout: (fn: () => void, ms: number) => Timer;
  setInterval: (fn: () => void, ms: number) => Timer;
  log: (message: string) => void;
};

const FIRST_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;
const G = globalThis as typeof globalThis & { __clientErrorPrune?: boolean };

async function realQuery(sql: string): Promise<{ rowCount?: number | null }> {
  const { default: pool } = await import("../../lib/db.ts");
  return pool.query(sql);
}

const realDeps: Deps = {
  query: realQuery,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  setInterval: (fn, ms) => setInterval(fn, ms),
  log: (m) => console.warn(m),
};

/** Start the daily prune; false when this process already started it. `again` is for tests. */
export function startClientErrorPrune(deps: Deps = realDeps, again = false): boolean {
  if (G.__clientErrorPrune && !again) return false;
  G.__clientErrorPrune = true;
  const run = () => {
    void deps.query(CLIENT_ERROR_PRUNE_SQL).then(
      (r) => { if (r.rowCount) console.log(`[client-error] daily prune removed ${r.rowCount} row(s)`); },
      (e: unknown) => deps.log(`[client-error] daily prune failed: ${e instanceof Error ? e.message : String(e)}`),
    );
  };
  deps.setTimeout(() => {
    run();
    deps.setInterval(run, DAY_MS).unref?.();
  }, FIRST_MS).unref?.();
  return true;
}
