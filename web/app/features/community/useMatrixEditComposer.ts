"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { MatrixClient, MatrixEvent } from "matrix-js-sdk";
import { EventType, type TimelineEvents } from "matrix-js-sdk";
import type { Room } from "matrix-js-sdk";
import type { EditsMap } from "@/app/lib/matrixEdits";
import type { EmoteMap } from "@/app/lib/useEmotes";
import { buildEditContent, type Mention } from "@/app/lib/buildMatrixMessage";
import { stripReplyFallback } from "@/app/lib/stripReplyFallback";
import { senderLabel } from "@/app/lib/discordSender";
import { getMemberDisplayName } from "@/app/lib/matrixDisplay";

// The edit/mention half of a Matrix composer (handleEdit, cancelEdit,
// handleMention, the m.replace send path), shared by Timeline and ThreadPanel
// so a fix lands in one place instead of in parallel copies.
//
// Invariant: every callback returned here is IDENTITY-STABLE ([] deps).
// They're passed straight to the memoized MatrixMessageRow, whose propsEqual
// compares them first — a fresh identity per render re-renders every visible
// row on every incoming event. Anything mutable (edits, emotes, client,
// onBeginEdit) is therefore read through a ref at CALL time, never closed over.
export function useMatrixEditComposer(args: {
  client: MatrixClient | null;
  room: Room;
  emotes: EmoteMap;
  edits: EditsMap;
  setInput: Dispatch<SetStateAction<string>>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** Host hook-in when an edit begins (Timeline clears its reply state here). */
  onBeginEdit?: () => void;
}) {
  const [editing, setEditing] = useState<MatrixEvent | null>(null);

  const live = useRef(args);
  useEffect(() => {
    live.current = args;
  });

  // Labels picked via @mention since the last send, keyed by label → userId so
  // the send can turn "@Name" back into a pill without re-resolving anything.
  const pendingMentions = useRef<Map<string, string>>(new Map());

  // A room switch is a fresh mention history — a label picked in one room's
  // composer must not survive into another room's.
  useEffect(() => {
    pendingMentions.current.clear();
  }, [args.room.roomId]);

  const handleEdit = useCallback((ev: MatrixEvent) => {
    const id = ev.getId();
    if (!id) return;
    const edited = live.current.edits.get(id);
    // Prefill with the latest edited body if it's already been edited, else the
    // original (reply-fallback stripped so the quote prefix doesn't show).
    const latest =
      (edited?.body as string) ??
      stripReplyFallback(((ev.getContent() as Record<string, unknown>).body as string) ?? "");
    // Re-seed pendingMentions from the message's own m.mentions, so an
    // untouched edit round-trips its pills instead of dropping them: prefer
    // the latest edit's m.new_content (aggregateEdits stores the whole thing,
    // and buildMatrixMessage puts the full replacement mention set there),
    // falling back to the original event's m.mentions when it has never been
    // edited.
    const mentionSource =
      (edited?.["m.mentions"] as { user_ids?: string[] } | undefined) ??
      ((ev.getContent() as Record<string, unknown>)["m.mentions"] as { user_ids?: string[] } | undefined);
    pendingMentions.current.clear();
    for (const userId of mentionSource?.user_ids ?? []) {
      pendingMentions.current.set(senderLabel(getMemberDisplayName(live.current.room, userId), userId).label, userId);
    }
    live.current.onBeginEdit?.();
    setEditing(ev);
    live.current.setInput(latest);
    live.current.inputRef.current?.focus();
  }, []);

  const cancelEdit = useCallback(() => {
    setEditing(null);
    live.current.setInput("");
    pendingMentions.current.clear();
  }, []);

  /** Leave edit mode WITHOUT touching the input — for the host's send capture
   *  (flushSync) and for "starting a reply exits edit mode". */
  const stopEditing = useCallback(() => setEditing(null), []);

  // Inserts the person's NAME (bridge suffix stripped), and remembers which
  // user that label stands for so the send can turn it into a pill.
  const handleMention = useCallback((userId: string) => {
    const { room } = live.current;
    const { label } = senderLabel(getMemberDisplayName(room, userId), userId);
    pendingMentions.current.set(label, userId);
    live.current.setInput((prev) => (prev.endsWith(" ") || prev === "" ? prev : prev + " ") + `@${label} `);
    live.current.inputRef.current?.focus();
  }, []);

  /** The mentions picked since the last send, WITHOUT forgetting them — a
   *  send that then fails must leave them in place (see clearMentions). */
  const peekMentions = useCallback((): Mention[] => {
    return [...pendingMentions.current.entries()].map(([label, userId]) => ({ label, userId }));
  }, []);

  /** Forget the mentions picked since the last send. Call only once the send
   *  that consumed them (peekMentions) has actually succeeded. */
  const clearMentions = useCallback((): void => {
    pendingMentions.current.clear();
  }, []);

  /**
   * The m.replace send. The host has already captured `editing` and cleared the
   * composer (flushSync); on failure this restores both so nothing is lost.
   * The host owns its `sending` flag (call this inside its try/finally).
   */
  const sendEdit = useCallback(async (capturedEdit: MatrixEvent, body: string) => {
    const { client, room, emotes, setInput } = live.current;
    if (!client) return;
    const targetId = capturedEdit.getId();
    try {
      // Inlined rather than calling peekMentions() — this callback's identity must
      // stay [] (see the identity invariant above), and pendingMentions is a ref, so
      // reading it directly here needs no dependency at all. Cleared only after
      // the send succeeds (below), same rule as the new-message send path.
      const mentions: Mention[] = [...pendingMentions.current.entries()].map(([label, userId]) => ({ label, userId }));
      const editContent = buildEditContent(body, emotes, targetId ?? "", mentions);
      await client.sendEvent(room.roomId, EventType.RoomMessage, editContent as unknown as TimelineEvents[EventType.RoomMessage]);
      pendingMentions.current.clear();
    } catch (err) {
      console.error("matrix edit failed", room.roomId, err);
      setInput(body);
      setEditing(capturedEdit);
    }
  }, []);

  return { editing, handleEdit, cancelEdit, stopEditing, handleMention, peekMentions, clearMentions, sendEdit };
}
