import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResult } from "./usePaymentResult.ts";

test("parseResult: 'none' -> null", () => { assert.equal(parseResult({ outcome: "none" }), null); });
test("parseResult: 'failed' -> {title, body} only", () => {
  assert.deepEqual(
    parseResult({ outcome: "failed", title: "Insufficient funds.", body: "Insufficient funds. You were not charged. Try another payment method or card.", canRetry: true, at: "2026-09-22T01:00:00.000Z" }),
    { title: "Insufficient funds.", body: "Insufficient funds. You were not charged. Try another payment method or card." }
  );
});
test("parseResult: malformed input is null, not a throw", () => {
  assert.equal(parseResult(null), null);
  assert.equal(parseResult(undefined), null);
  assert.equal(parseResult({}), null);
});
