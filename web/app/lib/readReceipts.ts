"use client";

// Read receipts for the Matrix client.
//
// `roomUnreads()` (matrixRooms.ts) shows the SERVER's notification counts, and
// the server only resets them when this account sends a read receipt — without
// one, a channel's dot clears only if another client on the same account reads
// the room. Discord's rule, adopted here: you have read a channel when it is
// open, you are at the bottom, and the tab is visible. One call marks all three
// markers — m.fully_read, the public m.read receipt, and the private
// m.read.private one (MSC2285) — so other clients on this account agree and
// other members see the receipt. With Community › Privacy › Send read receipts
// OFF the public one is left out (matrixPrivacy.ts).
//
// The attempt is skipped while `newestEvent` is still a local echo (unsent):
// it has no server event id to mark read, and the sent copy arrives with the
// next sync, which re-runs this effect anyway.

import { useEffect, useRef } from "react";
import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";
import { sendReadMarker } from "./matrixPrivacy.ts";

export type ReceiptInput = {
  anchored: boolean;
  visible: boolean;
  newestId: string | null;
  lastSentId: string | null;
};

/**
 * The event id to mark read now, or null when nothing should be sent.
 *
 * @test-only every call site composes this via useReadReceipts below, in the
 * same file — check-orphans' cross-file reference scan can't see that wiring
 * (it excludes a symbol's own defining file). The export exists for
 * readReceipts.test.ts, which pins the decision directly rather than only
 * through the hook's debounce/effect timing.
 */
export function nextReceiptTarget({ anchored, visible, newestId, lastSentId }: ReceiptInput): string | null {
  if (!anchored || !visible || !newestId) return null;
  if (newestId === lastSentId) return null;
  return newestId;
}

const DEBOUNCE_MS = 800;

/**
 * Marks `newestEvent` read whenever the decision says so. `thread` = true
 * sends a threaded receipt (the thread panel); false marks the room's main
 * timeline with all three markers.
 */
export function useReadReceipts({
  client,
  room,
  newestEvent,
  anchored,
  thread = false,
}: {
  client: MatrixClient | null | undefined;
  room: Room;
  newestEvent: MatrixEvent | null;
  anchored: boolean;
  thread?: boolean;
}): void {
  const lastSentRef = useRef<string | null>(null);
  const warnedRef = useRef(false);

  // A room switch is a fresh receipt history.
  useEffect(() => {
    lastSentRef.current = null;
  }, [room.roomId]);

  useEffect(() => {
    if (!client || !newestEvent) return;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const attempt = () => {
      // An unsent event has no server id to mark; the sent one arrives with
      // the next sync (which re-runs this effect via the newestEvent dep).
      if (newestEvent.status !== null) return;
      const newestId = newestEvent.getId() ?? null;
      const target = nextReceiptTarget({
        anchored,
        visible: typeof document === "undefined" || document.visibilityState === "visible",
        newestId,
        lastSentId: lastSentRef.current,
      });
      if (!target) return;
      lastSentRef.current = target;
      // Public or private per Community › Privacy (matrixPrivacy.ts) — the
      // private receipt still clears the server's unread counts.
      const send = sendReadMarker(client, room.roomId, newestEvent, { single: thread });
      send.catch((e: unknown) => {
        // Allow a retry for this event, and say so once per mount, not per event.
        if (lastSentRef.current === target) lastSentRef.current = null;
        if (!warnedRef.current) {
          warnedRef.current = true;
          console.warn("[Matrix] receipt failed", e);
        }
      });
    };

    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(attempt, DEBOUNCE_MS);
    };

    schedule();
    document.addEventListener("visibilitychange", schedule);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [client, room.roomId, newestEvent, anchored, thread]);
}
