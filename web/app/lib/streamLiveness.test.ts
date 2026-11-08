// livenessOf — /stream/current's `liveness` as the site reads it (streamStatus.ts → StreamStatus.liveness).
//
// Run: node --test app/lib/streamLiveness.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { livenessOf } from "./streamLiveness.ts";
import { stripComments } from "./testSource.ts";

const AT = Date.parse("2026-10-25T20:00:00Z");

test("a snapshot passes through, cut to state, since and YouTube's scheduled start", () => {
  const cur = { live: true, liveness: { at: AT, platforms: {
    twitch: { state: "live", since: AT - 5, key: "k", evidence: "helix-live", misses: 0 },
    youtube: { state: "upcoming", since: AT - 9, scheduledStart: AT + 60_000, evidence: "upcoming" },
    myspace: { state: "live", since: 1 },
  } } };
  assert.deepEqual(livenessOf(cur), { at: AT, platforms: {
    twitch: { state: "live", since: AT - 5 },
    youtube: { state: "upcoming", since: AT - 9, scheduledStart: AT + 60_000 },
  } });
});

test("an older stream-api (no liveness) or a malformed one reads as none — never an invented state", () => {
  for (const cur of [null, {}, { live: false }, { liveness: null }, { liveness: "live" }, { liveness: { platforms: {} } }, { liveness: { at: "now", platforms: {} } }]) {
    assert.equal(livenessOf(cur), undefined, JSON.stringify(cur));
  }
  assert.deepEqual(livenessOf({ liveness: { at: AT, platforms: null } }), { at: AT, platforms: {} });
});

// streamStatus.ts cannot be imported here (it loads the pool); its wiring is pinned on its source.
test("streamStatus.ts carries livenessOf(cur) onto the live answer and every offline answer", () => {
  const src = stripComments(readFileSync(join(import.meta.dirname, "streamStatus.ts"), "utf8"));
  assert.match(src, /import \{ livenessOf \} from "\.\/streamLiveness\.ts";/);
  assert.match(src, /const lv = livenessOf\(cur\);\s*const liveness = lv \? \{ liveness: lv \} : \{\};/);
  assert.equal(src.match(/\.\.\.liveness\b/g)?.length, 2, "the live answer and the offline (community or loop) answer");
  // Vacuity anchor: the scan above read the whole file, to its last line.
  assert.match(src, /export const getStreamStatus = \(\): Promise<StreamStatus> => statusCache\.get\(\);\s*$/);
});
