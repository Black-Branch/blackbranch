// The player's embed surfaces, pinned at the source level.
//
// No Kick player (the slug stays — it routes outbound cross-posts); no "Beta
// player" pill (the source row is the opt-in); every iframe configured the way
// its platform documents; no dead offline-VOD branches; a VOD pick unmuted.
// These files render in a browser the harness cannot drive, so the assertions
// read the source (comments stripped, end-of-file anchored).
//
// Run: node --test app/lib/playerEmbeds.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

const VIEW = "app/lib/streamView.ts";
const STATUS = "app/lib/streamStatus.ts";
const MANAGER = "app/components/CommunityEmbedManager.tsx";
const EMBED_ROUTE = "app/api/mod/embed/route.ts";
const AREA = "app/features/player/StreamPlayerArea.tsx";
const TWITCH = "app/features/player/TwitchPlayer.tsx";
const BAR = "app/components/StreamEmbedBar.tsx";
const STREAM_VIEW = "app/components/StreamView.tsx";
const META = "app/components/StreamMetaBar.tsx";

/** Read a source file, proving first that the read reached its end. */
function read(rel: string, tail: RegExp): string {
  const src = readFileSync(join(webRoot, rel), "utf8");
  assert.match(src.slice(-300), tail,
    `${rel} did not end as expected — the read is truncated, and every assertion below it is vacuous`);
  return stripComments(src);
}

test("no Kick in the community embed — not a player, not a routing handle", () => {
  // The community embed carries no cross-posting options and no reference to
  // them — the Kick player is gone, and so is its cross-post routing handle.
  //
  // This is COMMUNITY-EMBED scope only. The owner's own Kick — sendKick,
  // KICK_BROADCASTER_ID, the /kick command, Kick moderation, the glyph — all
  // stay, and this test must never be widened to forbid the word "kick"
  // repo-wide or it will fail on all of them.
  const view = read(VIEW, /return String\(n\);\s*\}\s*$/);
  assert.doesNotMatch(view, /player\.kick\.com/);
  assert.doesNotMatch(view, /"kick"/);

  const status = read(STATUS, /statusCache\.get\(\);\s*$/);
  assert.doesNotMatch(status, /platform: "kick"/);
  assert.doesNotMatch(status, /ingest_kick/);
  assert.doesNotMatch(status, /kick_slug/, "the routing handle goes with the player");

  const manager = read(MANAGER, /<\/button>\s*\);\s*}\s*$/);
  assert.doesNotMatch(manager, /ingest_kick/);
  assert.doesNotMatch(manager, /kick_slug/, "the manager must offer no Kick routing field");
  assert.doesNotMatch(manager, /kick:/, "the POST body must carry no kick term");

  const route = read(EMBED_ROUTE, /return Response\.json\(rows\[0\]\);\s*}\s*$/);
  assert.doesNotMatch(route, /ingest_kick/, "nothing writes or reads the flag any more; migrations/migrate-v118.sql drops both columns");
  assert.doesNotMatch(route, /kick_slug/, "the column is gone from every statement — a stale name here compiles and silently shifts the placeholders");
});

// ─── the iframes ─────────────────────────────────────────────────────────────

