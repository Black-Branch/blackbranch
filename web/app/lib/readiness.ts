// The readiness registry: ONE shared substrate any subsystem joins, not a
// matrix-local status. A subsystem registers an ordered stage list once and
// reports through the reporter it gets back (`pending → active → done |
// error`); a surface composes the subsystems it cares about and receives one
// merged, ordered view.
//
// Module-level store on purpose (the dismissStack / windowLayer house
// pattern): no provider, no context, node-testable without React. The React
// adapter is useReadiness.ts — a useSyncExternalStore over `subscribeReadiness`
// + `readReadiness`, which is why the view is CACHED per key signature and
// frozen: an unchanged store must hand back the same array or every reader
// re-renders on every read.
//
// Registrants: "matrix" (MatrixClientContext.tsx: token → sdk → crypto → sync)
// and "emotes" (emoteReadiness.ts: catalog, personal). A surface composes
// exactly the stages it needs — that is the point of a shared registry.

export type StageStatus = "pending" | "active" | "done" | "error";
export type StageDef = { readonly id: string; readonly label: string };
export type StageView = {
  readonly key: string;
  readonly id: string;
  readonly label: string;
  readonly status: StageStatus;
  readonly error: string | null;
};
export type Reporter = {
  /** Move one stage. `error` is the reason shown on a failed stage; a failed
   *  stage without one still says "Something went wrong" — a blank error row
   *  reads as a stuck stage. Advancing to the status a stage already has is
   *  not a change (Sync fires SYNCING every poll). */
  advance: (id: string, status: StageStatus, error?: string) => void;
  /** Every stage back to pending — the retry's first act. */
  reset: () => void;
};
export type ReadinessSummary = {
  phase: "idle" | "loading" | "ready" | "error";
  done: number;
  total: number;
  active: StageView | null;
  failed: StageView | null;
};

type StageState = { status: StageStatus; error: string | null };
type Entry = { stages: readonly StageDef[]; state: Map<string, StageState> };

const registry = new Map<string, Entry>();
const listeners = new Set<() => void>();
/** Merged views cached by key signature; cleared on every change. */
const views = new Map<string, readonly StageView[]>();

function notify(): void {
  views.clear();
  for (const l of listeners) l();
}

/** Register (or re-register) a subsystem's ordered stages. Same key + same
 *  stage ids = the SAME registration: statuses and labels are kept, because
 *  StrictMode and HMR re-run module code and effects and a registrant must
 *  not wipe progress it already reported. A different stage list replaces
 *  the subsystem, all pending. */
export function registerReadiness(key: string, stages: readonly StageDef[]): Reporter {
  const prev = registry.get(key);
  const sameShape = !!prev && prev.stages.length === stages.length && prev.stages.every((s, i) => s.id === stages[i]!.id);
  if (!sameShape) {
    registry.set(key, { stages, state: new Map(stages.map((s) => [s.id, { status: "pending", error: null }])) });
    notify();
  }
  return {
    advance(id, status, error) {
      const st = registry.get(key)?.state.get(id);
      if (!st) {
        // A registrant bug. Loud where a developer will see it; in production
        // a typo must not take the subsystem down with it.
        if (process.env.NODE_ENV !== "production") throw new Error(`readiness: "${key}" has no stage "${id}"`);
        return;
      }
      const nextError = status === "error" ? (error ?? "Something went wrong") : null;
      if (st.status === status && st.error === nextError) return;
      st.status = status;
      st.error = nextError;
      notify();
    },
    reset() {
      const e = registry.get(key);
      if (!e) return;
      let changed = false;
      for (const st of e.state.values()) {
        if (st.status !== "pending" || st.error !== null) { st.status = "pending"; st.error = null; changed = true; }
      }
      if (changed) notify();
    },
  };
}

/** The merged view of `keys`, in the order given, each subsystem's stages in
 *  registration order. Unknown keys contribute nothing. Cached and frozen. */
export function readReadiness(keys: readonly string[]): readonly StageView[] {
  // NUL joins the signature, not a space: a key is an arbitrary string, and a
  // key containing a space would collide with a two-key signature (["a b"] and
  // ["a", "b"] both sign as "a b") — one composition would then be served the
  // other's cached view.
  const sig = keys.join("\0");
  const hit = views.get(sig);
  if (hit) return hit;
  const out: StageView[] = [];
  for (const key of keys) {
    const e = registry.get(key);
    if (!e) continue;
    for (const s of e.stages) {
      const st = e.state.get(s.id)!;
      out.push({ key, id: s.id, label: s.label, status: st.status, error: st.error });
    }
  }
  const frozen = Object.freeze(out);
  views.set(sig, frozen);
  return frozen;
}

export function subscribeReadiness(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** One reading of a view for a surface: which phase it is in, how far along,
 *  the running stage and the failed one. */
export function summarizeReadiness(view: readonly StageView[]): ReadinessSummary {
  const total = view.length;
  const done = view.filter((s) => s.status === "done").length;
  const failed = view.find((s) => s.status === "error") ?? null;
  const active = view.find((s) => s.status === "active") ?? null;
  const phase = total === 0 ? "idle" : failed ? "error" : done === total ? "ready" : "loading";
  return { phase, done, total, active, failed };
}

/** @test-only wipes every registrant, listener and cached view between node tests
 *
 *  `registry.clear()` un-registers every subsystem, and a Reporter captured at
 *  MODULE level (emoteReadiness.ts, MatrixClientContext.tsx) keeps pointing at a
 *  key that no longer exists — so its next `advance` throws outside production
 *  (the registrant-bug guard above). In a test file that both resets and drives
 *  `useEmotes` / the Matrix context, that throw lands inside a fetch chain and
 *  surfaces as an unhandled rejection, not as a readable failure. Call this only
 *  from files that register their OWN subsystems. */
export function _resetReadinessForTests(): void {
  registry.clear();
  listeners.clear();
  views.clear();
}
