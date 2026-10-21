// A failed send must never overwrite the draft typed after it.
//
// The decision is a pure function (tested by running it); the wiring lives in
// ChatInput.tsx, which the runner cannot mount with its whole context, so the
// wiring is a source scan with an END-of-file anchor.
//
// Run: node --test app/lib/failedSend.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { failedSendAction } from "./failedSend.ts";
import { stripComments } from "./testSource.ts";

test("an untouched composer gets the failed line back", () => {
  assert.equal(failedSendAction({ draft: "", replyArmed: false }), "restore");
  assert.equal(failedSendAction({ draft: "   ", replyArmed: false }), "restore", "whitespace is not a draft");
});

test("a new draft is kept, and the failed line is offered as a retry", () => {
  assert.equal(failedSendAction({ draft: "my next message", replyArmed: false }), "offer-retry");
});

test("a reply armed since the send is kept too — the failed line must not hijack it", () => {
  assert.equal(failedSendAction({ draft: "", replyArmed: true }), "offer-retry");
});

const SRC = stripComments(readFileSync(new URL("../features/chat/ChatInput.tsx", import.meta.url), "utf8"));

test("ChatInput asks the helper with the composer as it is NOW, and offers the retry", () => {
  const c = SRC.slice(SRC.indexOf("} catch (err) {"), SRC.indexOf("} finally {"));
  assert.ok(c.length > 0, "the send's catch block was not found — rewritten? update this scan");
  // A line that IS on the site (posted, a platform refused it) never throws,
  // so the catch has no branch for it (refusalNoteWiring.test.ts).
  assert.doesNotMatch(c, /PartialDeliveryError/);
  // The live draft and the live reply, read through refs — never the send's own closure.
  assert.match(c, /failedSendAction\(\{ draft: inputRef\.current\?\.value \?\? "", replyArmed: replyNow\.current != null \}\) === "restore"/);
  assert.match(c, /setFailedLine\(\{ text, reply: replyToRestore, spend: capturedSpend \}\)/);
  // The unconditional overwrite is gone.
  assert.doesNotMatch(c, /showError\(msg, ERROR_MS_FAILED_SEND\);\s*setInput\(text\);/);
  // The retry sends the failed line without touching the composer.
  assert.match(SRC, /await sendLine\(f\.text, f\.reply, f\.spend, false\);/);
  // END anchor: the component still closes on its form.
  assert.match(SRC.trimEnd(), /<\/form>\s*\)\s*;\s*}$/);
});
