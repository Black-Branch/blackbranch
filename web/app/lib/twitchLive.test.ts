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
  assert.deepEqual([...live], [["casey", { title: "Building a shelf", avatar: "https://static-cdn.jtvnw.net/jtv_user_pictures/casey.png" }]]);
});

test("not live, a non-live type, a foreign avatar host or no answer at all reads as nothing", () => {
  assert.equal(liveFromHelix({ data: [] }, null).size, 0);
  assert.equal(liveFromHelix({ data: [{ user_login: "casey", title: "x", type: "" }] }, null).size, 0);
  assert.equal(liveFromHelix(null, null).size, 0);
  const foreign = liveFromHelix({ data: [{ user_login: "casey", title: "x", type: "live" }] },
    { data: [{ login: "casey", profile_image_url: "https://evil.example/a.png" }] });
  assert.equal(foreign.get("casey")?.avatar, null);
});

test("the rotation reads Twitch-only entries and features one that is live on Twitch", () => {
  const src = readFileSync(new URL("./streamStatus.ts", import.meta.url), "utf8");
  assert.match(src, /WHERE youtube_channel_id IS NOT NULL OR twitch_login IS NOT NULL/);
  assert.match(src, /twitchLiveLogins\(rows\.flatMap\(\(r\) => \(r\.twitch_login \? \[r\.twitch_login\] : \[\]\)\)\)/);
  assert.match(src, /sources: \[\{ platform: "twitch", id: row\.twitch_login \}\]/);
  const fetches = readFileSync(new URL("./twitchLive.ts", import.meta.url), "utf8").match(/await fetch\(/g) ?? [];
  assert.equal(fetches.length, 1, "one fetch helper, every Helix read through it");
  assert.match(readFileSync(new URL("./twitchLive.ts", import.meta.url), "utf8"), /signal: AbortSignal\.timeout\(TWITCH_FETCH_TIMEOUT_MS\)/);
});
