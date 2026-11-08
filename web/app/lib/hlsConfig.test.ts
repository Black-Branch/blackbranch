// The "Smoother playback (adds delay)" switch: a viewer whose network drops
// packets trades delay for fewer stalls. Off by default.
//
// hls.js validates the config it is GIVEN and throws on a pair it does not
// accept, which no source scan can see (the 09-06 lesson: a scanned config
// was green and threw for every non-Safari viewer). So both configs are
// CONSTRUCTED here.
//
// Run: systemd-run --user --scope -p MemoryMax=8G env -u DATABASE_URL node --test app/lib/hlsConfig.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import Hls from "hls.js";
import "./testDom.ts";
import "./testTsx.ts"; // the registry's own imports are extensionless
import { hlsConfigFor, SMOOTH_JITTER_BUFFER_MS } from "./hlsConfig.ts";

test("Hls constructs with the smooth config, and it holds more of the stream back", () => {
  const smooth = hlsConfigFor(true);
  assert.equal(smooth.liveSyncDurationCount, 6);
  assert.equal(smooth.liveMaxLatencyDurationCount, 12);
  const made = new Hls(smooth);
  assert.equal(made.config.liveSyncDurationCount, 6, "hls.js did not take the sync count");
  assert.equal(made.config.liveMaxLatencyDurationCount, 12, "hls.js did not take the max latency");
  assert.equal(made.config.backBufferLength, 30, "everything else is the ordinary config");
  assert.equal(made.config.capLevelToPlayerSize, true);
  made.destroy();
});

test("switched off, the player gets the ordinary config", () => {
  const made = new Hls(hlsConfigFor(false));
  assert.equal(made.config.liveSyncDurationCount, 3);
  assert.equal(made.config.liveMaxLatencyDurationCount, 10);
  made.destroy();
});

test("the low-latency player's receive buffer: a real delay, inside what browsers accept", () => {
  // RTCRtpReceiver.jitterBufferTarget takes 0–4000 ms; a value outside throws.
  assert.ok(SMOOTH_JITTER_BUFFER_MS > 0 && SMOOTH_JITTER_BUFFER_MS <= 4000, String(SMOOTH_JITTER_BUFFER_MS));
});

test("the switch is a per-device viewer setting in Settings › Player, off by default", async () => {
  const { ENTRIES, DEFAULTS } = await import("./settingsRegistry.ts");
  const { SECTIONS } = await import("./settingsMenu.ts");
  const e = ENTRIES.playerSmooth;
  assert.ok(e, "playerSmooth is a setting");
  assert.equal(DEFAULTS.playerSmooth, false);
  assert.equal(e.prePaint, false, "nothing to paint before hydration");
  assert.equal(e.deviceLocal, true, "a network choice belongs to this device, never synced");
  assert.deepEqual(e.control, { kind: "toggle", label: "Smoother playback (adds delay)" });
  const player = SECTIONS.find((s) => s.title === "Player");
  assert.ok(player, "the Player section is there");
  assert.ok(player.items.some((i) => (i as { key?: string }).key === "playerSmooth"), "listed under Player");
});