test("every player iframe carries a title, the referrer policy and the allow list", () => {
  const src = read(AREA, /<\/div>\s*\);\s*}\s*$/);
  const twitch = read(TWITCH, /<\/>\s*\);\s*}\s*$/);

  // YouTube and Twitch each build their OWN <iframe> ONCE now (task 7's
  // adapter wiring) and reuse it from every call site through props, rather
  // than repeating the literal at each mount point — YouTubeFrame's and
  // TwitchPlayer's own headers say why ("four copies of this wiring is the
  // shape that rots"). So the raw <iframe> literal count in THIS file is
  // just stream.place's (no adapter path exists for it) plus YouTubeFrame's
  // one shared <iframe ref>; Twitch's no-script fallback iframe lives in
  // TwitchPlayer.tsx instead, checked separately below.
  const areaFrames = src.match(/<iframe[\s\S]*?\/>/g) ?? [];
  assert.equal(areaFrames.length, 2,
    `expected stream.place's iframe + YouTubeFrame's shared iframe, found ${areaFrames.length}`);
  const twitchFrames = twitch.match(/<iframe[\s\S]*?\/>/g) ?? [];
  assert.equal(twitchFrames.length, 1,
    `expected TwitchPlayer's one no-script fallback iframe, found ${twitchFrames.length}`);

  for (const f of [...areaFrames, ...twitchFrames]) {
    assert.match(f, /\btitle=/, `an iframe without an accessible name: ${f.slice(0, 60)}…`);
    assert.match(f, /referrerPolicy=\{(IFRAME_REFERRER|referrerPolicy)\}/, `YouTube refuses a missing Referer (error 153): ${f.slice(0, 60)}…`);
    assert.match(f, /allow=\{(IFRAME_ALLOW|allow)\}/, `the allow list must be the shared one: ${f.slice(0, 60)}…`);
    assert.match(f, /allowFullScreen/);
  }

  // The six logical player surfaces (VOD replay, stream.place, YouTube,
  // Twitch, playlist, community) each thread the SAME shared constants
  // through — the four that mount via <YouTubeFrame>/<TwitchPlayer> just as
  // much as the raw literals. The community slot is one call site that
  // branches on platform (only one side of which ever renders at once), so
  // it counts as two of these textual sites — seven in total.
  assert.equal((src.match(/allow=\{IFRAME_ALLOW\}/g) ?? []).length, 7,
    "one allow={IFRAME_ALLOW} per call site: VOD, stream.place, live YouTube, live Twitch, playlist, community YouTube, community Twitch");
  assert.equal((src.match(/referrerPolicy=\{IFRAME_REFERRER\}/g) ?? []).length, 7,
    "the referrer policy must accompany the allow list at every call site");

  assert.match(src, /IFRAME_ALLOW = "autoplay; fullscreen; picture-in-picture; encrypted-media"/);
  assert.match(src, /IFRAME_REFERRER = "strict-origin-when-cross-origin"/);
});

test("the Beta player pill is gone — the source row is the opt-in", () => {
  const src = read(AREA, /<\/div>\s*\);\s*}\s*$/);
  assert.doesNotMatch(src, /Beta player/);
  assert.doesNotMatch(src, /hover_&\]/,
    "an arbitrary sticky-hover variant carries none of hover:'s media gate — a phone tap flipped a PERSISTED preference");
  assert.doesNotMatch(src, /Lightning/);
  assert.doesNotMatch(src, /onClick=\{onToggleSpPlayer\}/,
    "nothing in the player area may WRITE the persisted flag — the source row is the only way in");
  assert.match(src, /onFallback=\{onToggleSpPlayer\}/, "the thin player's own way back to the embed stays");
});

test("the offline-VOD branches are gone — radio is the offline default", () => {
  const src = read(AREA, /<\/div>\s*\);\s*}\s*$/);
  assert.doesNotMatch(src, /vodlive-/);
  assert.doesNotMatch(src, /Stream is offline/);
  const bar = read(BAR, /\/>\s*\);\s*}\s*$/);
  assert.doesNotMatch(bar, /watch\?v=/, "the 'open on YouTube' escape hatch only existed for the dead branch");
  assert.doesNotMatch(bar, /selectedVod/);
});

test("a VOD pick plays unmuted unless the device setting says otherwise", () => {
  const src = read(AREA, /<\/div>\s*\);\s*}\s*$/);
  // Since task 8 the tail is built from the shared YT_EMBED_PARAMS constant
  // (which carries rel=0 and enablejsapi=1 — pinned by playerSource.test.ts
  // and playerApiReach.test.ts), not restated as a literal here.
  assert.match(src, /embed\/\$\{selectedVod\.id\}\?\$\{YT_EMBED_PARAMS\}\$\{vodStartMuted \? "&mute=1" : ""\}/);
  const sv = read(STREAM_VIEW, /GuestSupportContent = dynamic\([\s\S]*\{ ssr: false \}\);\s*$/);
  assert.match(sv, /vodStartMuted=\{autoMute\}/);
});

test("the community frame is built by communitySrc alone", () => {
  // The server already puts the live video id into the YouTube source's `id`,
  // so the inline "prefer community.video_id" branch built the same URL twice.
  const src = read(AREA, /<\/div>\s*\);\s*}\s*$/);
  assert.doesNotMatch(src, /community\.video_id/);
  assert.match(src, /src=\{communitySrc\(communitySource, embedHost\)\}/);
});

