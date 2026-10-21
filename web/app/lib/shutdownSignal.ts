// One AbortSignal that fires when this process is told to stop (SIGTERM / SIGINT). SERVER ONLY.
//
// Next's standalone server stops by closing its listener and WAITING for every request still in
// flight. A request that itself waits — the help desk's long-poll holds up to 35 s — holds the
// whole shutdown with it; once it took 90 s and systemd killed the site (report B5). Docker kills
// at its grace period (40 s, contract 5). A route that waits combines this signal with its own
// deadline, so it answers within moments of the signal and the process can exit inside the grace.
//
// Listening does not replace Next's own handler: every listener on a signal runs.

type G = typeof globalThis & { __shutdownController?: AbortController };

/** Aborted once the process has been asked to stop. The same signal for every caller. */
export function shutdownSignal(proc: Pick<NodeJS.Process, "once"> = process): AbortSignal {
  const g = globalThis as G;
  if (!g.__shutdownController) {
    const c = new AbortController();
    g.__shutdownController = c;
    const stop = (sig: string) => () => { if (!c.signal.aborted) c.abort(new Error(`process ${sig}`)); };
    proc.once("SIGTERM", stop("SIGTERM"));
    proc.once("SIGINT", stop("SIGINT"));
  }
  return g.__shutdownController.signal;
}
