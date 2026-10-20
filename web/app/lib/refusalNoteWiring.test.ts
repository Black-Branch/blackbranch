// The U1 rework's wiring in the two components the runner cannot mount with
// their whole context (ChatInput, ChatMessage) — source scans with END anchors.
// The behaviour itself is RUN in platformRefusals.test.ts, sendDeliveryHook.test.ts,
// SendToButton.render.test.ts and ChatComposerField.note.render.test.ts.
//
// Run: node --test app/lib/refusalNoteWiring.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./testSource.ts";

const read = (p: string) => stripComments(readFileSync(new URL(p, import.meta.url), "utf8"));
const INPUT = read("../features/chat/ChatInput.tsx");
const ROW = read("../features/chat/ChatMessage.tsx");

test("ChatInput: the one note sits in the field, the menu retries and shows state", () => {
  assert.match(INPUT, /const refusal = useRefusalNote\(\);/);
  assert.match(INPUT, /note=\{refusal \? \{ text: refusal\.text, forms: refusal\.forms, onDismiss: \(\) => dismissRefusalNote\(refusal\.id\) \} : null\}/);
  assert.match(INPUT, /<SendToButton[^>]*onRetry=\{retryDestination\}[^>]*refusals=\{refusalStates\}/);
  assert.match(INPUT, /const refusalStates = useSkippedPlatforms\(\);/);
  // A transient note and the "couldn't reach" line go away on their own; a persistent one waits for the ✕.
  assert.match(INPUT, /if \(!refusal \|\| refusal\.kind === "persistent"\) return;/);
  assert.match(INPUT, /setTimeout\(\(\) => dismissRefusalNote\(refusal\.id\), ERROR_MS_FAILED_SEND\)/);
  // END anchor.
  assert.match(INPUT.trimEnd(), /<\/form>\s*\)\s*;\s*}$/);
});

test("ChatInput: a posted line is never a send error — no per-message branch for it", () => {
  assert.doesNotMatch(INPUT, /PartialDeliveryError/);
});

test("ChatMessage: no extra row under a line — at most a zero-height inline marker", () => {
  assert.doesNotMatch(ROW, /<div[^>]*data-undelivered/, "the 'not delivered to Kick' ROW is gone");
  const at = ROW.indexOf("data-undelivered");
  assert.ok(at > 0, "the inline marker is still rendered for a transient miss");
  const tag = ROW.slice(ROW.lastIndexOf("<", at), ROW.indexOf(">", at) + 1);
  assert.match(tag, /^<span/, "inline, inside the line");
  assert.match(tag, /lineHeight: 0/, "adds no height to the line box");
  // It sits inside the line's own div, after the body — before that div closes.
  const body = ROW.indexOf("{body}");
  const close = ROW.indexOf("</div>", body);
  assert.ok(body > 0 && at > body && at < close, "the marker is inside the message line, not under it");
  // END anchor.
  assert.match(ROW.trimEnd(), /\n\}\);$/);
});
