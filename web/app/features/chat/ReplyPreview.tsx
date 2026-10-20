"use client";

import { createPortal } from "react-dom";
import { normalizeUsername } from "@/app/lib/chatMsg";
import type { ReplyPreviewState } from "@/app/lib/useReplyJump";
import { RedactedQuote } from "@/app/components/RedactedText";

// The hover preview for a reply line: the WHOLE replied-to message (the
// line itself only fits a few words). One per chat host, portalled to <body> so
// no transformed or clipped ancestor of the chat column can trap it. It never
// takes the pointer: it is a label, and a preview that could be hovered would
// hold itself open over the rows beneath it.

const GAP = 6;
// px, for the left-edge clamp only; the box itself is sized in rem so it grows
// with the /chat window's ?scale (which works through the root font-size).
const WIDTH = 340;
// Below this much room above the line, the preview opens downward instead.
const MIN_ROOM_ABOVE = 140;

export default function ReplyPreview({ preview }: { preview: ReplyPreviewState | null }) {
  if (!preview || typeof document === "undefined") return null;
  const { anchor } = preview;
  const left = Math.max(8, Math.min(anchor.left, anchor.vw - WIDTH - 8));
  const above = anchor.top >= MIN_ROOM_ABOVE;
  return createPortal(
    <div
      role="tooltip"
      className="fixed z-(--z-menu) glass rounded-lg px-3 py-2 text-sm text-body pointer-events-none break-words whitespace-pre-wrap max-h-[50vh] overflow-hidden"
      style={{
        left, width: "min(22rem, calc(100vw - 16px))",
        ...(above ? { bottom: anchor.vh - anchor.top + GAP } : { top: anchor.bottom + GAP }),
      }}
    >
      <div className="text-xs font-medium text-muted mb-0.5">↩ {normalizeUsername(preview.username)}</div>
      {/* A redacted message's stored text carries placeholder glyphs where the
          hidden parts are; drawn raw they would read as cipher text. Closed
          bars, like the reply line itself. */}
      <RedactedQuote text={preview.text} />{preview.clipped ? "…" : ""}
    </div>,
    document.body
  );
}
