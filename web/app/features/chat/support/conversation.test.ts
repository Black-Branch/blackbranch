import { test } from "node:test";
import assert from "node:assert/strict";
import { openState, pickOption, userText, deskSays } from "./conversation.ts";
import { SUPPORT_ROOT, linkNudgeOptions, NUDGE_LATER_KEY } from "../../../lib/support/flows.ts";

// The pure conversation reducer — the hook is a thin fetch wrapper around
// these. Everything here is synchronous and side-effect free on purpose: the
// panel's whole behaviour is testable without React or a network.

test("opening yields one gadget message, the root options, and awaits a pick", () => {
  const s = openState("What can I help you with today?");
  assert.equal(s.msgs.length, 1);
  assert.equal(s.msgs[0]?.role, "bot");
  assert.equal(s.options.length, SUPPORT_ROOT.length);
  assert.equal(s.awaiting, "options");
});

test("an answer leaf replies and returns to the root options", () => {
  let s = openState("hi");
  s = pickOption(s, "faq");
  assert.equal(s.awaiting, "options", "descending a branch still awaits a pick");
  assert.ok(s.options.some((o) => o.key === "faq-points"), "branch children became the options");
  s = pickOption(s, "faq-points");
  const last = s.msgs[s.msgs.length - 1];
  assert.equal(last?.role, "bot");
  assert.match(last?.text ?? "", /the site currency/);
  assert.equal(s.options.length, SUPPORT_ROOT.length, "an answer returns to the root options");
});

test("report-a-user collects a name, then a reason", () => {
  let s = openState("hi");
  s = pickOption(s, "report-user");
  assert.equal(s.awaiting, "report-user");
  s = userText(s, "TroubleGuy");
  assert.equal(s.awaiting, "report-reason");
  assert.equal(s.pendingReport?.username, "TroubleGuy");
  // Two user lines: the button pick renders as their line (messenger-style
  // quick replies), then the name they typed.
  assert.equal(s.msgs.filter((m) => m.role === "user").length, 2);
  assert.equal(s.msgs.filter((m) => m.role === "user")[1]?.text, "TroubleGuy");
});

test("report-a-bug arms the description collector", () => {
  let s = openState("hi");
  s = pickOption(s, "report-bug");
  assert.equal(s.awaiting, "bug-desc");
});

test("something-else arms free text", () => {
  let s = openState("hi");
  s = pickOption(s, "other");
  assert.equal(s.awaiting, "free");
});

test("typing over the options row is a free-text question, not a dead end", () => {
  let s = openState("hi");
  s = userText(s, "how do i change my name colour");
  assert.equal(s.awaiting, "busy", "typed text while options show must route to the LLM");
});

test("deskSays can hand the floor back to the root", () => {
  let s = openState("hi");
  s = pickOption(s, "other");
  s = userText(s, "how do llamas work");
  s = deskSays(s, "Not my department.", { backToRoot: true });
  assert.equal(s.awaiting, "options");
  assert.equal(s.options.length, SUPPORT_ROOT.length);
});

test("picking an unknown key is a no-op, not a crash", () => {
  const s = openState("hi");
  assert.deepEqual(pickOption(s, "nope"), s);
});

test("a reminder open offers its own chips, and the walkthrough resolves from them", () => {
  // The reminder's nodes don't live in SUPPORT_ROOT — pickOption must resolve
  // against the OFFERED options (the load-time nudge depends on this).
  let s = openState("link your account?", linkNudgeOptions(true));
  assert.equal(s.awaiting, "options");
  assert.ok(s.options.some((n) => n.key === "nudge-walkthrough"), "reminder chips not offered");
  s = pickOption(s, "nudge-walkthrough");
  assert.equal(s.msgs.at(-2)?.role, "user", "the pick should read as the user's line");
  assert.equal(s.msgs.at(-1)?.role, "bot", "the walkthrough answer never arrived");
  assert.equal(s.awaiting, "options");
  assert.equal(s.options.length, SUPPORT_ROOT.length, "answering should hand the floor back to the root");
});

test("a dismissal chip reaching the reducer is a safe no-op", () => {
  // ChatSidebar intercepts these keys before pick; if one ever slips through,
  // the actionless node must not corrupt the state.
  const s = openState("link your account?", linkNudgeOptions(true));
  assert.deepEqual(pickOption(s, NUDGE_LATER_KEY), s);
});

test("message ids are unique and ordered", () => {
  let s = openState("hi");
  s = pickOption(s, "other");
  s = userText(s, "one");
  s = deskSays(s, "two");
  const ids = s.msgs.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...ids].sort((a, b) => a - b), ids);
});
