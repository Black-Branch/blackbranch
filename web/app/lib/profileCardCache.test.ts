// The profile-card session cache (feedback round 2, issue 2 — the pop-in fix).
//
// The properties that make the UX fix real, pinned:
//   - concurrent prefetches (idle warm + hover + card mount) coalesce onto ONE
//     load — the triggers are deliberately layered, so without coalescing every
//     card open would fire the batch three times;
//   - hover → click inside the freshness window is served from cache, so the
//     click that follows a prefetching hover costs zero network;
//   - the batch resolves as one unit (the anti-pop-in property: sections land
//     together, never one by one);
//   - a switched account can never read the previous account's card;
//   - a failed load doesn't wedge the inflight slot (retry works).
//
// Run: node --test app/lib/profileCardCache.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { createProfileCardCache, type ProfileCardData, type ProfileCardIds } from "./profileCardCache.ts";

function batch(credit: number): ProfileCardData {
  return {
    me: { displayName: "casey", canonicalId: "af3a4e0ffee3", bannerMxc: "mxc://site.test/x" },
    pronouns: null,
    color: "#aabbcc",
    style: { font: "script" },
    linkedPlatforms: ["twitch"],
    stats: { found: true, activity: 10 },
    credit,
  };
}

const IDS: ProfileCardIds = { matrixId: "@casey:site.test", canonicalId: "af3a4e0ffee3" };

test("cold cache reads null; prefetch resolves the whole batch and read serves it", async () => {
  let loads = 0;
  const loaded: ProfileCardData[] = [];
  const cache = createProfileCardCache(async () => { loads++; return batch(5); }, (d) => loaded.push(d));
  assert.equal(cache.read(IDS.matrixId), null, "cold cache must read null (card falls back to fetch-then-batch-paint)");
  const d = await cache.prefetch(IDS);
  assert.equal(d.credit, 5);
  assert.equal(cache.read(IDS.matrixId)?.credit, 5, "read() must serve the prefetched batch synchronously");
  assert.equal(loads, 1);
  assert.equal(loaded.length, 1, "onLoaded (the image/font warm hook) fires once per load");
});

test("concurrent prefetches coalesce onto one load", async () => {
  let loads = 0;
  let release!: (d: ProfileCardData) => void;
  const gate = new Promise<ProfileCardData>((r) => { release = r; });
  const cache = createProfileCardCache(() => { loads++; return gate; });
  const p1 = cache.prefetch(IDS); // idle warm
  const p2 = cache.prefetch(IDS); // hover
  const p3 = cache.prefetch(IDS); // card mount
  release(batch(1));
  const [a, b, c] = await Promise.all([p1, p2, p3]);
  assert.equal(loads, 1, "three stacked triggers must cost one network batch");
  assert.equal(a, b);
  assert.equal(b, c);
});

test("a fresh cache short-circuits the follow-up prefetch (hover → click)", async () => {
  let loads = 0;
  const cache = createProfileCardCache(async () => { loads++; return batch(2); });
  await cache.prefetch(IDS);          // hover warm
  const d = await cache.prefetch(IDS); // click → card mount, milliseconds later
  assert.equal(loads, 1, "the click must be served from the hover's still-fresh batch");
  assert.equal(d.credit, 2);
});

test("read never serves another account's data", async () => {
  const cache = createProfileCardCache(async () => batch(3));
  await cache.prefetch(IDS);
  assert.equal(cache.read("@someoneelse:site.test"), null);
  // Prefix-trick guard: a matrixId that happens to prefix the cached one.
  assert.equal(cache.read("@casey:example"), null);
});

test("patchMe merges an in-place edit into the cached me", async () => {
  const cache = createProfileCardCache(async () => batch(4));
  await cache.prefetch(IDS);
  cache.patchMe(IDS.matrixId, { bannerMxc: "mxc://site.test/NEW" });
  assert.equal(cache.read(IDS.matrixId)?.me?.bannerMxc, "mxc://site.test/NEW");
  assert.equal(cache.read(IDS.matrixId)?.me?.displayName, "casey", "patch must merge, not replace");
  cache.patchMe("@someoneelse:site.test", { bannerMxc: "mxc://evil/x" });
  assert.equal(cache.read(IDS.matrixId)?.me?.bannerMxc, "mxc://site.test/NEW", "a mismatched account must not patch");
});

test("invalidate drops the cache and forces the next prefetch to reload", async () => {
  // The Should-Fix regression: editing color/style/pronouns/display name
  // PATCHes the API, but a close+reopen inside the 15s freshness window would
  // serve the pre-edit batch. The editor's save paths call invalidate().
  let loads = 0;
  const cache = createProfileCardCache(async () => { loads++; return batch(loads); });
  await cache.prefetch(IDS);
  cache.invalidate();
  assert.equal(cache.read(IDS.matrixId), null, "an edited profile must not be readable from the stale cache");
  const d = await cache.prefetch(IDS);
  assert.equal(loads, 2, "the freshness window must not survive an invalidation");
  assert.equal(d.credit, 2);
});

test("a load in flight when invalidate() fires never lands its stale batch", async () => {
  let release!: (d: ProfileCardData) => void;
  const gate = new Promise<ProfileCardData>((r) => { release = r; });
  let first = true;
  const cache = createProfileCardCache(() => {
    if (first) { first = false; return gate; }
    return Promise.resolve(batch(99));
  });
  const p = cache.prefetch(IDS); // load starts…
  cache.invalidate();            // …edit lands mid-flight
  release(batch(1));             // …then the PRE-edit batch resolves
  const stale = await p;
  assert.equal(stale.credit, 1, "the caller still gets the batch it asked for");
  assert.equal(cache.read(IDS.matrixId), null, "but the stale batch must never repopulate the cache");
  const fresh = await cache.prefetch(IDS);
  assert.equal(fresh.credit, 99, "the next prefetch reloads for real");
});

test("a failed load clears the inflight slot so the next prefetch retries", async () => {
  let loads = 0;
  const cache = createProfileCardCache(async () => {
    loads++;
    if (loads === 1) throw new Error("network down");
    return batch(9);
  });
  await assert.rejects(cache.prefetch(IDS));
  assert.equal(cache.read(IDS.matrixId), null, "a failed load must not populate the cache");
  const d = await cache.prefetch(IDS);
  assert.equal(d.credit, 9);
  assert.equal(loads, 2, "the retry must actually reload");
});
