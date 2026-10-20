// derivePlayerStats — the thin player's diagnostics derivation. Pinned here
// because the transport that feeds it can't be tested; the math and the health
// thresholds are the part a refactor could silently bend.
//
// Run: node --test app/lib/playerStats.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { derivePlayerStats, type StatsSample } from "./playerStats.ts";

const base: StatsSample = {
  t: 0, audioLost: 0, audioRecv: 0, videoLost: 0, videoRecv: 0,
  bytes: 0, jitter: 0, resolution: null,
};
const at = (over: Partial<StatsSample>): StatsSample => ({ ...base, ...over });

test("clean interval → good health, correct bitrate", () => {
  const s = derivePlayerStats(
    at({ t: 0, bytes: 0, audioRecv: 0 }),
    at({ t: 1000, bytes: 125_000, audioRecv: 500, jitter: 0.005, resolution: "1280×720" })
  );
  assert.equal(s.audioLossPct, 0);
  assert.equal(s.audioJitterMs, 5);
  assert.equal(s.bitrateKbps, 1000); // 125000 B over 1s = 1 Mbit/s
  assert.equal(s.resolution, "1280×720");
  assert.equal(s.health, "good");
});

test("loss % is computed on the DELTA, not the totals", () => {
  // Totals carry history (900 lost before this window); only the window counts.
  const s = derivePlayerStats(
    at({ t: 0, audioLost: 900, audioRecv: 9000 }),
    at({ t: 1000, audioLost: 902, audioRecv: 9098 })
  );
  assert.equal(s.audioLossPct, 2); // 2 of 100 in-window
});

test("health bands: audio-driven — <1% good, <5% ok, else poor", () => {
  const lossPct = (lost: number, recv: number) =>
    derivePlayerStats(at({}), at({ t: 1000, audioLost: lost, audioRecv: recv })).health;
  assert.equal(lossPct(0, 1000), "good");
  assert.equal(lossPct(20, 980), "ok");     // 2%
  assert.equal(lossPct(60, 940), "poor");   // 6%
  // Video loss alone never degrades the verdict (talk stream: audio is what
  // viewers notice) — it is displayed, not judged.
  const videoOnly = derivePlayerStats(at({}), at({ t: 1000, videoLost: 500, videoRecv: 500, audioRecv: 1000 }));
  assert.equal(videoOnly.videoLossPct, 50);
  assert.equal(videoOnly.health, "good");
});

test("high jitter alone drops good → ok (loss still under 5%)", () => {
  const s = derivePlayerStats(at({}), at({ t: 1000, audioRecv: 1000, jitter: 0.04 }));
  assert.equal(s.audioJitterMs, 40);
  assert.equal(s.health, "ok");
});

test("zero-division guards: no packets and no elapsed time → zeros, not NaN", () => {
  const s = derivePlayerStats(at({}), at({ t: 0 }));
  assert.equal(s.audioLossPct, 0);
  assert.equal(s.videoLossPct, 0);
  assert.equal(s.bitrateKbps, 0);
  assert.ok(Number.isFinite(s.audioLossPct + s.videoLossPct + s.bitrateKbps));
});

test("a counter reset never prints negative numbers", () => {
  // A sample pair spanning two peer connections (the counters restart at 0).
  // The caller re-seeds on every negotiation, but the derivation must not
  // depend on it.
  const s = derivePlayerStats(
    at({ t: 0, audioLost: 50, audioRecv: 5000, videoLost: 10, videoRecv: 9000, bytes: 9_000_000 }),
    at({ t: 1000, audioLost: 0, audioRecv: 100, videoLost: 0, videoRecv: 200, bytes: 100 })
  );
  assert.ok(s.audioLossPct >= 0, `audio loss ${s.audioLossPct}`);
  assert.ok(s.videoLossPct >= 0, `video loss ${s.videoLossPct}`);
  assert.ok(s.bitrateKbps >= 0, `bitrate ${s.bitrateKbps}`);
});

test("only the LOST counter resetting drives the ratio negative — the loss clamps must catch it", () => {
  // The sums stay positive (received keeps climbing), so this reaches the
  // Math.max(0, …) on the loss percentages, which the previous test cannot.
  const s = derivePlayerStats(
    at({ t: 0, audioLost: 50, audioRecv: 1000, videoLost: 10, videoRecv: 1000 }),
    at({ t: 1000, audioLost: 0, audioRecv: 1500, videoLost: 0, videoRecv: 1500 })
  );
  assert.equal(s.audioLossPct, 0, "dAL = -50 over a +450 window must clamp, not print -11.1%");
  assert.equal(s.videoLossPct, 0, "dVL = -10 over a +490 window must clamp, not print -2.0%");
  assert.equal(s.health, "good");
});
