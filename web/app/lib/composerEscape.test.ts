// Escape precedence in the chat composer.
//
// In spend mode (highlight/read-aloud), pressing Escape dismisses the spend,
// the same way it dismisses a / command.
//
// A source scan rather than a behavioural test because the handler lives in a
// .tsx that `node --test` cannot load at all — the same reason lineTokens and
// linkGuard were extracted. What matters here is ORDER, and order is exactly
// what a scan can pin: Escape has five possible meanings in this one handler
// (emote picker, reply, spend, command palette, emote overlay) and the bug in
// each direction is that the wrong one wins.
//
// The anchor problem this file has to avoid: `if (e.key === "Escape")` occurs
// TWICE in handleKeyDown — once in the overlay block and once inside
// `cmdOwnsKeys`. Slicing from the first match to the `cmdOwnsKeys` guard is what
// keeps the assertions pointed at the block they claim to describe; without it a
// deleted branch could silently retarget every index comparison below onto the
// palette's block, which would still pass.
//
// Run: node --test app/lib/composerEscape.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** The first Escape block of ChatInput's handleKeyDown, comments removed. */
function escapeBlock(): string {
  const src = stripComments(
    readFileSync(join(here, "../features/chat/ChatInput.tsx"), "utf8")
  );
  const fn = src.indexOf("function handleKeyDown");
  assert.notEqual(fn, -1, "handleKeyDown is gone from ChatInput — anchors lost");

  const start = src.indexOf('if (e.key === "Escape")', fn);
  assert.notEqual(start, -1, "the overlay Escape block is gone from handleKeyDown");

  const end = src.indexOf("cmdOwnsKeys", start);
  assert.notEqual(end, -1, "the cmdOwnsKeys guard is gone — the slice below is unbounded");

  const block = src.slice(start, end);
  // Vacuity guard: an empty or near-empty slice makes every index comparison
  // below trivially true.
  assert.ok(block.length > 80, `the Escape block scanned to ${block.length} chars — too small to be real`);
  return block;
}

test("Escape dismisses spend mode", () => {
  const block = escapeBlock();
  assert.match(
    block, /setSpendMode\(null\)/,
    "Escape no longer leaves spend mode — the chip's ✕ would be the only exit again"
  );
});

test("Escape dismisses spend via the MODE, not the derived active flag", () => {
  const block = escapeBlock();
  // spendActive is `spendMode !== null && !replyTo && !!matrixId && !encryptArmed`.
  // Keying the branch off it would strand a composer whose spend is armed but
  // inactive — armed with no matrixId, or armed alongside the encrypted
  // sentinel — with no keyboard exit at all.
  assert.match(
    block, /if \(spendMode\)/,
    "the spend branch is keyed off something other than spendMode"
  );
  assert.doesNotMatch(
    block, /if \(spendActive\)/,
    "the spend branch is keyed off spendActive, which is false in exactly the states " +
    "where a user is most stuck"
  );
});

test("transient overlays outrank composer modes", () => {
  const block = escapeBlock();
  const picker = block.indexOf("showEmotePicker");
  const reply = block.indexOf("replyTo");
  const spend = block.indexOf("spendMode");
  assert.ok(picker !== -1 && reply !== -1 && spend !== -1, "an Escape branch vanished");

  // The emote picker is an overlay ON TOP of the composer: an Escape aimed at it
  // must not reach past it and cancel the spend the user is still composing.
  assert.ok(
    picker < spend,
    "spend is dismissed before the emote picker closes — one Escape would do two things"
  );
  // reply and spend are mutually exclusive (spendActive requires !replyTo), so
  // this order is about keeping the two composer modes read in a fixed sequence
  // rather than about a reachable conflict.
  assert.ok(reply < spend, "the reply branch moved below spend");
});

test("dismissing a spend does not also close a card behind the composer", () => {
  const block = escapeBlock();
  const spend = block.indexOf("if (spendMode)");
  const branch = block.slice(spend);
  // The floating Window closes on a document-level Escape (its listener is on `document`,
  // and React's root-container delegation runs first, so stopPropagation here
  // genuinely prevents it). Without this, escaping a spend would also close an
  // open profile/account card.
  assert.match(
    branch, /e\.stopPropagation\(\)/,
    "the spend branch does not stop propagation — Escape would also close an open floating Window"
  );
  assert.match(
    branch, /e\.preventDefault\(\)/,
    "the spend branch does not preventDefault, unlike every other branch beside it"
  );
});
