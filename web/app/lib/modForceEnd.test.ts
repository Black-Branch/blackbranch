// Mod force-end must not collapse "couldn't ask" into "already offline".
//
// The same class the poller's sessionDecision handles: a failed read is NOT a
// negative answer. A liveness read whose `.catch(() => null)` falls through to
// the `{ live: false, ended: false }` no-op would tell a mod hitting "force
// offline" while stream-api rebooted that the stream was already off, while
// the site kept showing LIVE. The honest answer is a 502.
//
// Source scan (the route imports the auth stack, unreachable by node --test),
// with vacuity anchors.
//
// Run: node --test app/lib/modForceEnd.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROUTE = "app/api/mod/stream/end/route.ts";

test("a failed liveness read answers 502, never the already-offline no-op", () => {
  const src = readFileSync(join(process.cwd(), ROUTE), "utf8");
  assert.match(src, /export async function POST/, "vacuity anchor: the handler is gone");
  const readFail = src.search(/if \(!cur \|\| !cur\.ok\)[\s\S]{0,160}status: 502/);
  const noop = src.indexOf("ended: false");
  assert.ok(readFail !== -1,
    "the liveness-read failure path must answer 502 — a failed read is not a negative answer (sessionDecision's rule)");
  assert.ok(noop !== -1, "vacuity anchor: the legitimate no-op branch is gone");
  assert.ok(readFail < noop,
    "the 502 guard must sit BEFORE the no-op — otherwise the catch's null still falls through as 'already offline'");
});
