// Twitch Player API adapter.
//
// THEIR API BUILDS THE IFRAME. Unlike YouTube's, which attaches to an
// existing frame, Twitch.Player constructs its own inside a container element
// we give it by id. That is why TwitchPlayer.tsx renders a container rather
// than an iframe.
//
// THERE IS NO LIVE SEEK. seek() is documented VOD-only, so the only way back
// to the edge is setChannel() to the same channel, which reloads the stream.
// Crude — a brief black — which is why the policy only ever fires it on return
// from a hidden tab (liveEdge.ts).
//
// THERE IS NO destroy(). Teardown removes our listeners; the caller empties
// the container.
//
// Volume here is ALREADY 0.0-1.0, matching playerVolume.ts. Do not scale it
// (YouTube's 0-100 is the odd one out).
//
// There is no error event carrying a cause, which is why
// CAPABILITIES.twitch.errorDetail is false.
import { CAPABILITIES, type AdapterVolume, type PlayerAdapter, type PlayerEvent } from "@/app/lib/playerAdapter";

type TwitchPlayerInstance = {
  addEventListener(event: string, cb: () => void): void;
  removeEventListener(event: string, cb: () => void): void;
  getPlaybackStats(): { hlsLatencyBroadcaster?: number } | null;
  setChannel(channel: string): void;
  getVolume(): number;
  setVolume(v: number): void;
  getMuted(): boolean;
  setMuted(m: boolean): void;
  play(): void;
};

type TwitchApi = {
  Player: (new (containerId: string, options: Record<string, unknown>) => TwitchPlayerInstance) & {
    ONLINE: string; OFFLINE: string; PLAYBACK_BLOCKED: string; READY: string; PLAYING: string;
  };
};

export function createTwitchAdapter(deps: {
  Twitch: TwitchApi;
  containerId: string;
  channel: string;
  parent: string;
  muted: boolean;
}): PlayerAdapter {
  const listeners = new Set<(e: PlayerEvent) => void>();
  const emit = (e: PlayerEvent) => { for (const l of listeners) l(e); };

  const player = new deps.Twitch.Player(deps.containerId, {
    channel: deps.channel,
    parent: [deps.parent],
    autoplay: true,
    muted: deps.muted,
    width: "100%",
    height: "100%",
  });

  function safe<T>(fn: () => T, fallback: T): T {
    try { return fn(); } catch { return fallback; }
  }

  // Kept so destroy() can remove exactly what it added.
  const wired: [string, () => void][] = [
    [deps.Twitch.Player.READY, () => emit({ kind: "ready" })],
    [deps.Twitch.Player.ONLINE, () => emit({ kind: "online" })],
    [deps.Twitch.Player.OFFLINE, () => emit({ kind: "offline" })],
    [deps.Twitch.Player.PLAYBACK_BLOCKED, () => emit({ kind: "blocked" })],
  ];
  for (const [evt, cb] of wired) safe(() => player.addEventListener(evt, cb), undefined);

  return {
    source: "twitch",
    capabilities: CAPABILITIES.twitch,

    setVolume(volume) { safe(() => player.setVolume(volume), undefined); },
    setMuted(muted) { safe(() => player.setMuted(muted), undefined); },
    readVolume(): AdapterVolume | null {
      return safe(() => ({ volume: player.getVolume(), muted: player.getMuted() }), null);
    },

    drift() {
      return safe(() => {
        const s = player.getPlaybackStats();
        const l = s?.hlsLatencyBroadcaster;
        return typeof l === "number" && Number.isFinite(l) ? l : null;
      }, null);
    },

    goLive() { safe(() => player.setChannel(deps.channel), undefined); },
    play() { safe(() => player.play(), undefined); },

    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    destroy() {
      listeners.clear();
      for (const [evt, cb] of wired) safe(() => player.removeEventListener(evt, cb), undefined);
    },
  };
}
