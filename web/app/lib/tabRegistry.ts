// The shared tab registry — tabs as equal-in-kind, consumed by BOTH hosts: the
// desktop bottom dock and the mobile chat tab bar. This file is the MODEL only
// — keys, labels, arm/close rules, persistence. Each host renders its own
// content per key (a registry-level render cannot close over StreamView's
// props without a context god-object). tabRegistry.test.ts derives from
// SITE_TABS that every host guards every key — adding a tab starts here or
// the test fails.
//
// Registry contract: a tab's content renders while it is the ACTIVE tab, OR
// while a live pager motion holds it within ONE pane of the viewport
// (approach-mount). Both halves are literal `=== "key" &&` guards, never a
// hidden class — a slot whose content is not mounted is an empty pane-width
// spacer, so the pager's geometry never shifts under a gesture.
// Passing-through mounts are transient by construction (`snap-stop: always`
// means one pane per swipe). An APPROACH never latches Matrix: only a commit
// or a tab click sets `matrixOpened`, which is what keeps a Matrix/forum tab
// from restarting the /sync long-poll on page load or on a swipe past it (the
// lazy-start guard, matrixIdentity.test.ts).
//
// Persistence vs display are SEPARATE: readArmed keeps keys the host cannot
// currently show (e.g. "vods" before any VOD loads) so arming survives;
// partitionTabs splits that for display and clampOpen picks a showable open tab.
//
// Adding a tab is deliberately THREE edits, each of which refuses to be
// forgotten: a SITE_TABS entry (here), a readiness answer per host (the
// TabReadiness Record is exhaustive, so both hosts stop compiling until they
// answer), and a `=== "key" &&` render guard per host (tabRegistry.test.ts).

export type SiteTabKey = "home" | "forums" | "news" | "vods" | "stream";
export type SiteTabDef = {
  key: SiteTabKey;
  label: string;
  /** Drawn BEFORE the pinned Live/Matrix pair on the phone (Home).
   *  Desktop needs nothing: the dock draws in registry order. */
  leading?: true;
  /** Always armed and never closable (Home): readArmed puts a missing pinned
   *  key back in front, closeTab refuses it, and neither host draws a ✕ on it
   *  (`closable: !isPinnedTab(key)`). */
  pinned?: true;
};

// @test-only the registry's own functions are its only production readers —
// hosts get their labels from partitionTabs, deliberately, so that no host can
// re-filter this list into a second availability rule. Exported because the
// guard tests enumerate it: every key here must have a render guard in BOTH
// hosts, and that test has to be able to see the list to check it.
export const SITE_TABS: readonly SiteTabDef[] = [
  { key: "home", label: "Home", leading: true, pinned: true },
  { key: "forums", label: "Forums" },
  { key: "news", label: "News" },
  { key: "vods", label: "VODs" },
  // Admin-only: both hosts answer its readiness with the viewer's is_admin, so for anyone else it
  // is never drawn, offered or mounted.
  { key: "stream", label: "Stream" },
];

export const DOCK_DEFAULT_ARMED: readonly SiteTabKey[] = ["home", "forums", "news", "vods", "stream"];
export const CHATBAR_DEFAULT_ARMED: readonly SiteTabKey[] = ["home", "news", "stream"];

const ALL_KEYS: readonly string[] = SITE_TABS.map((t) => t.key);
const PINNED_KEYS: readonly SiteTabKey[] = SITE_TABS.filter((t) => t.pinned).map((t) => t.key);

/** A tab the user can never remove. Hosts read it for `closable`. */
export function isPinnedTab(key: SiteTabKey): boolean {
  return PINNED_KEYS.includes(key);
}

/** Pinned keys the list lacks go back IN FRONT, in registry order; a pinned
 *  key the user's list already has keeps the user's place for it. */
function withPinned(list: readonly SiteTabKey[]): SiteTabKey[] {
  return [...PINNED_KEYS.filter((k) => !list.includes(k)), ...list];
}

/** The ONE place an untrusted string (storage, a URL, a DOM value) becomes a
 *  registry key — so a new tab needs no new narrowing anywhere. */
export function isSiteTabKey(v: unknown): v is SiteTabKey {
  return typeof v === "string" && ALL_KEYS.includes(v);
}

/** Stored JSON list → armed keys. Unknown keys drop, dupes collapse, order
 *  kept. `[]` is a VALID stored choice (user closed everything closable);
 *  only nothing-stored / unparseable falls back. Pinned keys (Home) are
 *  always present. */
