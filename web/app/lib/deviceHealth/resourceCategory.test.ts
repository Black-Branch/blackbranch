// Run: node --test app/lib/deviceHealth/resourceCategory.test.ts
import "../testInstallValues.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { categorize, CATEGORIES } from "./resourceCategory.ts";

const O = "https://example.tv";

test("one fixture per category", () => {
  const cases: Array<[string, string, string]> = [
    ["https://cdn.7tv.app/emote/abc/2x.webp", "img", "emote_7tv"],
    ["https://cdn.betterttv.net/emote/abc/3x", "img", "emote_bttv"],
    ["https://cdn.frankerfacez.com/emote/1/2", "img", "emote_ffz"],
    ["https://static-cdn.jtvnw.net/emoticons/v2/1/default/dark/2.0", "img", "emote_twitch"],
    ["https://static-cdn.jtvnw.net/jtv_user_pictures/x-profile_image-70x70.png", "img", "avatar"],
    ["https://yt3.ggpht.com/abc=s88", "img", "avatar"],
    ["https://example.tv/api/badges", "fetch", "badges"],
    ["https://example.tv/api/badges/image/19/0123456789abcdef.gif", "img", "badges"],
    ["https://example.tv/api/me", "fetch", "api"],
    ["https://matrix.example.tv/_matrix/client/v3/sync?since=s1", "fetch", "matrix"],
    ["https://example.tv/_next/static/chunks/abc.js", "script", "js"],
    ["https://example.tv/_next/static/chunks/abc.css", "link", "css"],
    ["https://example.tv/_next/static/media/geist.woff2", "css", "font"],
    ["https://vod.stream.place/x/index.m3u8?token=1", "fetch", "media"],
    ["https://vod.stream.place/x/seg1.m4s", "fetch", "media"],
    ["https://i.ytimg.com/vi/x/hq.jpg", "img", "image_other"],
    ["https://www.youtube.com/iframe_api", "script", "other"],
  ];
  const seen = new Set<string>();
  for (const [url, init, want] of cases) {
    assert.equal(categorize(url, init, O), want, url);
    seen.add(want);
  }
  assert.deepEqual([...seen].sort(), [...CATEGORIES].sort(), "a category has no fixture");
});

test("a query string never decides — or survives — anything", () => {
  assert.equal(categorize("https://example.tv/api/chat/history?room=!secret:example.tv", "fetch", O), "api");
  assert.equal(categorize("https://cdn.7tv.app/emote/x/2x.webp?a=b#c", "img", O), "emote_7tv");
});

test("garbage and unknowns are 'other'", () => {
  assert.equal(categorize("::::", "img", "not a url"), "other");
  assert.equal(categorize("https://evil.example/x.js", "script", O), "other");
  assert.equal(categorize("https://other.example/api/badges", "fetch", O), "other", "only OUR /api is api");
});
