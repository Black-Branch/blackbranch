// Unit tests for the pure emote/mention trigger logic. Run with:
//   node --test app/lib/emoteTriggerLogic.test.ts
// (Node ≥ 23 strips the TS types natively — no build step or test deps.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectTriggers, getCurrentTrigger, buildValue, restoreQuery } from "./emoteTriggerLogic.ts";

const triggerAt = (value: string, caret: number, mentions?: string[]) =>
  getCurrentTrigger(value, caret, detectTriggers(value, caret, false, mentions));

test("plain word at end of input is detected", () => {
  const v = "hello Kap";
  const s = triggerAt(v, v.length);
  assert.equal(s?.mode, "plain");
  assert.equal(s?.query, "Kap");
  assert.equal(s?.prefix, "hello ");
  assert.equal(s?.suffix, "");
  assert.equal(s?.tail, "");
});

test("caret in the MIDDLE of a word completes that word, preserving the rest", () => {
  const v = "hello Kap world";      // caret right after "Kap"
  const caret = "hello Kap".length;
  const s = triggerAt(v, caret);
  assert.equal(s?.mode, "plain");
  assert.equal(s?.query, "Kap");
  assert.equal(s?.prefix, "hello ");
  assert.equal(s?.suffix, " world"); // following word kept (with its leading space)
  assert.equal(s?.tail, "");

  const built = buildValue(s!, "Kappa");
  assert.equal(built.value, "hello Kappa world");   // single space, "world" intact
  assert.equal(built.caret, "hello Kappa".length);  // caret after the inserted emote
});

test("caret INSIDE a partially-typed word replaces the whole word", () => {
  const v = "gg NotLikeThis gg";    // caret after "NotLike"
  const caret = "gg NotLike".length;
  const s = triggerAt(v, caret);
  assert.equal(s?.query, "NotLike");
  assert.equal(s?.tail, "This");    // the rest of the word, after the caret
  assert.equal(s?.suffix, " gg");

  const built = buildValue(s!, "NotLikeThis");
  assert.equal(built.value, "gg NotLikeThis gg"); // whole word swapped, trailing "gg" kept
});

test("end-of-input commit adds a trailing space", () => {
  const v = "yo Kap";
  const s = triggerAt(v, v.length)!;
  const built = buildValue(s, "Kappa");
  assert.equal(built.value, "yo Kappa ");
  assert.equal(built.caret, built.value.length);
});

test("colon trigger and zero-width filter", () => {
  const v = "nice :~sta";
  const s = triggerAt(v, v.length)!;
  assert.equal(s.mode, "colon");
  assert.equal(s.query, "sta");
  assert.equal(s.zeroWidth, true);
  assert.equal(buildValue(s, "StareCat").value, "nice StareCat ");
});

test("mention trigger only when mentions provided", () => {
  const v = "hey @jor";
  assert.equal(triggerAt(v, v.length), null); // no mentions list → @ not a trigger
  const s = triggerAt(v, v.length, ["casey", "joe"]);
  assert.equal(s?.mode, "mention");
  assert.equal(s?.query, "jor");
  assert.equal(buildValue(s!, "casey").value, "hey @casey ");
});

test("no trigger for a single-char plain word", () => {
  const v = "a";
  assert.equal(triggerAt(v, v.length), null);
});

test("suppress disables all triggers", () => {
  const v = "hello Kap";
  const t = detectTriggers(v, v.length, true);
  assert.equal(getCurrentTrigger(v, v.length, t), null);
});

test("restoreQuery round-trips the typed text and caret", () => {
  const v = "hello Kap world";
  const caret = "hello Kap".length;
  const s = triggerAt(v, caret)!;
  const r = restoreQuery(s);
  assert.equal(r.value, v);       // original value reconstructed
  assert.equal(r.caret, caret);   // caret back where it was
});

test("commit when suffix starts with non-space inserts a separator", () => {
  const v = "Kap!";              // caret after "Kap", suffix "!"
  const s = triggerAt(v, "Kap".length)!;
  assert.equal(s.suffix, "!");
  assert.equal(buildValue(s, "Kappa").value, "Kappa !");
});
