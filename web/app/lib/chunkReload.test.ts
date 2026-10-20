// Run: node --test app/lib/chunkReload.test.ts
//
// chunkReload.ts exports exactly one thing — shouldReloadForChunkError — so
// every assertion here goes through it, the same as ErrorBoundary does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldReloadForChunkError } from "./chunkReload.ts";

/** The smallest thing that behaves like sessionStorage for these calls. */
function fakeStore(initial: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  } as Storage;
}

test("it recognises the exact message production recorded", () => {
  // Copied verbatim from a site.client_errors row.
  const err = new Error("Failed to load chunk /_next/static/chunks/2zy8__-pww23p.js from module 177674");
  assert.equal(shouldReloadForChunkError(err, fakeStore()), true);
});

test("it recognises the other bundlers' spellings too", () => {
  // A bundler upgrade must not silently turn this guard off.
  for (const m of [
    "Loading chunk 42 failed.",
    "ChunkLoadError: Loading chunk vendors failed",
    "error loading dynamically imported module: https://site.test/_next/static/x.js",
    "Importing a module script failed.",
  ]) {
    // A fresh store per message: each is a first sighting in its own session.
    assert.equal(shouldReloadForChunkError(new Error(m), fakeStore()), true, `should match: ${m}`);
  }
});

test("an ordinary crash is NOT a chunk error", () => {
  // The whole boundary must not turn into a reload loop for real bugs.
  for (const m of [
    "Cannot read properties of undefined (reading 'map')",
    "Node.removeChild: The node to be removed is not a child of this node",
    "Failed to load Stripe.js",
  ]) {
    assert.equal(shouldReloadForChunkError(new Error(m), fakeStore()), false, `should NOT match: ${m}`);
  }
});

test("a non-Error value does not throw and does not match", () => {
  const store = fakeStore();
  assert.equal(shouldReloadForChunkError(null, store), false);
  assert.equal(shouldReloadForChunkError("Failed to load chunk foo", store), false);
  assert.equal(shouldReloadForChunkError({ message: 42 }, store), false);
});

test("it reloads once, then never again in the same session", () => {
  // A chunk that 404s because the file is genuinely gone would reload forever.
  const store = fakeStore();
  const err = new Error("Failed to load chunk /_next/static/chunks/a.js from module 1");
  assert.equal(shouldReloadForChunkError(err, store), true, "first time must reload");
  assert.equal(store.length, 1, "the latch must be written to the store");
  assert.equal(shouldReloadForChunkError(err, store), false, "second time must NOT reload");
});

test("a non-chunk error neither reloads nor arms the latch", () => {
  const store = fakeStore();
  assert.equal(shouldReloadForChunkError(new Error("boom"), store), false);
  assert.equal(store.length, 0, "an unrelated crash must not spend the one reload");
});

test("no storage at all degrades to not reloading", () => {
  // Private mode, or a browser that throws on sessionStorage access. Showing the
  // boundary's fallback is correct; an unlatched reload loop is not.
  assert.equal(shouldReloadForChunkError(new Error("Failed to load chunk x"), null), false);
});

// Vacuity anchor at the END: the function must genuinely behave differently
// across calls, or every assertion above could be reading one constant.
test("the same chunk error is not a constant answer — it depends on the store's history", () => {
  const store = fakeStore();
  const err = new Error("Failed to load chunk x");
  const first = shouldReloadForChunkError(err, store);
  const second = shouldReloadForChunkError(err, store);
  assert.equal(first, true);
  assert.equal(second, false);
  assert.notEqual(first, second, "shouldReloadForChunkError must not be a constant function");
});
