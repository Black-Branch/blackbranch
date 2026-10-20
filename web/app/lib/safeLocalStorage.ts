// SSR- and private-mode-safe localStorage wrappers. Direct localStorage access
// throws when storage is disabled (Safari private mode, blocked cookies) and is
// undefined during SSR, so every site in the app was hand-wrapped in try/catch —
// this centralizes that, plus the JSON parse/stringify dance.

// On the SERVER these must not even NAME the global. Since Node 25
// `localStorage` exists there as a getter that prints an ExperimentalWarning on
// first touch (`typeof localStorage` included) and then yields undefined — so
// a try/catch alone "works" while every web process logs the warning on its
// first server-rendered page. `typeof window` is the safe probe.
// (Passing --localstorage-file is NOT the fix: that would create one real
// store on the server, shared by every visitor.)
const onServer = () => typeof window === "undefined";

/** Read a string, or `null` if absent/unavailable. */
export function lsGet(key: string): string | null {
  if (onServer()) return null;
  try { return localStorage.getItem(key); } catch { return null; }
}

/** Write a string; silently no-ops if storage is unavailable (private mode/quota). */
export function lsSet(key: string, value: string): void {
  if (onServer()) return;
  try { localStorage.setItem(key, value); } catch { /* unavailable — ignore */ }
}

/** Remove a key; silently no-ops if storage is unavailable. */
export function lsRemove(key: string): void {
  if (onServer()) return;
  try { localStorage.removeItem(key); } catch { /* unavailable — ignore */ }
}

/** Read + JSON.parse a value, returning `fallback` on absence/parse error. */
export function lsGetJSON<T>(key: string, fallback: T): T {
  if (onServer()) return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch { return fallback; }
}

/** JSON.stringify + write a value; silently no-ops if storage is unavailable. */
export function lsSetJSON(key: string, value: unknown): void {
  if (onServer()) return;
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}
