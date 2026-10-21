import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "../../../lib/testSource.ts";

// ── Support-mode leak fences ─────────────────────────────────────────────────
//
// Support conversations are PRIVATE. Two independent fences keep support-mode
// text off the public chat wire, and both must hold:
//
//   1. ChatInput never hands support-mode text to onSendMessage — it goes to
//      the panel's onSupportText instead.
//   2. /api/chat/send hard-rejects forced_destination === "support". This one
//      is load-bearing, not belt-and-braces: the route's validation COERCES any
//      unroutable destination to null, and null means native — so a leaked
//      support send would post the user's support question to public chat.

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => stripComments(readFileSync(join(here, rel), "utf8"));

test("send route hard-rejects the support sentinel BEFORE the coercion", () => {
  const send = read("../../../api/chat/send/route.ts");
  const rejectIdx = send.search(/fd === SUPPORT_DEST[\s\S]{0,160}status: 400/);
  const coerceIdx = send.indexOf("isRoutablePlatform(fd)");
  assert.ok(rejectIdx !== -1, "the support reject is gone from the send route");
  assert.ok(coerceIdx !== -1, "anchor lost — the coercion moved; re-verify the reject still precedes it");
  assert.ok(rejectIdx < coerceIdx, "the reject must run before the coercion maps support to native");
});

test("ChatInput routes support-mode text to the panel, never the chat wire", () => {
  const input = read("../ChatInput.tsx");
  // `supportArmed` is the hook's own state, and the destination is untouched
  // while the help desk is armed — so pin that it comes FROM the hook, and
  // that support has not crept back into the destination. The intercept below
  // is unchanged either way.
  assert.match(input, /supportArmed, armSupport, leaveSupport,/,
    "supportArmed no longer comes from useSendDestination as its own state");
  assert.doesNotMatch(input, /supportArmed = forcedDest === SUPPORT_DEST/,
    "support is back inside forcedDest — it is a mode, not a destination");
  // Anchored on the FULL `} else if (...) {`, not a bare `if (supportArmed)`.
  // There is a second `if (supportArmed)` — the help-desk button's toggle —
  // much EARLIER in the file, and `search` takes the first match, so a loose
  // anchor would silently retarget this whole test onto an unrelated branch.
  // An anchor that can match twice is not an anchor. `+ 1` on the branch-end
  // scan because the anchor starts AT a `} else`, so searching from `guard`
  // would find its own opener.
  const guard = input.search(/\} else if \(supportArmed\) \{/);
  assert.ok(guard !== -1, "the support-mode intercept is gone from ChatInput");
  // Scan only the intercept's own branch — up to the else that follows it —
  // not a fixed window that would bleed into the ordinary-send branch.
  const branchEnd = input.indexOf("} else", guard + 1);
  assert.ok(branchEnd !== -1, "anchor lost — the intercept no longer sits before the ordinary-send branch");
  const block = input.slice(guard, branchEnd);
  assert.match(block, /onSupportText/, "the intercept no longer hands text to the panel");
  assert.doesNotMatch(block, /onSendMessage/, "the intercept block must not fall through to onSendMessage");
});

test("the load-time effect is the ONLY auto-open path (reminders never interrupt)", () => {
  // ChatSidebar arms support mode itself (supportCtl enter) in exactly one
  // place: the effect marked "load-time-only support opener". Every other
  // opener is a user action (typing in support mode, /support, a chip). A
  // second .enter() call site means someone added an auto-open path — that
  // needs a deliberate decision, not a quiet merge. Raw source: the marker is a comment.
  const raw = readFileSync(join(here, "../ChatSidebar.tsx"), "utf8");
  const marker = raw.indexOf("load-time-only support opener");
  assert.ok(marker !== -1, "the marked opener effect is gone from ChatSidebar");
  const effectEnd = raw.indexOf("}, [", marker);
  assert.ok(effectEnd !== -1, "anchor lost — the opener effect's dependency close moved");
  const enters = [...raw.matchAll(/supportCtl\.current\?\.enter\(\)/g)].map((m) => m.index);
  assert.ok(enters.length >= 1, "the opener effect no longer arms support mode");
  for (const idx of enters) {
    assert.ok(idx > marker && idx < effectEnd,
      "an .enter() call site exists outside the load-time-only opener effect");
  }
});

