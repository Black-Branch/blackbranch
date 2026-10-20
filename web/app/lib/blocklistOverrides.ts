import pool from "@/lib/db";
import { setOverrides, type Override, type Severity } from "./blacklist";
import { setHostRules, setLinkPosture, type HostRule } from "./linkGate";

// Loading the mod-curated blocklist overrides into this runtime.
//
// WHY THIS IS A BACKGROUND REFRESHER AND NOT A CACHE READ ON THE HOT PATH.
// `classify()` runs on every native send and is deliberately synchronous and
// I/O-free (see blacklist.ts) — a property worth keeping: awaiting a cache
// lookup per message puts the database between a person and their own chat
// line, on the one path where latency is felt directly. So this module owns a
// timer, and `classify` never waits for anything.
//
// The `ttlCache` helper is deliberately NOT used here for the same reason: its
// contract is `get(): Promise<T>`, which is exactly the await this avoids.

const REFRESH_MS = 60_000;

/** How the last load went — the return contract of refreshBlocklistOverrides. */
export type LoadResult = { ok: true; count: number } | { ok: false; error: string };

// This module's state lives on `globalThis` too. The timer
// runs in instrumentation.ts's copy of this module and the mod routes refresh
// from theirs; both write ONE shared store (blacklist.ts / linkGate.ts), so
// the serialisation below only works if every copy queues on the same chain.
//
// Refreshes are SERIALISED. The mod routes await a refresh right after
// writing a rule; an in-flight timer refresh whose read STARTED before that
// write could otherwise finish last and silently revert the mod's change
// until the next tick.
type RefresherState = {
  timer: ReturnType<typeof setInterval> | null;
  everLoaded: boolean;
  refreshChain: Promise<unknown>;
};
const STATE_KEY = Symbol.for("bb.blocklistOverrides");
const slots = globalThis as unknown as Record<symbol, RefresherState | undefined>;
const state: RefresherState = (slots[STATE_KEY] ??= {
  timer: null, everLoaded: false, refreshChain: Promise.resolve(),
});

/**
 * Read the override table and install it.
 *
 * THE FAILURE SEMANTICS ARE THE POINT, so they are spelled out rather than
 * implied:
 *
 *   • zero rows  → a REAL answer ("no overrides exist"). Installs the shipped
 *     grading. Distinguishing this from a failed read is why the catch below
 *     does not call `setOverrides([])` — doing so would let one DB blip silently
 *     revert every mod re-grade to the code default.
 *
 *   • read fails, nothing ever loaded → the shipped list stays in force. That is
 *     the strictest state available and the correct one to fail into: a filter
 *     that fails OPEN is the only genuinely bad outcome here.
 *
 *   • read fails AFTER a successful load → the last known good set STAYS, not
 *     the shipped list. Both are "stricter, never open", but reverting to
 *     shipped would bring back the very case this feature exists for: a mod
 *     whitelists a reclaimed word mid-stream, the DB blips, and the word starts
 *     being destroyed again with no one touching anything. Keeping the last
 *     good set is never MORE open than it was a minute ago, which is the
 *     property that actually matters.
 */
export function refreshBlocklistOverrides(): Promise<LoadResult> {
  const run = state.refreshChain.then(() => doRefresh());
  state.refreshChain = run.catch(() => {});
  return run;
}

async function doRefresh(): Promise<LoadResult> {
  try {
    // Rules AND posture in ONE statement — one MVCC snapshot, so arming the
    // gate can never be observed a refresh apart from the allowlist it depends
    // on (that skew would hold every link the mod had just allowlisted). The
    // posture rides along as a sentinel row; its severity is unused.
    const { rows } = await pool.query<{ kind: string; term: string; severity: number }>(
      `SELECT kind, term, severity FROM site.blocklist_overrides
       UNION ALL
       SELECT 'posture', link_gate, 1 FROM site.lockdown WHERE id = 1`
    );
    const posture = rows.find((r) => r.kind === "posture");
    // Re-validated on READ, not trusted from the column. The DB CHECK caps
    // severity at 3, but a row written before that constraint (or by a manual
    // psql edit) must not be able to turn on blocking from data.
    const valid = rows.filter((r) => r.kind !== "posture" && r.severity >= 1 && r.severity <= 3);
    const overrides: Override[] = valid
      .filter((r) => r.kind === "word")
      .map((r) => ({ term: r.term, severity: r.severity as Severity }));
    const hosts: HostRule[] = valid
      .filter((r) => r.kind === "host")
      .map((r) => ({ host: r.term, severity: r.severity as Severity }));

    setOverrides(overrides);
    setHostRules(hosts);
    setLinkPosture(posture?.term ?? "off");
    state.everLoaded = true;
    return { ok: true, count: overrides.length + hosts.length };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // Deliberately no setOverrides call — see above.
    console.warn("[blocklist] override refresh failed:", error,
      state.everLoaded ? "(keeping the last known set)" : "(shipped list still in force)");
    return { ok: false, error };
  }
}

/**
 * Start the refresh loop. Called once from instrumentation.ts, alongside the
 * other process-lifetime singletons.
 *
 * `unref()` so this timer cannot hold the process open — it is a background
 * nicety, not work anything is waiting on.
 */
export function startBlocklistOverrideRefresh(): void {
  if (state.timer) return;
  void refreshBlocklistOverrides();
  const timer = setInterval(() => { void refreshBlocklistOverrides(); }, REFRESH_MS);
  timer.unref?.();
  state.timer = timer;
}
