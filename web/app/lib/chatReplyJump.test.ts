// Click a reply to jump to the message it answers; hover it to read the
// whole thing. The pure pieces: where to scroll, and what the preview says.
//
// Run: node --test app/lib/chatReplyJump.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replyJumpPlan, replyPreviewOf, findReplyTarget, REPLY_FLASH_MS } from "./chatReplyJump.ts";
import { stripComments } from "./testSource.ts";

const box = { clientHeight: 400, scrollHeight: 4000 };

test("a target already fully on screen is not scrolled to — and the live feed is not paused for it", () => {
  assert.deepEqual(replyJumpPlan({ ...box, scrollTop: 3600, rowTop: 3700, rowHeight: 40 }), { kind: "visible" });
});

test("a target above the viewport is centred, and the feed pauses first so the engine does not snap back", () => {
  assert.deepEqual(replyJumpPlan({ ...box, scrollTop: 3600, rowTop: 1000, rowHeight: 40 }),
    { kind: "scroll", top: 820 });
});

test("a target near the top clamps at zero rather than asking for a negative scroll", () => {
  assert.deepEqual(replyJumpPlan({ ...box, scrollTop: 3600, rowTop: 30, rowHeight: 40 }),
    { kind: "scroll", top: 0 });
});

test("a landing spot that IS the bottom re-anchors instead of writing — a write there is undone while anchored and strands a paused feed", () => {
  // Half-cut at the top edge of a short feed sitting at the bottom.
  assert.deepEqual(replyJumpPlan({ clientHeight: 400, scrollHeight: 500, scrollTop: 100, rowTop: 95, rowHeight: 380 }), { kind: "bottom" });
});

test("a row taller than the viewport lands with its TOP in view, not its middle", () => {
  assert.deepEqual(replyJumpPlan({ ...box, scrollTop: 3600, rowTop: 1000, rowHeight: 900 }),
    { kind: "scroll", top: 1000 });
});

test("the preview prefers the LOADED message — the stored reply text is clipped at 100 characters", () => {
  const long = "x".repeat(300);
  const msgs = [{ id: 7, platform: "native", username: "ana", message: long }];
  assert.deepEqual(replyPreviewOf({ reply_to_id: 7, reply_to_username: "ana", reply_to_text: long.slice(0, 100) }, msgs),
    { username: "ana", text: long, clipped: false });
});

test("a target that is no longer loaded falls back to the stored clip, and says it may be clipped", () => {
  assert.deepEqual(replyPreviewOf({ reply_to_id: 7, reply_to_username: "ana", reply_to_text: "y".repeat(100) }, []),
    { username: "ana", text: "y".repeat(100), clipped: true });
  // A short stored text cannot have been clipped.
  assert.equal(replyPreviewOf({ reply_to_id: 7, reply_to_username: "ana", reply_to_text: "hi" }, [])?.clipped, false);
});

test("a deleted target shows nothing of what it said", () => {
  const msgs = [{ id: 7, platform: "native", username: "ana", message: "secret", deleted: true }];
  assert.equal(replyPreviewOf({ reply_to_id: 7, reply_to_username: "ana", reply_to_text: "secret" }, msgs), null);
});

test("no reply, no preview", () => {
  assert.equal(replyPreviewOf({ reply_to_id: null, reply_to_username: null, reply_to_text: null }, []), null);
});

// A reply to a Twitch/YouTube/Kick chatter carries NO id (the send route nulls
// it — the column is a foreign key into site messages), which is a large share
// of native replies. Those are matched by author + quoted text.
test("a reply with no id finds the nearest EARLIER message by that author starting with the quoted text", () => {
  const rows = [
    { id: "a1", platform: "twitch", username: "Dana", message: "honey is tasty and also good for you" },
    { id: "a2", platform: "twitch", username: "dana", message: "honey is tasty and also good for you" },
    { id: 9, platform: "native", username: "me", message: "agreed", reply_to_id: null, reply_to_username: "dana", reply_to_text: "honey is tasty" },
    { id: "a3", platform: "twitch", username: "dana", message: "honey is tasty, later" },
  ];
  assert.equal(findReplyTarget(rows[2]!, rows)?.id, "a2", "nearest earlier, case-insensitive author, never a LATER row");
  // No author match: a SHORT quote is not enough to go on…
  assert.equal(findReplyTarget({ ...rows[2]!, reply_to_username: "someone else", reply_to_text: "honey" }, rows), null);
  // …a long one is (names differ across platforms) — still the nearest earlier row.
  assert.equal(findReplyTarget({ ...rows[2]!, reply_to_username: "someone else" }, rows)?.id, "a2");
});

