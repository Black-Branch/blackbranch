"use client";

// "Delete message history" for a ban made OUTSIDE the community (the Mod Panel's Bans form, the
// live-chat user card): the moderator chose an action that needs the Matrix client, so it is
// started here if it is not running (ADR 0005: only on intent) and given up to 30 s. If it does
// not come up, the ban's site part has already happened and the line says the community part
// did not. The member card does not need this: it is opened from a running client.

import { useCallback, useEffect, useRef } from "react";
import { useMatrixClient } from "./MatrixClientContext";
import { deleteHistoryAfterBan, refusalOf, COMMUNITY_UNREACHABLE, type HistoryWindow } from "./banHistory";
import { postJson } from "./http";

const READY_WAIT_MS = 30_000;
const POLL_MS = 250;

export type CommunityHistoryRun = (o: {
  targetId: string; window: HistoryWindow; reason?: string;
  siteRemoved: number | null; batchId: string | null;
  onProgress: (line: string | null) => void;
}) => Promise<string | null>;

export function useCommunityHistory(): CommunityHistoryRun {
  const mx = useMatrixClient();
  const latest = useRef(mx);
  useEffect(() => { latest.current = mx; });

  return useCallback<CommunityHistoryRun>(async (o) => {
    if (o.window === "none") return null;
    const ready = async () => {
      if (latest.current.status !== "ready") void latest.current.startClient();
      for (let waited = 0; waited < READY_WAIT_MS; waited += POLL_MS) {
        const { status, client } = latest.current;
        if (status === "ready" && client) return client;
        if (status === "notoken" || status === "error") return null;
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      return null;
    };
    try {
      return await deleteHistoryAfterBan({
        check: async (targetId) => refusalOf(await fetch(`/api/mod/ban-history?targetId=${encodeURIComponent(targetId)}`).catch(() => null)),
        redact: async (since) => {
          o.onProgress("Removing messages…");
          const client = await ready();
          if (!client) return null;
          // Loaded only now: it carries the SDK, which the live-chat card's bundle must not.
          const { redactHistory, communityScope } = await import("./matrixRedactHistory");
          const rooms = communityScope(client, client.getUserId() ?? "");
          if (rooms.length === 0) return null;
          return redactHistory(client as never, rooms, o.targetId, since, o.reason,
            (done, total) => o.onProgress(`Removing messages… ${done}/${total}`));
        },
        post: async (body) => (await postJson("/api/mod/ban-history", body).catch(() => null))?.ok ?? false,
      }, { targetId: o.targetId, window: o.window, now: Date.now(), siteRemoved: o.siteRemoved, batchId: o.batchId });
    } catch {
      return COMMUNITY_UNREACHABLE;
    } finally {
      o.onProgress(null);
    }
  }, []);
}
