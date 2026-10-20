// The tweet id inside a link — the ONLY thing that reaches the FxTwitter API,
// so it is digits or nothing. Hosts are the ones people paste (x/twitter and
// the fix-up mirrors, which Discord users post for the embed).
//
// Run: node --test app/lib/tweetId.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { tweetIdFromUrl } from "./tweetId.ts";

test("real-world link shapes", () => {
  assert.equal(tweetIdFromUrl("https://x.com/broderick/status/2098456617549275433"), "2098456617549275433");
  assert.equal(tweetIdFromUrl("https://fixupx.com/wallstreetapes/status/2098396138298630488"), "2098396138298630488");
});

test("hosts and shapes", () => {
  for (const u of [
    "https://twitter.com/a/status/1",
    "https://www.x.com/a/status/1",
    "https://mobile.twitter.com/a/status/1",
    "https://fxtwitter.com/a/status/1",
    "https://vxtwitter.com/a/status/1",
    "https://x.com/i/status/1",
    "https://x.com/status/1",
    "https://x.com/a/status/1?s=20&t=abc",
    "https://x.com/a/status/1/photo/1",
    "http://x.com/a/status/1",
  ]) assert.equal(tweetIdFromUrl(u), "1", u);
});

test("not a tweet", () => {
  for (const u of [
    "https://x.com/broderick",
    "https://x.com/a/likes",
    "https://x.com/a/status/abc",
    "https://x.com/a/status/",
    "https://notx.com/a/status/1",
    "https://x.com.evil.example/a/status/1",
    "https://x.com/a/status/12345678901234567890123456",
    "javascript:alert(1)",
    "not a url",
    "",
  ]) assert.equal(tweetIdFromUrl(u), null, u);
});

// Vacuity anchor at the END.
test("the parser discriminates", () => {
  assert.notEqual(tweetIdFromUrl("https://x.com/a/status/7"), tweetIdFromUrl("https://x.com/a"));
});
