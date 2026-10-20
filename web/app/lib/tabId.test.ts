// Tests for the per-tab census id (pure, node --test, no DOM).
//
// The one invariant that matters: whatever this module hands back always
// passes the server's REAL validator — parseTabId, app/lib/sourceCensus.ts —
// which is importable here the same way sourceCensus.test.ts already imports
// it under node --test. A malformed id is rejected by the server silently —
// the viewer is just never counted, a failure with no symptom — so this file
// exists to keep that validator satisfied on every path, not just the happy
// one. Asserting against the real function, not a restated copy of its
// regex, is the point: a copy can drift the moment the server's regex is
// widened, and this file is what is supposed to catch that when it happens.
//
// Run: node --test app/lib/tabId.test.ts

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { parseTabId } from "./sourceCensus.ts";

// ── A fake sessionStorage ────────────────────────────────────────────────────
class Store {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

const store = new Store();
const g = globalThis as unknown as { sessionStorage: unknown };
g.sessionStorage = store;

const { tabId } = await import("./tabId.ts");

beforeEach(() => {
  store.map.clear();
  g.sessionStorage = store;
});

test("a minted id passes the server's real validator, over many mints", () => {
  for (let i = 0; i < 1000; i++) {
    store.map.clear();
    const id = tabId();
    assert.equal(parseTabId(id), id, `"${id}" must pass the server's real parseTabId`);
  }
});

test("tabId() returns the same value on repeated calls within one session", () => {
  const first = tabId();
  const second = tabId();
  const third = tabId();
  assert.equal(second, first);
  assert.equal(third, first);
});

test("a stored value that does not pass the server's validator is replaced, not returned", () => {
  store.setItem("player_tab_id", "!!!not-valid!!!");
  const id = tabId();
  assert.equal(parseTabId(id), id, `"${id}" must pass the server's real parseTabId`);
  assert.notEqual(id, "!!!not-valid!!!");
  // and the replacement is what gets persisted for the next call
  assert.equal(store.getItem("player_tab_id"), id);
});

test("falls back to a validator-passing id when sessionStorage throws (private mode)", () => {
  g.sessionStorage = {
    getItem() { throw new Error("storage disabled"); },
    setItem() { throw new Error("storage disabled"); },
  };
  const id = tabId();
  assert.equal(parseTabId(id), id, `"${id}" must pass the server's real parseTabId`);
});
