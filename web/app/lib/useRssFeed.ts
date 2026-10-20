import { useEffect, useState } from "react";
import { getJson } from "@/app/lib/http";
import type { RssItem } from "@/app/lib/rssServer";

// Client poll for the curated RSS feed. Mirrors StreamView's /api/stream/status
// poll: load on mount, then refresh on an interval while `active` and the tab is
// visible. Importing RssItem is type-only (erased), so no server code is bundled.
export type { RssItem };

const POLL_MS = 60_000;
/** Wait this long after the last keystroke before asking the server. Long enough
 *  that typing a word is ONE request, short enough to feel immediate. */
const SEARCH_DEBOUNCE_MS = 250;

export function useRssFeed(active: boolean, query = ""): { items: RssItem[]; loading: boolean; error: boolean } {
  const [items, setItems] = useState<RssItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const q = query.trim();

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const url = `/api/rss/items?limit=50${q ? `&q=${encodeURIComponent(q)}` : ""}`;
        const data = await getJson<{ items: RssItem[] }>(url);
        if (!cancelled) {
          setItems(data.items);
          setError(false);
        }
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    // Debounce only the SEARCH, never the first load or the background poll: `q`
    // changes on every keystroke and each change re-runs this effect, so firing
    // immediately would mean one request per character. With no term there is
    // nothing to debounce — the panel opens showing items straight away.
    // The timer must be cleared on cleanup as well as the interval, or a
    // half-typed term still lands after the next keystroke has superseded it.
    let first: ReturnType<typeof setTimeout> | null = null;
    if (q) first = setTimeout(load, SEARCH_DEBOUNCE_MS);
    else load();
    const id = setInterval(() => {
      if (!document.hidden) load();
    }, POLL_MS);
    return () => {
      cancelled = true;
      if (first) clearTimeout(first);
      clearInterval(id);
    };
  }, [active, q]);

  return { items, loading, error };
}
