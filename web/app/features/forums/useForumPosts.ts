import { useCallback, useEffect, useRef, useState } from "react";
import { getJson, HttpError } from "@/app/lib/http";
import type { ForumPostView, ForumRoomInfo } from "@/app/lib/forumModel";

// Client poll for GET /api/forum/posts. Mirrors useHomeData: load on mount,
// refresh on an interval while `active` and the tab is visible, refetch on
// the manual "bb:forum-refresh" event. Sorting is client-side, so the
// route's sort is fixed here. `patch` rewrites one post locally — the
// optimistic half of a vote; the server's answer reconciles it.
const POLL_MS = 60_000;
const FORUM_REFRESH_EVENT = "bb:forum-refresh";

export type ForumPostsData = { rooms: ForumRoomInfo[]; posts: ForumPostView[] };

export function useForumPosts(active: boolean, room: string): {
  data: ForumPostsData | null;
  loading: boolean;
  error: boolean;
  /** A 503 from the route: the reader is unconfigured or the homeserver is down. */
  unavailable: boolean;
  refresh: () => void;
  patch: (id: string, fn: (p: ForumPostView) => ForumPostView) => void;
} {
  const [data, setData] = useState<ForumPostsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  // The current load, reachable from refresh() without re-subscribing.
  const loadRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const body = await getJson<ForumPostsData>(`/api/forum/posts?room=${encodeURIComponent(room)}&sort=active`);
        if (!cancelled) { setData({ rooms: body.rooms ?? [], posts: body.posts ?? [] }); setError(false); setUnavailable(false); }
      } catch (e) {
        if (cancelled) return;
        if (e instanceof HttpError && e.status === 503) { setUnavailable(true); setError(false); }
        else setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    loadRef.current = () => { void load(); };
    load();
    const id = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
    const onRefresh = () => { load(); };
    window.addEventListener(FORUM_REFRESH_EVENT, onRefresh);
    return () => {
      cancelled = true;
      loadRef.current = () => {};
      clearInterval(id);
      window.removeEventListener(FORUM_REFRESH_EVENT, onRefresh);
    };
  }, [active, room]);

  const refresh = useCallback(() => { loadRef.current(); }, []);
  const patch = useCallback((id: string, fn: (p: ForumPostView) => ForumPostView) => {
    setData((d) => (d ? { ...d, posts: d.posts.map((p) => (p.id === id ? fn(p) : p)) } : d));
  }, []);

  return { data, loading, error, unavailable, refresh, patch };
}
