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
  // A ban's purge writes into the ban's batch: on a platform with an action row, that row answers.
  const acted = new Set(rows.filter((r) => r.action !== "purge").map((r) => r.platform.toLowerCase()));
  const newest = new Map<string, ActionRow>();
  for (const r of rows) {
    const p = r.platform.toLowerCase();
    if (r.action === "purge" && acted.has(p)) continue;
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

/** A purge row's answer, in a few words; null when there was nothing of theirs there. */
function removedOn(r: ActionRow): string | null {
  const name = platformLabel(r.platform);
  const d = r.detail ?? "";
  if (d === "no_messages" || d === "unsupported" || /_unset$/.test(d)) return null;
  // Reader-captured YouTube lines carry ids the Data API cannot delete (liveChatMessages.delete
  // takes only its own "LCC." ids); a liveChatBans ban stops new messages and removes none.
  if (d.startsWith("no_api_message_ids")) return `${name} can't remove their earlier messages from here`;
  const m = /^deleted (\d+)\/(\d+)/.exec(d);
  if (m) return m[1] === m[2] ? `${name} ${m[1]} removed` : `${name} ${m[1]} of ${m[2]} removed`;
  return r.ok ? null : `${name} not removed (${reasonOf(r)})`;
}

/**
 * What a ban's purge removed, one part per place: "Messages: 5 removed here · Twitch clears them
 * with the ban · Kick 2 removed · YouTube can't remove their earlier messages from here". Twitch
 * has no purge row with a ban (modPurge.ts runPurge): a Twitch ban or timeout clears the person's
 * chat there, so it is named when the ban landed. null when the ban purged nothing (switch off).
 * @test-only the status line below (fill) calls it; the test pins each place's words.
 */
export function removalLine(
  rows: ActionRow[], purged: number | null | undefined, opts: { clickedSkipped?: boolean; purgeFailed?: boolean } = {},
): string | null {
  if (opts.purgeFailed) return "Messages: couldn't be removed. Purge them by hand.";
  if (purged == null) return null;
  const parts = [purged > 0 ? `${purged} removed here` : "none to remove here"];
  if (opts.clickedSkipped) parts.push("the clicked message could not be removed");
  const newest = new Map<string, ActionRow>();
  for (const r of rows) {
    const key = `${r.action === "purge" ? "purge" : "act"}:${r.platform.toLowerCase()}`;
    const seen = newest.get(key);
    if (!seen || r.id > seen.id) newest.set(key, r);
  }
  const twitch = newest.get("act:twitch");
  if (twitch?.ok && !newest.has("purge:twitch")) parts.push(`Twitch clears them with the ${twitch.action === "timeout" ? "timeout" : "ban"}`);
  for (const p of ORDER) {
    const r = newest.get(`purge:${p}`);
    const said = r ? removedOn(r) : null;
    if (said) parts.push(said);
  }
  return `Messages: ${parts.join(" · ")}`;
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

/** What the ban route answers about the fan-out it started; `purged` = the site lines its purge
 *  removed (null or absent: no purge). */
export type FanOut = { batchId?: string; platforms?: string[]; purged?: number | null; clickedSkipped?: boolean; purgeFailed?: boolean };

/** The platforms a ban's purge writes a row for (Twitch is left to the ban — modPurge.ts runPurge). */
const PURGE_ROW_PLATFORMS = ["kick", "youtube"];

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
 * Poll the batch until every platform the route named has answered (and, with a purge, Kick's and
 * YouTube's removal), or `tries` run out (the platform calls are network calls of their own).
 * Resolves with the outcomes so far.
 * @test-only the status line polls through the same loop (awaitRows); the test pins it with a stubbed fetch.
 */
export async function awaitPropagation(fan: FanOut, opts: PollOpts = {}): Promise<Outcome[]> {
  return outcomesOf(await awaitRows(fan, opts));
}

type PollOpts = { tries?: number; everyMs?: number; sleep?: (ms: number) => Promise<void> };

async function awaitRows(fan: FanOut, opts: PollOpts = {}): Promise<ActionRow[]> {
  if (!fan.batchId) return [];
  const tries = opts.tries ?? 10;
  const every = opts.everyMs ?? 1000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => { unref(setTimeout(r, ms)); }));
  const want = new Set((fan.platforms ?? []).map((p) => p.toLowerCase()));
  const wantPurge = fan.purged == null ? [] : PURGE_ROW_PLATFORMS;
  let rows: ActionRow[] = [];
  for (let i = 0; i < tries; i++) {
    if (i > 0) await sleep(every);
    rows = (await batchRows(fan.batchId)) ?? rows;
    const have = new Set(rows.filter((r) => r.action !== "purge").map((r) => r.platform.toLowerCase()));
    const purgedOn = new Set(rows.filter((r) => r.action === "purge").map((r) => r.platform.toLowerCase()));
    if (want.size > 0 && [...want].every((p) => have.has(p)) && wantPurge.every((p) => purgedOn.has(p))) break;
  }
  return rows;
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

export type StatusLine = {
  id: number; label: string; outcomes: Outcome[] | null; fan: FanOut;
  /** What the ban's purge removed (removalLine); null without a purge or until read. */
  removal: string | null;
};

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
  const rows = await awaitRows(fan, { tries });
  const outcomes = outcomesOf(rows);
  const removal = removalLine(rows, fan.purged, { clickedSkipped: fan.clickedSkipped === true, purgeFailed: fan.purgeFailed === true });
  publish(lines.map((l) => (l.id === id ? { ...l, outcomes, removal } : l)));
  keepFor(id);
}

/** Show "<label> · Twitch ✓ · Kick ✗ …" for an action the route just started. */
export function trackPropagation(label: string, fan: FanOut): void {
  if (!fan.batchId) return;
  const id = nextId++;
  publish([...lines, { id, label, outcomes: null, fan, removal: null }]);
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
