// A random identity for THIS TAB, for the per-source viewer census.
//
// sessionStorage, not localStorage: a new tab is a new viewer and closing the
// tab ends it, which is as close to "a person watching" as we can honestly get
// without tracking anyone. It is never persisted across sessions, never joined
// to an account, and never sent anywhere but our own status poll — its only job
// is to stop one viewer's twice-a-minute poll counting as two viewers.
//
// Falls back to a per-call random id when storage is unavailable (private mode,
// storage disabled). That over-counts a viewer rather than failing, which is the
// right way round for a measurement that must never break the page.

const KEY = "player_tab_id";

const mint = () => Math.random().toString(36).slice(2).padEnd(8, "0").slice(0, 16);

/** This tab's census id. Matches the server's /^[a-z0-9]{6,64}$/ validation. */
export function tabId(): string {
  try {
    const existing = sessionStorage.getItem(KEY);
    if (existing && /^[a-z0-9]{6,64}$/.test(existing)) return existing;
    const next = mint();
    sessionStorage.setItem(KEY, next);
    return next;
  } catch {
    return mint();
  }
}
