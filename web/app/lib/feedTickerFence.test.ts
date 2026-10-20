// Guards for the news-feed "never runs while it can't be seen" rule —
// unconditional, not a setting.
//
// The ticker crawl is an INFINITE animation on an element that stays mounted
// through two invisible states: StreamView's opacity-0 fade (feedView
// "hidden") and the community-mode width-0 collapse. Opacity does not stop a
// CSS animation, and an invisible element still intersects — so the fence
// needs BOTH the `active` prop and an IntersectionObserver, and the zero-area
// collapse additionally needs an explicit width check (a zero-area target can
// still report isIntersecting).
//
// Run: node --test app/lib/feedTickerFence.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

const read = (...p: string[]) => stripComments(readFileSync(join(process.cwd(), ...p), "utf8"));

test("the ticker registers an IntersectionObserver and derives the paused class from active + onScreen", () => {
  const src = read("app", "components", "FeedPanel", "index.tsx");
  assert.match(src, /new IntersectionObserver/,
    "the ticker no longer observes its own visibility — the crawl runs off-screen again");
  assert.match(src, /active && onScreen \? "" : " feed-ticker-paused"/,
    "the paused class no longer depends on BOTH active and onScreen — one of the " +
    "two invisible states (opacity-0 fade / scroll-away) leaks the animation");
  assert.match(src, /boundingClientRect\.width > 0/,
    "the zero-area guard is gone — the community-mode width-0 collapse can report " +
    "isIntersecting and keep the crawl compositing");
});

test("globals.css actually pauses the track for the fence class", () => {
  const css = read("app", "globals.css");
  assert.match(css, /\.feed-ticker-track\.feed-ticker-paused \{\n\s*animation-play-state: paused;/,
    "the paused rule is gone — FeedPanel's class does nothing");
});

test("RSS polling stays gated on tab visibility", () => {
  // Already true before the fence shipped; pinned so it cannot quietly regress —
  // a backgrounded tab must not poll /api/rss/items.
  const src = read("app", "lib", "useRssFeed.ts");
  assert.match(src, /if \(!document\.hidden\) load\(\);/,
    "the interval load lost its document.hidden gate — hidden tabs poll again");
});

test("mobile only mounts the feed while the News tab is open (or one pane from it, mid-swipe)", () => {
  // ChatSidebar's list view is the only mobile mount; it must stay conditional
  // on the active content tab (registry gate) so a closed News tab costs
  // nothing (no ticker exists there).
  //
  // The pane body is one shared `newsPaneEl` element used by BOTH middle
  // branches, so there are TWO gates: the at-rest content-tab guard and the
  // pager row's own. The claim, checked hard: exactly ONE <FeedPanel in the
  // file, it lives in `newsPaneEl`, and every place that element is rendered
  // is behind a news gate. The pager's extra term (`paneMounted("news")`) is
  // the widened registry contract — approach-mount within one pane — and it is
  // still a gate, not an unconditional mount.
  const src = read("app", "features", "chat", "ChatSidebar.tsx");
  assert.equal((src.match(/<FeedPanel/g) ?? []).length, 1,
    "more than one FeedPanel mount point in the sidebar — each one needs its own gate");
  assert.match(src, /const newsPaneEl = \([^]{0,200}<FeedPanel/,
    "the feed is no longer the body of newsPaneEl — the gates below guard nothing");
  assert.match(src, /\{!pagerOn && contentTab === "news" && newsPaneEl\}/,
    "FeedPanel is mounted outside the news content-tab gate on mobile");
  assert.match(src, /\{k === "news" && paneMounted\("news"\) && newsPaneEl\}/,
    "the pager row mounts the feed unconditionally — a swipe past News would start the poll and never stop it");
});
