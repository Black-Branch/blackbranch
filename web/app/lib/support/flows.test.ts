import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SUPPORT_ROOT, GREETINGS, FIRST_VISIT, CLOSE_HINT, findNode, setSupportFacts, supportFreeText,
  linkNudgeOptions, NUDGE_LATER_KEY, NUDGE_NEVER_KEY, type FlowNode, type SupportFacts,
} from "./flows.ts";

const ALL_ON: SupportFacts = { off: [], purchasable: true, subscriptions: true, tts: true, freeText: true };
const BARE: SupportFacts = { off: ["radio", "stripe", "paypal"], purchasable: false, subscriptions: false, tts: false, freeText: false };

/** Every key and every answer the panel offers right now. */
function offered(): { keys: string[]; text: string } {
  const keys: string[] = [];
  const texts: string[] = [];
  walk(SUPPORT_ROOT, (n) => { keys.push(n.key); texts.push(n.label); if (n.action?.kind === "answer") texts.push(n.action.text); });
  return { keys, text: texts.join("\n") };
}

// Before the page says what the install runs: no free text, no paid part. Read FIRST, before any
// test sets facts.
const BEFORE = offered();
const FREE_BEFORE = supportFreeText();

// The structure tests below walk the fullest tree.
setSupportFacts(ALL_ON);

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

// ── The answers follow what this install runs ─────────────────────────────────────────────────

test("before the page says, nothing install-specific is offered — no free text, no Supporter, no buying", () => {
  assert.ok(BEFORE.keys.includes("faq-linking"), "vacuity: the tree loaded");
  for (const k of ["other", "faq-supporter", "faq-encrypted", "faq-radio"]) assert.ok(!BEFORE.keys.includes(k), k);
  assert.equal(FREE_BEFORE, false);
  assert.doesNotMatch(BEFORE.text, /\bbuy\b|read out|Supporter/);
});

test("AI off: no 'Something else' and typed questions do not go to the AI; on: both come back", () => {
  setSupportFacts({ ...ALL_ON, freeText: false });
  assert.ok(!offered().keys.includes("other"));
  assert.equal(supportFreeText(), false);
  setSupportFacts(ALL_ON);
  assert.ok(offered().keys.includes("other"));
  assert.equal(supportFreeText(), true);
});

test("buying points is mentioned only where points can be bought", () => {
  setSupportFacts({ ...ALL_ON, purchasable: false });
  const off = (findNode("faq-points")?.action as { text: string }).text;
  assert.doesNotMatch(off, /\bbuy\b/);
  assert.match(off, /earn/);
  setSupportFacts(ALL_ON);
  assert.match((findNode("faq-points")?.action as { text: string }).text, /\bbuy\b/);
});

test("no subscription here: no Supporter answer, no redacted-message answer, no Supporter perk in the name-style answer", () => {
  setSupportFacts({ ...ALL_ON, subscriptions: false });
  const o = offered();
  assert.ok(!o.keys.includes("faq-supporter") && !o.keys.includes("faq-encrypted"));
  assert.doesNotMatch(o.text, /Supporter|subscri/i);
  setSupportFacts(ALL_ON);
  assert.ok(offered().keys.includes("faq-supporter"));
});

test("read-aloud is promised only where the voice is on", () => {
  setSupportFacts({ ...ALL_ON, tts: false });
  assert.doesNotMatch((findNode("howto-cheer")?.action as { text: string }).text, /read out/);
  setSupportFacts(ALL_ON);
  assert.match((findNode("howto-cheer")?.action as { text: string }).text, /read out/);
});

test("the votes fact is there on every install (ticket #160: the desk denied votes exist)", () => {
  for (const f of [ALL_ON, BARE]) {
    setSupportFacts(f);
    const votes = findNode("faq-votes");
    assert.ok(votes?.action?.kind === "answer");
    assert.match(votes.action.text, /Hover over a message/);
  }
  setSupportFacts(ALL_ON);
});

test("no owner-persona or owner-setup lines in any answer, on the fullest install", () => {
  setSupportFacts(ALL_ON);
  assert.doesNotMatch(offered().text, /grudging|that's the bit|stream timer|in-house|my support desk/i);
});

test("a bare install still offers a working menu: every leaf has an action, the reports stay", () => {
  setSupportFacts(BARE);
  const o = offered();
  for (const k of ["faq-points", "faq-linking", "faq-votes", "report-user", "report-bug", "howto-cheer"]) assert.ok(o.keys.includes(k), k);
  walk(SUPPORT_ROOT, (n) => assert.ok(n.children?.length || n.action, `dead button ${n.key}`));
  setSupportFacts(ALL_ON);
});
