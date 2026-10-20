// YouTube IFrame Player API adapter.
//
// TWO SCALES. YouTube's volume is 0-100; every other volume in this app is
// 0-1 (playerVolume.ts). Both crossings convert.
//
// NO PICTURE-IN-PICTURE, NO BACKGROUND AUDIO. Neither exists in this API,
// and YouTube blocks background playback deliberately. Do not look for them.
//
// NO QUALITY CONTROL. setPlaybackQuality is deprecated and ignored, which is
// why CAPABILITIES.youtube.quality is false.
import { CAPABILITIES, type AdapterVolume, type PlayerAdapter, type PlayerEvent } from "@/app/lib/playerAdapter";

/** Why playback failed, in words a viewer can act on. */
// @test-only youtubeAdapter.test.ts asserts these strings directly; production
// only reads this map from inside this same file's onError handler, and the
// orphan scan does not count a same-file reference.
export const YT_ERROR_REASON: Record<number, string> = {
  2: "This video link is malformed.",
  5: "This video can't play in this browser.",
  100: "This video was removed or made private.",
  101: "The owner doesn't allow this video to play outside YouTube.",
  150: "The owner doesn't allow this video to play outside YouTube.",
  153: "YouTube refused the request from this page.",
};

/**
 * How far back the playhead must jump before we call it a deliberate rewind.
 * Small negative deltas happen on their own during buffering.
 */
// @test-only youtubeAdapter.test.ts drives this threshold directly; production
// only reads it inside this same file's onStateChange handler.
export const SEEK_BACK_S = 5;

type YouTubePlayer = {
  getDuration(): number;
  getCurrentTime(): number;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getVolume(): number;
  setVolume(v: number): void;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  playVideo(): void;
  destroy(): void;
};

type YouTubeApi = {
  Player: new (element: unknown, config: { events: Record<string, (e: { data: unknown }) => void> }) => YouTubePlayer;
};

export function createYouTubeAdapter(deps: { YT: YouTubeApi; element: unknown }): PlayerAdapter {
  const listeners = new Set<(e: PlayerEvent) => void>();
  const emit = (e: PlayerEvent) => { for (const l of listeners) l(e); };

  let lastTime: number | null = null;
  // Set while WE move the playhead, so our own seek is never read as a rewind.
  let selfSeeking = false;
  let sawRewind = false;

  const player = new deps.YT.Player(deps.element, {
    events: {
      onReady: () => emit({ kind: "ready" }),
      onError: (e) => {
        const code = Number(e?.data ?? 0);
        emit({ kind: "error", code, reason: YT_ERROR_REASON[code] ?? "This video can't play here." });
      },
      onAutoplayBlocked: () => emit({ kind: "blocked" }),
      onStateChange: () => {
        // YouTube publishes no seek event. A backward discontinuity across a
        // state change is the only signal a viewer rewound — and a seek always
        // produces state changes (buffering, then playing), so sampling here
        // catches it without polling.
        const now = safe(() => player.getCurrentTime(), null);
        if (now !== null && lastTime !== null && !selfSeeking && now < lastTime - SEEK_BACK_S && !sawRewind) {
          sawRewind = true;
          emit({ kind: "seekedBack" });
        }
        selfSeeking = false;
        if (now !== null) lastTime = now;
      },
    },
  });

  /** The API throws if the frame is gone; a dead player must not take the page with it. */
  function safe<T>(fn: () => T, fallback: T): T {
    try { return fn(); } catch { return fallback; }
  }

  return {
    source: "youtube",
    capabilities: CAPABILITIES.youtube,

    setVolume(volume) { safe(() => player.setVolume(Math.round(volume * 100)), undefined); },
    setMuted(muted) { safe(() => (muted ? player.mute() : player.unMute()), undefined); },
    readVolume(): AdapterVolume | null {
      return safe(() => ({ volume: player.getVolume() / 100, muted: player.isMuted() }), null);
    },

    drift() {
      // getDuration() is elapsed-since-start for a live event, so this is the
      // distance from the live edge — INCLUDING YouTube's own inherent
      // latency. Only its GROWTH is meaningful; see liveEdge.ts.
      return safe(() => {
        const d = player.getDuration();
        const c = player.getCurrentTime();
        if (!Number.isFinite(d) || !Number.isFinite(c) || d <= 0) return null;
        return d - c;
      }, null);
    },

    goLive() {
      safe(() => {
        const d = player.getDuration();
        if (!Number.isFinite(d) || d <= 0) return;
        // Already at (or within jitter distance of) the edge: a seek here
        // would be a no-op, and YouTube may then fire no onStateChange at
        // all — the only place `selfSeeking` ever gets cleared. Left set, it
        // would swallow the viewer's NEXT genuine rewind. Compare against
        // the LIVE playhead (getCurrentTime()), not the last onStateChange
        // sample: onStateChange fires no events for minutes during steady
        // playback, so a stale `lastTime` reads a since-drifted position as
        // current and misses a since-arrived no-op seek. Skip flagging (and
        // the redundant seek) rather than risk a flag nothing ever clears.
        const now = player.getCurrentTime();
        if (Number.isFinite(now) && d - now <= SEEK_BACK_S) return;
        selfSeeking = true;
        player.seekTo(d, true);
        lastTime = d;
      }, undefined);
    },

    play() { safe(() => player.playVideo(), undefined); },

    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    destroy() {
      listeners.clear();
      safe(() => player.destroy(), undefined);
    },
  };
}
