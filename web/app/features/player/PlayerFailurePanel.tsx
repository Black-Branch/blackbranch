"use client";
// The only two surfaces the adapter program adds, and both are failure-only.
//
// They replace a black rectangle: without them a refused autoplay and an embed
// whose owner disabled it look identical — nothing, forever — and the viewer
// cannot tell "tap to start" from "this will never work".
//
// NEITHER OFFERS A SOURCE SWITCH, and neither writes a preference. The way
// out is the source rail that already exists. An automatic demotion that writes
// a persisted preference strands viewers on a worse player for whole sessions
// (see NO AUTOMATIC DEMOTION in StreamplaceThinPlayer); a panel that quietly
// relocates them is the same defect wearing a button.
import { Play, X } from "@phosphor-icons/react/dist/ssr";

export function PlayerFailurePanel({ blocked, failure, onPlay, onDismiss }: {
  blocked: boolean;
  failure: { code: number; reason: string } | null;
  onPlay: () => void;
  onDismiss: () => void;
}) {
  // Conditional things hold no permanent space.
  if (!blocked && !failure) return null;

  // Check failure BEFORE blocked: both can be true at once (independent events).
  // A real error always wins; a dead control with no explanation is worse than
  // a play button that does nothing.
  if (failure) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-scrim-heavy px-6 text-center">
        <p className="text-sm text-body-dim">{failure.reason}</p>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss this message"
          className="flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1.5 text-xs text-body-dim hover:bg-surface-3"
        >
          <X size={12} weight="bold" />
          Dismiss
        </button>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-scrim">
      <button
        type="button"
        onClick={onPlay}
        aria-label="Play the stream"
        className="flex h-14 w-14 items-center justify-center rounded-full bg-surface-2 text-strong hover:bg-surface-3"
      >
        <Play size={24} weight="fill" />
      </button>
    </div>
  );
}
