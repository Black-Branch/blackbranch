// Community-gift processing must be serialized per session.
//
// The race: Stripe delivery is at-least-once, and the community branch is
// tally → RANDOM recipient pick → grant loop → announce. Without a lock, two
// concurrent deliveries of the same checkout session both read
// remaining=count, pick DIFFERENT random recipients — so grantGift's
// per-recipient ON CONFLICT cannot dedup across the two sets — and both call
// announceGift, which stream-api credits to support_events/the bar each time.
// Double grant, double bar credit, from one payment.
//
// Three layers, each pinned here:
//   1. pg_advisory_xact_lock(hashtext(session)) BEFORE the tally — the second
//      delivery blocks, then its tally sees the first's rows (the pattern
//      app/api/points/spend/sticker-boost/route.ts uses; a mock pool cannot
//      verify lock SEMANTICS, so this pins the wiring and PG provides the
//      semantics).
//   2. The tally must not swallow errors — a `.catch(() => 0 rows)` would turn
//      a DB blip into "nothing processed yet", i.e. an over-grant.
//   3. announceGift carries a spendId derived from the session id, so even a
//      delivery that somehow bypassed the lock dedups at stream-api's
//      /chat/event outcome store instead of crediting the bar twice.
//
// Run: node --test app/lib/giftIdempotency.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function readWhole(path: string, tailAnchor: RegExp): string {
  const src = readFileSync(join(webRoot, path), "utf8");
  assert.match(
    src.slice(-400), tailAnchor,
    `${path} did not end as expected — the read is truncated, and every assertion below it is vacuous`,
  );
  return stripComments(src);
}

const GIFTS = "app/lib/giftServer.ts";
const GIFTS_TAIL = /setInterval\(\(\) => void run\(\), 60 \* 60 \* 1000\); \/\/ hourly\s*\}\s*$/;

test("the community tally runs under the session's advisory lock", () => {
  const src = readWhole(GIFTS, GIFTS_TAIL);
  const lockAt = src.indexOf("pg_advisory_xact_lock(hashtext($1))");
  const tallyAt = src.indexOf("FROM site.gift_subscriptions WHERE stripe_session_id");
  assert.ok(lockAt !== -1,
    "no advisory lock in giftServer — two concurrent deliveries of one session double-grant " +
    "and double-credit the bar (random recipients defeat the per-recipient ON CONFLICT)");
  assert.ok(tallyAt !== -1, "the community tally query is gone — rewrite this test with it");
  assert.ok(lockAt < tallyAt,
    "the tally runs BEFORE the lock — the second delivery reads remaining=count before blocking, " +
    "which is the race unchanged");
});

test("the tally does not swallow errors into 'nothing processed yet'", () => {
  const src = readWhole(GIFTS, GIFTS_TAIL);
  const tallyBlock = src.match(/SELECT[\s\S]{0,400}gift_pending\s+WHERE stripe_session_id[\s\S]{0,200}/)?.[0] ?? "";
  assert.ok(tallyBlock, "tally query not found");
  assert.doesNotMatch(tallyBlock, /catch\(\(\) => \(\{ rows: \[\{ granted: 0, pending: 0 \}\]/,
    "the tally's catch turns a DB blip into granted=0/pending=0 — i.e. 'grant everything again'. " +
    "Let it throw: a webhook 500 makes Stripe redeliver later, which is the safe failure");
});

test("the gift announce carries a session-derived spendId for stream-api dedup", () => {
  const src = readWhole(GIFTS, GIFTS_TAIL);
  assert.match(src, /spendId: `gift:\$\{sessionId\}`/,
    "announceGift has no spendId — a double announce credits the support bar twice; " +
    "/chat/event's outcome store can only dedup what carries an id");
  const calls = src.match(/await announceGift\(/g) ?? [];
  assert.equal(calls.length, 2, "announceGift call sites changed — re-verify both pass cs.id");
  assert.match(src, /announceGift\(gifter, anonymous, "direct", months, \[recipient\], cs\.amount_total \?\? 0, cs\.id\)/,
    "the direct-gift announce no longer passes the session id");
  assert.match(src, /announceGift\(gifter, anonymous, "community", months, grantedNow, cs\.amount_total \?\? 0, cs\.id\)/,
    "the community-gift announce no longer passes the session id");
});
