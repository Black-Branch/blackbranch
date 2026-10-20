import { test } from "node:test";
import assert from "node:assert/strict";
import { rankByUsage } from "./emoteUsageServer.ts";

test("ranks only catalog names, in usage order, 1-based and gap-free", () => {
  const r = rankByUsage(["lol", "KEKW", "the", "om", "KEKW", "Qorm"], new Set(["KEKW", "om", "Qorm", "unused"]));
  assert.deepEqual([...r], [["KEKW", 1], ["om", 2], ["Qorm", 3]]);
  assert.equal(r.has("unused"), false, "an emote nobody typed has no rank (the warmer puts it in the tail)");
});

test("no tokens → no ranks", () => {
  assert.equal(rankByUsage([], new Set(["KEKW"])).size, 0);
});
