"use client";

import { useCallback } from "react";
import { EventType, RelationType } from "matrix-js-sdk";
import type { Room, MatrixClient, MatrixEvent } from "matrix-js-sdk";
import { redactOrCancel } from "./matrixRedact";
import type { ReactionExtra } from "./matrixReactions";

// React / unreact / delete for a room's messages, shared by the main timeline
// and the thread panel rather than copied into each.
//
// Keeping them here also keeps them memo-safe: MatrixMessageRow's comparator
// checks these callbacks by identity, so they must depend only on [client, room]
// — anything finer-grained re-renders every row in the window on every event.
export function useRoomActions(client: MatrixClient | null | undefined, room: Room) {
  const handleReact = useCallback(
    (ev: MatrixEvent, key: string, extra?: ReactionExtra) => {
      const targetId = ev.getId();
      if (!client || !targetId) return;
      // A Discord custom emoji: key on the image's mxc — mautrix-discord resolves
      // that to the guild emoji; a ":NAME:" key would be sent as unicode and fail.
      client
        .sendEvent(room.roomId, EventType.Reaction, {
          "m.relates_to": { rel_type: RelationType.Annotation, event_id: targetId, key: extra ? extra.mxc : key },
          ...(extra ? { "com.beeper.reaction.shortcode": extra.shortcode } : {}),
        })
        .catch((e: unknown) => console.error("[Matrix] react failed", e));
    },
    [client, room]
  );

  const handleUnreact = useCallback(
    (reactionEventId: string) => {
      if (!client) return;
      // Resolve the reaction event so we can tell a confirmed reaction from a
      // still-pending local echo (redactOrCancel handles each correctly).
      const ev = room
        .getLiveTimeline()
        .getEvents()
        .find((e) => e.getId() === reactionEventId);
      if (ev) redactOrCancel(client, room, ev);
      else
        (client as unknown as { redactEvent: (r: string, e: string) => Promise<unknown> })
          .redactEvent(room.roomId, reactionEventId)
          .catch((e: unknown) => console.error("[Matrix] unreact failed", e));
    },
    [client, room]
  );

  const handleDelete = useCallback(
    (ev: MatrixEvent) => {
      if (!client) return;
      redactOrCancel(client, room, ev);
    },
    [client, room]
  );

  return { handleReact, handleUnreact, handleDelete };
}

/** Freeze-boundary identity for the scroll engine; matches the row key. */
export const eventKey = (ev: MatrixEvent) => ev.getId() ?? "";
