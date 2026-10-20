"use client";

import { useCallback, useState } from "react";
import { useChatSocket, type ChatSocketEvent } from "./useChatSocket";
import { useLocalStorageString } from "./useClientState";
import { MOD_SHOW_DELETED_LS_KEY } from "./useChatMessages";
import { applyCardFrame } from "./userLiveFrames";
import type { ChatMsg } from "./chatMsg";

/**
 * Live messages from ONE person, for a standalone user card.
 *
 * The in-page card is handed the chat's existing buffer, but a popped-out card
 * has no chat around it. Rather than mounting the whole `useChatMessages` state
 * machine — history paging, votes, pins, stickers, polls, slow mode — this keeps
 * only what a card needs: subscribe, keep the frames from this identity, follow
 * deletions and purges (userLiveFrames.ts), drop the rest.
 *
 * Filtering is client-side because it has to be: stream-api broadcasts every
 * frame to every client and has no subscribe-by-user protocol. Matching is on
 * identity (matrixId / the per-platform publicId), never username — display names collide
 * across platforms and can be changed at will.
 */
export function useUserLiveMessages(matrixId?: string | null, publicId?: string | null, isMod = false): ChatMsg[] {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  // The main chat's rule: only a moderator who opted in keeps deleted lines (struck out).
  const [showDeletedLs] = useLocalStorageString(MOD_SHOW_DELETED_LS_KEY);
  const showDeleted = isMod && showDeletedLs === "1";

  const onEvent = useCallback(
    (data: ChatSocketEvent) => {
      const view = {
        mine: (m: ChatMsg) => !m.system &&
          (!!(matrixId && m.matrixId === matrixId) || !!(publicId && m.publicId === publicId)),
        showDeleted,
      };
      setMsgs((prev) => applyCardFrame(prev, data, view));
    },
    [matrixId, publicId, showDeleted]
  );

  useChatSocket(onEvent);
  return msgs;
}
