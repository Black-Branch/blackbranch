// The per-viewer tier cache behind getActiveTier (entitlements.ts). The defect it
// fixes (P05): a query error was turned into "no rows", so the viewer read as not
// a Supporter, and that answer was cached for 60 s — one database blip stripped
// every Supporter's perks (and encrypted-message reading) for a minute.
//
// Run: node --test app/lib/tierCache.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTierCache, TIER_FAILURE_LOG_MS } from "./tierCache.ts";
import { stripComments } from "./testSource.ts";

const TTL = 60_000;
const STALE = 2 * TTL; // the stale window counts from the last good answer, as ttlCache.ts's does

function harness(answers: (string | null | Error)[]) {
  let now = 1_000_000;
  const calls: string[] = [];
  const warnings: string[] = [];
  const cache = createTierCache<string>({
    ttlMs: TTL,
    serveStaleForMs: STALE,
    now: () => now,
    warn: (line) => warnings.push(line),
    lookup: async (id) => {
      calls.push(id);
      const a = answers.shift();
      if (a instanceof Error) throw a;
      return a ?? null;
    },
  });
  return { cache, calls, warnings, advance: (ms: number) => { now += ms; } };
}

test("a good answer is cached for the TTL", async () => {
  const h = harness(["supporter"]);
  assert.equal(await h.cache.get("@a:x"), "supporter");
  h.advance(TTL - 1);
  assert.equal(await h.cache.get("@a:x"), "supporter");
  assert.equal(h.calls.length, 1);
});

test("an error is never cached: the next call queries again (P05)", async () => {
  const h = harness([new Error("connection terminated"), "supporter"]);
  assert.equal(await h.cache.get("@a:x"), null, "no previous value: null for THIS call only");
  assert.equal(await h.cache.get("@a:x"), "supporter", "the next call asked the database again");
  assert.equal(h.calls.length, 2);
});

test("the previous value survives one error, and is not re-stamped", async () => {
  const h = harness(["supporter", new Error("timeout"), "supporter"]);
  assert.equal(await h.cache.get("@a:x"), "supporter");
  h.advance(TTL + 1);
  assert.equal(await h.cache.get("@a:x"), "supporter", "the blip keeps the Supporter a Supporter");
  assert.equal(await h.cache.get("@a:x"), "supporter");
  assert.equal(h.calls.length, 3, "the stale value was served but not stored as fresh");
});

test("errors in a row serve the old tier for ONE stale window, then nothing", async () => {
  // A lookup that keeps failing must not keep a lapsed Supporter's perks until a restart.
  const h = harness(["supporter", new Error("down"), new Error("still down")]);
  assert.equal(await h.cache.get("@a:x"), "supporter");
  h.advance(TTL + 1);
  assert.equal(await h.cache.get("@a:x"), "supporter", "first error, inside the stale window: the old tier");
  h.advance(STALE);
  assert.equal(await h.cache.get("@a:x"), null, "second error, past the window: nothing");
  assert.equal(h.calls.length, 3);
});

test("RETRY: an outage logs once per minute, not once per call", async () => {
  const h = harness(Array.from({ length: 5 }, () => new Error("down")));
  for (let i = 0; i < 4; i++) await h.cache.get(`@u${i}:x`);
  assert.equal(h.warnings.length, 1);
  assert.doesNotMatch(h.warnings[0]!, /@u0/, "the line names no viewer");
  h.advance(TIER_FAILURE_LOG_MS);
  await h.cache.get("@u9:x");
  assert.equal(h.warnings.length, 2);
  assert.match(h.warnings[1]!, /3 more/, "the next line says how many it held back");
});

test("RESTART: a fresh cache (a restarted process) asks the database first", async () => {
  const before = harness(["supporter"]);
  await before.cache.get("@a:x");
  const after = harness(["supporter"]);
  assert.equal(await after.cache.get("@a:x"), "supporter");
  assert.equal(after.calls.length, 1);
});

test("invalidate drops the entry so the next read reflects a webhook's change", async () => {
  const h = harness(["supporter", null]);
  await h.cache.get("@a:x");
  h.cache.invalidate("@a:x");
  assert.equal(await h.cache.get("@a:x"), null);
});

test("getActiveTier goes through the cache and lets a query error reach it", () => {
  const src = stripComments(readFileSync(new URL("./entitlements.ts", import.meta.url), "utf8"));
  assert.match(src, /import \{ createTierCache \} from "\.\/tierCache(?:\.ts)?";/);
  assert.doesNotMatch(src, /\.catch\(/, "no catch may turn a query error into an answer that gets cached");
  assert.doesNotMatch(src, /tierCache\.set\(|new Map</, "the one cache is tierCache.ts");
  assert.match(src, /return tiers\.get\(matrixId\);/);
  // END anchor: the scan read the whole file.
  assert.match(src.trimEnd(), /return tier \? CHAT_RATE_SUB : CHAT_RATE_BASE;\n\}$/);
});
