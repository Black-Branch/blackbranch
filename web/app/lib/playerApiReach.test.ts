// The IFrame API is unreachable without enablejsapi=1 on the embed URL, and
// the script is unreachable without a CSP origin. Both are one token, both
// fail silently, and neither has any other test.
// Run: node --test app/lib/playerApiReach.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";
import { youtubeLiveSrc, YT_EMBED_PARAMS } from "./playerSource.ts";
import { loopPlaylistSrc } from "./loopPlaylist.ts";
import { communitySrc } from "./streamView.ts";
import { hlsPlaylistUrl } from "./hlsPath.ts";

const here = dirname(fileURLToPath(import.meta.url));
const areaPath = join(here, "..", "features", "player", "StreamPlayerArea.tsx");
const configPath = join(here, "csp.ts"); // the one writer of the CSP
const viewPath = join(here, "..", "components", "StreamView.tsx");
const loopPath = join(here, "loopPlaylist.ts");

test("the live YouTube embed enables the JS API, in both id and channel forms", () => {
  const byId = youtubeLiveSrc({ videoId: "abc123", channelId: "", autoMute: false });
  const byChannel = youtubeLiveSrc({ videoId: null, channelId: "UCxyz", autoMute: true });
  assert.match(byId!, /enablejsapi=1/);
  assert.match(byChannel!, /enablejsapi=1/);
});

test("the fallback playlist enables the JS API, for one video and for many", () => {
  assert.match(loopPlaylistSrc([{ video_id: "one" }])!, /enablejsapi=1/);
  assert.match(loopPlaylistSrc([{ video_id: "a" }, { video_id: "b" }])!, /enablejsapi=1/);
});

test("a featured streamer's YouTube embed enables the JS API, channel and video forms", () => {
  const chan = communitySrc({ platform: "youtube", id: "UCabc" } as never, "site.test");
  const vid = communitySrc({ platform: "youtube", id: "vid123" } as never, "site.test");
  assert.match(chan, /enablejsapi=1/);
  assert.match(vid, /enablejsapi=1/);
});

test("the VOD replay embed enables the JS API", () => {
  // Since task 8, the tail is no longer a literal here — it's built from the
  // shared YT_EMBED_PARAMS constant (which carries enablejsapi=1; pinned by
  // the constant's own tests below), so a source scan can only see the
  // reference, not the token.
  const src = stripComments(readFileSync(areaPath, "utf8"));
  const vod = src.match(/https:\/\/www\.youtube\.com\/embed\/\$\{selectedVod\.id\}\?[^`\n]*/);
  assert.ok(vod, "the VOD replay embed URL was not found — has it moved?");
  assert.match(vod[0], /\$\{YT_EMBED_PARAMS\}/, "the VOD embed must build its tail from the shared constant");
});

test("no YouTube embed URL anywhere in the player area lacks the shared parameter tail", () => {
  const src = stripComments(readFileSync(areaPath, "utf8"));
  for (const m of src.matchAll(/https:\/\/www\.youtube\.com\/embed\/[^`\n]*/g)) {
    assert.match(m[0], /\$\{YT_EMBED_PARAMS\}/, `embed URL without the shared parameter tail: ${m[0]}`);
  }
});

test("the CSP admits both player API scripts", () => {
  const cfg = stripComments(readFileSync(configPath, "utf8"));
  const line = cfg.split("\n").find((l) => l.includes("script-src"));
  assert.ok(line, "no script-src directive found in csp.ts");
  assert.match(line, /https:\/\/www\.youtube\.com/, "YouTube's iframe_api origin is not permitted");
  assert.match(line, /https:\/\/embed\.twitch\.tv/, "Twitch's embed script origin is not permitted");
});

