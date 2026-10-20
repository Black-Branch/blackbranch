// One interface over the two third-party players, plus the table of what each
// can actually do.
//
// WHY A CAPABILITY TABLE AND NOT `if (source === "twitch")`. The two APIs are
// asymmetric in ways that are easy to forget and impossible to see at a call
// site: Twitch's seek() is VOD-only so there is no live seek at all, and
// YouTube publishes no latency figure. Encoding that as data means a component
// reads a value rather than remembering a caveat, and a new source cannot ship
// with a silently missing answer (playerAdapter.test.ts asserts every field).
//
// Neither API can give us picture-in-picture or background audio. Both need a
// handle on the <video> element; these APIs are postMessage command channels
// and expose no element, and YouTube blocks background playback deliberately.
// Do not add capabilities for them.
import type { LiveEdgeLever } from "./liveEdge";

export type AdapterSource = "youtube" | "twitch";

export type PlayerCapabilities = {
  /** Can we read and write volume/mute? */
  volume: boolean;
  /** What this player can do about drift. */
  liveEdge: LiveEdgeLever;
  /** Can it report seconds behind the broadcaster? */
  latency: boolean;
  /**
   * Can the PLATFORM enumerate and choose quality?
   *
   * True does NOT mean a call site can do it. Twitch's quality is API-only —
   * `getQualities()`/`setQuality()` exist and the iframe has no equivalent — but
   * Twitch's own control bar already offers it to the viewer, so `PlayerAdapter`
   * deliberately exposes no quality method rather than shipping one with no
   * reader. Add the method with a unified control bar, if that ever happens.
   */
  quality: boolean;
  /** Does it tell us when the browser refused autoplay? */
  blockedEvent: boolean;
  /** Does it distinguish WHY playback failed, not just that it did? */
  errorDetail: boolean;
};

export const CAPABILITIES: Record<AdapterSource, PlayerCapabilities> = {
  youtube: {
    volume: true,
    liveEdge: "seek",
    latency: false,
    quality: false, // setPlaybackQuality is deprecated and ignored.
    blockedEvent: true, // onAutoplayBlocked
    errorDetail: true, // codes 2 / 5 / 100 / 101 / 150 / 153
  },
  twitch: {
    volume: true,
    liveEdge: "reload", // setChannel() to the same channel; seek() is VOD-only.
    latency: true, // getPlaybackStats().hlsLatencyBroadcaster
    quality: true, // getQualities() / setQuality()
    blockedEvent: true, // PLAYBACK_BLOCKED
    errorDetail: false, // no error event carrying a cause
  },
};

/** What a player tells us. Deliberately small — we act on very little. */
export type PlayerEvent =
  /** The player finished its handshake — YouTube's onReady, Twitch's READY.
   *  Nothing sent before this is guaranteed to stick; it is the one honest
   *  moment to apply a persisted volume (usePlayerAdapter.ts). */
  | { kind: "ready" }
  /** The browser refused autoplay. Surface a tap-to-play; never retry blindly. */
  | { kind: "blocked" }
  /** Playback failed for a knowable reason. Never auto-move the viewer. */
  | { kind: "error"; code: number; reason: string }
  /** This SOURCE went live/offline. Never write app-wide `live` from these. */
  | { kind: "online" }
  | { kind: "offline" }
  /** The viewer rewound on their own — stand down from live-edge correction. */
  | { kind: "seekedBack" };

export type AdapterVolume = { volume: number; muted: boolean };

export type PlayerAdapter = {
  readonly source: AdapterSource;
  readonly capabilities: PlayerCapabilities;
  /** Apply our persisted audio state to the player. */
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  /** Read the player's audio state back, so a source switch carries it. Null if unreadable. */
  readVolume(): AdapterVolume | null;
  /** Seconds behind the live edge, or null when unmeasurable. */
  drift(): number | null;
  /** Apply this source's live-edge lever. A no-op when liveEdge is "none". */
  goLive(): void;
  /** Start playback after a refusal. */
  play(): void;
  /** Subscribe. Returns an unsubscribe. */
  on(listener: (e: PlayerEvent) => void): () => void;
  /** Remove listeners and drop the player handle. */
  destroy(): void;
};
