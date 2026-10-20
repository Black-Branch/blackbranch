// The user card's data-before-visible discipline. What can go wrong here: the
// prefetch NOT deduping (every pointerdown a fresh pair of GETs), the open
// gate hanging past its cap (a press with no card), a failed fetch pinned into
// the cache (15s of "No stream record" re-opens after one network blip), and
// the component wiring quietly dropping off — the press prefetch, the gated
// open, the seeded first frame.
//
// Run: node --test --experimental-strip-types app/lib/userCardData.test.ts

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  prefetchUserCard, userCardDataWithin, _resetUserCardCacheForTests,
} from "./userCardData.ts";

// ── fetch stub ───────────────────────────────────────────────────────────────
const realFetch = globalThis.fetch;
let calls: string[] = [];
let respond: (url: string) => Promise<Response>;

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200, headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  _resetUserCardCacheForTests();
  calls = [];
  respond = (url) =>
    Promise.resolve(url.startsWith("/api/user/credit")
      ? okJson({ credit: 7 })
      : okJson({ found: true, name: "bram" }));
  globalThis.fetch = ((url: RequestInfo | URL) => {
    const u = String(url);
    calls.push(u);
    return respond(u);
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

const MSG = { canonicalId: "abc123", matrixId: "@bram:site.test" };

// ── the cache ────────────────────────────────────────────────────────────────

test("prefetch dedupes: a pointerdown and the click's open gate share ONE fetch pair", async () => {
  const [a, b] = await Promise.all([prefetchUserCard(MSG), prefetchUserCard(MSG)]);
  assert.equal(calls.length, 2, "one lookup + one credit — not a pair per caller");
  assert.deepEqual(a, { lookup: { found: true, name: "bram" }, credit: 7 });
  assert.equal(a, b, "both callers hold the same settled promise's value");
});

test("a subject with no identity fetches nothing and resolves the empty shape", async () => {
  const d = await prefetchUserCard({});
  assert.equal(calls.length, 0);
  assert.deepEqual(d, { lookup: { found: false }, credit: 0 });
});

test("a degraded result is EVICTED — one blip must not pin 'No stream record' for 15s", async () => {
  respond = (url) =>
    url.startsWith("/api/user/credit")
      ? Promise.resolve(okJson({ credit: 7 }))
      : Promise.reject(new Error("boom"));
  const d1 = await prefetchUserCard(MSG);
  assert.equal(d1.lookup.found, false, "the lookup degrades to found:false, exactly as the card's old effect did");
  assert.equal(d1.credit, 7, "the fields degrade INDEPENDENTLY — a lookup failure keeps the credit");
  respond = (url) =>
    Promise.resolve(url.startsWith("/api/user/credit")
      ? okJson({ credit: 7 })
      : okJson({ found: true, name: "bram" }));
  const d2 = await prefetchUserCard(MSG);
  assert.equal(d2.lookup.found, true, "the next open refetches instead of re-serving the blip");
  assert.equal(calls.length, 4, "two pairs: the degraded one, then the retry");
});

test("a clean result is CACHED — an immediate re-open refetches nothing", async () => {
  await prefetchUserCard(MSG);
  await prefetchUserCard(MSG);
  assert.equal(calls.length, 2);
});

// ── the open gate ────────────────────────────────────────────────────────────

test("the gate returns the data when the fetch beats the cap", async () => {
  const d = await userCardDataWithin(MSG, 1000);
  assert.ok(d, "fast path delivers data");
  assert.equal(d.credit, 7);
});

test("the gate returns null once the cap expires — the card must open, not hang on the network", async () => {
  respond = () => new Promise<Response>(() => {}); // a fetch that never settles
  const d = await userCardDataWithin(MSG, 20);
  assert.equal(d, null);
});

// ── the wiring (source-scan pins — each anchored on its file's real tail) ────
const WEB = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");

test("ChatSidebar opens the card THROUGH the gate and seeds it", () => {
  const src = read("features", "chat", "ChatSidebar.tsx");
  assert.match(src, /userCardDataWithin\(msg, USER_CARD_OPEN_CAP_MS\)/,
    "the open gate is gone — the card would mount before its data again");
  assert.match(src, /initialData=\{card\.data\}/,
    "the seed is gone — a gated open would still first-paint a spinner-height card");
  // vacuity anchor — the END of the file, so a truncated read cannot pass
  assert.match(src, /<\/Window>\s*\)\}\s*<\/aside>\s*\);\s*\}\s*$/, "vacuity anchor: ChatSidebar's real tail");
});

test("ChatMessage prefetches at pointer-down on the username", () => {
  const src = read("features", "chat", "ChatMessage.tsx");
  assert.match(src, /onPointerDown=\{onUsernameClick \? \(\) => \{ void prefetchUserCard\(msg\); \} : undefined\}/,
    "the pointerdown prefetch is gone — the press→click gap head start with it");
  // vacuity anchor — the END of the file, so a truncated read cannot pass
  assert.match(src, /<\/div>\s*\);\s*\}\);\s*$/, "vacuity anchor: ChatMessage's real tail (memo-wrapped)");
});

test("UserCard seeds from initialData and falls back through the SAME cache", () => {
  const src = read("components", "UserCard.tsx");
  assert.match(src, /useState<Lookup \| null>\(initialData \? initialData\.lookup : null\)/,
    "the seed is gone — the first frame would be a spinner again");
  assert.match(src, /if \(initialData\) return;/,
    "a seeded card must not refetch what the gate just delivered");
  assert.match(src, /prefetchUserCard\(msg\)/,
    "the unseeded fallback must read THROUGH the cache, so a pointerdown prefetch still pays off in ungated hosts");
  // vacuity anchor — the END of the file, so a truncated read cannot pass
  assert.match(src, /<\/div>\s*\);\s*\}\s*$/, "vacuity anchor: UserCard's real tail");
});
