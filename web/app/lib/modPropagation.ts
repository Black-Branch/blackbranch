// Which platforms a ban, timeout or unban reached. The site action is stored first and the
// platform calls run after it in the background, each writing one row to
// site.platform_mod_actions under the action's batch id; this reads those rows back into ONE line
// — "Twitch ✓ · Kick ✗ (missing scope)" — for the mod who acted, the ✗ on Mod history and Bans
// rows, and a Retry that re-runs the failed ones (a retry joins the same batch; the newest row per
// platform is the answer).
//
// Relative imports only: node --test loads this with no "@/" alias.
import { platformLabel } from "./platforms.ts";

export type ActionRow = {
  id: number; platform: string; action: string; ok: boolean; status: number | null; detail: string | null;
};

export type Outcome = {
  platform: string;
  state: "ok" | "failed" | "skipped";
  /** Why, in a few words; null when it worked. */
  reason: string | null;
  /** The row a Retry re-runs. */
  rowId: number;
  retryable: boolean;
};

const ORDER = ["twitch", "kick", "youtube"];
const RETRYABLE = new Set(["ban", "timeout", "unban"]);

function reasonOf(r: ActionRow): string {
  if (r.detail === "no_capable_token") return "missing scope";
  if (r.detail === "not_live") return "not live";
  if (r.detail === "no_ban_ref") return "no earlier ban there";
  if (r.status === 401 || r.status === 403) return `refused, ${r.status}`;
  if (r.status != null) return `error ${r.status}`;
  return r.detail ? r.detail.slice(0, 40) : "failed";
}

/** The newest row per platform, as an outcome. A platform with no moderation API, or one this
 *  install has not set up, is left out: there was nothing to reach.
 *  @test-only used in this file (failedPlatforms, the status line); the test pins each case. */
export function outcomesOf(rows: ActionRow[]): Outcome[] {
  const newest = new Map<string, ActionRow>();
  for (const r of rows) {
    const p = r.platform.toLowerCase();
    const seen = newest.get(p);
    if (!seen || r.id > seen.id) newest.set(p, r);
  }
  const out: Outcome[] = [];
  for (const [platform, r] of newest) {
    if (r.detail === "unsupported" || /_unset$/.test(r.detail ?? "")) continue;
    if (r.ok) { out.push({ platform, state: "ok", reason: null, rowId: r.id, retryable: false }); continue; }
    if (/^target_no_/.test(r.detail ?? "")) {
      out.push({ platform, state: "skipped", reason: `not on ${platformLabel(platform)}`, rowId: r.id, retryable: false });
      continue;
    }
    out.push({ platform, state: "failed", reason: reasonOf(r), rowId: r.id, retryable: RETRYABLE.has(r.action) });
  }
  const rank = (p: string) => (ORDER.indexOf(p) < 0 ? ORDER.length : ORDER.indexOf(p));
  return out.sort((a, b) => rank(a.platform) - rank(b.platform) || a.platform.localeCompare(b.platform));
}

/** "Twitch ✓ · Kick ✗ (missing scope) · YouTube – (not on YouTube)". Empty when nothing was reached. */
export function propagationLine(outcomes: Outcome[]): string {
  return outcomes.map((o) => {
    const name = platformLabel(o.platform);
    if (o.state === "ok") return `${name} ✓`;
    if (o.state === "skipped") return `${name} – (${o.reason})`;
    return `${name} ✗ (${o.reason})`;
  }).join(" · ");
}

/** The platforms an action FAILED on (✗) — what a history or Bans row marks. */
export function failedPlatforms(rows: ActionRow[]): string[] {
  return outcomesOf(rows).filter((o) => o.state === "failed").map((o) => o.platform);
}

