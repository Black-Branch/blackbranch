// When the YouTube reader's "api cadence" heartbeat is printed.
//
// At one line per 30 s it would be about a quarter of the whole ingest journal, so shared logs
// would be mostly cadence. The poller is still JUDGED every 30 s:
// a window with no successful poll, or with discarded items, is printed at once, loud. A healthy
// window is only summed, and the sums are printed every 10 minutes — the first healthy window of a
// chat page right away, so a fresh page shows it works.
//
// This decides; platforms/youtube.js prints (its console calls are what stream-api's
// log-names.test.js scans for names, so the lines stay written there).

/**
 * @param {{ checkMs?: number, healthyEveryMs?: number, now?: number }} [opts]
 */
export function createCadenceReporter({ checkMs = 30_000, healthyEveryMs = 600_000, now = Date.now() } = {}) {
  let lastCheck = now;
  let lastHealthy = null; // when a healthy line was last printed; null = never on this page
  let aggSince = now;
  let agg = {};
  return {
    /**
     * Call on every poll. Returns null while the 30 s window is open; at its end, what to print —
     * the caller then resets its window counters.
     *   stalled  this window's counters when it had no successful poll (print now, loud)
     *   healthy  the sums since the last healthy line, when one is due (print now)
     *   dropped  true when this window discarded recognised items (print now, loud)
     * @param {number} t now
     * @param {Record<string, number>} cnt this window's counters (`ok`, `dropText`, `dropEvent`, …)
     * @returns {{ windowS: number, stalled: Record<string, number>|null, healthy: { counts: Record<string, number>, windowS: number }|null, dropped: boolean } | null}
     */
    check(t, cnt) {
      if (t - lastCheck <= checkMs) return null;
      const windowS = Math.round((t - lastCheck) / 1000);
      lastCheck = t;
      for (const [k, v] of Object.entries(cnt)) agg[k] = (agg[k] || 0) + v;
      let stalled = null;
      let healthy = null;
      if (!(cnt.ok > 0)) {
        stalled = { ...cnt };
      } else if (lastHealthy === null || t - lastHealthy >= healthyEveryMs) {
        healthy = { counts: agg, windowS: Math.round((t - aggSince) / 1000) };
        lastHealthy = t;
        agg = {};
        aggSince = t;
      }
      return { windowS, stalled, healthy, dropped: Boolean(cnt.dropText || cnt.dropEvent) };
    },
  };
}
