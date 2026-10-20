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

/** "10m", "6h", "24h" — how a purge window reads back in a notice and the mod log. */
export function windowLabel(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}
