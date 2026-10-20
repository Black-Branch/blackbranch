// The LIVE seam of the composer binding: a
// few honest lines in ChatInput and SendToButton that let a bound window take
// the destination. A destination override that read the render's value would
// miss a bind between render and submit. (No window takes the whole line —
// the terminal and the chat box are used side by side.)
// Every unbound expression is pinned to its exact form: unbound behaviour must
// be identical. The DM window is the tenant.
//
// Run: node --test --experimental-strip-types app/features/chat/composerBindingSeam.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "../../lib/testSource.ts";

const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), "utf8"));
const CHAT_INPUT = read("./ChatInput.tsx");
const SEND_TO = read("../../components/SendToButton.tsx");

test("ChatInput: the binding is read synchronously at send time; a bound line goes to the binding's send, never the wire", () => {
  assert.match(CHAT_INPUT, /const bound = currentBinding\(\);/, "read from the slot, not the render's value");
  assert.doesNotMatch(CHAT_INPUT, /"divert"/, "nothing takes the chat box's lines");
  // A bound line: its own branch, ahead of support and the plain send, and it never calls onSendMessage.
  const bound = CHAT_INPUT.indexOf('} else if (bound?.kind === "sendTo") {');
  const support = CHAT_INPUT.indexOf("} else if (supportArmed) {");
  assert.ok(bound > 0 && support > bound, "the bound branch comes before support and the plain send");
  const branch = CHAT_INPUT.slice(bound, support);
  assert.match(branch, /await bound\.send\(text\);/, "the line goes to the binding's send");
  assert.doesNotMatch(branch, /onSendMessage\(/, "a DM line never reaches the chat wire");
  assert.doesNotMatch(CHAT_INPUT, /bound\.destination/, "the binding no longer carries a destination string");
  // The plain send keeps EXACTLY its unbound expression.
  assert.match(CHAT_INPUT,
    /const sentTo = encryptArmed \? null : forcedDest;\s*await onSendMessage\(text, capturedReply, sentTo, capturedSpend, encryptArmed\);/,
    "the plain send's destination is `encryptArmed ? null : forcedDest`");
  // The one-shot command send is NOT overridden: a `/t hi` names its own destination and wins.
  assert.match(CHAT_INPUT, /await onSendMessage\(outcome\.text, null, outcome\.destination, spend, outcome\.encrypted\);/,
    "a routing command's send is untouched by the binding");
});

test("ChatInput: the send-to control gets the binding's face and a release", () => {
  assert.match(CHAT_INPUT, /const binding = useComposerBinding\(\);/);
  assert.match(CHAT_INPUT,
    /<SendToButton destCycle=\{destCycle\} forcedDest=\{forcedDest\} onPick=\{setDest\} onDisarm=\{resetDest\}[^/]*?\s*binding=\{binding\?\.kind === "sendTo" \? \{ face: binding\.face, release: \(\) => releaseComposer\(binding\.windowId\) \} : null\}\s*\/>/,
    "SendToButton receives the face + release only for a sendTo binding");
  // END anchor: the composer form closes after the control — a truncated read fails here.
  assert.ok(CHAT_INPUT.lastIndexOf("</form>") > CHAT_INPUT.indexOf("<SendToButton"), "the read reached the end of the form");
});

test("SendToButton: a binding renders even with nowhere else to send, wears the face, and its click RELEASES", () => {
  assert.match(SEND_TO, /if \(!binding && destCycle\.length <= 1\) return null;/,
    "the no-choice early return yields to a binding — a DM face must show for a user with no cross-post destinations");
  assert.match(SEND_TO, /onClick=\{binding\.release\}/, "clicking the bound face releases (the window dismisses, the destination falls back)");
  assert.match(SEND_TO, /aria-label=\{`Sending to \$\{label\}\. Click to stop and send to chat again\.`\}/);
  // END anchor: SupportButton is the file's last export and follows the bound branch.
  assert.ok(SEND_TO.indexOf("export function SupportButton") > SEND_TO.indexOf("onClick={binding.release}"));
});

test("ChatInput: the terminal's `say` sends through this box's path — same destination, no reply, no spend, slow mode kept", () => {
  const provide = CHAT_INPUT.indexOf("provideChatSender(");
  assert.ok(provide > 0, "the chat box offers its send path to the terminal");
  const body = CHAT_INPUT.slice(CHAT_INPUT.indexOf("terminalSend.current = async (text: string, opts?: { redact?: boolean }) => {"), provide);
  assert.match(body, /if \(slowActive\) throw new Error\(/, "slow mode refuses a terminal line as it refuses a typed one");
  // The TUI's `/redact` rides the same path as the lock: native, whole-message.
  assert.match(body, /const redact = encryptArmed \|\| !!opts\?\.redact;\s*await onSendMessage\(text, null, redact \? null : forcedDest, null, redact\);/,
    "where the box would send, never a reply, never a paid spend, 🔒 honoured");
  assert.match(body, /armSlowMode\(\);/, "an accepted line starts the slow-mode countdown");
  assert.doesNotMatch(body, /setInput\(/, "a terminal line never touches the draft in the box");
  // END anchor: the provider sits before the form — a truncated read fails here.
  assert.ok(CHAT_INPUT.lastIndexOf("</form>") > provide);
});
