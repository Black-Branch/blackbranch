import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { ChatMsg } from "./chatMsg";
import { chatKey } from "./chatSeed.ts";
import { emitChatNotice } from "./chatNotice.ts";
import { findReplyTarget, replyJumpPlan, replyPreviewOf, REPLY_FLASH_MS } from "./chatReplyJump.ts";

// What a chat host needs to make a reply line clickable and hoverable:
//   onReplyJump(msg)          scroll to the message `msg` answers, tint it briefly
//   onReplyPreview(msg, el)   show (el) / hide (null) the full replied-to text
//   flashKey                  the chatKey of the row wearing the tint, or null
// The scroll goes THROUGH the engine (replyJumpPlan says how): pause, then
// write — or re-anchor when the landing spot is the bottom. A bare write is
// layout noise to useAnchoredChat and the feed snaps back (the same lesson as
// the PgUp/PgDn keys, chatScrollKeys.ts).

export type ReplyPreviewState = {
  username: string; text: string; clipped: boolean;
  /** The reply line's box and the viewport's size, captured in the hover event
   *  so the preview's render reads nothing from `window`. */
  anchor: { left: number; top: number; bottom: number; vw: number; vh: number };
};

export function useReplyJump({ scrollRef, messages, pause, anchorToBottom }: {
  scrollRef: RefObject<HTMLElement | null>;
  messages: readonly ChatMsg[];
  pause: () => void;
  anchorToBottom: () => void;
}) {
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const [preview, setPreview] = useState<ReplyPreviewState | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The handlers stay referentially stable (ChatMessage is memoised; a handler
  // that changed with every incoming message would re-render every row).
  const messagesRef = useRef(messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  const onReplyJump = useCallback((msg: ChatMsg) => {
    setPreview(null);
    const el = scrollRef.current;
    if (!el) return;
    const target = findReplyTarget(msg, messagesRef.current);
    const key = target && target.id != null ? chatKey({ platform: target.platform, id: target.id }) : null;
    const row = key ? el.querySelector<HTMLElement>(`[data-chat-row-key="${CSS.escape(key)}"]`) : null;
    if (!key || !row) { emitChatNotice("That message is too far back to jump to."); return; }
    const box = el.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const plan = replyJumpPlan({
      scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight,
      rowTop: r.top - box.top + el.scrollTop, rowHeight: r.height,
    });
    if (plan.kind === "bottom") anchorToBottom();
    else if (plan.kind === "scroll") { pause(); el.scrollTop = plan.top; }
    setFlashKey(key);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashKey(null), REPLY_FLASH_MS);
  }, [scrollRef, pause, anchorToBottom]);

  const onReplyPreview = useCallback((msg: ChatMsg, el: HTMLElement | null) => {
    if (!el) { setPreview(null); return; }
    const p = replyPreviewOf(msg, messagesRef.current);
    if (!p) { setPreview(null); return; }
    const b = el.getBoundingClientRect();
    setPreview({ ...p, anchor: { left: b.left, top: b.top, bottom: b.bottom, vw: window.innerWidth, vh: window.innerHeight } });
  }, []);
  /** The list moved under a stationary pointer: the line the preview hangs off
   *  is no longer where it was. Hosts call this from their scroll handler. */
  const dismissPreview = useCallback(() => setPreview((p) => (p ? null : p)), []);

  return { flashKey, preview, onReplyJump, onReplyPreview, dismissPreview };
}
