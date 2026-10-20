import { test } from "node:test";
import { siteName } from "./siteName.ts";
import assert from "node:assert/strict";
import {
  PLAYER_MODE_KEY, railModes, MODE_LABEL, parsePlayerMode, modeForTab, railTone, modeDetail,
  modeHasMenu, liveOptions, communityOptions,
} from "./playerMode.ts";

test("the key sits beside player_live_source and parses only known values", () => {
  assert.equal(PLAYER_MODE_KEY, "player_mode");
  assert.equal(parsePlayerMode("none"), "none");
  assert.equal(parsePlayerMode("live"), "live");
  assert.equal(parsePlayerMode("radio", ["radio"]), "radio", "a registered fallback's mode");
  assert.equal(parsePlayerMode("radio"), null, "…and not one with no plugin to play it");
  assert.equal(parsePlayerMode("replay"), null);
  assert.equal(parsePlayerMode(null), null);
});

test("the rail is Live · Community, then each registered fallback", () => {
  assert.deepEqual(railModes([]), ["live", "community"]);
  assert.deepEqual(railModes(["radio"]), ["live", "community", "radio"]);
  assert.deepEqual(MODE_LABEL, { live: "Live", community: "Community" });
});

test("a VOD replay sits under Live's slot; every tab maps to a rail mode", () => {
  assert.equal(modeForTab("live"), "live");
  assert.equal(modeForTab("replay"), "live");
  assert.equal(modeForTab("community"), "community");
  assert.equal(modeForTab("radio"), "radio");
});

test("tone table: grey nothing · white available · red live", () => {
  const base = { live: false, communityLive: false, hasPlaylist: false, fallbackUp: true };
  assert.equal(railTone("live", base), "off");
  assert.equal(railTone("live", { ...base, live: true }), "live");
  assert.equal(railTone("community", base), "off");
  assert.equal(railTone("community", { ...base, hasPlaylist: true }), "available");
  assert.equal(railTone("community", { ...base, communityLive: true }), "live");
  assert.equal(railTone("community", { ...base, communityLive: true, hasPlaylist: true }), "live");
  assert.equal(railTone("radio", base), "available");
  assert.equal(railTone("radio", { ...base, fallbackUp: false }), "off");
});

test("the expanded item's detail names the current option, plain", () => {
  const d = { liveSource: "twitch" as const, communityName: "icebeans", hasPlaylist: true, replay: false };
  assert.equal(modeDetail("live", d), "Twitch");
  assert.equal(modeDetail("live", { ...d, liveSource: "native" }), `${siteName()} player`);
  // Community never names the channel: the featured streamer's name is the
  // bottom bar's job, so the rail reads "Community" alone while someone is
  // live — the dropdown still lists their platforms.
  assert.equal(modeDetail("community", d), null);
  assert.equal(modeDetail("community", { ...d, communityName: null }), "Playlist");
  assert.equal(modeDetail("community", { ...d, hasPlaylist: false }), null, "a live channel still shows no name");
  assert.equal(modeDetail("community", { ...d, communityName: null, hasPlaylist: false }), null);
  assert.equal(modeDetail("radio", d), null);
  // A replay plays in Live's slot, so without this the rail said "Live · Twitch"
  // over a recording — the name of a source that is not what is playing. The
  // VOD's own title is the bottom bar's job, so this is just the word.
  assert.equal(modeDetail("live", { ...d, replay: true }), "Replay");
  assert.equal(modeDetail("live", { ...d, liveSource: "native", replay: true }), "Replay");
  // Replay only ever sits under Live; it must not leak into the other two.
  assert.equal(modeDetail("community", { ...d, replay: true }), null);
  assert.equal(modeDetail("community", { ...d, communityName: null, replay: true }), "Playlist");
  assert.equal(modeDetail("radio", { ...d, replay: true }), null);
});

test("Live always has a menu; Community only when there is a choice; Radio never", () => {
  // Live's four sources exist whatever the poll says, so its caret never
  // depends on state. Community's does: with one platform the caret would open
  // a menu whose only row is already checked.
  assert.equal(modeHasMenu("live", { communityPlatforms: 0 }), true);
  assert.equal(modeHasMenu("live", { communityPlatforms: 2 }), true);
  assert.equal(modeHasMenu("community", { communityPlatforms: 0 }), false);
  assert.equal(modeHasMenu("community", { communityPlatforms: 1 }), false);
  assert.equal(modeHasMenu("community", { communityPlatforms: 2 }), true);
  assert.equal(modeHasMenu("radio", { communityPlatforms: 2 }), false);
});

test("Live options: the four sources by name, current one checked, no other rows", () => {
  const rows = liveOptions("youtube");
  assert.deepEqual(rows.map((r) => r.label), [`${siteName()} player`, "stream.place", "YouTube", "Twitch"]);
  assert.deepEqual(rows.map((r) => r.checked), [false, false, true, false]);
  assert.deepEqual(rows.map((r) => r.key), ["native", "streamplace", "youtube", "twitch"]);
  assert.ok(rows.every((r) => typeof r.platform === "string"));
});

test("Community options: the featured streamer's platforms, the played one checked", () => {
  const sources = [{ platform: "youtube" }, { platform: "twitch" }];
  // No pick yet: the player shows the FIRST source, so that is what reads checked.
  const dflt = communityOptions(sources, null);
  assert.deepEqual(dflt.map((r) => r.label), ["YouTube", "Twitch"]);
  assert.deepEqual(dflt.map((r) => r.key), ["youtube", "twitch"]);
  assert.deepEqual(dflt.map((r) => r.checked), [true, false]);
  // A pick moves the check, and nothing else.
  assert.deepEqual(communityOptions(sources, "twitch").map((r) => r.checked), [false, true]);
  // An unknown platform keeps its raw name rather than vanishing from the menu.
  assert.deepEqual(
    communityOptions([{ platform: "kick" }, { platform: "rumble" }], null).map((r) => r.label),
    ["Kick", "rumble"]
  );
  assert.deepEqual(communityOptions([], null), []);
});
