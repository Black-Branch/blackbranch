"use client";

// "X is typing…" over the bottom edge of the timeline. An overlay, not a
// composer-bar row: the bar's height is a shared token with live chat, and a
// row that comes and goes would shift a paused reader's view.
export function TypingLine({ text }: { text: string }) {
  return (
    <div
      aria-live="polite"
      className="absolute bottom-0 left-0 right-0 px-4 py-0.5 text-2xs text-muted bg-raised/90 pointer-events-none truncate"
    >
      {text}
    </div>
  );
}
