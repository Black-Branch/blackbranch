// The Stream tab's chat readers, read from the ingest service's health answer (stream-ingest
// GET /health, relayed by GET /api/admin/stream/readers): per platform, running / starting / failed /
// off, since when, and the one-line reason a reader failed. Pure: the section renders what this
// returns, and a shape it does not know is "unknown", never a guess.

export type ReaderState = "running" | "starting" | "failed" | "off";
export type ReaderRow = { platform: string; state: ReaderState; since: string | null; error: string | null };

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
    });
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
