// The Stream tab's embed switches on the watch page: one setting (player.embedsOff), one pure rule
// for what the Live row offers, failing open.
// Run: node --test app/lib/playerEmbedsOff.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
import { availableSources, liveSourcesOn, liveSourceOn, liveSourcesSetUp } from "./playerSource.ts";
import { liveOptions, modeHasMenu } from "./playerMode.ts";
import { instanceEntry, parseInstanceValue } from "./instanceSchema.generated.mjs";

/** Stripped, with the raw file's last line proven to close the stripped text (a lost tail fails). */
const read = (rel: string) => {
  const raw = readFileSync(join(process.cwd(), rel), "utf8");
  const src = stripComments(raw);
  const last = raw.trimEnd().split("\n").pop()!;
  assert.ok(src.trimEnd().endsWith(last.trim()), `${rel}: the read lost the end of the file`);
  return src;
};

test("nothing switched off → every live source, in the Live row's order", () => {
  assert.deepEqual(liveSourcesOn([]), ["native", "streamplace", "youtube", "twitch"]);
  assert.deepEqual(availableSources({ live: true, hasCommunity: false, fallbacks: [] }), ["native", "streamplace", "youtube", "twitch"]);
});

test("a switched-off source leaves the Live row and the drop-down; unknown names are ignored", () => {
  const on = liveSourcesOn(["twitch", "kick", "bogus"]);
  assert.deepEqual(on, ["native", "streamplace", "youtube"]);
  assert.deepEqual(availableSources({ live: true, hasCommunity: true, fallbacks: ["radio"], liveOn: on }), ["native", "streamplace", "youtube", "community", "radio"]);
  assert.deepEqual(liveOptions("youtube", on).map((o) => o.key), ["native", "streamplace", "youtube"]);
  assert.deepEqual(liveOptions("youtube").map((o) => o.key), ["native", "streamplace", "youtube", "twitch"], "the default is all four");
  assert.deepEqual(availableSources({ live: false, hasCommunity: false, fallbacks: ["radio"], liveOn: on }), ["radio"], "offline is unchanged");
});

test("FAIL OPEN: a setting that switches every source off is ignored — a player with no source is a dark site", () => {
  assert.deepEqual(liveSourcesOn(["native", "streamplace", "youtube", "twitch"]), ["native", "streamplace", "youtube", "twitch"]);
});

test("a remembered source that is off plays the first one on; one that is on is kept", () => {
  assert.equal(liveSourceOn("twitch", ["native", "youtube"]), "native");
  assert.equal(liveSourceOn("youtube", ["native", "youtube"]), "youtube");
});

test("one source left is not a choice: no caret, no menu", () => {
  assert.equal(modeHasMenu("live", { communityPlatforms: 0 }), true);
  assert.equal(modeHasMenu("live", { communityPlatforms: 0, liveSources: 2 }), true);
  assert.equal(modeHasMenu("live", { communityPlatforms: 0, liveSources: 1 }), false);
});

test("the setting is one list of known names, edited at once, read by the website", () => {
  const e = instanceEntry("player.embedsOff");
  assert.ok(e, "the key exists");
  assert.equal(e.kind, "list");
  assert.deepEqual(e.default, []);
  assert.equal(e.tier, "instance");
  assert.equal(e.reload, "live");
  assert.deepEqual(e.packages, ["web"]);
  assert.deepEqual(parseInstanceValue(e, ["twitch", "youtube", "twitch"]), { ok: true, value: ["twitch", "youtube"] });
  assert.deepEqual(parseInstanceValue(e, "native, streamplace"), { ok: true, value: ["native", "streamplace"] });
  const bad = parseInstanceValue(e, ["kick"]);
  assert.equal(bad.ok, false, "a name outside the list is refused");
  // A list without `values` still takes any text (the rule is opt-in per key).
  assert.deepEqual(parseInstanceValue(instanceEntry("chat.botUsernames")!, ["anything"]), { ok: true, value: ["anything"] });
});

test("the home page reads the setting per render and the player takes every source decision through the helpers", () => {
  const page = read("app/(main)/page.tsx");
  assert.match(page, /embedsOff=\{instanceList\("player\.embedsOff"\)\}/);
  const view = read("app/components/StreamView.tsx");
  assert.match(view, /const liveOn = useMemo\(\(\) => liveSourcesOn\(/);
  assert.match(view, /const liveSource = liveSourceOn\(parseLiveSource\(storedLive\) \?\? liveSourceFromLegacy\(legacyEmbed, legacySpThin\), liveOn\);/);
  assert.match(view, /availableSources\(\{ live, hasCommunity, fallbacks: fallbackIds, liveOn \}\)/);
  assert.match(view, /liveOn=\{liveOn\}/);
});

// ── Only sources this install has a channel for ────────────────────────────────────────────────

const SETUP = { streamplaceChannel: "", youtubeChannelId: "", youtubeShown: true, twitchChannel: "" };

test("a source with no channel is not set up: an empty stream.place channel drops the site player and the embed", () => {
  assert.deepEqual(liveSourcesSetUp({ ...SETUP, twitchChannel: "casey" }), ["twitch"]);
  assert.deepEqual(liveSourcesSetUp({ ...SETUP, streamplaceChannel: "casey.example" }), ["native", "streamplace"]);
  assert.deepEqual(liveSourcesSetUp({ ...SETUP, youtubeChannelId: "UCabc", youtubeShown: false }), [], "YouTube with its module off is not offered");
  assert.deepEqual(liveSourcesSetUp({ streamplaceChannel: "a", youtubeChannelId: "UC", youtubeShown: true, twitchChannel: "b" }), ["native", "streamplace", "youtube", "twitch"]);
});

test("a first-time viewer on a Twitch-only install lands on Twitch, not an empty stream.place embed", () => {
  const on = liveSourcesOn([], liveSourcesSetUp({ ...SETUP, twitchChannel: "casey" }));
  assert.deepEqual(on, ["twitch"]);
  // No stored choice reads as the legacy default, "streamplace" — which is not on here.
  assert.equal(liveSourceOn("streamplace", on), "twitch");
  assert.deepEqual(availableSources({ live: true, hasCommunity: false, fallbacks: [], liveOn: on }), ["twitch"]);
});

test("fail open stays inside the set-up sources; none set up = no live source at all (the player says so)", () => {
  assert.deepEqual(liveSourcesOn(["twitch"], ["twitch"]), ["twitch"], "switching off the only one is ignored");
  assert.deepEqual(liveSourcesOn([], []), []);
  assert.deepEqual(availableSources({ live: true, hasCommunity: false, fallbacks: [], liveOn: [] }), []);
});

test("wiring: the page hands the set-up sources and the Kick channel; the player shows a Kick link instead of an empty embed", () => {
  const page = read("app/(main)/page.tsx");
  assert.match(page, /liveSetUp=\{liveSourcesSetUp\(\{/);
  assert.match(page, /youtubeShown: !off\.includes\("youtube"\)/);
  assert.match(page, /kickChannel=\{instanceString\("platform\.kick\.slug"\) \?\? ""\}/);
  const view = read("app/components/StreamView.tsx");
  assert.match(view, /livePlayable=\{liveOn\.length > 0\}/);
  const area = read("app/features/player/StreamPlayerArea.tsx");
  assert.match(area, /\{tab === "live" && live && !livePlayable && \(/);
  assert.match(area, /Live on Kick — this site has no Kick player yet\./);
  for (const a of ["sp", "yt", "tw"]) assert.match(area, new RegExp(`\\{tab === "live" && playLive && active === "${a}"`), `the ${a} embed mounts only with a playable source`);
});
