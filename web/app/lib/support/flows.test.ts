import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SUPPORT_ROOT, GREETINGS, FIRST_VISIT, CLOSE_HINT, findNode,
  linkNudgeOptions, NUDGE_LATER_KEY, NUDGE_NEVER_KEY, type FlowNode,
} from "./flows.ts";

// The flow tree is data the panel walks blindly — these pin the invariants the
// walker relies on, so a copy edit can't strand a user on a dead button.

function walk(nodes: FlowNode[], fn: (n: FlowNode) => void) {
  for (const n of nodes) { fn(n); if (n.children) walk(n.children, fn); }
}

test("every node key is unique across the whole tree", () => {
  const seen = new Set<string>();
  walk(SUPPORT_ROOT, (n) => {
    assert.ok(!seen.has(n.key), `duplicate flow key: ${n.key}`);
    seen.add(n.key);
  });
});

test("every leaf has an action and every branch has children", () => {
  walk(SUPPORT_ROOT, (n) => {
    if (n.children?.length) {
      assert.equal(n.action, undefined, `branch ${n.key} also carries an action — ambiguous`);
    } else {
      assert.ok(n.action, `leaf ${n.key} has no action — a dead button`);
    }
  });
});

test("the root offers the five entry points", () => {
  const keys = SUPPORT_ROOT.map((n) => n.key);
  for (const k of ["faq", "report-user", "report-bug", "howto", "other"]) {
    assert.ok(keys.includes(k), `root lost its ${k} entry`);
  }
});

test("findNode reaches nested leaves", () => {
  assert.equal(findNode("report-user")?.action?.kind, "report-user");
  assert.equal(findNode("other")?.action?.kind, "free-text");
  assert.equal(findNode("definitely-not-a-key"), null);
});

test("answer leaves carry real copy, not stubs", () => {
  walk(SUPPORT_ROOT, (n) => {
    if (n.action?.kind === "answer") {
      assert.ok(n.action.text.length > 40, `answer ${n.key} is a stub`);
    }
  });
});

test("the fixed copy strings are verbatim", () => {
  assert.equal(FIRST_VISIT, "If you need anything, I'm here to help!");
  assert.equal(CLOSE_HINT, "If you need me again, use /support in chat!");
  assert.ok(GREETINGS.length >= 3, "the greeting pool shrank below rotation size");
});

test("the reminder offers never-again only from the second showing on", () => {
  const first = linkNudgeOptions(false).map((n) => n.key);
  assert.ok(!first.includes(NUDGE_NEVER_KEY), "never-again offered on the first showing");
  assert.ok(first.includes(NUDGE_LATER_KEY), "the reminder lost its plain dismissal");
  const later = linkNudgeOptions(true).map((n) => n.key);
  assert.ok(later.includes(NUDGE_NEVER_KEY), "offerNever no longer surfaces the chip");
});

test("the reminder walkthrough and the linking FAQ never drift apart", () => {
  const walkthrough = linkNudgeOptions(false).find((n) => n.key === "nudge-walkthrough");
  assert.ok(walkthrough?.action?.kind === "answer", "walkthrough is not an answer leaf");
  const faq = findNode("faq-linking");
  assert.ok(faq?.action?.kind === "answer", "faq-linking is not an answer leaf");
  assert.equal(walkthrough.action.text, faq.action.text,
    "same feature, two sets of instructions — share LINKING_ANSWER");
});

test("the dismissal chips carry no action — ChatSidebar intercepts their keys", () => {
  for (const key of [NUDGE_LATER_KEY, NUDGE_NEVER_KEY]) {
    const chip = linkNudgeOptions(true).find((n) => n.key === key);
    assert.ok(chip, `${key} missing from the reminder options`);
    assert.equal(chip.action, undefined, `${key} grew an action — the reducer would swallow the pick`);
    assert.equal(chip.children, undefined, `${key} grew children`);
  }
});
