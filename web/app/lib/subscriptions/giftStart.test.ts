// A gift's start is STORED (`site.gift_subscriptions.starts_at`, migrate-v172), never derived from its
// end. It used to be `expires_at - make_interval(months => months)`, and Postgres clamps month
// arithmetic: Oct 31 + 1 month = Nov 30, Nov 30 - 1 month = Oct 30. A gift queued behind a period
// ending on the 31st told its recipient it began a day early (CI 40250307555, 2026-10-26, caught when
// the test's now-relative period end landed on Oct 31). The behaviour is pinned by
// giftQueue.db.test.ts and giftServer.db.test.ts; this scan keeps the derivation from coming back
// anywhere a gift's dates are read: every non-test source file in web/app and stream-api.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../testSource.ts";

const WEB_APP = join(import.meta.dirname, "..", "..");
const STREAM_API = join(WEB_APP, "..", "..", "stream-api");

/** Every non-test source file under `root` (node_modules and build output left out). */
function sources(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.(?:ts|tsx|js|mjs|cjs)$/.test(f) && !/\.test\.|(?:^|\/)(?:node_modules|\.next)\//.test(f))
    .map((f) => join(root, f));
}

/** A start computed by taking months off a date: the subtraction itself, in SQL or in JS. */
const DERIVES_START = [
  /-\s*make_interval\s*\(\s*months\b/,                                   // x - make_interval(months => n)
  /-\s*\(?\s*(?:[\w$.]+\s*\*\s*)?interval\s*'[^']*\bmon(?:th|ths|s)?\b/i,  // x - interval '1 month', x - (n * interval '1 month')
  /set(?:UTC)?Month\(\s*[^)]*\.get(?:UTC)?Month\(\)\s*-/,               // d.setMonth(d.getMonth() - n)
];
const derives = (s: string) => DERIVES_START.some((re) => re.test(s));

const files = [...sources(WEB_APP), ...sources(STREAM_API)];
const text = new Map(files.map((f) => [f, stripComments(readFileSync(f, "utf8"))]));

test("no code path derives a date by subtracting months — a gift's start is read from starts_at", () => {
  const hits = [...text].filter(([, s]) => derives(s)).map(([f]) => f);
  assert.deepEqual(hits, [], "a start derived by subtracting months is a day early at month ends: read starts_at");
});

test("the gift readers and writers name the stored start", () => {
  const read = (rel: string) => text.get(join(WEB_APP, rel)) ?? "";
  const queue = read("lib/subscriptions/giftQueue.ts");
  assert.match(queue, /SELECT id, starts_at AS start, expires_at, follows_subscription AS follows/, "the renewal mover reads the stored start");
  assert.match(queue, /SET starts_at = \$2::timestamptz, expires_at = \$2::timestamptz \+ make_interval\(months => months\)/, "and moves it with the end");
  assert.match(queue, /SELECT MIN\(starts_at\) AS start FROM site\.gift_subscriptions\s+WHERE recipient_matrix_id = \$1 AND follows_subscription AND starts_at > now\(\)/,
    "the date the recipient is told");
  assert.match(read("lib/giftLedger.ts"), /CASE WHEN g\.follows_subscription AND g\.starts_at > now\(\) THEN NULL ELSE g\.expires_at END AS expires_at/);
  assert.match(read("lib/giftServer.ts"), /\(stripe_session_id, gifter_matrix_id, recipient_matrix_id, tier, months, kind, anonymous, follows_subscription, starts_at, expires_at\)/,
    "the grant writes the start");
});

// Vacuity anchors: the scan above is a NEGATIVE assertion, green over a short read. It must have read
// both packages, each scanned gift file to its END, and its detector must still catch the old line.
test("vacuity: the scan read both packages to the end of each gift file, and its detector catches the old derivation", () => {
  assert.ok(files.length > 300, `the scan read ${files.length} files`);
  assert.ok(files.some((f) => f.startsWith(STREAM_API) && f.endsWith("economics.js")), "stream-api was scanned");
  const tail = (rel: string, re: RegExp) => assert.match(text.get(join(WEB_APP, rel)) ?? "", re, `END of ${rel} not read`);
  tail("lib/subscriptions/giftQueue.ts", /return \(rows \?\? \[\]\)\.map\(\(r\) => r\.recipient_matrix_id\);\s*\}\s*$/);
  tail("lib/giftLedger.ts", /a\.createdAt > b\.createdAt \? -1 : 0\)\);\s*\}\s*$/);
  tail("lib/giftServer.ts", /setInterval\(\(\) => void run\(\), 60 \* 60 \* 1000\);\s*\}\s*$/);
  assert.ok(derives("SELECT MIN(expires_at - make_interval(months => months)) AS start"), "the line CI 40250307555 caught");
  assert.ok(derives("g.expires_at - interval '1 month'"));
  assert.ok(derives("expires_at - ($1 * interval '1 month')"));
  assert.ok(derives("d.setUTCMonth(d.getUTCMonth() - months)"));
  assert.ok(!derives("now() - make_interval(days => $1)"), "a days window is not a month derivation");
});
