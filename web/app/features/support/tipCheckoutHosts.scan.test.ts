// Every TipForm host posts through checkoutRequestFor — never a hard-coded
// tip route — so a quiet purchase can't be sent to /api/billing/donate (where
// it would play on stream) from one host while the others route it right.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const HOSTS = [
  ["DonateClient", "../../donate/DonateClient.tsx"],
  ["SupportContent", "../../components/SupportContent.tsx"],
  ["StoreContent", "../store/StoreContent.tsx"],
] as const;

for (const [name, rel] of HOSTS) {
  test(`${name} routes its TipForm submit through checkoutRequestFor`, () => {
    const src = readFileSync(new URL(rel, import.meta.url), "utf8");
    assert.ok(src.trimEnd().endsWith("}"), `vacuity anchor: ${name} truncated`);
    assert.match(src, /checkoutRequestFor\(/, `${name} must build its checkout request with checkoutRequestFor`);
    assert.doesNotMatch(src, /"\/api\/billing\/donate"/, `${name} hard-codes the tip route — a quiet buy would play on stream`);
  });
}

test("the Store renders the shared TipForm, starting quiet — not its own amount box", () => {
  const src = readFileSync(new URL("../store/StoreContent.tsx", import.meta.url), "utf8");
  assert.ok(src.trimEnd().endsWith("}"), "vacuity anchor: StoreContent truncated");
  assert.match(src, /<TipForm\b[\s\S]*?initialAnnounce=\{false\}/, "the Store's box starts with Announce off");
  assert.doesNotMatch(src, /const PRESETS\b/, "a second preset list is a second amount box");
  assert.doesNotMatch(src, /<TipPayButton\b/, "the Store must not mount the pay button directly any more");
  assert.doesNotMatch(src, /"\/api\/billing\/coins"/, "the Store routes through checkoutRequestFor like every host");
});

test("StoreContent's done-view Done button clears the remembered draft; the checkout ← Back button keeps it", () => {
  const src = readFileSync(new URL("../store/StoreContent.tsx", import.meta.url), "utf8");
  assert.ok(src.trimEnd().endsWith("}"), "vacuity anchor: StoreContent truncated");

  // The done view's "Done" button, when there is no onClose (a standalone
  // Store, not a modal): reopening the home view must not find the old
  // draft still set, or a saved draft overrides initialAnnounce={false} and
  // the Store reopens announcing with the old message instead of quiet.
  const doneHandler = src.match(/onClick=\{onClose \?\? \(\(\) => \{([^}]*)\}\)\}/);
  assert.ok(doneHandler, "vacuity anchor: done-view Done button handler not found");
  assert.match(doneHandler![1]!, /setDraft\(null\)/, "Done (no onClose) must clear the remembered draft");

  // The checkout view's "← Back" button must KEEP the draft — that's what
  // lets a declined card retry with the amount/message still there.
  const backHandler = src.match(/onClick=\{\(\) => \{([^}]*)\}\}[\s\S]{0,200}?← Back/);
  assert.ok(backHandler, "vacuity anchor: checkout ← Back button handler not found");
  assert.doesNotMatch(backHandler![1]!, /setDraft\(null\)/, "← Back must not clear the draft — it exists for a declined-card retry");
});
