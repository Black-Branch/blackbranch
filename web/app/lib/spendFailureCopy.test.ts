// "Nothing was charged" may only be said when it is PROVABLE. The invariant
// (chatEventDelivery.ts): a refusal the server answered with 4xx provably
// credited nothing (or refunded), so the claim is true and a kindness. A 5xx
// the client cannot classify may sit AFTER the credit — claiming "nothing was
// charged" there is exactly the lie the unconfirmed contract exists to avoid.
//
// The copy is pure, out of StoreSpend.tsx (a .tsx, unreachable by
// `node --test`) and useStickerSend.ts, so the money copy is testable.
//
// Run: node --test app/lib/spendFailureCopy.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { storeSpendFailureCopy, stickerSendFailureCopy } from "./spendFailureCopy.ts";

test("store: a 4xx refusal may truthfully say nothing was charged", () => {
  assert.match(storeSpendFailureCopy(400, {}), /nothing was charged/i);
  assert.match(storeSpendFailureCopy(402, {}), /Not enough/i);
  assert.match(storeSpendFailureCopy(429, { retryAfterSeconds: 3 }), /3s/);
  assert.match(storeSpendFailureCopy(400, { error: "blocked" }), /word filter/i);
  assert.match(storeSpendFailureCopy(409, { error: "stream_offline" }), /live/i);
  assert.match(storeSpendFailureCopy(409, { error: "sound_unavailable" }), /clip/i);
  assert.match(storeSpendFailureCopy(409, { error: "price_changed", price: 250 }), /250/);
});

test("store: an unclassifiable 5xx must NOT claim nothing was charged", () => {
  // The crash may sit AFTER the debit and before the refund — the honest copy
  // is the unconfirmed one, with its mod-refund escape hatch.
  const copy = storeSpendFailureCopy(500, {});
  assert.doesNotMatch(copy, /nothing was charged/i,
    "a 500 is not a provable refusal — this claim can be false exactly when money moved");
  assert.match(copy, /confirm|refund/i, "the unconfirmed copy must offer the recovery path");
  assert.doesNotMatch(storeSpendFailureCopy(502, {}), /nothing was charged/i);
  assert.doesNotMatch(storeSpendFailureCopy(503, {}), /nothing was charged/i);
});

test("store: an explicit *_unconfirmed error keeps the unconfirmed copy at any status", () => {
  assert.match(storeSpendFailureCopy(502, { error: "sound_unconfirmed" }), /confirm/i);
});

test("sticker: refusals keep their specific truthful copy", () => {
  assert.match(stickerSendFailureCopy(402, {}), /Not enough/i);
  assert.match(stickerSendFailureCopy(429, { retryAfterSeconds: 5 }), /5s/);
  assert.match(stickerSendFailureCopy(409, { price: 120 }), /120/);
  assert.match(stickerSendFailureCopy(400, {}), /nothing was charged/i);
});

test("sticker: a 503 no longer asserts the price story OR the charge", () => {
  // 503 is not read as "price table unavailable" (pre-debit, true) — a
  // 503 can also be minted by infrastructure with the debit already taken.
  // Only the route's own error code proves the pre-debit story.
  assert.match(stickerSendFailureCopy(503, { error: "price_unavailable" }), /nothing was charged/i);
  assert.doesNotMatch(stickerSendFailureCopy(503, {}), /nothing was charged/i);
});

test("sticker: an unclassifiable 5xx must NOT claim nothing was charged", () => {
  const copy = stickerSendFailureCopy(500, {});
  assert.doesNotMatch(copy, /nothing was charged/i);
  assert.match(copy, /confirm|refund/i);
  assert.match(stickerSendFailureCopy(502, { error: "sticker_unconfirmed" }), /confirm|refund/i);
});

test("StoreSpend refreshes the price table on price_changed — the 409 must not stick", async () => {
  // The truthful 409 copy needs the refresh too — a tile that keeps rendering
  // the STALE price re-sends the same expectedPrice on every retry and loops
  // on the same 409 forever. The sticker flow (useStickerSend) refreshes on
  // 409 and is the model.
  // Source scan: spend() lives in a .tsx, unreachable by node --test.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../features/store/StoreSpend.tsx", import.meta.url), "utf8");
  // Anchored to the spend() failure path specifically — the admin reprice
  // handler also calls refreshStorePrices() near a "price_changed" comment,
  // and a loose proximity regex matches THAT and goes vacuously green.
  const spendFn = src.slice(src.indexOf("async function spend("), src.indexOf("export default function StoreSpend"));
  assert.ok(spendFn.length > 0, "vacuity anchor: spend() is gone from StoreSpend");
  assert.match(spendFn, /if\s*\(d\.error === "price_changed"\)\s*refreshStorePrices\(\)/,
    "spend()'s price_changed refusal must refresh the table so the tiles re-render with the price the server will accept");
  assert.match(src, /export default function StoreSpend/,
    "vacuity anchor: StoreSpend's default export is gone — the scan is reading the wrong file");
});