export function readArmed(raw: string | null, fallback: readonly SiteTabKey[]): SiteTabKey[] {
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return withPinned([...new Set(parsed.filter(isSiteTabKey))]);
    } catch { /* unparseable → fallback */ }
  }
  return withPinned([...fallback]);
}

export function writeArmed(list: readonly SiteTabKey[]): string {
  return JSON.stringify(list);
}

export function armTab(list: readonly SiteTabKey[], key: SiteTabKey): SiteTabKey[] {
  return list.includes(key) ? [...list] : [...list, key];
}

export function closeTab(list: readonly SiteTabKey[], key: SiteTabKey): SiteTabKey[] {
  if (isPinnedTab(key)) return [...list];
  return list.filter((k) => k !== key);
}

/** Per key: has this tab anything to show in THIS host right now? Only the
 *  host holds the data, so the host answers — but EXHAUSTIVELY, by type. A new
 *  SiteTabKey fails to compile in every host until each has made a decision,
 *  the same discipline stream-api's COIN_KINDS table uses for money. */
export type TabReadiness = Record<SiteTabKey, boolean>;

/**
 * Split the registry into the three lists a host's tab row needs.
 * - `shown`   — armed AND ready, in the user's ARMED order, so `shown[0]` is
 *               the tab they armed first (the open-choice fallback).
 * - `tabs`    — the row to draw, in REGISTRY order, so the row does not
 *               reshuffle as tabs are armed and closed.
 * - `unarmed` — what the `+` picker offers: ready but not armed.
 *
 * A tab that is armed but not ready stays armed and is simply not drawn —
 * persistence ≠ display (see readArmed).
 */
export function partitionTabs(armed: readonly SiteTabKey[], ready: TabReadiness): {
  shown: SiteTabKey[];
  tabs: SiteTabDef[];
  unarmed: SiteTabDef[];
} {
  const available = SITE_TABS.filter((t) => ready[t.key]);
  const shown = armed.filter((k) => ready[k]);
  return {
    shown,
    tabs: available.filter((t) => shown.includes(t.key)),
    unarmed: available.filter((t) => !armed.includes(t.key)),
  };
}

/** Keep an open choice on a showable tab: not shown → first shown → null.
 *  null (collapsed) is preserved — a space change never uncollapses. */
export function clampOpen(open: SiteTabKey | null, shown: readonly SiteTabKey[]): SiteTabKey | null {
  if (open === null) return null;
  return shown.includes(open) ? open : (shown[0] ?? null);
}

/** The open tab after closing (x-ing) one. Closing the open tab moves to the
 *  first remaining; closing another leaves the open choice alone. */
export function openAfterClose(
  open: SiteTabKey | null, closed: SiteTabKey, remaining: readonly SiteTabKey[],
): SiteTabKey | null {
  if (open === null) return null;
  if (open !== closed && remaining.includes(open)) return open;
  return remaining[0] ?? null;
}

/** The phone row's two halves: leading tabs go before Live, the rest after
 *  Matrix. Both keep registry order. ChatSidebar builds `paneKeys` from this
 *  and ChatTabBar builds its items from the same call, so pane index and tab
 *  index agree by construction (the pager reads a fractional index against
 *  both). */
export function splitLeading<T extends SiteTabDef>(tabs: readonly T[]): { leading: T[]; rest: T[] } {
  return { leading: tabs.filter((t) => t.leading), rest: tabs.filter((t) => !t.leading) };
}

/** The one-time arm at a tab's release: a device that already had an armed
 *  list gets the tab added ONCE per host; the flag says never again — closing
 *  the tab afterwards is respected. Per host, because the two lists are
 *  separate and a device whose first post-release load was narrow must not
 *  spend the dock's one arm on the phone row. Home's flag is
 *  "home_armed_v1:<host>"; Forums arms in the dock only. */
export function armFlagKey(key: SiteTabKey, host: "dock" | "chat"): string {
  return `${key}_armed_v1:${host}`;
}

/** The armed string to store, or null when there is nothing to write (fresh
 *  device — the fallback already carries the key — or the flag is set). The
 *  host sets the flag either way. */
export function armOnce(
  raw: string | null, flag: string | null, fallback: readonly SiteTabKey[], key: SiteTabKey,
): string | null {
  if (flag === "1" || raw === null) return null;
  const list = readArmed(raw, fallback);
  return list.includes(key) ? null : writeArmed(armTab(list, key));
}
