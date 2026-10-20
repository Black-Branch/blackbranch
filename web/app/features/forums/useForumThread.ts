import { useCallback, useEffect, useRef, useState } from "react";
import { getJson } from "@/app/lib/http";
import type { ForumThreadView } from "@/app/lib/forumModel";
import type { ThreadRef } from "@/app/lib/forumLinks";

// One thread from GET /api/forum/thread. No polling: a thread changes when the
// viewer replies, and that path calls refresh() itself.
export function useForumThread(ref: ThreadRef | null): {
  thread: ForumThreadView | null;
  loading: boolean;
  error: boolean;
  refresh: () => void;
} {
  const [thread, setThread] = useState<ForumThreadView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const loadRef = useRef<() => void>(() => {});
  const roomId = ref?.roomId ?? null;
  const eventId = ref?.eventId ?? null;

  useEffect(() => {
    if (!roomId || !eventId) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const body = await getJson<{ thread: ForumThreadView }>(
          `/api/forum/thread?room=${encodeURIComponent(roomId)}&event=${encodeURIComponent(eventId)}`,
        );
        if (!cancelled) { setThread(body.thread); setError(false); }
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    loadRef.current = () => { void load(); };
    load();
    return () => {
      cancelled = true;
      loadRef.current = () => {};
    };
  }, [roomId, eventId]);

  // A different thread (or none) shows nothing until its own load lands —
  // render-time adjust keyed on the ref, no effect pass.
  const [shownFor, setShownFor] = useState<string | null>(null);
  const key = roomId && eventId ? `${roomId}\u0000${eventId}` : null;
  if (shownFor !== key) {
    setShownFor(key);
    setThread(null);
    setError(false);
  }

  const refresh = useCallback(() => { loadRef.current(); }, []);
  return { thread: key ? thread : null, loading, error, refresh };
}
