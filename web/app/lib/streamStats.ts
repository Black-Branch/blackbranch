// The Stream tab's model: the shapes its routes answer with and the pure derivations over them.
// Times are epoch MILLISECONDS throughout — DST-proof, and every value from SQL crosses int() so
// pg's string bigints never ride into arithmetic. Money is integer cents of take-home:
// stream.support_events.amount_usd, written once by stream-api's economics.takeHome.

/** A player live source's name (playerSource.ts LiveSource), restated so this file has no imports. */
type LiveSourceKey = "native" | "streamplace" | "youtube" | "twitch";

/** The four platforms viewers are counted on, in stack order (bottom → top). */
export const VIEWER_PLATFORMS = ["twitch", "youtube", "kick", "streamplace"] as const;
export type ViewerPlatform = (typeof VIEWER_PLATFORMS)[number];

export type CurvePoint = { ms: number; total: number } & Record<ViewerPlatform, number>;
export type VelocityBucket = { ms: number; total: number };
export type ChatPoint = { ms: number; count: number };
export type SupportEvent = { id: number; ms: number; platform: string; username: string; eventType: string | null; cents: number };
export type Viewers = Record<ViewerPlatform, number | null> & { total: number };

export type StreamLive =
  | { live: false }
  | { live: true; streamId: string; startedMs: number; viewers: Viewers | null; viaSnapshot: boolean };

/** Money for one stream — present only when the caller asked for income. */
export type StreamIncome = {
  earnedCents: number;
  byPlatform: Record<string, number>;
  events: SupportEvent[];
  /** Money with no stream attached since the stream before this one ended (renewals, off-stream tips). */
  offStreamCents: number;
};

export type LiveDashboard = { curve: CurvePoint[]; velocity: VelocityBucket[]; income: StreamIncome | null };

export type SessionSort = "date" | "earned" | "viewers" | "duration";
const SESSION_SORTS: readonly SessionSort[] = ["date", "viewers", "duration", "earned"];

export type SessionSummary = {
  /** The group's first segment: what the picker and the review route key on. */
  streamId: string;
  segments: number;
  startedMs: number;
  endedMs: number | null;
  durationMs: number | null;
  peakViewers: number;
  avgViewers: number;
  messages: number;
  /** null when income was not asked for. */
  earnedCents: number | null;
};

export type SessionDetail = { summary: SessionSummary; curve: CurvePoint[]; chat: ChatPoint[]; income: StreamIncome | null };

/** One row of the Platforms section (streamPlatformsServer.ts builds them). */
export type PlatformKey = "native" | "streamplace" | "youtube" | "twitch" | "kick";

export type PlatformRow = {
  key: PlatformKey;
  label: string;
  setUp: boolean;
  /** The player source this platform is, and whether the watch page offers it; null = no embed. */
  embed: { source: LiveSourceKey; on: boolean } | null;
  title: string | null;
  category: string | null;
  /** Why there is no title, or where it came from — one short line. */
  titleNote: string;
  /** The platform's own page for changing the title (D6). */
  manageUrl: string | null;
  /** The Admin Panel place that sets it up. */
  setupHref: string;
};

export function int(v: unknown, what: string): number {
  const n = typeof v === "number" ? v : Number(String(v));
  if (!Number.isSafeInteger(n)) throw new Error(`stream stats: non-integer ${what}: ${String(v)}`);
  return n;
}

/** Zero-filled per-minute buckets ending at endMs's minute, oldest first. */
export function fillMinuteBuckets(rows: readonly { minuteMs: number; count: number }[], endMs: number, minutes: number): VelocityBucket[] {
  const endMinute = Math.floor(endMs / 60_000) * 60_000;
  const byMinute = new Map<number, number>();
  for (const r of rows) byMinute.set(r.minuteMs, (byMinute.get(r.minuteMs) ?? 0) + r.count);
  const out: VelocityBucket[] = [];
  for (let i = minutes - 1; i >= 0; i--) {
    const ms = endMinute - i * 60_000;
    out.push({ ms, total: byMinute.get(ms) ?? 0 });
  }
  return out;
}

export function durationMinutes(startedMs: number, endedMs: number): number {
  return Math.max(0, Math.round((endedMs - startedMs) / 60_000));
}

export function fmtDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h === 0 ? `${m}m` : `${h}h ${String(m).padStart(2, "0")}m`;
}

/** Whole dollars for a headline, cents for a row. */
export function fmtMoney(cents: number, whole = false): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", ...(whole ? { maximumFractionDigits: 0 } : {}) }).format(cents / 100);
}

export function isSessionSort(v: unknown): v is SessionSort {
  return typeof v === "string" && (SESSION_SORTS as readonly string[]).includes(v);
}

const SORT_KEY: Record<SessionSort, (s: SessionSummary) => number> = {
  date: (s) => s.startedMs,
  earned: (s) => s.earnedCents ?? 0,
  viewers: (s) => s.peakViewers,
  // an open (live) stream has no length yet — it sorts on top
  duration: (s) => s.durationMs ?? Number.MAX_SAFE_INTEGER,
};

/** Biggest first; ties keep date order (newest first). Earned without income is date order. */
export function sortSessions(list: readonly SessionSummary[], sort: SessionSort): SessionSummary[] {
  const key = SORT_KEY[sort === "earned" && list.some((s) => s.earnedCents === null) ? "date" : sort];
  return [...list].sort((a, b) => key(b) - key(a) || b.startedMs - a.startedMs);
}

/** Each platform's share of the viewers now, in stack order, platforms with none left out. */
export function composition(v: Viewers | null): { platform: ViewerPlatform; viewers: number; share: number }[] {
  if (!v || v.total <= 0) return [];
  return VIEWER_PLATFORMS.flatMap((p) => {
    const n = v[p] ?? 0;
    return n > 0 ? [{ platform: p, viewers: n, share: n / v.total }] : [];
  });
}

/** The running total of what a stream earned, a step per payment, from its start. */
export function earnedCurve(events: readonly SupportEvent[], startedMs: number, endMs: number): { ms: number; cents: number }[] {
  const sorted = [...events].sort((a, b) => a.ms - b.ms);
  const out = [{ ms: startedMs, cents: 0 }];
  let run = 0;
  for (const e of sorted) {
    run += e.cents;
    out.push({ ms: Math.max(startedMs, e.ms), cents: run });
  }
  out.push({ ms: Math.max(endMs, out[out.length - 1]!.ms), cents: run });
  return out;
}

/** Cents per hour over the stream's length so far (0 under a minute). */
export function hourlyRate(cents: number, startedMs: number, endMs: number): number {
  const hours = (endMs - startedMs) / 3_600_000;
  return hours < 1 / 60 ? 0 : Math.round(cents / hours);
}

/** Per-platform totals of a list of support events. */
export function byPlatform(events: readonly SupportEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) out[e.platform] = (out[e.platform] ?? 0) + e.cents;
  return out;
}

/** One of the doctor's rows, as the health strip reads it (GET /api/admin/doctor). */
export type DoctorRow = { id: string; title: string; status: "ok" | "warn" | "fail" | "grey" };

/** The counts per verdict and the first failing (else warning) check. Pure. */
export function healthSummary(rows: readonly DoctorRow[]): { counts: Record<DoctorRow["status"], number>; worst: DoctorRow | null } {
  const counts = { ok: 0, warn: 0, fail: 0, grey: 0 };
  for (const r of rows) counts[r.status] += 1;
  return { counts, worst: rows.find((r) => r.status === "fail") ?? rows.find((r) => r.status === "warn") ?? null };
}

