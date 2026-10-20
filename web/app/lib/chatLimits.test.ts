import { test } from "node:test";
import assert from "node:assert/strict";
import { chatCharLimit } from "./chatLimits.ts";

test("viewers get 200, staff get 500", () => {
  assert.equal(chatCharLimit({ isMod: false, isAdmin: false }), 200);
  assert.equal(chatCharLimit({ isMod: true, isAdmin: false }), 500);
  assert.equal(chatCharLimit({ isMod: false, isAdmin: true }), 500);
});

test("a coin-paid TTS message is capped at what the voice reads, for everyone", () => {
  assert.equal(chatCharLimit({ isMod: true, isAdmin: true }, "tts"), 200);
  assert.equal(chatCharLimit({ isMod: false, isAdmin: false }, "tts"), 200);
});

test("highlight mode is an ordinary message", () => {
  assert.equal(chatCharLimit({ isMod: false, isAdmin: false }, "highlight"), 200);
  assert.equal(chatCharLimit({ isMod: false, isAdmin: false }, null), 200);
});
