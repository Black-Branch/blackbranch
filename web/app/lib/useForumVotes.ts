"use client";

import { useState, useEffect, useCallback } from "react";
import { getJson, postJsonOrThrow } from "@/app/lib/http";

// Client-side forum vote state for one room (posts + comments). Scores and the
// caller's own votes are loaded from /api/forum/vote; voting is optimistic and
// reconciled from the server response (the server resolves the event author and
// rejects self-votes). One hook instance per forum surface (post list, detail).
export type Vote = -1 | 1;

export function useForumVotes(roomId: string) {
  const [scores, setScores] = useState<Map<string, number>>(() => new Map());
  const [myVotes, setMyVotes] = useState<Map<string, Vote>>(() => new Map());
  // false until the first fetch resolves — lets the vote pill show a placeholder
  // instead of a premature "0" that pops to the real score moments later.
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    try {
      const data = await getJson<{ scores?: Record<string, number>; myVotes?: Record<string, number> }>(
        `/api/forum/vote?roomId=${encodeURIComponent(roomId)}`
      );
      setScores(new Map(Object.entries(data.scores ?? {}).map(([k, v]) => [k, Number(v)])));
      setMyVotes(
        new Map(
          Object.entries(data.myVotes ?? {}).map(([k, v]) => [k, Number(v) as Vote])
        )
      );
    } catch { /* non-fatal */ } finally {
      setLoaded(true);
    }
  }, [roomId]);

  // Reset when the room changes — state adjust during render (no effect pass);
  // the effect below only kicks off the (async) reload.
  const [votesRoom, setVotesRoom] = useState(roomId);
  if (votesRoom !== roomId) {
    setVotesRoom(roomId);
    setScores(new Map());
    setMyVotes(new Map());
    setLoaded(false);
  }
  // Microtask defer keeps reload()'s setStates out of the synchronous effect pass.
  useEffect(() => { Promise.resolve().then(reload); }, [reload]);

  // Click direction up(+1)/down(-1); re-clicking the active direction clears it.
  const vote = useCallback(
    async (eventId: string, direction: Vote) => {
      const cur = myVotes.get(eventId) ?? 0;
      const next = cur === direction ? 0 : direction;

      // optimistic: adjust the score by the delta, set/clear my vote
      setScores((prev) => {
        const m = new Map(prev);
        m.set(eventId, (m.get(eventId) ?? 0) - cur + next);
        return m;
      });
      setMyVotes((prev) => {
        const m = new Map(prev);
        if (next === 0) m.delete(eventId);
        else m.set(eventId, next as Vote);
        return m;
      });

      try {
        const data = await postJsonOrThrow<{ score: number; myVote: number | null }>(
          "/api/forum/vote",
          { roomId, eventId, vote: next }
        );
        setScores((prev) => {
          const m = new Map(prev);
          m.set(eventId, Number(data.score));
          return m;
        });
        setMyVotes((prev) => {
          const m = new Map(prev);
          if (data.myVote == null) m.delete(eventId);
          else m.set(eventId, Number(data.myVote) as Vote);
          return m;
        });
      } catch (e) {
        console.warn("[Forum] vote failed", e);
        reload(); // resync from server
      }
    },
    [roomId, myVotes, reload]
  );

  return { scores, myVotes, loaded, vote, reloadVotes: reload };
}
