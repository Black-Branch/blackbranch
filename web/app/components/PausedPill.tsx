"use client";

// "Chat paused" pill shared by the live chat and the Matrix timeline.
// Shown only while the scroll is paused (useAnchoredChat), so unlike the old
// "More messages below" copy it always states the actual cause — and counts
// what's actually waiting.
export function PausedPill({ queued, onClick }: { queued: number; onClick: () => void }) {
  const label =
    queued === 0
      ? "Chat paused"
      : queued === 1
        ? "1 new message"
        : `${queued > 99 ? "99+" : queued} new messages`;
  return (
    <button
      onClick={onClick}
      className="absolute bottom-2 left-1/2 -translate-x-1/2 z-10 px-3 py-1 rounded-full bg-raised/95 border border-edge-strong text-2xs font-medium text-body-dim hover:text-strong shadow-lg transition-colors"
    >
      {label} ↓
    </button>
  );
}
