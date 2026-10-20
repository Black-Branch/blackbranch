// Name colours and looks (style + pronouns) by Matrix id, fetched for the ids on screen.
//
// The two routes behind it (/api/users/colors, /api/users/looks) answer only for the ids they are
// asked about, so whatever draws a name says so with wantUserStyles(ids) — useWantUserStyles in a
// component — and every hook that reads the maps re-renders when the answer lands. Ids wanted in
// the same tick are sent together, at most STYLE_CHUNK per request; an id is asked once per page
// load (a failed request lets it be asked again).
import { getJson } from "./http.ts";
import type { EquippedStyle } from "./usernameStyles.ts";

export type UserLook = { s?: EquippedStyle | null; p?: string | null };
export type UserLooks = Record<string, UserLook>;
export type UserColors = Record<string, string>;

/** Below the routes' 200-id cap, and short enough for any URL limit. */
const STYLE_CHUNK = 100;

/** A store over an injected fetch and scheduler; the page uses the one below.
 *  @test-only the factory form lets the tests drive the batching with a fake fetch and clock; the
 *  app reaches it only through `userStyleStore`. */
export function createUserStyleStore(
  fetchJson: <T>(url: string) => Promise<T>,
  schedule: (fn: () => void) => void = (fn) => { setTimeout(fn, 0); },
) {
  let colors: UserColors = {};
  let looks: UserLooks = {};
  const asked = new Set<string>();
  let pending = new Set<string>();
  let scheduled = false;
  const listeners = new Set<() => void>();

  async function ask(ids: string[]): Promise<void> {
    const q = `ids=${encodeURIComponent(ids.join(","))}`;
    try {
      const [c, l] = await Promise.all([
        fetchJson<UserColors>(`/api/users/colors?${q}`),
        fetchJson<UserLooks>(`/api/users/looks?${q}`),
      ]);
      colors = { ...colors, ...c };
      looks = { ...looks, ...l };
      for (const fn of listeners) fn();
    } catch {
      for (const id of ids) asked.delete(id);
    }
  }

  function flush(): Promise<void> {
    scheduled = false;
    const ids = [...pending];
    pending = new Set();
    const runs: Promise<void>[] = [];
    for (let i = 0; i < ids.length; i += STYLE_CHUNK) runs.push(ask(ids.slice(i, i + STYLE_CHUNK)));
    return Promise.all(runs).then(() => {});
  }

  return {
    want(ids: Iterable<string>): void {
      for (const id of ids) {
        if (!id || !id.startsWith("@") || asked.has(id)) continue;
        asked.add(id);
        pending.add(id);
      }
      if (pending.size && !scheduled) { scheduled = true; schedule(() => { void flush(); }); }
    },
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    colors: (): UserColors => colors,
    looks: (): UserLooks => looks,
  };
}

/** The page's one store. */
export const userStyleStore = createUserStyleStore(getJson);
