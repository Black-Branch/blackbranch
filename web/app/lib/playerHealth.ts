// The player half of the device-health report.
//
// A module-level record: the players WRITE it (which source is up, whether it is seen, what it
// sounds like, what video it received), and DeviceHealthReporter READS it. Both halves exist on
// purpose — a counter that is written and never read measures nothing, and report.test.ts asserts
// that every field here reaches the report.
//
// MEASUREMENT ONLY. Nothing here pauses, rests or changes a player — an off-screen or backgrounded
// player is never paused. Seen/unseen time is recorded so a post-stream read can see what phones
// were doing; it drives nothing.
import type { VideoSample } from "./deviceHealth/videoQuality.ts";

export type PlayerAudio = { silent: boolean | null; vol: number | null };

type State = {
  src: string;
  seen: boolean;
  folded: boolean;
  audio: PlayerAudio;
  mountedMs: number;
  unseenMs: number;
  silentUnseenMs: number;
  foldedMs: number;
  at: number | null;
  audioProbe: (() => PlayerAudio | null) | null;
  videoProbe: (() => Promise<VideoSample | null>) | null;
};

function fresh(): State {
  return {
    src: "none", seen: true, folded: false, audio: { silent: null, vol: null },
    mountedMs: 0, unseenMs: 0, silentUnseenMs: 0, foldedMs: 0,
    at: null, audioProbe: null, videoProbe: null,
  };
}

let s = fresh();

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Bank the time since the last change into whichever buckets the current state is in. */
function tick(t: number): void {
  if (s.at !== null) {
    const dt = Math.max(0, t - s.at);
    if (s.folded) s.foldedMs += dt;
    if (s.src !== "none") {
      s.mountedMs += dt;
      if (!s.seen) {
        s.unseenMs += dt;
        if (s.audio.silent === true) s.silentUnseenMs += dt;
      }
    }
  }
  s.at = t;
}

/** Which player is mounted: "native" (the site's own), "streamplace" (the embed), "youtube", "twitch",
 *  "replay", "community", "radio" — or "none". */
export function setPlayerSrc(src: string, t = now()): void {
  tick(t);
  if (src !== s.src) s.audio = { silent: null, vol: null };
  s.src = src;
}

/** Is the player box on screen in a visible page? (usePlayerSeen) */
export function setPlayerSeen(seen: boolean, t = now()): void {
  tick(t);
  s.seen = seen;
}

/** The video panel closed (the player is unmounted) — time spent so is its own bucket. */
export function setPlayerFolded(folded: boolean, t = now()): void {
  tick(t);
  s.folded = folded;
}

/** What the viewer hears. `silent: null` = unknown (an iframe we cannot read). */
export function setPlayerAudio(a: PlayerAudio, t = now()): void {
  tick(t);
  s.audio = a;
}

/** A player that can be asked about its audio at report time registers here; returns an unregister. */
export function registerAudioProbe(fn: () => PlayerAudio | null): () => void {
  s.audioProbe = fn;
  return () => { if (s.audioProbe === fn) s.audioProbe = null; };
}

/** The in-house player registers its video sampler here; returns an unregister. */
export function registerVideoProbe(fn: () => Promise<VideoSample | null>): () => void {
  s.videoProbe = fn;
  return () => { if (s.videoProbe === fn) s.videoProbe = null; };
}

/** Ask the registered probes once (the reporter calls this on its own timer, while visible) and
 *  return the video sample, if any — the reporter owns the session total, so the code that folds
 *  samples stays out of the first-load JS. */
export async function samplePlayer(): Promise<VideoSample | null> {
  try {
    const a = s.audioProbe?.();
    if (a) setPlayerAudio(a);
  } catch { /* an unreadable player is "unknown", never an error */ }
  const probe = s.videoProbe;
  if (!probe) return null;
  try {
    return await probe();
  } catch {
    return null;
  }
}

export type PlayerReport = {
  src: string; silent: boolean | null; vol: number | null;
  mountedMs: number; unseenMs: number; silentUnseenMs: number; foldedMs: number;
};

/** The player block of the report, as of `t`. */
export function playerSnapshot(t = now()): PlayerReport {
  tick(t);
  return {
    src: s.src,
    silent: s.audio.silent,
    vol: s.audio.vol === null ? null : Math.round(s.audio.vol * 1000) / 1000,
    mountedMs: Math.round(s.mountedMs),
    unseenMs: Math.round(s.unseenMs),
    silentUnseenMs: Math.round(s.silentUnseenMs),
    foldedMs: Math.round(s.foldedMs),
  };
}

/** @test-only each render test starts from an empty record; production never resets it */
export function resetPlayerHealth(): void {
  s = fresh();
}
