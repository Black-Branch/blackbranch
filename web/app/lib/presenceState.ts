import { siteName } from "./siteName.ts";
// Presence — the one rule. Pure: no React, no pool, no SDK, so
// presenceState.test.ts can pin every row of the precedence table against a
// fixed clock. Consumers: the members list, the member card, the read route's
// counts (same windows), the beat hook (cadence), the status route (mirror).

/** A beat this recent means "still on the site". Hidden tabs beat every 60 s
 *  and browsers throttle background timers to about once a minute, so 150 s
 *  is the margin, not the cadence. */
export const HERE_MS = 150_000;
/** No VISIBLE beat for this long (while still beating) = away. */
export const AWAY_AFTER_MS = 300_000;
/** Offline and unseen this long = the collapsed Inactive group (14 days). */
const FOLD_MS = 14 * 24 * 3600 * 1000;
const BEAT_VISIBLE_MS = 30_000;
const BEAT_HIDDEN_MS = 60_000;

export type SelfStatus = "online" | "idle" | "dnd" | "invisible";
export type PresenceState = "community" | "site" | "elsewhere" | "away" | "dnd" | "offline";

/** One site user as GET /api/presence returns them (invisible rows are never returned). */
export type SitePresenceRow = {
  lastBeat: string | null;
  lastVisible: string | null;
  lastCommunity: string | null;
  /** MAX(site.user_sessions.last_seen), day-rounded — sent for the caller's own row only (null for everyone else). */
  lastLogin: string | null;
  status: Exclude<SelfStatus, "invisible">;
  statusText: string;
  supporter: boolean;
};

/** What the Matrix client knows from m.presence (client.getUser(id)). */
export type MatrixSnapshot = { presence: string | null; lastActiveTs: number | null };

/** GET /api/presence's shape — moved here (from presenceServer.ts) so the
 *  client (usePresence.ts) never imports the pool-backed module. */
export type PresenceDirectory = {
  counts: { onSite: number; inCommunity: number };
  users: Record<string, SitePresenceRow>;
};

const ts = (iso: string | null | undefined): number | null => (iso ? Date.parse(iso) : null);
const newer = (a: number | null, b: number | null): number | null => (a == null ? b : b == null ? a : Math.max(a, b));

export function deriveState(site: SitePresenceRow | null, mx: MatrixSnapshot | null, now: number): {
  state: PresenceState; lastActive: number | null; inactive: boolean;
} {
  const lastBeat = ts(site?.lastBeat);
  const lastVisible = ts(site?.lastVisible);
  const lastCommunity = ts(site?.lastCommunity);
  const siteHere = lastBeat != null && lastBeat > now - HERE_MS;
  const siteVisible = lastVisible != null && lastVisible > now - AWAY_AFTER_MS;
  const inCommunity = siteHere && lastCommunity != null && lastCommunity > now - HERE_MS;
  const matrixOnline = mx?.presence === "online";
  const matrixAway = mx?.presence === "unavailable";
  const anySignal = siteHere || matrixOnline || matrixAway;

  let state: PresenceState;
  if (site?.status === "dnd" && anySignal) state = "dnd";
  else if (site?.status === "idle" && anySignal) state = "away";
  else if (inCommunity && siteVisible) state = "community";
  else if (siteHere && siteVisible) state = "site";
  else if (matrixOnline) state = "elsewhere";
  else if (siteHere || matrixAway) state = "away";
  else state = "offline";

  const lastActive = newer(newer(lastBeat, mx?.lastActiveTs ?? null), ts(site?.lastLogin));
  const inactive = state === "offline" && (lastActive == null || lastActive < now - FOLD_MS);
  return { state, lastActive, inactive };
}

function relativeAgo(t: number, now: number): string {
  const s = Math.max(0, now - t) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86_400);
  if (d > 90) return "a long time ago";
  return `${d} ${d === 1 ? "day" : "days"} ago`;
}

export function presenceLine(state: PresenceState, lastActive: number | null, now: number): string {
  switch (state) {
    case "community": return "In the community";
    case "site": return `On ${siteName()}`;
    case "elsewhere": return "Online on Matrix";
    case "away": return "Away";
    case "dnd": return "Do not disturb";
    case "offline": return lastActive == null ? "Offline" : `Offline · last seen ${relativeAgo(lastActive, now)}`;
  }
}

/** Coarse page for the beat — the raw path never leaves the tab. */
export function pageFromPath(pathname: string): "stream" | "community" | "radio" | "other" {
  if (pathname === "/") return "stream";
  if (pathname === "/community" || pathname.startsWith("/community/")) return "community";
  if (pathname === "/radio" || pathname.startsWith("/radio/")) return "radio";
  return "other";
}

/** The Matrix mirror of a self-set status. Matrix has no DND: DND is
 *  online + text. An empty text is sent as "" on purpose — omitting status_msg
 *  keeps the old one, and that rule applies to invisible too: going invisible
 *  must clear any old custom text at the homeserver, not just flip presence,
 *  or the next person who un-hides still carries yesterday's status line. */
export function statusToMatrix(status: SelfStatus, text: string): { presence: "online" | "unavailable" | "offline"; status_msg?: string } {
  if (status === "invisible") return { presence: "offline", status_msg: "" };
  return { presence: status === "idle" ? "unavailable" : "online", status_msg: text };
}

export function beatIntervalMs(visible: boolean): number {
  return visible ? BEAT_VISIBLE_MS : BEAT_HIDDEN_MS;
}

export function isSelfStatus(v: unknown): v is SelfStatus {
  return v === "online" || v === "idle" || v === "dnd" || v === "invisible";
}
