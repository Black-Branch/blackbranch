"use client";

// A failed send's row actions, for every room panel that shows our own messages (the community
// timeline, the thread panel): Retry resends the same echo, Delete drops it. Identity-stable, so
// the memoised rows are not re-rendered by a fresh handler.
import { useCallback } from "react";
import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";
import { dropEcho, retryEcho } from "./localEcho";

export function useEchoActions(client: MatrixClient | null | undefined, room: Room) {
  const handleRetry = useCallback((ev: MatrixEvent) => {
    if (client) void retryEcho(client, room, ev);
  }, [client, room]);
  const handleDrop = useCallback((ev: MatrixEvent) => {
    if (client) dropEcho(client, ev);
  }, [client]);
  return { handleRetry, handleDrop };
}
