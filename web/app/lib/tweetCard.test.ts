// FxTwitter JSON → the card the row renders. Fixtures are trimmed copies of
// real api.fxtwitter.com responses.
//
// Run: node --test app/lib/tweetCard.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";
import { tweetCardFromFx } from "./tweetCard.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

const PHOTO = {
  code: 200, message: "OK",
  tweet: {
    url: "https://x.com/broderick/status/2098456617549275433",
    text: "The absolute mad man. He actually did it. Unreal.",
    likes: 27113, retweets: 1177, replies: 105, views: 4029152,
    author: { name: "Ryan Broderick", screen_name: "broderick", avatar_url: "https://pbs.twimg.com/profile_images/1419661731324956678/XFT3yMLU_200x200.jpg" },
    media: { all: [{ type: "photo", url: "https://pbs.twimg.com/media/HR83J44WcAIDEsV.jpg?name=orig", width: 1041, height: 721 }],
             photos: [{ type: "photo", url: "https://pbs.twimg.com/media/HR83J44WcAIDEsV.jpg?name=orig", width: 1041, height: 721 }] },
  },
};
const VIDEO = {
  code: 200, message: "OK",
  tweet: {
    url: "https://x.com/WallStreetApes/status/2098396138298630488",
    text: "American shows up in a disco suit",
    likes: 12, retweets: 3, replies: 0,
    author: { name: "Wall Street Apes", screen_name: "WallStreetApes", avatar_url: "https://pbs.twimg.com/a.jpg" },
    media: { videos: [{ type: "video", url: "https://video.twimg.com/v.mp4", thumbnail_url: "https://pbs.twimg.com/amplify_video_thumb/t.jpg", width: 1080, height: 1698, duration: 312.5 }] },
  },
};

test("a photo tweet", () => {
  assert.deepEqual(tweetCardFromFx(PHOTO, "https://fixupx.com/broderick/status/2098456617549275433"), {
    kind: "post",
    title: "Ryan Broderick (@broderick)",
    description: "The absolute mad man. He actually did it. Unreal.",
    image: "https://pbs.twimg.com/media/HR83J44WcAIDEsV.jpg?name=orig",
    imageWidth: 1041, imageHeight: 721,
    avatar: "https://pbs.twimg.com/profile_images/1419661731324956678/XFT3yMLU_200x200.jpg",
    stats: "💬 105 · 🔁 1.2K · ❤️ 27.1K",
    siteName: "X",
    url: "https://x.com/broderick/status/2098456617549275433",
  });
});

test("a video tweet uses the thumbnail and its dims", () => {
  const c = tweetCardFromFx(VIDEO, "https://x.com/WallStreetApes/status/2098396138298630488")!;
  assert.equal(c.image, "https://pbs.twimg.com/amplify_video_thumb/t.jpg");
  assert.equal(c.imageWidth, 1080);
  assert.equal(c.imageHeight, 1698);
  assert.equal(c.stats, "💬 0 · 🔁 3 · ❤️ 12");
});

test("no media, no name, missing counts, a non-https tweet url", () => {
  const c = tweetCardFromFx({ code: 200, tweet: { text: "hi", author: { screen_name: "someone" }, url: "ftp://x" } }, "https://x.com/someone/status/5")!;
  assert.equal(c.title, "@someone");
  assert.equal(c.image, null);
  assert.equal(c.imageWidth, null);
  assert.equal(c.stats, "💬 0 · 🔁 0 · ❤️ 0");
  assert.equal(c.url, "https://x.com/someone/status/5", "falls back to the message's own link");
});

test("millions and thousands", () => {
  const c = tweetCardFromFx({ code: 200, tweet: { text: "", author: { screen_name: "a" }, likes: 4029152, retweets: 999, replies: 1000 } }, "https://x.com/a/status/1")!;
  assert.equal(c.stats, "💬 1.0K · 🔁 999 · ❤️ 4.0M");
});

test("not-found, malformed and empty responses are null — never a scrape of x.com", () => {
  assert.equal(tweetCardFromFx({ code: 404, message: "NOT_FOUND" }, "https://x.com/a/status/1"), null);
  assert.equal(tweetCardFromFx({ code: 200 }, "https://x.com/a/status/1"), null);
  assert.equal(tweetCardFromFx({ code: 200, tweet: { text: "no author" } }, "https://x.com/a/status/1"), null);
  assert.equal(tweetCardFromFx(null, "https://x.com/a/status/1"), null);
  assert.equal(tweetCardFromFx("junk", "https://x.com/a/status/1"), null);
});

test("the og route asks FxTwitter BEFORE the generic scrape and never scrapes x.com", () => {
  const raw = readFileSync(join(webRoot, "app/api/og/route.ts"), "utf8");
  assert.match(raw.slice(-300), /return Response\.json\(null\);\s*}\s*}\s*$/);
  const src = stripComments(raw);
  const fx = src.indexOf("const tweetId = tweetIdFromUrl(url);");
  const scrape = src.indexOf("await safeFetch(url");
  assert.ok(fx > 0 && scrape > fx, "the tweet branch must sit before the generic scrape");
  // Only a digits-only id reaches the fixed FxTwitter host, encoded.
  assert.match(src, /if \(!\/\^\\d\{1,25\}\$\/\.test\(tweetId\)\) return Response\.json\(null\);/);
  assert.match(src, /`https:\/\/api\.fxtwitter\.com\/status\/\$\{encodeURIComponent\(tweetId\)\}`/);
  assert.match(src, /if \(!fx\.ok\) return Response\.json\(null\);/);
  assert.match(src, /const json = await readJsonCapped\(fx, \d[\d *]*\);\s*return Response\.json\(json === null \? null : tweetCardFromFx\(json, url\)\);/);
  const lp = stripComments(readFileSync(join(webRoot, "app/components/LinkPreview.tsx"), "utf8"));
  assert.match(lp, /if \(data\.kind === "post"\) return <PostCard url=\{url\} data=\{data\} \/>;/);
  assert.match(lp, /const fit = fitMediaBox\(data\.imageWidth, data\.imageHeight\);/, "the post's image sits in the same box as an attachment");
});

test("a photo entry with no url falls through to the video's thumbnail AND the video's dims", () => {
  const mixed = {
    code: 200, message: "OK",
    tweet: {
      url: "https://x.com/a/status/9",
      text: "mixed media",
      likes: 1, retweets: 0, replies: 0,
      author: { name: "A", screen_name: "a" },
      media: {
        photos: [{ type: "photo", width: 10, height: 10 }],
        videos: [{ type: "video", url: "https://video.twimg.com/v2.mp4", thumbnail_url: "https://pbs.twimg.com/amplify_video_thumb/t2.jpg", width: 640, height: 480 }],
      },
    },
  };
  const c = tweetCardFromFx(mixed, "https://x.com/a/status/9")!;
  assert.equal(c.image, "https://pbs.twimg.com/amplify_video_thumb/t2.jpg");
  assert.equal(c.imageWidth, 640);
  assert.equal(c.imageHeight, 480);
});

// Vacuity anchor at the END: the mapper reads its input.
test("the mapper discriminates", () => {
  assert.notDeepEqual(tweetCardFromFx(PHOTO, "https://x.com/a/status/1"), tweetCardFromFx(VIDEO, "https://x.com/a/status/1"));
});
