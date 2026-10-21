import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
// testDom installs window/sessionStorage globals (jsdom) before anything reads them.
import "./testDom.ts";
import { readHomeStore, writeHomeStore, subscribeHomeStore, resetHomeStore } from "./homeStore.ts";

const body = { status: null, lastStream: null, news: null, vods: null, threads: null, boards: null, platforms: [] as string[], generatedAt: "2026-09-26T08:00:00.000Z" };

beforeEach(() => { resetHomeStore(); sessionStorage.clear(); });

test("a written body is read back as the SAME object, subscribers hear it, and it survives a fresh module read via sessionStorage", () => {
  let fired = 0;
  const off = subscribeHomeStore(() => { fired++; });
  assert.equal(readHomeStore(), null);
  writeHomeStore(body);
  assert.equal(readHomeStore(), readHomeStore(), "stable reference (useSyncExternalStore needs it)");
  assert.equal(fired, 1);
  resetHomeStore(); // a new page: memory gone, sessionStorage not
  assert.deepEqual(readHomeStore(), body);
  off();
});

test("an older envelope, garbage, a body without generatedAt, or null reads as absent", () => {
  for (const raw of ['{"v":1,"body":{"generatedAt":"x"}}', "not json", '{"v":2,"body":{}}', "null", '{"v":2}']) {
    resetHomeStore();
    sessionStorage.setItem("home_payload_v1", raw);
    assert.equal(readHomeStore(), null, raw);
  }
});

test("a storage that throws still keeps the body in memory", () => {
  const real = globalThis.sessionStorage;
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get() { throw new Error("blocked"); } });
  try {
    writeHomeStore(body);
    assert.deepEqual(readHomeStore(), body);
  } finally {
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, writable: true, value: real });
  }
});

test("a body stored before platforms existed reads with platforms: [] (the sign-in logos never read undefined)", () => {
  resetHomeStore();
  sessionStorage.setItem("home_payload_v1", JSON.stringify({ v: 2, body: { generatedAt: "2026-09-26T08:00:00.000Z", news: null } }));
  assert.deepEqual(readHomeStore()?.platforms, []);
  resetHomeStore();
});
