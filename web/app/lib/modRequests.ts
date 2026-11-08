// Request bodies that more than one client sends to a mod route, written ONCE: the client builds
// the body with the builder here and the route reads it with the parser here, so the two cannot
// name a field differently (a command once sent `sinceMinutes` to a route that read `windowHours`,
// and every `/purge 10m` cleared 24 hours).
//
// Relative imports only: node --test loads this with no "@/" alias.

/** Who a per-person mod action targets: a site account by Matrix id, a platform-only chatter by
 *  canonical id (the routes upgrade a linked canonical to its site account). */
export type ModTarget = { targetId: string } | { canonicalId: string };

const CANONICAL_RE = /^[0-9a-f]{12}$/i;

/** The longest window a purge reaches back. */
export const PURGE_MAX_MINUTES = 24 * 60;

export type PurgeRequest = ModTarget & { windowMinutes: number };

export function purgeRequest(target: ModTarget, windowMinutes: number): PurgeRequest {
  return { ...target, windowMinutes };
}

/** The purge route's reading of a body: the target and the window in whole minutes (capped at 24 h),
 *  or null for a body it must refuse. */
export function parsePurgeRequest(body: unknown): { targetId: string; windowMinutes: number } | null {
  const b = (body ?? {}) as { targetId?: unknown; canonicalId?: unknown; windowMinutes?: unknown };
  const targetId = typeof b.targetId === "string" && b.targetId
    ? b.targetId
    : typeof b.canonicalId === "string" && CANONICAL_RE.test(b.canonicalId) ? b.canonicalId.toLowerCase() : null;
  if (!targetId) return null;
  const raw = b.windowMinutes === undefined ? PURGE_MAX_MINUTES : Number(b.windowMinutes);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return { targetId, windowMinutes: Math.min(Math.ceil(raw), PURGE_MAX_MINUTES) };
}

/** Whether a ban or timeout also removes the person's recent lines (the ban route runs the Purge
 *  button's purge with it). On unless the body says `purge: false`: the switch on the ban card and
 *  the Bans form turns it off for one ban; an Undo that puts an earlier ban back sends false. */
export function banPurges(body: unknown): boolean {
  return (body as { purge?: unknown } | null)?.purge !== false;
}

const BIGINT_MAX = "9223372036854775807";

/** A chat line id Postgres can hold: digits within bigint (a longer one would throw in SQL). */
export function isLineId(id: string): boolean {
  if (!/^\d+$/.test(id)) return false;
  const n = id.replace(/^0+(?=\d)/, "");
  return n.length < BIGINT_MAX.length || (n.length === BIGINT_MAX.length && n <= BIGINT_MAX);
}

/** The line a ban was clicked on ({ id, platform }): the ban's purge removes it by its id even when
 *  it is older than the window. null = no usable line (none named, a synthetic id such as the held
 *  queue's `automod:…`, no platform); "invalid" = an all-digit id past bigint — skipped, and the
 *  mod-log row says so. Neither ever stops the ban. */
export function clickedLineOf(body: unknown): { platform: string; id: string } | null | "invalid" {
  const m = (body as { message?: { id?: unknown; platform?: unknown } } | null)?.message;
  const id = typeof m?.id === "number" && Number.isSafeInteger(m.id) ? String(m.id) : typeof m?.id === "string" ? m.id : "";
  if (!/^\d+$/.test(id) || typeof m?.platform !== "string" || !m.platform) return null;
  return isLineId(id) ? { id, platform: m.platform } : "invalid";
}

/** "10m", "6h", "24h" — how a purge window reads back in a notice and the mod log. */
export function windowLabel(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}
