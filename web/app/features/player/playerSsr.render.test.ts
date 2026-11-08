// The player renders on the SERVER with every first source. A "use client" component still renders
// once in Node for the HTML, where there is no `window`: a `window` read in a render (a useState
// initialiser counts) throws there, and the home page answers 500 whenever that source is the first
// one shown — seen on the Task 8 look (2026-10-25) with Twitch or YouTube first.
// This renders StreamPlayerArea with react-dom/server and `window`/`document` REMOVED, as Next does.
// Run: node --test app/features/player/playerSsr.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { React } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";

const { StreamPlayerArea } = await import("@/app/features/player/StreamPlayerArea");
const { renderToString } = await import("react-dom/server");

const base = {
  tab: "live", live: true, spSrc: "https://example.test/sp", ytSrc: "https://www.youtube.com/embed/abcdefghijk",
  twSrc: "https://player.twitch.tv/?channel=casey&parent=example.test", kkSrc: "https://player.kick.com/casey",
  twitchChannel: "casey", twStartMuted: true, community: null, communitySource: null, loopVideos: [],
  embedHost: "example.test", selectedVod: null, vodStartMuted: true, spThinPlayer: false, spStartMuted: true,
  spChannel: "casey.example", onToggleSpPlayer: () => {}, isSignedIn: false, fallbackCollapsed: false,
  onToggleFallbackCollapsed: () => {}, onPlayerLive: () => {},
};

/** Render as the server does: no window, no document. */
function serverRender(props: Record<string, unknown>): string {
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document };
  delete g.window;
  delete g.document;
  try {
    return renderToString(React.createElement(StreamPlayerArea, { ...base, ...props } as never));
  } finally {
    g.window = saved.window;
    g.document = saved.document;
  }
}

const FIRST = { tw: /player\.twitch\.tv/, yt: /youtube\.com\/embed\/abcdefghijk/, sp: /<iframe|<video/, kk: /player\.kick\.com\/casey/ } as const;
for (const active of ["tw", "yt", "sp", "kk"] as const) {
  test(`the live player renders on the server with ${active} first`, () => {
    const html = serverRender({ active });
    assert.match(html, FIRST[active], "the first source's player is in the server HTML");
  });
}

test("a community entry on YouTube and on Twitch renders on the server too", () => {
  const yt = { key: "UCx", display_name: "X", youtube_channel_id: "UCx", video_id: "abcdefghijk", stream_title: "", avatar_url: null,
    twitch_login: "xx", sources: [{ platform: "youtube", id: "abcdefghijk" }, { platform: "twitch", id: "xx" }], scheduled: null };
  assert.match(serverRender({ tab: "community", live: false, community: yt, communitySource: yt.sources[0] }), /youtube\.com\/embed\/abcdefghijk/);
  assert.match(serverRender({ tab: "community", live: false, community: yt, communitySource: yt.sources[1] }), /player\.twitch\.tv\/\?channel=xx/);
});
