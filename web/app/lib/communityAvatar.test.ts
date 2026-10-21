// A featured YouTube streamer who is live must show an avatar on an install with no YouTube API
// key. The live watch page carries the channel's avatar in its own data; read it from there.
// Run: node --test app/lib/communityAvatar.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "./testTsx.ts";

const { avatarFromLivePage } = await import("./streamStatus.ts");

const page = (url: string) =>
  `…"videoOwnerRenderer":{"thumbnail":{"thumbnails":[{"url":"${url}","width":48,"height":48}]},"title":{"runs":[]}}…`;

test("the avatar on a live watch page is read without the API", () => {
  assert.equal(avatarFromLivePage(page("https://yt3.ggpht.com/abc=s48-c-k-c0x00ffffff-no-rj")), "https://yt3.ggpht.com/abc=s48-c-k-c0x00ffffff-no-rj");
  assert.equal(avatarFromLivePage(page("https://yt3.googleusercontent.com/x=s88")), "https://yt3.googleusercontent.com/x=s88");
});

test("only a YouTube image host over https; a page without the field is null", () => {
  assert.equal(avatarFromLivePage(page("http://yt3.ggpht.com/abc")), null);
  assert.equal(avatarFromLivePage(page("https://evil.example/abc")), null);
  assert.equal(avatarFromLivePage(page("javascript:alert(1)")), null);
  assert.equal(avatarFromLivePage("<html>offline channel home</html>"), null);
});

test("wiring: the API's avatar first, the live page's when there is no key or no answer", () => {
  const src = readFileSync(new URL("./streamStatus.ts", import.meta.url), "utf8");
  assert.match(src, /const avatar_url = \(apiKey \? await getChannelAvatar\(row\.youtube_channel_id, apiKey\) : null\) \?\? check\.avatar;/);
  assert.match(src, /avatar = avatarFromLivePage\(html\);/);
});
