// The composer's line id (lineId.ts) and its wiring in ChatInput: one id for every attempt at a
// line (a restored draft sent again, the "Not sent" retry), a new id for a new line.
//
// Run: node --test app/lib/lineId.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
import { createLineIds } from "./lineId.ts";

const counter = () => { let n = 0; return () => `id-${++n}`; };

test("retry: a restored line sent again keeps its id", () => {
  const ids = createLineIds(counter());
  const first = ids.forText("hey");
  // The send threw; the box holds "hey" again and the sender presses Enter.
  assert.equal(ids.forText("hey"), first);
  assert.equal(ids.forText("hey"), first, "however many times it is resent");
});

test("an edited line is a new line", () => {
  const ids = createLineIds(counter());
  const first = ids.forText("hey");
  assert.notEqual(ids.forText("hey there"), first);
});

test("a line that went through retires its id: the same words again are a new line", () => {
  const ids = createLineIds(counter());
  const first = ids.forText("lol");
  ids.sent(first);
  assert.notEqual(ids.forText("lol"), first, "a second 'lol' would be swallowed as a replay");
});

test("a late success of an older line does not retire the line in the box", () => {
  const ids = createLineIds(counter());
  const old = ids.forText("one");
  const now = ids.forText("two");
  ids.sent(old);
  assert.equal(ids.forText("two"), now);
});

test("the default mint is a UUID (the route ignores anything else)", () => {
  assert.match(createLineIds().forText("x"), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("ChatInput: the composer's id rides every send, the failed line keeps its own, success retires it", () => {
  const raw = readFileSync(join(import.meta.dirname, "../features/chat/ChatInput.tsx"), "utf8");
  assert.match(raw.slice(-400), /<\/form>\s*\)\s*;\s*}\s*$/, "vacuity: ChatInput was read to its end");
  const src = stripComments(raw);
  assert.match(src, /const \[lineIds\] = useState\(createLineIds\);/);
  // A composed line: its id from the text (the same id when a restored draft is resent).
  assert.match(src, /await sendLine\(text, replyTo, capturedSpend, true, lineIds\.forText\(text\)\);/);
  // The "Not sent" retry resends with the id the line was first sent with.
  assert.match(src, /await sendLine\(f\.text, f\.reply, f\.spend, false, f\.clientMsgId\);/);
  assert.match(src, /setFailedLine\(\{ text, reply: replyToRestore, spend: capturedSpend, clientMsgId \}\);/);
  // Both composer send paths carry it, and each retires it once the send returned.
  assert.match(src, /await onSendMessage\(outcome\.text, null, outcome\.destination, spend, outcome\.encrypted, clientMsgId\);\s*lineIds\.sent\(clientMsgId\);/);
  assert.match(src, /await onSendMessage\(text, capturedReply, sentTo, capturedSpend, encryptArmed, clientMsgId\);\s*lineIds\.sent\(clientMsgId\);/);
});
