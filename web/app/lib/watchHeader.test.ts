// The watch page's title and follower count come from whichever platform is live, not Twitch alone.
// Run: node --test app/lib/watchHeader.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { followerTotal, watchTitle } from "./watchHeader.ts";

const rows = (...titles: (string | null)[]) => titles.map((title) => ({ title }));

test("a YouTube-only or Kick-only install shows its own live title", () => {
  assert.equal(watchTitle({ live: true, twitchLive: null, rows: rows(null, "Live on YouTube", null), fallback: "" }), "Live on YouTube");
  assert.equal(watchTitle({ live: true, twitchLive: null, rows: rows(null, null, "Kick title"), fallback: "" }), "Kick title");
});

test("Twitch's live title wins when there is one; the fallback only when no platform has a title; offline is empty", () => {
  assert.equal(watchTitle({ live: true, twitchLive: "Twitch live", rows: rows("Twitch channel", "YT"), fallback: "F" }), "Twitch live");
  assert.equal(watchTitle({ live: true, twitchLive: null, rows: rows(null, null, null), fallback: "F" }), "F");
  assert.equal(watchTitle({ live: false, twitchLive: "Twitch live", rows: rows("YT"), fallback: "F" }), "");
});

test("followers add up across the platforms that report a count; none reporting = no count", () => {
  assert.equal(followerTotal([null, 1200]), 1200, "YouTube alone");
  assert.equal(followerTotal([300, 1200]), 1500);
  assert.equal(followerTotal([0, null]), 0, "a real zero is a count");
  assert.equal(followerTotal([null, null]), null);
});

test("the watch page reads both through these helpers", () => {
  const page = readFileSync(join(import.meta.dirname, "..", "(main)", "page.tsx"), "utf8");
  assert.match(page, /const streamTitle = watchTitle\(\{ live: isLive, twitchLive: twitchInfo\.title, rows: liveRows, fallback: process\.env\.STREAM_TITLE \?\? "" \}\);/);
  assert.match(page, /const followerCount = followerTotal\(\[twitchInfo\.followerCount, ytSubscribers\]\);/);
  assert.match(page, /\n\}\n$/, "END anchor");
});
