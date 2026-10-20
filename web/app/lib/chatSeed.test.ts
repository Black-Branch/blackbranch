// The chat opens with its rows already on the page: the
// server reads the newest page of history and hands it to useChatMessages as
// `initialMessages`, and this module turns that page into the buffer's first
// state — the same rows, in the same order, with the same stripe parity the
// live path would have assigned. Pure, so node --test can pin it without React.
//
// Run: node --test app/lib/chatSeed.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { assignAlt, newAltState, seedMessages } from "./chatSeed.ts";
import type { ChatMsg } from "./chatMsg.ts";

const row = (id: number, extra: Partial<ChatMsg> = {}): ChatMsg => ({
  id, platform: "native", username: "Bram42", message: `m${id}`,
  isMod: false, isVip: false, isMember: false, ts: 1000 + id, ...extra,
});

test("a seed keeps the rows, oldest first, and caps to the live buffer", () => {
  const st = newAltState();
  const out = seedMessages([row(3), row(1), row(2)], st, 2);
  assert.deepEqual(out.map((m) => m.id), [2, 3], "sorted by time, then the NEWEST `cap` rows kept");
});

test("stripe parity is assigned in seed order and continues into the live path", () => {
  const st = newAltState();
  const out = seedMessages([row(1), row(2), row(3)], st, 80);
  assert.deepEqual(out.map((m) => m.alt), [false, true, false]);
  // The live path's next message takes the next ordinal — no parity reset at
  // the seam, or the first live row would repeat the stripe of the last seeded one.
  assert.equal(assignAlt(st, row(4)).alt, true);
  // Re-seeing a seeded id keeps its parity (the WS history frame replays them).
  assert.equal(assignAlt(st, row(2)).alt, true);
});

test("a deleted or unkeyable row never seeds — the page shows what everyone sees", () => {
  const st = newAltState();
  const bad = { ...row(9), platform: undefined } as unknown as ChatMsg;
  const out = seedMessages([row(1), row(2, { deleted: true }), bad], st, 80);
  assert.deepEqual(out.map((m) => m.id), [1]);
});

test("no seed, no rows", () => {
  assert.deepEqual(seedMessages(undefined, newAltState(), 80), []);
});
