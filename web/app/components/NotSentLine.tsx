"use client";

import { keepFocus } from "@/app/lib/keepFocus";

/** Under one of the viewer's own messages that did not reach the server:
 *  "Not sent · Retry · Delete". A state of the person's own message, so it is
 *  always shown (ADR 0110 scope); role=status announces it politely. */
export function NotSentLine({ onRetry, onDelete }: { onRetry: () => void; onDelete: () => void }) {
  return (
    <div role="status" className="mt-0.5 flex items-center gap-1.5" style={{ fontSize: "var(--text-chat-sm)" }}>
      <span className="text-red-400">Not sent</span>
      <span aria-hidden className="text-faint">·</span>
      {/* tap-hit-44: a thumb-sized hit area on a phone without growing the line. */}
      <button type="button" onClick={onRetry} onMouseDown={keepFocus}
        className="tap-hit-44 text-body-dim hover:text-strong underline underline-offset-2">
        Retry
      </button>
      <span aria-hidden className="text-faint">·</span>
      <button type="button" onClick={onDelete} onMouseDown={keepFocus}
        className="tap-hit-44 text-body-dim hover:text-strong underline underline-offset-2">
        Delete
      </button>
    </div>
  );
}
