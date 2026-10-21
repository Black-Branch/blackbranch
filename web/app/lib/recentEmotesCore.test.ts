// Unit tests for the pure frecency core. Run with:
//   node --test app/lib/recentEmotesCore.test.ts
// (Node ≥ 23 strips the TS types natively — no build step or test deps.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStore, rankNames, bump, RECENT_MAX, type FrecencyEntry } from "./recentEmotesCore.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;
const always = () => true;

// Replay a list of (name, atOffsetDays) uses through bump, then rank at `readAt`.
function ranked(uses: Array<[string, number]>, readDay: number, exists: (n: string) => boolean = always): string[] {
  let store: FrecencyEntry[] = [];
  for (const [name, day] of uses) store = bump(store, name, T0 + day * DAY);
  return rankNames(store, T0 + readDay * DAY, exists);
}

test("legacy string[] format migrates with its order preserved", () => {
  const store = parseStore(["c", "b", "a"], T0); // most-recent-first
  assert.deepEqual(rankNames(store, T0, always), ["c", "b", "a"]);
});

test("malformed / empty storage parses to an empty store", () => {
  assert.deepEqual(parseStore(null, T0), []);
  assert.deepEqual(parseStore([], T0), []);
  assert.deepEqual(parseStore("garbage", T0), []);
  assert.deepEqual(parseStore([{ name: "x" }], T0), []); // missing score/at → dropped
});

test("a frequently-used emote outranks a once-used one", () => {
  const rec = ranked([["fav", 0], ["once", 0], ["fav", 0], ["fav", 0]], 0);
  assert.equal(rec[0], "fav");
});

test("spamming a new emote does NOT evict an established favorite (the churn bug)", () => {
  const uses: Array<[string, number]> = [];
  for (let i = 0; i < 10; i++) uses.push(["fav", i]);        // built up over 10 days
  for (let i = 0; i < 5; i++) uses.push(["spam", 10]);       // then a burst of a one-off
  const rec = ranked(uses, 10);
  assert.ok(rec.includes("fav"), "favorite must survive the spam burst");
  assert.equal(rec[0], "fav", "favorite (score ~10) still outranks the burst (score 5)");
});

test("recency decay lets a fresh emote overtake a long-abandoned favorite", () => {
  // "old" used twice on day 0 (score 2), then abandoned; "new" used once on day 60.
  const rec = ranked([["old", 0], ["old", 0], ["new", 60]], 60);
  assert.equal(rec[0], "new"); // 2 * 0.5^(60/14) ≈ 0.1  <  1
});

test("rankNames filters out emotes that no longer exist", () => {
  const exists = (n: string) => n === "a";
  const rec = ranked([["a", 0], ["b", 0]], 0, exists);
  assert.deepEqual(rec, ["a"]);
});

test("bump drops stale non-existent entries and caps at RECENT_MAX", () => {
  let store: FrecencyEntry[] = [];
  for (let i = 0; i < 5; i++) store = bump(store, "star", T0 + i * DAY); // clear favorite
  for (let i = 0; i < 50; i++) store = bump(store, `e${i}`, T0 + 5 * DAY); // 50 one-offs
  assert.ok(store.length <= RECENT_MAX, "list is capped");
  assert.ok(store.some((e) => e.name === "star"), "the strongest entry is never evicted");
});

// bump() must not prune entries missing from the CURRENT manifest. The manifest
// genuinely collapses sometimes (a 7TV fetch can find 178 of 1150 emotes), so
// pruning would let one emote pick during a degraded fetch permanently erase the
// user's entire frecency history. Persisted state must outlive a transient
// fetch failure; rankNames() hides missing emotes at read time instead.
test("bump does not destroy history when the manifest is degraded", () => {
  const T = 1_700_000_000_000;
  let store: FrecencyEntry[] = [];
  for (const n of ["alpha", "beta", "gamma"]) store = bump(store, n, T);
  assert.equal(store.length, 3);

  // Manifest collapses to a single emote; the user picks it.
  store = bump(store, "alpha", T + 1000);

  const names = store.map((e) => e.name).sort();
  assert.deepEqual(names, ["alpha", "beta", "gamma"], "history must survive a degraded manifest");

  // And they are correctly HIDDEN (not deleted) while missing...
  const degraded = (n: string) => n === "alpha";
  assert.deepEqual(rankNames(store, T + 2000, degraded), ["alpha"]);

  // ...then reappear once the manifest recovers.
  const recovered = () => true;
  assert.equal(rankNames(store, T + 3000, recovered).length, 3, "entries return after recovery");
});
