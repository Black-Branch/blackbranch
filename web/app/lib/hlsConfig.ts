// hls.js configuration for the in-house player's compatibility mode —
// ONE literal, exported so the test can CONSTRUCT it. hls.js validates
// the user-supplied config (not the merged defaults) and throws when
// liveMaxLatencyDurationCount is given without liveSyncDurationCount,
// which a source scan of the component can never see: such a config is green
// in every scan and fails instantly for every non-Safari viewer.
import type { HlsConfig } from "hls.js";

export const HLS_CONFIG: Partial<HlsConfig> = {
  // The default, stated because the catch-up below is gated on it.
  lowLatencyMode: true,
  // hls.js's own default, restated because its validator rejects
  // liveMaxLatencyDurationCount without a companion liveSyncDurationCount.
  liveSyncDurationCount: 3,
  // hls.js only nudges playback toward the live edge when this is above 1
  // (its latency controller returns early at exactly 1), and only seeks
  // there when the max latency is finite. Without both, a phone that slept
  // 40s stayed 40s behind chat until the viewer hit ↻.
  maxLiveSyncPlaybackRate: 1.5,
  liveMaxLatencyDurationCount: 10,
  // Mux, "An hls.js cautionary tale: QoE and video player memory":
  // hls.js's default back buffer is Infinity: every second already played stays
  // in the SourceBuffer for the whole session, and a live stream never ends.
  // Our HLS mode has no rewind UI, so 30 s is plenty for a seek-back nudge.
  backBufferLength: 30,
  // Never pick a rendition larger than the player box. A no-op while
  // stream.place serves one 1080p60 level — and right the day it ships a ladder.
  capLevelToPlayerSize: true,
};
