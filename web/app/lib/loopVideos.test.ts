// Tests for the community fallback playlist (migrate-v77) — the videos the
// community player loops when NOBODY is live.
//
// Run: node --test app/lib/loopVideos.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { loopPlaylistSrc } from "./loopPlaylist.ts";
import { parseYoutubeVideoId, youtubeVideoIdFromUrl } from "./youtubeId.ts";
import { availableSources, fallbackSource, type PlayerState } from "./playerSource.ts";

const FB = ["radio"] as const; // the registered fallback this install has (app/(owner)/player.ts)

type LoopVideo = { video_id: string; title: string | null };

const vid = (video_id: string): LoopVideo => ({ video_id, title: null });

// The legacy state fallbackSource reads back. Offline it is not consulted —
// only the live branch answers with where the viewer last watched.
const prev: PlayerState = { tab: "radio", active: "sp", spThinPlayer: false };

// ─── the embed URL ────────────────────────────────────────────────────────────

test("an empty playlist yields no src", () => {
  assert.equal(loopPlaylistSrc([]), null, "the caller must render nothing, not a broken embed");
});

test("the first id goes in the PATH and playlist= carries only the REST", () => {
  // Putting the whole list in `playlist=` plays the first video twice per lap.
  const src = loopPlaylistSrc([vid("aaa1"), vid("bbb2"), vid("ccc3")])!;
  const u = new URL(src);
  assert.equal(u.pathname, "/embed/aaa1");
  assert.equal(u.searchParams.get("playlist"), "bbb2,ccc3");
});

test("a SINGLE video repeats its own id, or it does not loop", () => {
  // With loop=1 alone a one-video embed plays once and stops on the end screen.
  const u = new URL(loopPlaylistSrc([vid("solo1")])!);
  assert.equal(u.pathname, "/embed/solo1");
  assert.equal(u.searchParams.get("playlist"), "solo1", "the id must repeat for a 1-video loop");
});

test("autoplay is muted — browsers block unmuted autoplay", () => {
  const u = new URL(loopPlaylistSrc([vid("aaa1")])!);
  assert.equal(u.searchParams.get("autoplay"), "1");
  assert.equal(u.searchParams.get("mute"), "1");
  assert.equal(u.searchParams.get("loop"), "1");
  assert.equal(u.searchParams.get("playsinline"), "1");
});

// ─── the source row ───────────────────────────────────────────────────────────

test("a configured playlist makes Community reachable while offline", () => {
  // getStatus only reports `community` for a LIVE streamer, so without this the
  // playlist would exist in the DB and be unreachable in the UI.
  assert.deepEqual(availableSources({ live: false, hasCommunity: true, fallbacks: FB }), ["community", "radio"]);
  assert.deepEqual(availableSources({ live: false, hasCommunity: false, fallbacks: FB }), ["radio"]);
});

test("the offline fallback source stays valid either way", () => {
  for (const hasCommunity of [true, false]) {
    const d = fallbackSource({ live: false, hasCommunity, fallbacks: FB }, prev);
    assert.ok(
      availableSources({ live: false, hasCommunity, fallbacks: FB }).includes(d),
      `default source ${d} is not in the row (hasCommunity=${hasCommunity})`
    );
  }
});

// ─── what a mod can paste ─────────────────────────────────────────────────────

test("every YouTube URL shape a mod might paste resolves", () => {
  for (const [input, want] of [
    ["https://www.youtube.com/watch?v=60psYSeQoK8", "60psYSeQoK8"],
    ["https://youtu.be/60psYSeQoK8?t=42", "60psYSeQoK8"],
    ["https://www.youtube.com/shorts/-5Ej2NdoOkY", "-5Ej2NdoOkY"],
    ["https://www.youtube.com/embed/60psYSeQoK8", "60psYSeQoK8"],
    ["https://m.youtube.com/watch?v=60psYSeQoK8", "60psYSeQoK8"],
    ["www.youtube.com/watch?v=60psYSeQoK8", "60psYSeQoK8"],  // no scheme
    ["60psYSeQoK8", "60psYSeQoK8"],                           // bare id
    ["  60psYSeQoK8  ", "60psYSeQoK8"],
  ] as [string, string][]) {
    assert.equal(parseYoutubeVideoId(input), want, `failed on ${input}`);
  }
});

test("things that are NOT a video id are refused", () => {
  // Being lenient here turns a typo into a dead embed sitting in the rotation.
  for (const bad of [
    "",
    "   ",
    "not a video",
    "https://vimeo.com/12345",
    "https://www.youtube.com/@somechannel",           // a channel, not a video
    "https://www.youtube.com/channel/UC1ImmfXBRkBBQ19RJg65Iyg",
    "example.com",                                    // bare host, not an id
  ]) {
    assert.equal(parseYoutubeVideoId(bad), null, `accepted junk: ${JSON.stringify(bad)}`);
  }
});

test("the URL-only parser rejects a bare id (the shared/OG path)", () => {
  // youtubeVideoIdFromUrl backs link previews, where a bare word is not a video.
  assert.equal(youtubeVideoIdFromUrl("60psYSeQoK8"), null);
  assert.equal(youtubeVideoIdFromUrl("https://youtu.be/60psYSeQoK8"), "60psYSeQoK8");
});
