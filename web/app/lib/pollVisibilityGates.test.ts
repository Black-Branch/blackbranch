// Guards for mobile idle cost: pollers must skip hidden tabs, refresh on
// return where the UI depends on freshness, and keep state identity stable
// when a payload hasn't changed (fresh identities defeat memo and re-render
// the whole chat — a badge poll doing that every 60s re-renders up to 1000
// rows).
//
// Run: node --test app/lib/pollVisibilityGates.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
import { keepIfEqual } from "./stableState.ts";

const read = (...p: string[]) => stripComments(readFileSync(join(process.cwd(), ...p), "utf8"));

test("keepIfEqual keeps the previous identity for structurally equal payloads", () => {
  const prev = { a: [1, 2], b: "x" };
  assert.equal(keepIfEqual({ a: [1, 2], b: "x" })(prev), prev, "equal payload must return prev itself");
  const next = { a: [1, 2], b: "y" };
  assert.equal(keepIfEqual(next)(prev), next, "changed payload must return the new value");
  const arr = [1, 2, 3];
  assert.equal(keepIfEqual([1, 2, 3])(arr), arr);
  assert.equal(keepIfEqual(null)(null), null);
});

test("status poll: polls while hidden ON PURPOSE (LIVE tab title), visible-return stays immediate", () => {
  // The status poll does NOT skip hidden tabs: the LIVE tab title is
  // document.title, which is exactly what a hidden tab shows, so the poll
  // must keep running to update it. One tiny status GET per 30s is the price.
  // (The badge poll below keeps ITS hidden gate — nothing it learns shows on
  // a hidden tab.)
  const src = read("app", "lib", "useStreamStatusPoll.ts");
  assert.match(src, /document\.title = live/,
    "the LIVE title writer is gone — if it stays gone, the hidden-tab poll skip should come back");
  assert.doesNotMatch(src, /if \(!document\.hidden\) poll\(\);/,
    "the hidden gate is back while the tab title depends on the poll — the title freezes exactly when it matters");
  assert.match(src, /visibilitychange/,
    "no return-to-visible poll — the live/offline tab auto-switch (edge-detected " +
    "from poll results) would wait out the interval after the tab returns");
  assert.match(src, /setCommunity\(keepIfEqual\(/, "community lost identity stability");
  assert.match(src, /setLoopVideos\(keepIfEqual\(/, "loopVideos lost identity stability");
});

test("badge poll: identity-stable setters + hidden gate on the interval", () => {
  const src = read("app", "lib", "BadgesContext.tsx");
  assert.match(src, /setCatalog\(keepIfEqual\(/,
    "catalog gets a fresh identity every poll again — every ChatMessage re-renders past memo each 60s");
  assert.match(src, /setPerUser\(keepIfEqual\(/, "perUser lost identity stability");
  assert.match(src, /if \(!document\.hidden\) refresh\(\);/,
    "the 60s interval lost its hidden gate (visibilitychange already refreshes on return)");
});

test("timer tick skips hidden tabs (recomputes from the wall-clock anchor on return)", () => {
  const src = read("app", "lib", "useStreamTimer.ts");
  assert.match(src, /if \(document\.hidden\) return;\n\s*const a = anchor\.current;/,
    "the 250ms tick lost its hidden gate — it runs at full rate in backgrounded tabs again");
});

test("E2EE dot: only the transient pending-verification state pulses", () => {
  const src = read("app", "lib", "useEncryptionStatus.ts");
  assert.doesNotMatch(src, /"bg-red-400 animate-pulse"/,
    "red pulses again — an infinite animation in the always-mounted composer for " +
    "the long-lived not-cross-signed state (the common case)");
  assert.match(src, /"bg-yellow-400 animate-pulse"/,
    "the pending-verification pulse was removed — that one is transient and needs eyes");
});
