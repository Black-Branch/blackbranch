// Pure derivation for the thin player's diagnostics panel: two consecutive
// getStats samples → loss % / jitter / bitrate / health. Lives here so it can
// be unit-tested — the RTCPeerConnection transport can't. Same split as
// whepEscalation.ts (reconnect policy) and playerVolume.ts.

export type StatsSample = {
  /** ms timestamp (performance.now() at sample time) */
  t: number;
  audioLost: number;
  audioRecv: number;
  videoLost: number;
  videoRecv: number;
  /** total inbound-rtp bytesReceived across kinds */
  bytes: number;
  /** audio jitter in SECONDS — the WebRTC stats unit */
  jitter: number;
  resolution: string | null;
};

export type PlayerStats = {
  audioLossPct: number;
  audioJitterMs: number;
  videoLossPct: number;
  bitrateKbps: number;
  resolution: string | null;
  health: "good" | "ok" | "poor";
};

// Health is driven by AUDIO: for a talk stream, crackle is the failure viewers
// actually notice; video loss shows in the panel but doesn't move the verdict.
export function derivePlayerStats(prev: StatsSample, cur: StatsSample): PlayerStats {
  const dAL = cur.audioLost - prev.audioLost;
  const dAR = cur.audioRecv - prev.audioRecv;
  const dVL = cur.videoLost - prev.videoLost;
  const dVR = cur.videoRecv - prev.videoRecv;
  const dt = (cur.t - prev.t) / 1000;
  // Clamped at 0: a pair spanning two peer connections (counters reset) would
  // otherwise print negative loss and bitrate.
  const audioLossPct = dAL + dAR > 0 ? Math.max(0, (dAL / (dAL + dAR)) * 100) : 0;
  const videoLossPct = dVL + dVR > 0 ? Math.max(0, (dVL / (dVL + dVR)) * 100) : 0;
  const bitrateKbps = dt > 0 ? Math.max(0, ((cur.bytes - prev.bytes) * 8) / dt / 1000) : 0;
  const audioJitterMs = cur.jitter * 1000;
  const health: PlayerStats["health"] =
    audioLossPct < 1 && audioJitterMs < 30 ? "good" : audioLossPct < 5 ? "ok" : "poor";
  return { audioLossPct, audioJitterMs, videoLossPct, bitrateKbps, resolution: cur.resolution, health };
}