type RowQuery = (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

/** For each batch id, the platforms its action failed on. Server side (the log and bans routes). */
export async function failedByBatch(q: RowQuery, batchIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const ids = [...new Set(batchIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const { rows } = await q(
    `SELECT id, batch_id::text AS batch_id, platform, action, ok, status, detail
       FROM site.platform_mod_actions WHERE batch_id = ANY($1::uuid[])`,
    [ids],
  );
  const by = new Map<string, ActionRow[]>();
  for (const r of rows) {
    const key = String(r.batch_id);
    const list = by.get(key) ?? [];
    list.push({ id: Number(r.id), platform: String(r.platform), action: String(r.action), ok: !!r.ok,
      status: r.status == null ? null : Number(r.status), detail: r.detail == null ? null : String(r.detail) });
    by.set(key, list);
  }
  for (const [k, list] of by) {
    const failed = failedPlatforms(list);
    if (failed.length) out.set(k, failed);
  }
  return out;
}

// ─── Reading an action's outcome back, in the browser ────────────────────────

/** What the ban route answers about the fan-out it started. */
export type FanOut = { batchId?: string; platforms?: string[] };

async function batchRows(batchId: string): Promise<ActionRow[] | null> {
  try {
    const res = await fetch(`/api/mod/platform-actions?batchId=${encodeURIComponent(batchId)}&limit=50`, { cache: "no-store" });
    if (!res.ok) return null;
    const d = (await res.json()) as { actions?: ActionRow[] };
    return Array.isArray(d.actions) ? d.actions : [];
  } catch {
    return null;
  }
}

/**
 * Poll the batch until every platform the route named has answered, or `tries` run out (the
 * platform calls are network calls of their own). Resolves with the outcomes so far.
 * @test-only the status line below drives it; the test pins its polling with a stubbed fetch.
 */
export async function awaitPropagation(
  fan: FanOut, opts: { tries?: number; everyMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Outcome[]> {
  if (!fan.batchId) return [];
  const tries = opts.tries ?? 10;
  const every = opts.everyMs ?? 1000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => { unref(setTimeout(r, ms)); }));
  const want = new Set((fan.platforms ?? []).map((p) => p.toLowerCase()));
  let rows: ActionRow[] = [];
  for (let i = 0; i < tries; i++) {
    if (i > 0) await sleep(every);
    rows = (await batchRows(fan.batchId)) ?? rows;
    const have = new Set(rows.map((r) => r.platform.toLowerCase()));
    if (want.size > 0 && [...want].every((p) => have.has(p))) break;
  }
  return outcomesOf(rows);
}

/** Re-run every retryable failure; resolves once the retry route has answered for each.
 *  @test-only retryLine below calls it; the test pins which rows it re-runs. */
export async function retryFailed(outcomes: Outcome[]): Promise<void> {
  for (const o of outcomes) {
    if (o.state !== "failed" || !o.retryable) continue;
    await fetch("/api/mod/platform-actions/retry", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: o.rowId }),
    }).catch(() => null);
  }
}

// ─── One status line per action, for the toast ───────────────────────────────

export type StatusLine = { id: number; label: string; outcomes: Outcome[] | null; fan: FanOut };

const SHOW_MS = 15_000;

/** A timer that never holds a process open (node --test); a no-op in the browser. */
function unref<T>(t: T): T {
  (t as { unref?: () => void }).unref?.();
  return t;
}
let lines: readonly StatusLine[] = [];
const subs = new Set<() => void>();
let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function publish(next: readonly StatusLine[]) {
  lines = next;
  for (const fn of Array.from(subs)) fn();
}

function keepFor(id: number) {
  const old = timers.get(id);
  if (old) clearTimeout(old);
  timers.set(id, unref(setTimeout(() => { timers.delete(id); publish(lines.filter((l) => l.id !== id)); }, SHOW_MS)));
}

async function fill(id: number, fan: FanOut, tries?: number) {
  const outcomes = await awaitPropagation(fan, { tries });
  publish(lines.map((l) => (l.id === id ? { ...l, outcomes } : l)));
  keepFor(id);
}

/** Show "<label> · Twitch ✓ · Kick ✗ …" for an action the route just started. */
export function trackPropagation(label: string, fan: FanOut): void {
  if (!fan.batchId) return;
  const id = nextId++;
  publish([...lines, { id, label, outcomes: null, fan }]);
  keepFor(id);
  void fill(id, fan);
}

/** The status line's Retry: re-run its failures, then read the batch again. */
export async function retryLine(id: number): Promise<void> {
  const l = lines.find((x) => x.id === id);
  if (!l?.outcomes) return;
  publish(lines.map((x) => (x.id === id ? { ...x, outcomes: null } : x)));
  // The retry route waits for each platform's answer, so one read sees the new rows.
  await retryFailed(l.outcomes);
  await fill(id, l.fan, 1);
}

export function statusLines(): readonly StatusLine[] {
  return lines;
}

export function subscribeStatusLines(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}
