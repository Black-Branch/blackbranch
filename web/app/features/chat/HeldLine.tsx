"use client";

import { CHAT_FONT, CHAT_FONT_XS } from "@/app/lib/chatFont";
import { HELD_PENDING_TEXT, HELD_REJECTED_TEXT, HELD_EXPIRED_TEXT } from "@/app/lib/heldMessages";
import type { HeldLine as Held } from "@/app/lib/useHeldLines";

/** The sender's own held message, in their chat only (useHeldLines). Faded while it
 *  waits; once refused it says why and can be dismissed. */
export default function HeldLine({ line, onDismiss }: { line: Held; onDismiss: (rowId: number) => void }) {
  const status = line.state === "rejected" ? HELD_REJECTED_TEXT
    : line.state === "expired" ? HELD_EXPIRED_TEXT
    : HELD_PENDING_TEXT;
  return (
    <div className="group relative pl-3 pr-3 py-0.5 chat-msg-row" data-held-row={line.rowId}>
      <div className="break-words text-body-dim opacity-70" style={{ fontSize: CHAT_FONT, lineHeight: "var(--chat-line-height, 1.4)" }}>
        {line.text}
      </div>
      <div className="flex items-center gap-2 text-muted" style={{ fontSize: CHAT_FONT_XS }}>
        <span role="status" className={line.state === "pending" ? "" : "text-red-300"}>{status}</span>
        <button
          type="button"
          onClick={() => onDismiss(line.rowId)}
          aria-label="Dismiss"
          title="Dismiss"
          className="ml-auto rounded px-1 hover:text-strong hover:bg-surface-1 transition-colors"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
