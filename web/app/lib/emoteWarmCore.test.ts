import { test } from "node:test";
import assert from "node:assert/strict";
import { planWarm, warmNeeded, warmRecordKey } from "./emoteWarmCore.ts";
import type { EmoteMap } from "./emoteMap.ts";

// A manifest shaped like prod: globals first, channel sets last.
const E: EmoteMap = {
  gA: { url: "https://cdn.7tv.app/emote/gA/2x.webp", zeroWidth: false },
  gB: { url: "https://cdn.7tv.app/emote/gB/2x.webp", zeroWidth: false, r: 2, still: "https://cdn.7tv.app/emote/gB/2x_static.webp" },
  bt: { url: "https://cdn.betterttv.net/emote/bt/3x.png", zeroWidth: false },
  far: { url: "https://cdn.7tv.app/emote/far/2x.webp", zeroWidth: false, r: 900 },
  KEKW: { url: "https://cdn.7tv.app/emote/kekw/2x.webp", zeroWidth: false, r: 1, h: 20 },
  chan: { url: "https://static-cdn.jtvnw.net/emoticons/v2/1/static/dark/3.0", zeroWidth: false },
};
const id = (u: string, h?: number) => (h ? `${u}#${h}` : u);
const base = { emotes: E, recent: [] as string[], still: false, net: {}, size: id };

test("hot = recents, then the channel's own Twitch emotes, then the top ranks; tail = the rest", () => {
  const p = planWarm({ ...base, recent: ["gA"] });
  assert.deepEqual(p.hot, [
    "https://cdn.7tv.app/emote/gA/2x.webp",
    "https://static-cdn.jtvnw.net/emoticons/v2/1/static/dark/3.0",
    "https://cdn.7tv.app/emote/kekw/2x.webp#20", // sized with its own 1x height
    "https://cdn.7tv.app/emote/gB/2x.webp",
  ]);
  // Ranked beyond the hot set first, then the never-used in REVERSE manifest order.
  assert.deepEqual(p.tail, ["https://cdn.7tv.app/emote/far/2x.webp", "https://cdn.betterttv.net/emote/bt/3x.png"]);
});

test("animated emotes off → the still frame where one exists", () => {
  const p = planWarm({ ...base, still: true });
  assert.ok(p.hot.includes("https://cdn.7tv.app/emote/gB/2x_static.webp"));
  assert.ok(!p.hot.includes("https://cdn.7tv.app/emote/gB/2x.webp"));
});

test("Save-Data or a 2g link warms nothing; 3g warms the hot set only", () => {
  assert.deepEqual(planWarm({ ...base, net: { saveData: true } }), { hot: [], tail: [] });
  assert.deepEqual(planWarm({ ...base, net: { effectiveType: "2g" } }), { hot: [], tail: [] });
  assert.deepEqual(planWarm({ ...base, net: { effectiveType: "slow-2g" } }), { hot: [], tail: [] });
  const g3 = planWarm({ ...base, net: { effectiveType: "3g" } });
  assert.ok(g3.hot.length > 0);
  assert.deepEqual(g3.tail, []);
});

test("every URL appears once", () => {
  const dup: EmoteMap = { a: E.gA!, b: { ...E.gA! } };
  const p = planWarm({ ...base, emotes: dup });
  assert.equal([...p.hot, ...p.tail].length, 1);
});

test("a finished walk is skipped; a half one resumes at the tail; a stale or different one re-runs", () => {
  const plan = { hot: ["h"], tail: ["t"] };
  const now = 1_000_000_000;
  assert.deepEqual(warmNeeded({ k: "K", t: now - 1000, tier: "all" }, "K", now, plan), { hot: [], tail: [] });
  assert.deepEqual(warmNeeded({ k: "K", t: now - 1000, tier: "hot" }, "K", now, plan), { hot: [], tail: ["t"] });
  assert.deepEqual(warmNeeded({ k: "K", t: now - 8 * 86_400_000, tier: "all" }, "K", now, plan), plan);
  assert.deepEqual(warmNeeded({ k: "OTHER", t: now, tier: "all" }, "K", now, plan), plan);
  assert.deepEqual(warmNeeded(null, "K", now, plan), plan);
});

test("the record key moves with the display size, the still switch and the catalog", () => {
  const k = warmRecordKey("1@31", false, E);
  assert.notEqual(k, warmRecordKey("2@61", false, E));
  assert.notEqual(k, warmRecordKey("1@31", true, E));
  assert.notEqual(k, warmRecordKey("1@31", false, { ...E, extra: E.gA! }));
  assert.equal(k, warmRecordKey("1@31", false, { ...E }));
});
