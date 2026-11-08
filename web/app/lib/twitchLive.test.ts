// A featured streamer with only a Twitch login can be featured: the rotation asks Twitch whether
// that login is live, instead of skipping every entry without a YouTube channel.
// Run: node --test app/lib/twitchLive.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "./testTsx.ts";

const { liveFromHelix } = await import("./twitchLive.ts");

test("a live Twitch stream is read with its title and Twitch's own avatar", () => {
  const live = liveFromHelix(
    { data: [{ user_login: "Casey", title: "Building a shelf", type: "live" }] },
    { data: [{ login: "casey", profile_image_url: "https://static-cdn.jtvnw.net/jtv_user_pictures/casey.png" }] },
  );
  assert.deepEqual([...live!], [["casey", { title: "Building a shelf", avatar: "https://static-cdn.jtvnw.net/jtv_user_pictures/casey.png" }]]);
});

test("not live, a non-live type or a foreign avatar host reads as nothing; no answer at all reads as null", () => {
  assert.equal(liveFromHelix({ data: [] }, null)?.size, 0);
  assert.equal(liveFromHelix({ data: [{ user_login: "casey", title: "x", type: "" }] }, null)?.size, 0);
  assert.equal(liveFromHelix(null, null), null, "no answer is not an answer: null, never 'nobody live' (C6)");
  assert.equal(liveFromHelix(null, { data: [] }), null);
  const foreign = liveFromHelix({ data: [{ user_login: "casey", title: "x", type: "live" }] },
    { data: [{ login: "casey", profile_image_url: "https://evil.example/a.png" }] });
  assert.equal(foreign?.get("casey")?.avatar, null);
});

test("the rotation reads Twitch-only entries and features one that is live on Twitch", () => {
  const src = readFileSync(new URL("./communityLive.ts", import.meta.url), "utf8");
  assert.match(src, /WHERE youtube_channel_id IS NOT NULL OR twitch_login IS NOT NULL/);
  assert.match(src, /deps\.twitchLive\(rows\.flatMap\(\(r\) => \(r\.twitch_login \? \[r\.twitch_login\] : \[\]\)\)\)/);
  assert.match(src, /sources: \[\{ platform: "twitch", id: login \}\]/);
  assert.match(src, /twitchLive: twitchLiveLogins,/);
  const tl = readFileSync(new URL("./twitchLive.ts", import.meta.url), "utf8");
  const fetches = tl.match(/await fetch\(/g) ?? [];
  assert.equal(fetches.length, 1, "one fetch helper, every Helix read through it");
  assert.match(tl, /signal: AbortSignal\.timeout\(TWITCH_FETCH_TIMEOUT_MS\)/);
  assert.match(tl, /if \(live\) cache = \{ at: Date\.now\(\), key, live \};/, "a failed read is not remembered as an answer");
  assert.match(tl, /\n\}\s*$/, "vacuity: read to the end");
});