// A real exchange: the streamer answers a Twitch chatter from the site; Twitch
// shows it as "@name …" under the Twitch display name, and the chatter's reply
// quotes THAT.
test("a platform reply quoting the '@name ' form of a site message finds the site row, under its other name", () => {
  const rows = [
    { id: 4100, platform: "native", username: "casey", message: "Nope, the site keeps none of that, it lives on the homeserver." },
    { id: 4101, platform: "twitch", username: "GadgetTinker", message: "@HostChannel Makes sense, just curious",
      reply_to_id: null, reply_to_username: "HostChannel", reply_to_text: "@GadgetTinker Nope, the site keeps none of that, it lives on the homeserver." },
  ];
  assert.equal(findReplyTarget(rows[1]!, rows)?.id, 4100);
  // A short quote is not trusted without an author match.
  assert.equal(findReplyTarget({ ...rows[1]!, reply_to_text: "@GadgetTinker Nope," }, rows), null);
});

test("two rows can share an id (two sequences): the quoted author picks between them", () => {
  const rows = [
    { id: 500, platform: "twitch", username: "bob", message: "platform row" },
    { id: 500, platform: "native", username: "ana", message: "native row" },
  ];
  assert.equal(findReplyTarget({ reply_to_id: 500, reply_to_username: "ana", reply_to_text: "native" }, rows)?.platform, "native");
});

test("the flash is brief", () => { assert.ok(REPLY_FLASH_MS >= 800 && REPLY_FLASH_MS <= 2500); });

// Wiring: the reply line is a BUTTON. That is what keeps the broadcaster's
// click-to-highlight (chatSpotlight's NOT_A_PICK lists `button`) from firing on
// the same click, and what makes it keyboard-reachable.
test("the reply line is a button wherever a host can jump, both hosts wire it, and the OBS source does not", () => {
  const dir = ["app", "features", "chat"];
  const msg = stripComments(readFileSync(join(process.cwd(), ...dir, "ChatMessage.tsx"), "utf8"));
  assert.match(msg.slice(-200), /\)\s*;?\s*\}\s*\)\s*;?\s*$/, "ChatMessage.tsx read whole");
  assert.match(msg, /<button[^>]*\bdata-reply-jump\b/);
  assert.match(msg, /data-chat-row-key=\{/);
  for (const f of ["ChatSidebar.tsx", "ChatWindow.tsx"]) {
    const src = stripComments(readFileSync(join(process.cwd(), ...dir, f), "utf8"));
    assert.match(src.slice(-120), /\}\s*$/, `${f} read whole`);
    assert.match(src, /useReplyJump\(\{ scrollRef, messages, pause, anchorToBottom \}\)/, `${f} does not use the jump`);
    assert.match(src, /onReplyJump=\{onReplyJump\}/, `${f} does not hand the jump to its rows`);
    assert.match(src, /<ReplyPreview\b/, `${f} does not render the preview`);
    assert.match(src, /onScroll=\{\(\) => \{ handleScroll\(\); dismissPreview\(\); \}\}/, `${f}: a scroll must drop the preview`);
  }
  // The OBS source cannot be clicked, so its line stays plain text.
  const obs = stripComments(readFileSync(join(process.cwd(), ...dir, "ChatOverlay.tsx"), "utf8"));
  assert.match(obs.slice(-120), /\}\s*$/, "ChatOverlay.tsx read whole");
  assert.doesNotMatch(obs, /onReplyJump|onReplyPreview/);
});
