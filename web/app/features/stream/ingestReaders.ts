// The Stream tab's chat readers, read from the ingest service's health answer (stream-ingest
// GET /health, relayed by GET /api/admin/stream/readers): per platform, running / starting / failed /
// off, since when, and the one-line reason a reader failed; and, beside it, the platform's live
// detection (the health answer's `liveness`): Live / Offline / Scheduled / Can't tell and why. Pure:
// the section renders what this returns, and a shape it does not know is "unknown", never a guess.
import { PLATFORM_LIVENESS } from "../../lib/platformLiveness.generated.mjs";

export type ReaderState = "running" | "starting" | "failed" | "off";
type LiveState = "live" | "offline" | "unknown" | "upcoming";
/** One platform's live detection as the row shows it: `words` whole; `head` is the chip beside the
 *  platform's name (Live / Offline / Scheduled for … / Can't tell) and `why` the reason it can't
 *  tell, drawn on the line under it so a long reason never pushes the row's switch off its line. */
export type LiveChip = { state: LiveState; words: string; head: string; why: string | null; stale: boolean; note: string | null };
/** `state` is null for a platform with live detection but no chat reader row. */
export type ReaderRow = { platform: string; state: ReaderState | null; since: string | null; error: string | null; live: LiveChip | null };

/** Shown under YouTube's row: when an ended YouTube broadcast reads as ended. */
export const YOUTUBE_LIVE_NOTE = "YouTube ends the broadcast about a minute after you stop only when auto-stop is on in YouTube Studio; otherwise it stays live until you end it there.";

const LIVE_STATES: readonly LiveState[] = ["live", "offline", "unknown", "upcoming"];
const STALE_MIN = Math.round(PLATFORM_LIVENESS.STALE_ANSWER_MS / 60_000);
const localTime = (iso: string) => new Date(iso).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });

/** The vocabulary's words for an evidence code; null for a code it does not know (own keys only). */
function evidenceWords(code: unknown): string | null {
  if (typeof code !== "string" || !Object.prototype.hasOwnProperty.call(PLATFORM_LIVENESS.EVIDENCE, code)) return null;
  return PLATFORM_LIVENESS.EVIDENCE[code as keyof typeof PLATFORM_LIVENESS.EVIDENCE];
}

/**
 * One platform's `liveness` entry → its chip. `fmt` formats a scheduled start (the viewer's local time).
 * @test-only exported so ingestReaders.test.ts pins the words per state and code with a fixed time
 * format; readersView below is its runtime caller.
 */
export function livenessChip(entry: unknown, fmt: (iso: string) => string = localTime): LiveChip {
  const e = (entry && typeof entry === "object" ? entry : {}) as { state?: unknown; evidence?: unknown; scheduledStart?: unknown; stale?: unknown };
  const state: LiveState = LIVE_STATES.includes(e.state as LiveState) ? (e.state as LiveState) : "unknown";
  const start = typeof e.scheduledStart === "string" && !Number.isNaN(Date.parse(e.scheduledStart)) ? e.scheduledStart : null;
  const why = evidenceWords(e.evidence);
  const head = state === "live" ? "Live"
    : state === "offline" ? "Offline"
    : state === "upcoming" ? (start ? `Scheduled for ${fmt(start)}` : "Scheduled")
    : "Can't tell";
  const reason = state === "unknown" ? why : null;
  const words = reason ? `${head} — ${reason}` : head;
  const stale = e.stale === true;
  return { state, words, head, why: reason, stale, note: stale ? `No answer for over ${STALE_MIN} min — an open stream stays open while it can't tell.` : null };
}

/** What the relay answers: the ingest's own body, or that it could not be reached. */
export type ReadersReply = { reachable: true; health: unknown } | { reachable: false };

export type ReadersView =
  | { kind: "unreachable" }
  | { kind: "unknown" }
  | { kind: "ok"; ok: boolean; bot: "running" | "off" | null; rows: ReaderRow[] };

const STATES: readonly ReaderState[] = ["running", "starting", "failed", "off"];
/** Platforms in the order the rest of the tab lists them; any other comes after, by name. */
const ORDER = ["twitch", "youtube", "kick", "streamplace"];
const ERROR_MAX = 240;

/** A reader's error as one short line: the first line, trimmed and capped. */
function oneLine(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const line = v.split(/\r?\n/)[0]!.trim();
  if (!line) return null;
  return line.length > ERROR_MAX ? `${line.slice(0, ERROR_MAX - 1)}…` : line;
}

export function readersView(reply: ReadersReply | null): ReadersView {
  if (!reply) return { kind: "unknown" };
  if (!reply.reachable) return { kind: "unreachable" };
  const h = reply.health as { ok?: unknown; readers?: unknown; bot?: unknown } | null;
  if (!h || typeof h !== "object" || !h.readers || typeof h.readers !== "object" || Array.isArray(h.readers)) return { kind: "unknown" };
  // An ingest older than live detection sends no `liveness`: every row then has no chip.
  const lv = (h as { liveness?: unknown }).liveness;
  const liveness: Record<string, unknown> = lv && typeof lv === "object" && !Array.isArray(lv) ? (lv as Record<string, unknown>) : {};
  const chipOf = (platform: string): LiveChip | null => {
    const e = Object.prototype.hasOwnProperty.call(liveness, platform) ? liveness[platform] : null;
    return e && typeof e === "object" ? livenessChip(e) : null;
  };
  const rows: ReaderRow[] = [];
  for (const [platform, r] of Object.entries(h.readers as Record<string, unknown>)) {
    const st = (r as { state?: unknown } | null)?.state;
    if (!STATES.includes(st as ReaderState)) continue;
    const since = (r as { since?: unknown }).since;
    rows.push({
      platform,
      state: st as ReaderState,
      since: typeof since === "string" && !Number.isNaN(Date.parse(since)) ? since : null,
      // Only a failed reader carries its reason on screen.
      error: st === "failed" ? oneLine((r as { error?: unknown }).error) : null,
      live: chipOf(platform),
    });
  }
  // A platform with live detection but no reader row still shows its chip.
  for (const platform of Object.keys(liveness)) {
    if (rows.some((r) => r.platform === platform)) continue;
    const live = chipOf(platform);
    if (live) rows.push({ platform, state: null, since: null, error: null, live });
  }
  const rank = (p: string) => { const i = ORDER.indexOf(p); return i < 0 ? ORDER.length : i; };
  rows.sort((a, b) => rank(a.platform) - rank(b.platform) || a.platform.localeCompare(b.platform));
  return {
    kind: "ok",
    ok: h.ok === true,
    bot: h.bot === "running" || h.bot === "off" ? h.bot : null,
    rows,
  };
}
