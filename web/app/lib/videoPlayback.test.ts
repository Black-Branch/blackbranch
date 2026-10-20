// videoPlayback.ts tests — how an m.video renders.
// Run: systemd-run --user --scope -p MemoryMax=8G --quiet node --test app/lib/videoPlayback.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { videoPlaybackMode, PREVIEW_MAX_BYTES } from "./videoPlayback.ts";

// The real `info` of a Discord gif as mautrix-discord bridges it, copied from a
// live event (tenor/klipy "gifs" are MP4s).
const BRIDGED_GIF_INFO = {
  "fi.mau.autoplay": true, "fi.mau.discord.gifv": true, "fi.mau.gif": true,
  "fi.mau.hide_controls": true, "fi.mau.loop": true, "fi.mau.no_audio": true,
  h: 498, mimetype: "video/mp4", size: 67560, w: 280,
};
// A real non-gif video from the same room: no fi.mau keys, no thumbnail.
const PLAIN_VIDEO_INFO = { h: 640, mimetype: "video/mp4", size: 425176, w: 640 };

test("a bridged Discord gif is a loop clip", () => {
  assert.equal(videoPlaybackMode(BRIDGED_GIF_INFO, false), "loop");
});

test("either the gif flag or the loop flag alone makes a loop clip", () => {
  assert.equal(videoPlaybackMode({ "fi.mau.gif": true, size: 1 }, false), "loop");
  assert.equal(videoPlaybackMode({ "fi.mau.loop": true, size: 1 }, false), "loop");
});

test("a flag that is present but not true does not make a loop clip", () => {
  assert.equal(videoPlaybackMode({ "fi.mau.loop": false, "fi.mau.gif": "yes", size: 1 }, false), "preview");
});

test("a small plain video shows a first-frame preview", () => {
  assert.equal(videoPlaybackMode(PLAIN_VIDEO_INFO, false), "preview");
  assert.equal(videoPlaybackMode({ size: PREVIEW_MAX_BYTES }, false), "preview", "the cap is inclusive");
});

test("a large plain video stays click-to-play — a preview would download the whole file (no Range on Synapse)", () => {
  assert.equal(videoPlaybackMode({ size: PREVIEW_MAX_BYTES + 1 }, false), "click");
});

test("an unknown size stays click-to-play", () => {
  assert.equal(videoPlaybackMode({ mimetype: "video/mp4" }, false), "click");
  assert.equal(videoPlaybackMode(undefined, false), "click");
  assert.equal(videoPlaybackMode({ size: "big" }, false), "click");
});

test("an encrypted video always previews — it is already fully downloaded to decrypt it", () => {
  assert.equal(videoPlaybackMode({ size: PREVIEW_MAX_BYTES * 10 }, true), "preview");
  assert.equal(videoPlaybackMode(undefined, true), "preview");
});

// Vacuity anchor at the END: the three modes are all reachable.
test("the helper genuinely discriminates", () => {
  const modes = new Set([
    videoPlaybackMode(BRIDGED_GIF_INFO, false),
    videoPlaybackMode(PLAIN_VIDEO_INFO, false),
    videoPlaybackMode({ size: PREVIEW_MAX_BYTES + 1 }, false),
  ]);
  assert.equal(modes.size, 3);
});
