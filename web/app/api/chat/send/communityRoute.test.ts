// Row 12 of the community slot (per-platform liveness, Task 9): a viewer watching a community
// streamer who is not the featured one cross-posts to the streamer they watch. The send carries the
// entry's `community` key; the route resolves it against the server's own list (communityTarget) and
// never trusts it as a channel — an unknown key falls back to the featured streamer.
//
// route.ts cannot be executed under node --test (it loads the pool through the @/lib/db alias, like
// every route here), so the decision is run for real through communityTarget and its wiring is
// pinned on the route's source.
// Run: node --test app/api/chat/send/communityRoute.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../../lib/testSource.ts";
import { communityTarget } from "../../../lib/streamView.ts";

const entry = (key: string, display_name: string, twitch_login: string | null, youtube_channel_id: string | null) => ({
  key, display_name, twitch_login, youtube_channel_id, video_id: null, stream_title: "", avatar_url: null, sources: [], scheduled: null,
});

test("row 12: community=<other key> on a Twitch send reaches the other's login; an unknown key reaches the featured one", () => {
  const featured = entry("UCfeaturedfeaturedfeat1", "Featured", "featuredlogin", "UCfeaturedfeaturedfeat1");
  const other = entry("tw:otherlogin", "Other", "otherlogin", null);
  const status = { live: false, community: featured, communities: [featured, other] };
  assert.equal(communityTarget(status, "tw:otherlogin")?.twitch_login, "otherlogin");
  assert.equal(communityTarget(status, "tw:someoneelse")?.twitch_login, "featuredlogin");
  assert.equal(communityTarget(status, null)?.twitch_login, "featuredlogin");
});

test("the route reads `community` from the body as a bounded string and routes through communityTarget", () => {
  const raw = readFileSync(join(import.meta.dirname, "route.ts"), "utf8");
  const src = stripComments(raw);
  assert.match(src, /const chosenCommunity = typeof body\.community === "string" \? body\.community\.slice\(0, 64\) : null;/);
  assert.match(src, /const c = status\.live \? null : communityTarget\(status, chosenCommunity\);\s*if \(c\) \{/);
  assert.match(src, /else if \(platformTarget === "twitch" && c\.twitch_login\) target = \{ twitchLogin: c\.twitch_login \};/);
  assert.doesNotMatch(src, /const c = status\.community;/, "the featured entry is no longer the only target");
  assert.match(raw.slice(-400), /\}\s*$/, "vacuity: the route was read to its end");
  assert.ok(src.length > 20_000, "vacuity: the whole route, not a stub");
});

test("the send carries the entry the viewer watches: StreamView → ChatSidebar → useSendChatMessage", () => {
  const view = stripComments(readFileSync(join(import.meta.dirname, "../../../components/StreamView.tsx"), "utf8"));
  assert.match(view, /communityKey=\{shownCommunity\?\.key \?\? null\}/);
  const sidebar = stripComments(readFileSync(join(import.meta.dirname, "../../../features/chat/ChatSidebar.tsx"), "utf8"));
  assert.match(sidebar, /useSendChatMessage\(setBanExpiry, communityKey\)/);
  const hook = stripComments(readFileSync(join(import.meta.dirname, "../../../lib/useSendChatMessage.ts"), "utf8"));
  assert.match(hook, /\.\.\.\(communityKey \? \{ community: communityKey \} : \{\}\),/);
});
