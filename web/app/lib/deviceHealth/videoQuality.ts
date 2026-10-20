// What the in-house player actually received and decoded, for the device-health report. Pure:
// the player hands in getStats() reports or the <video> element's numbers; this turns
// them into one session total.
//
// getStats() counters are cumulative PER PEER CONNECTION. A reconnect builds a new pc whose
// counters start again at 0, so a plain "latest snapshot" would forget every frame before the
// reconnect — and reconnects are exactly the sessions worth reading. `foldVideoSample` notices the
// counters going backwards and banks the old pc's totals first.
//
// `decoderImplementation` / `powerEfficientDecoder` are deliberately not read: the W3C spec
// exposes them only while the page is CAPTURING (camera/mic), which our viewers never are, so they
// would be empty in every row.

export type VideoSample = {
  mode: "webrtc" | "hls";
  w: number; h: number;
  /** The browser's own receive frame rate, when it reports one. */
  fps: number | null;
  decoded: number; dropped: number;
  /** Seconds spent decoding (`totalDecodeTime`), WebRTC only. */
  decodeS: number | null;
  freezes: number; freezeS: number;
  /** Bytes received, video + audio (WebRTC only — HLS bytes are Resource Timing's `media`). */
  bytes: number;
};

/** The cumulative counters a sample carries — what a reconnect resets. */
type Totals = { decoded: number; dropped: number; decodeS: number; freezes: number; freezeS: number; bytes: number };
const ZERO: Totals = { decoded: 0, dropped: 0, decodeS: 0, freezes: 0, freezeS: 0, bytes: 0 };

export type VideoAcc = { base: Totals; last: VideoSample | null };

export function emptyVideoAcc(): VideoAcc {
  return { base: { ...ZERO }, last: null };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** One video sample from a getStats() report set, or null when it holds no inbound video. */
export function readInboundVideo(reports: Iterable<unknown>): VideoSample | null {
  let video: Record<string, unknown> | null = null;
  let bytes = 0;
  for (const r of reports) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    if (rec.type !== "inbound-rtp") continue;
    bytes += num(rec.bytesReceived) ?? 0;
    if (rec.kind === "video" && !video) video = rec;
  }
  if (!video) return null;
  return {
    mode: "webrtc",
    w: num(video.frameWidth) ?? 0,
    h: num(video.frameHeight) ?? 0,
    fps: num(video.framesPerSecond),
    decoded: num(video.framesDecoded) ?? 0,
    dropped: num(video.framesDropped) ?? 0,
    decodeS: num(video.totalDecodeTime),
    freezes: num(video.freezeCount) ?? 0,
    freezeS: num(video.totalFreezesDuration) ?? 0,
    bytes,
  };
}

/** The HLS stand-in: the element's own counters. No decode time exists on this path. */
export function readVideoElement(v: {
  videoWidth: number; videoHeight: number;
  getVideoPlaybackQuality?: () => { totalVideoFrames: number; droppedVideoFrames: number };
}): VideoSample {
  const q = v.getVideoPlaybackQuality?.();
  return {
    mode: "hls", w: v.videoWidth || 0, h: v.videoHeight || 0, fps: null,
    decoded: q?.totalVideoFrames ?? 0, dropped: q?.droppedVideoFrames ?? 0,
    decodeS: null, freezes: 0, freezeS: 0, bytes: 0,
  };
}

const totalsOf = (s: VideoSample): Totals => ({
  decoded: s.decoded, dropped: s.dropped, decodeS: s.decodeS ?? 0,
  freezes: s.freezes, freezeS: s.freezeS, bytes: s.bytes,
});

/** Fold a new sample in. A counter going backwards (or a transport switch) means a new source:
 *  the previous sample's totals are banked before the new one counts. */
export function foldVideoSample(acc: VideoAcc, s: VideoSample): void {
  const last = acc.last;
  if (last && (s.mode !== last.mode || s.decoded < last.decoded || s.bytes < last.bytes)) {
    const t = totalsOf(last);
    for (const k of Object.keys(t) as (keyof Totals)[]) acc.base[k] += t[k];
  }
  acc.last = s;
}

export type VideoReport = {
  w: number; h: number; fps: number | null; decoded: number; dropped: number;
  /** Mean decode time per frame in ms, or null where the browser does not count it. */
  decodeMs: number | null;
  freezes: number; freezeMs: number; bytes: number; mode: "webrtc" | "hls";
};

/** The session total, as the report carries it. Null before the first sample. */
export function videoReport(acc: VideoAcc): VideoReport | null {
  const s = acc.last;
  if (!s) return null;
  const b = acc.base;
  const decoded = b.decoded + s.decoded;
  const decodeS = b.decodeS + (s.decodeS ?? 0);
  const anyDecodeTime = s.decodeS !== null || b.decodeS > 0;
  return {
    w: s.w, h: s.h, fps: s.fps === null ? null : Math.round(s.fps * 10) / 10,
    decoded, dropped: b.dropped + s.dropped,
    decodeMs: anyDecodeTime && decoded > 0 ? Math.round((decodeS * 1000 / decoded) * 100) / 100 : null,
    freezes: b.freezes + s.freezes, freezeMs: Math.round((b.freezeS + s.freezeS) * 1000),
    bytes: b.bytes + s.bytes, mode: s.mode,
  };
}
