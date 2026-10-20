import { useCallback, useEffect, useRef, useState } from "react";
import { onHeldMessage, HELD_POLL_MS, type HeldState } from "./heldMessages.ts";
import { chatKey } from "./chatSeed.ts";
import type { ChatMsg } from "./chatMsg.ts";

export type HeldLine = {
  rowId: number;
  text: string;
  state: HeldState;
  /** chatKey of the last message on screen when it was held — the line sits
   *  right after it. null, or a key no longer on screen, = above everything. */
  afterKey: string | null;
};

/**
 * The sender's held messages, local to this tab. A pending line polls its row
 * every HELD_POLL_MS while the tab is visible: approved → the line goes (the real
 * message arrives over the normal broadcast); rejected/expired → it says so and
 * stays until dismissed; a row that is gone (404) → the line goes.
 */
export function useHeldLines(messages: readonly ChatMsg[]) {
  const [lines, setLines] = useState<HeldLine[]>([]);
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    const last = messages[messages.length - 1];
    lastKey.current = last ? chatKey(last) : null;
  }, [messages]);

  useEffect(() => onHeldMessage(({ rowId, text }) => {
    setLines((prev) => prev.some((l) => l.rowId === rowId)
      ? prev
      : [...prev, { rowId, text, state: "pending", afterKey: lastKey.current }]);
  }), []);

  const anyPending = lines.some((l) => l.state === "pending");
  const pendingIds = lines.filter((l) => l.state === "pending").map((l) => l.rowId).join(",");
  useEffect(() => {
    if (!anyPending) return;
    let cancelled = false;
    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      for (const rowId of pendingIds.split(",").map(Number)) {
        const res = await fetch(`/api/chat/held/${rowId}`, { cache: "no-store" }).catch(() => null);
        if (cancelled || !res) continue;
        if (res.status === 404) { setLines((p) => p.filter((l) => l.rowId !== rowId)); continue; }
        if (!res.ok) continue;
        const d = (await res.json().catch(() => null)) as { state?: HeldState } | null;
        const state = d?.state;
        if (!state || state === "pending" || cancelled) continue;
        setLines((p) => state === "approved"
          ? p.filter((l) => l.rowId !== rowId)
          : p.map((l) => (l.rowId === rowId ? { ...l, state } : l)));
      }
    };
    const timer = setInterval(() => { void poll(); }, HELD_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [anyPending, pendingIds]);

  const dismiss = useCallback((rowId: number) => {
    setLines((p) => p.filter((l) => l.rowId !== rowId));
  }, []);

  return { heldLines: lines, dismissHeld: dismiss };
}
