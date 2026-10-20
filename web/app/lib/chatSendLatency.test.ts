// /api/chat/send's identity reads must run CONCURRENTLY (the chat-send hot
// path, web half).
//
// Four independent reads — active tier, ban row, user style row, canonical
// link. The web app and Postgres can live on different machines, so each
// await is a cross-machine round-trip; four in a row is four RTTs of dead time on the single most common user action,
// before the message even leaves for stream-api. None of them depends on
// another's result — only the CHECKS have an order (rate limit, then ban),
// and checking results in order does not require fetching them in order.
//
// The route is a Next handler over a live pool, so these are source-level
// assertions on the shape (same trade as billingCelebrations.test.ts).
//
// Run: node --test app/lib/chatSendLatency.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../api/chat/send/route.ts", import.meta.url), "utf8");
const post = src.slice(src.indexOf("export async function POST("));

test("the four independent reads are kicked off together", () => {
  assert.ok(post.length > 0, "vacuity anchor: POST is gone from chat/send");
  // The reads object is created once, each field an un-awaited promise.
  const readsAt = post.indexOf("const reads = {");
  assert.notEqual(readsAt, -1,
    "the concurrent-reads block is gone — four serial RTTs are back on the hot path");
  const reads = post.slice(readsAt, post.indexOf("};", readsAt));
  assert.match(reads, /tier:\s*getActiveTier\(matrixId\)/);
  assert.match(reads, /FROM site\.bans/);
  assert.match(reads, /FROM site\.users/);
  assert.match(reads, /FROM site\.platform_links/);
});

test("no identity read is awaited at its creation", () => {
  // The serial shape this replaces: `const tier = await getActiveTier(…)`,
  // then `await pool.query(SELECT … FROM site.bans …)`, and so on.
  assert.doesNotMatch(post, /await getActiveTier\(/,
    "getActiveTier is directly awaited — the reads have gone serial again");
  const directAwaitedSelect = /await pool\.query[\s\S]{0,200}?FROM site\.(bans|platform_links)/;
  assert.doesNotMatch(post, directAwaitedSelect,
    "an identity SELECT is directly awaited — the reads have gone serial again");
});

test("every kicked-off read is still consumed at its checkpoint", () => {
  // Firing promises is not the fix — CHECKING them, in the existing order, is.
  assert.match(post, /await reads\.tier/);
  assert.match(post, /await reads\.bans/);
  assert.match(post, /await reads\.user/);
  assert.match(post, /await reads\.link/);
});

test("an early return cannot leave the ban read as an unhandled rejection", () => {
  // reads.bans intentionally has no inline .catch — a failed ban check must
  // fail the send (fail closed), not default to "not banned". But a rate-limit
  // or bad-request return exits before its checkpoint, and an unobserved
  // rejection takes the whole process down. The detached handler marks it
  // observed without changing what `await reads.bans` throws.
  assert.match(post, /reads\.bans\.catch\(\(\) => \{\}\)/,
    "the detached rejection handler is gone — a DB blip during a rate-limited send crashes the server");
});
