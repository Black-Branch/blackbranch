// Without read receipts a channel's unread dot only clears when another client
// on the same account reads it. The decision of WHEN to send is pure and tested
// here; the hook only owns timing.
//
// Run: node --test app/lib/readReceipts.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./testSource.ts";
import { nextReceiptTarget } from "./readReceipts.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

test("anchored + visible + a new newest event → send for it", () => {
  assert.equal(nextReceiptTarget({ anchored: true, visible: true, newestId: "$b", lastSentId: "$a" }), "$b");
  assert.equal(nextReceiptTarget({ anchored: true, visible: true, newestId: "$b", lastSentId: null }), "$b");
});

test("scrolled up → nothing (you have not seen the newest message)", () => {
  assert.equal(nextReceiptTarget({ anchored: false, visible: true, newestId: "$b", lastSentId: "$a" }), null);
});

test("tab hidden → nothing", () => {
  assert.equal(nextReceiptTarget({ anchored: true, visible: false, newestId: "$b", lastSentId: "$a" }), null);
});

test("already sent for this event → nothing (no receipt spam)", () => {
  assert.equal(nextReceiptTarget({ anchored: true, visible: true, newestId: "$b", lastSentId: "$b" }), null);
});

test("no events → nothing", () => {
  assert.equal(nextReceiptTarget({ anchored: true, visible: true, newestId: null, lastSentId: null }), null);
});

test("Timeline and ThreadPanel both mount the hook", () => {
  for (const rel of ["../features/community/Timeline.tsx", "../features/community/ThreadPanel.tsx"]) {
    const src = stripComments(readFileSync(join(HERE, rel), "utf8"));
    assert.match(src, /useReadReceipts\(\{/, `${rel} must call useReadReceipts`);
  }
});

// Vacuity anchor at the END: the decision genuinely varies with its inputs.
test("the decision discriminates", () => {
  assert.notEqual(
    nextReceiptTarget({ anchored: true, visible: true, newestId: "$b", lastSentId: "$a" }),
    nextReceiptTarget({ anchored: false, visible: true, newestId: "$b", lastSentId: "$a" }),
  );
});
