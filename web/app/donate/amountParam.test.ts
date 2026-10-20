import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAmountParam } from "./amountParam.ts";

test("a usable amount survives", () => {
  assert.equal(parseAmountParam("10"), 10);
  assert.equal(parseAmountParam("7.5"), 7.5);
  assert.equal(parseAmountParam("1"), 1);
  assert.equal(parseAmountParam("1000"), 1000);
});

test("anything unusable is ignored rather than argued with", () => {
  // The page must still render its default; a bad link is not an error page.
  for (const bad of ["", "abc", "-5", "0", "1000.01", "1e9", "NaN", "Infinity", undefined]) {
    assert.equal(parseAmountParam(bad as string | undefined), undefined, `rejected: ${String(bad)}`);
  }
});

test("a repeated parameter takes the first value", () => {
  // Next gives string[] for ?amount=5&amount=9; picking one is a decision, so pin it.
  assert.equal(parseAmountParam(["5", "9"]), 5);
});
