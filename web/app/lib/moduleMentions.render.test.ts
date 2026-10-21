// The About page's feature list and the support panel's answers name a module only while this
// install shows it — one test per module. Both named the radio unconditionally (and the support
// panel ships in the public cut, where there is no radio at all).
// Run: node --test app/lib/moduleMentions.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "./testTsx.ts";
import { MODULES } from "./instanceSchema.generated.mjs";
import { setSupportFacts, type FlowNode } from "./support/flows.ts";

/** The facts for an install that shows everything but `off` — the subscription is a Stripe part,
 *  so it goes with Stripe. Every other fact on, so only the module decides. */
function setSupportModulesOff(off: string[]): void {
  setSupportFacts({ off, purchasable: true, subscriptions: !off.includes("stripe"), tts: true, freeText: true });
}
const flows = await import("./support/flows.ts");
const { AboutFeatures } = await import("../about/AboutFeatures.tsx");
// What the panel offers before any page has said which modules it shows.
const INITIAL = flows.SUPPORT_ROOT;

// What naming each module looks like. Every module needs an entry, so a new module is a decision
// here rather than a silent gap.
const NAMES: Record<string, RegExp> = {
  // A popout chat used as an OBS browser source needs no module; the module is OBS CONTROL.
  obs: /OBS control|rig page|scene/i,
  lights: /\blights\b/i,
  meter: /\bmeter\b/i,
  radio: /\bradio\b|\bstation\b/i,
  youtube: /YouTube/,
  stripe: /\bStripe\b|subscri|gift sub/i,
  paypal: /PayPal|Venmo/,
};

const ids = MODULES.map((m) => m.id);
const allOn = Object.fromEntries(ids.map((id) => [id, true]));

/** The answers offered with these modules not shown. */
function supportRootFor(off: string[]): FlowNode[] {
  setSupportModulesOff(off);
  return flows.SUPPORT_ROOT;
}
function faqText(nodes: FlowNode[]): string {
  return nodes.map((n) => `${n.label}\n${n.action && n.action.kind === "answer" ? n.action.text : ""}\n${n.children ? faqText(n.children) : ""}`).join("\n");
}
function aboutText(shown: Record<string, boolean>): string {
  return renderToStaticMarkup(createElement(AboutFeatures, {
    siteName: "Example Stream",
    facts: {
      shown, stripe: shown.stripe === true, subscriptions: shown.stripe === true, paypal: shown.paypal === true,
      platforms: { twitch: true, kick: true, streamplace: true },
    },
  }));
}

test("every module has a naming pattern", () => {
  assert.ok(ids.length >= 7, "the module list did not load");
  assert.deepEqual(ids.filter((id) => !NAMES[id]), []);
});

for (const id of ids) {
  test(`module ${id}: neither the About list nor the support answers name it while it is off`, () => {
    const faq = faqText(supportRootFor([id]));
    const about = aboutText({ ...allOn, [id]: false });
    assert.ok(faq.length > 500 && about.length > 300, "vacuity: the answers and the list rendered");
    assert.doesNotMatch(faq, NAMES[id]!, `the support panel names ${id} while it is off`);
    assert.doesNotMatch(about, NAMES[id]!, `the About list names ${id} while it is off`);
  });
}

test("with the modules on, the radio, YouTube, card and PayPal payments are named again", () => {
  const faq = faqText(supportRootFor([]));
  const about = aboutText(allOn);
  assert.match(faq, NAMES.radio!);
  assert.match(faq, NAMES.stripe!);
  for (const id of ["radio", "youtube", "stripe", "paypal"]) assert.match(about, NAMES[id]!, `About lost ${id}`);
});

test("until the page says which modules it shows, the support panel offers no module's answer", () => {
  const keys = (nodes: FlowNode[]): string[] => nodes.flatMap((n) => [n.key, ...(n.children ? keys(n.children) : [])]);
  const before = keys(INITIAL);
  assert.ok(before.includes("faq-linking") && before.length > 8, "vacuity: the tree loaded");
  assert.ok(!before.includes("faq-radio") && !before.includes("howto-music") && !before.includes("faq-supporter"));
  setSupportModulesOff([]);
  assert.ok(keys(flows.SUPPORT_ROOT).includes("faq-radio"), "the live binding did not update");
  setSupportModulesOff(["radio"]);
  assert.ok(!keys(flows.SUPPORT_ROOT).includes("faq-radio"));
  assert.ok(keys(flows.SUPPORT_ROOT).includes("faq-supporter"));
});
