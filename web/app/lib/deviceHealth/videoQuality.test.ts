// Run: node --test app/lib/deviceHealth/videoQuality.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { emptyVideoAcc, foldVideoSample, readInboundVideo, readVideoElement, videoReport } from "./videoQuality.ts";

const reports = (o: { decoded: number; decodeS: number; bytes: number; dropped?: number; freezes?: number }) => [
  { type: "inbound-rtp", kind: "audio", bytesReceived: 1000 },
  { type: "inbound-rtp", kind: "video", frameWidth: 1920, frameHeight: 1080, framesPerSecond: 59.94,
    framesDecoded: o.decoded, framesDropped: o.dropped ?? 0, totalDecodeTime: o.decodeS,
    freezeCount: o.freezes ?? 0, totalFreezesDuration: 0.5, bytesReceived: o.bytes },
  { type: "candidate-pair", bytesReceived: 999999 },
];

test("reads the received resolution, fps, decode time and bytes (video + audio, not the candidate pair)", () => {
  const s = readInboundVideo(reports({ decoded: 600, decodeS: 3, bytes: 5000, dropped: 4, freezes: 1 }));
  assert.deepEqual(s, { mode: "webrtc", w: 1920, h: 1080, fps: 59.94, decoded: 600, dropped: 4, decodeS: 3, freezes: 1, freezeS: 0.5, bytes: 6000 });
});

test("no inbound video → null; a browser that counts nothing → nulls, never a fake 0 decode time", () => {
  assert.equal(readInboundVideo([{ type: "inbound-rtp", kind: "audio", bytesReceived: 5 }]), null);
  const s = readInboundVideo([{ type: "inbound-rtp", kind: "video" }]);
  assert.equal(s?.decodeS, null);
  const acc = emptyVideoAcc();
  foldVideoSample(acc, s!);
  assert.equal(videoReport(acc)?.decodeMs, null);
});

test("decode ms per frame is the session mean", () => {
  const acc = emptyVideoAcc();
  foldVideoSample(acc, readInboundVideo(reports({ decoded: 1000, decodeS: 4, bytes: 10 }))!);
  assert.equal(videoReport(acc)?.decodeMs, 4);
});

test("a reconnect (counters back near 0) banks the old peer connection's totals", () => {
  const acc = emptyVideoAcc();
  foldVideoSample(acc, readInboundVideo(reports({ decoded: 1000, decodeS: 4, bytes: 100_000, dropped: 10 }))!);
  foldVideoSample(acc, readInboundVideo(reports({ decoded: 2000, decodeS: 8, bytes: 200_000, dropped: 20 }))!);
  foldVideoSample(acc, readInboundVideo(reports({ decoded: 50, decodeS: 1, bytes: 3000, dropped: 1 }))!); // new pc
  const r = videoReport(acc)!;
  assert.equal(r.decoded, 2050);
  assert.equal(r.dropped, 21);
  assert.equal(r.bytes, 201_000 + 4000);
  assert.equal(r.decodeMs, Math.round((9 * 1000 / 2050) * 100) / 100);
});

test("HLS stands in with the element's playback quality, and has no decode time", () => {
  const s = readVideoElement({ videoWidth: 1280, videoHeight: 720, getVideoPlaybackQuality: () => ({ totalVideoFrames: 300, droppedVideoFrames: 3 }) });
  const acc = emptyVideoAcc();
  foldVideoSample(acc, s);
  assert.deepEqual(videoReport(acc), { w: 1280, h: 720, fps: null, decoded: 300, dropped: 3, decodeMs: null, freezes: 0, freezeMs: 0, bytes: 0, mode: "hls" });
  assert.equal(videoReport(emptyVideoAcc()), null, "nothing sampled → null");
});