test("YouTube embeds play inline on iOS", () => {
  const view = read(VIEW, /return String\(n\);\s*\}\s*$/);
  const yt = view.match(/youtube\.com\/embed[^`]*`/g) ?? [];
  assert.equal(yt.length, 2, "the live_stream form and the video-id form");
  // Since task 8 the tail is the shared YT_EMBED_PARAMS constant, not a
  // restated literal — playsinline=1 is pinned as part of it there and in
  // playerApiReach.test.ts's cross-builder agreement test.
  for (const u of yt) assert.match(u, /\$\{YT_EMBED_PARAMS\}/, u);
  // The streamer's own source is built by playerSource.youtubeLiveSrc (by broadcast id
  // when ingest has confirmed one, by channel otherwise); the executable pins
  // live in playerSource.test.ts. Here: StreamView uses it and does not
  // hand-build the channel form.
  const sv = read(STREAM_VIEW, /GuestSupportContent = dynamic\([\s\S]*\{ ssr: false \}\);\s*$/);
  // All three live sources must start muted on a phone (muted autoplay is
  // always permitted; unmuted autoplay is refused, and a refused player
  // starts nothing) — so this call site passes `autoMute: startMuted`, not
  // the bare `{ autoMute }` shorthand. Whitespace-tolerant (a reformat must
  // not retrip this), but it still requires the `autoMute:` key with a value
  // — it must fail on the bare shorthand and on the argument being dropped.
  assert.match(sv, /youtubeLiveSrc\(\{\s*videoId:\s*ytVideoId,\s*channelId:\s*ytChannelId,\s*autoMute:\s*startMuted\s*,?\s*\}\)/);
  assert.doesNotMatch(sv, /live_stream\?channel=/);
});

test("the meta bar keys its community block on the SELECTED source and names the playlist state", () => {
  const src = read(META, /\/>\s*\);\s*}\s*$/);
  assert.doesNotMatch(src, /!live && community/,
    "gating on Casey being offline put the featured streamer's avatar and 'Visit Channel' under the Gadget Radio title");
  assert.match(src, /const onCommunity = tab === "community";/);
  assert.match(src, /"Community playlist"/);
  assert.doesNotMatch(src, /selectedVod \? selectedVod\.title/, "only the Replay tab shows a VOD title");
});

test("the two legacy keys are READ as the fallback and WRITTEN by nothing", () => {
  const sv = read(STREAM_VIEW, /GuestSupportContent = dynamic\([\s\S]*\{ ssr: false \}\);\s*$/);
  // Read-only: the hook's setter is discarded for both legacy keys.
  assert.match(sv, /const \[legacyEmbed\] = useLocalStorageString\("embed_source"\);/);
  assert.match(sv, /const \[legacySpThin\] = useLocalStorageString\("chatStyle_spThinPlayer"\);/);
  assert.doesNotMatch(sv, /setSavedSource|setSpThin\b/, "a writer of the legacy pair survived the collapse");
  // One writer of the one key, and the fallback decides the derived pair.
  assert.match(sv, /useLocalStorageString\(LIVE_SOURCE_KEY\)/);
  assert.equal((sv.match(/setStoredLive\(/g) ?? []).length, 1, "exactly one write site for the live source");
  assert.match(sv, /parseLiveSource\(storedLive\) \?\? liveSourceFromLegacy\(legacyEmbed, legacySpThin\)/);
  // The thin player's way back to the embed goes through the same setter.
  assert.match(sv, /onToggleSpPlayer=\{\(\) => setSource\("streamplace"\)\}/);
  // …and so does the top bar's Live dropdown. The rail replaces the source
  // row; a dropdown pick that wrote the key itself would be the second writer
  // this test exists to forbid.
  assert.match(sv, /const selectLiveSource = useCallback\(\(s: LiveSource\) => setSource\(s\), \[setSource\]\);/);
  // Nothing else on the site writes either legacy key.
  const files: Array<[string, RegExp]> = [
    ["app/lib/playerSource.ts", /return null;\s*\}\s*$/],
    [AREA, /<\/div>\s*\);\s*}\s*$/],
    ["app/features/player/StreamplaceThinPlayer.tsx", /iceGatheringState === "complete"[\s\S]*\}\s*$/],
  ];
  for (const [f, tail] of files) {
    assert.doesNotMatch(read(f, tail), /"embed_source"|"chatStyle_spThinPlayer"/, `${f} names a legacy key`);
  }
});