test("the stream.place embed carries no inert parameters", async () => {
  // pictureInPictureEnabled IS a PlayerProp on the @streamplace/components type
  // the embed uses — but it DEFAULTS ON (their video component reads
  // `disablePictureInPicture={props.pictureInPictureEnabled === false}`, in
  // js/components/src/components/mobile-player/video.tsx on the `next` branch of
  // github.com/streamplace/streamplace — that package is NOT a dependency of
  // this repo, so this fact cannot be re-checked here), so sending it buys
  // nothing and is still an inert param. The PiP button itself needs our
  // IFRAME_ALLOW to delegate picture-in-picture into the frame.
  // `muted` IS real: keep it.
  const src = stripComments(readFileSync(viewPath, "utf8"));
  assert.doesNotMatch(src, /pictureInPictureEnabled/,
    "an inert query param is still being sent to the stream.place embed");
  // Not /spParams|muted/ — "muted" alone matches ANYWHERE in this large file
  // (finding 9), including unrelated Twitch/YouTube mute params. Pin the
  // actual mechanism: the stream.place params object setting "muted".
  assert.match(src, /spParams\.set\("muted"/, "the mobile mute param must survive");
});

test("picture-in-picture is delegated by the iframe allow list, where it actually comes from", () => {
  const areaSrc = stripComments(readFileSync(areaPath, "utf8"));
  assert.match(areaSrc, /picture-in-picture/, "the allow list is what enables PiP for every embed");
});

test("media-src carries the origin the compatibility player loads its playlist from", () => {
  // THE DEFECT THIS PINS. If media-src omits stream.place, the native-HLS
  // path's `video.src = <playlist>` is refused by our OWN policy:
  //   "MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check"
  // A media element is governed by media-src, not connect-src — the scheme-wide
  // `connect-src https:` we already have does NOT cover it. Compatibility mode
  // would be dead on Safari/iOS, and a source scan of the player can never see
  // a CSP directive. Only this can.
  //
  // A SEGMENT is a media load too. media-src governs everything the element
  // fetches, not just the manifest — on the native path the element pulls each
  // segment itself, and a redirect to a playback node is another media load.
  // stream.place's playback nodes are SUBDOMAINS (whepProxy.ts grants exactly
  // that boundary), so the wildcard has to be there as well as the apex; a CSP
  // host wildcard does not match the bare host, and this test only ever derives
  // the apex, so without the explicit wildcard check nothing here would notice.
  //
  // The origin is DERIVED from the builder, never restated: a host typed twice
  // is a host that can drift.
  const origin = new URL(hlsPlaylistUrl("site.test")).origin;
  const wildcard = origin.replace(/^https:\/\//, "https://*.");
  const cfg = stripComments(readFileSync(configPath, "utf8"));
  // A string OR a template literal — the directive interpolates the API origin (install key
  // site.apiOrigin, given by the proxy at request time).
  const directive = cfg.match(/["`]media-src[^"`]*["`]/)?.[0];
  assert.ok(directive, "no media-src directive found in csp.ts");
  // Exact SOURCE-EXPRESSION tokens, not a substring: `includes(origin)` is also
  // satisfied by a host like https://stream.place.evil.example, which allows an
  // origin we never meant to trust while reporting the policy as correct.
  const sources = directive.replace(/^["`]|["`]$/g, "").trim().split(/\s+/).slice(1);
  assert.ok(sources.includes(origin),
    `media-src must allow ${origin} or compatibility mode cannot load its playlist (saw: ${sources.join(" ")})`);
  assert.ok(sources.includes(wildcard),
    `media-src must allow ${wildcard} or a playlist on a playback-node subdomain is refused (saw: ${sources.join(" ")})`);
});

test("every YouTube embed carries the same parameter tail", () => {
  // rel=0 restricts related videos to the same channel (since 2018 it no longer
  // removes them); iv_load_policy=3 hides annotations. The live and community
  // embeds carried neither while the VOD and playlist embeds carried rel=0 —
  // four embeds, three different answers.
  const expected = YT_EMBED_PARAMS.split("&");
  const built = [
    youtubeLiveSrc({ videoId: "abc123", channelId: "", autoMute: false })!,
    youtubeLiveSrc({ videoId: null, channelId: "UCxyz", autoMute: false })!,
    communitySrc({ platform: "youtube", id: "UCabc" } as never, "site.test"),
    communitySrc({ platform: "youtube", id: "vid123" } as never, "site.test"),
    loopPlaylistSrc([{ video_id: "a" }, { video_id: "b" }])!,
  ];
  for (const url of built) {
    for (const p of expected) {
      assert.ok(url.includes(p), `${url} is missing ${p}`);
    }
  }
});

test("loopPlaylist's hand-copied tail still equals the builder's", () => {
  // loopPlaylist.ts keeps ZERO imports so `node --test` can load it directly, so
  // it restates the tail instead of importing it. This is what keeps the copy
  // from drifting — the whole reason the duplicate is tolerable.
  const src = stripComments(readFileSync(loopPath, "utf8"));
  assert.ok(src.includes(YT_EMBED_PARAMS),
    `loopPlaylist.ts must restate the tail verbatim: ${YT_EMBED_PARAMS}`);
});

test("VACUITY ANCHOR: the scanned files were read to the END", () => {
  // Every scan above is a negative or a match against file text. If a read
  // were truncated they would pass over the hole. These four prove the whole
  // files arrived.
  const area = readFileSync(areaPath, "utf8");
  const cfg = readFileSync(configPath, "utf8");
  const view = readFileSync(viewPath, "utf8");
  const loop = readFileSync(loopPath, "utf8");
  assert.match(area.trimEnd().slice(-40), /\}\s*$/, "StreamPlayerArea.tsx did not end in a closing brace");
  assert.ok(cfg.trimEnd().endsWith(";") || cfg.trimEnd().endsWith("}"), "next.config.ts ended mid-file");
  assert.match(view.trimEnd().slice(-40), /\);?\s*$/, "StreamView.tsx did not end with a closing paren or brace");
  assert.match(loop.trimEnd().slice(-40), /\}\s*$/, "loopPlaylist.ts ended mid-file");
});