test("support state can never reach storage — structurally, not by a skip", () => {
  const hook = read("../../../lib/useSendDestination.ts");
  // Support mode is a boolean of its own, so the persist effect cannot see
  // it at all — strictly stronger than a skip there.
  assert.match(hook, /const \[supportArmed, setSupportArmed\] = useState\(false\)/,
    "support mode is no longer its own state — it has moved back into forcedDest");
  const persist = hook.slice(hook.indexOf("Persist the chosen target"));
  assert.equal(persist.indexOf("SUPPORT_DEST"), -1,
    "SUPPORT_DEST is reachable from the persist path again");
  // The stored-sentinel guard STAYS. Support is never written as a
  // destination, but a profile may still carry a "support" string in
  // localStorage, and honouring one on load would bring the composer up armed
  // and open the panel on every load, forever. This guard is what retires
  // those values; it can only be deleted once no live profile can still hold one.
  assert.match(hook, /stored === ENCRYPTED_DEST \|\| stored === SUPPORT_DEST/,
    "the restore guard lost the support sentinel — legacy stored values would come back armed");
});

// ── The popout hosts support too ─────────────────────────────────────────────
//
// `/support` works in popouts. SupportPanel is rendered BY ChatSidebar, in the
// chat column the popout also has, so a narrow popout is no reason to refuse it.
//
// `supportEnabled` gates both the command and the panel; the hook does not
// take the flag, so there is no destination cycle to keep in step. Both
// assertions stay as a regression fence: a popout that cannot reach the help
// desk is the failure.
test("the popout offers support: neither the flag nor the panel is gated on isPopout", () => {
  const raw = readFileSync(join(here, "../ChatSidebar.tsx"), "utf8");

  assert.doesNotMatch(raw, /supportEnabled=\{!isPopout\}/,
    "the popout composer is refusing /support again");
  assert.match(raw, /supportEnabled(?![=\w])/,
    "ChatInput is no longer handed supportEnabled at all");

  const panel = raw.indexOf("<SupportPanel");
  assert.ok(panel !== -1, "SupportPanel is gone from ChatSidebar");
  // The render condition sits immediately before the element.
  const cond = raw.slice(raw.lastIndexOf("{", panel - 1) - 120, panel);
  assert.doesNotMatch(cond, /!isPopout &&/,
    "SupportPanel is gated on isPopout again — the sentinel would then be armed with no panel to show");
});

// The load-time bubble is a SEPARATE decision and stays popout-only-suppressed:
// a small always-on-top chat window must never pop a greeting at the user.
test("the load-time support bubble stays suppressed in popouts", () => {
  const raw = readFileSync(join(here, "../ChatSidebar.tsx"), "utf8");
  const marker = raw.indexOf("load-time-only support opener");
  assert.ok(marker !== -1, "the marked opener effect is gone from ChatSidebar");
  const guard = raw.slice(marker, raw.indexOf("}, [", marker));
  assert.match(guard, /if \(isPopout \|\|/,
    "the load-time opener lost its popout suppression — popouts must not auto-greet");
});

// ── The help-desk button is an INDICATOR, not an entry point ─────────────────
//
// A help-desk button in the destination toggle set is bad UX, and so is a
// permanent button beside it. You enter support the ways you always did (the
// `/support` command, the greeting bubble, the panel), and the button appears
// only once you are IN and goes away when support is not active. It cannot be
// something you land on by accident.
test("the Gadget button exists ONLY while support is live", () => {
  const input = read("../ChatInput.tsx");
  const button = readFileSync(join(here, "../../../components/SendToButton.tsx"), "utf8");
  assert.match(button, /export function SupportButton/, "the Gadget indicator is gone entirely");
  // Rendered behind `supportArmed &&`. The render gate IS the feature.
  assert.match(input, /\{supportArmed && \(\s*<SupportButton/,
    "the Gadget button renders unconditionally again — it must appear only once /support is active");
  // And it can only ever LEAVE. A button that also armed support would be an
  // entry point wearing an indicator's clothes.
  assert.doesNotMatch(button, /armed[?:]/,
    "SupportButton grew a second visual state — it only exists while armed, so there is no other");
  const fn = button.slice(button.indexOf("export function SupportButton"));
  assert.doesNotMatch(fn, /armSupport|onToggle/,
    "the Gadget indicator can arm support again — it must only leave");
});

test("the support indicator sits with the composer's other icon controls, not apart on the left", () => {
  // The indicator renders with the composer's icons on the right (tools, send), after the field —
  // not on the left beside the avatar, apart from them.
  const input = read("../ChatInput.tsx");
  const field = input.indexOf("<ChatComposerField");
  const button = input.indexOf("<SupportButton");
  const tools = input.indexOf("<ComposerToolsPopover");
  const send = input.indexOf('type="submit"');
  assert.ok(field !== -1 && button !== -1 && tools !== -1 && send !== -1, "a landmark moved — this test read nothing");
  assert.ok(field < button && button < tools && tools < send,
    "the support indicator is no longer between the field and the message tools");
  assert.equal(input.includes("supportAnchorRef"), false, "the composer still hands the panel an anchor — the panel is in-flow now");
  assert.ok(input.trimEnd().endsWith("}"), "END anchor: the whole file was read");
});
