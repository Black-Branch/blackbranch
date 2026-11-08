import { test } from "node:test";
import assert from "node:assert/strict";
import { rankByUsage, mergeRanks } from "./emoteUsageServer.ts";

test("ranks only catalog names, in usage order, 1-based and gap-free", () => {
  const r = rankByUsage(["lol", "KEKW", "the", "om", "KEKW", "Qorm"], new Set(["KEKW", "om", "Qorm", "unused"]));
  assert.deepEqual([...r], [["KEKW", 1], ["om", 2], ["Qorm", 3]]);
  assert.equal(r.has("unused"), false, "an emote nobody typed has no rank (the warmer puts it in the tail)");
});

test("no tokens → no ranks", () => {
  assert.equal(rankByUsage([], new Set(["KEKW"])).size, 0);
});

test("mergeRanks: usage rank `r` and sticker rank `s` merged in; an emote with neither keeps its own object", () => {
  const base = { KEKW: { url: "k", zeroWidth: false }, om: { url: "o", zeroWidth: false }, PogU: { url: "q", zeroWidth: false } };
  const m = mergeRanks(base, ["KEKW", "om"], ["om", "nope"]);
  assert.deepEqual(m.KEKW, { url: "k", zeroWidth: false, r: 1 });
  assert.deepEqual(m.om, { url: "o", zeroWidth: false, r: 2, s: 1 });
  assert.equal(m.PogU, base.PogU, "an unranked emote was copied");
  assert.equal(Object.hasOwn(base.om, "s"), false, "the cached manifest was written into");
  assert.equal("nope" in m, false, "a stickered name outside the catalog appeared");
});

test("mergeRanks: no ranks loaded yet → the catalog as it is", () => {
  const base = { KEKW: { url: "k", zeroWidth: false } };
  assert.deepEqual(mergeRanks(base, null, null), base);
});
