// A styled name gets exactly the side room its OWN glyphs
// need, measured once its face has loaded — not the worst case over the whole
// alphabet, which would put 24px after the badge where a plain name has 12.
// Run: node --test app/lib/nameInk.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
import { inkFromMetrics, firstFamilyVar } from "./nameInk.ts";

test("the spill is read off the WHOLE name's ink box, in em, never negative", () => {
  // A swash reaching left of the pen start, and one past the advance end.
  assert.deepEqual(
    inkFromMetrics({ actualBoundingBoxLeft: 28, actualBoundingBoxRight: 530, width: 480 }, 100),
    { left: 0.28, right: 0.5 },
  );
  // Ink inside the box on both sides → no room at all (a plain face's normal case).
  assert.deepEqual(
    inkFromMetrics({ actualBoundingBoxLeft: -3, actualBoundingBoxRight: 470, width: 480 }, 100),
    { left: 0, right: 0 },
  );
});

test("the face is found from the stack's own custom property", () => {
  assert.equal(firstFamilyVar("var(--font-alex-brush), cursive"), "--font-alex-brush");
  assert.equal(firstFamilyVar("Georgia, serif"), null);
});

const read = (...p: string[]) => stripComments(readFileSync(join(process.cwd(), ...p), "utf8"));

test("every surface that draws a styled name measures it", () => {
  const sites: [string, string[]][] = [
    ["ChatMessage", ["app", "features", "chat", "ChatMessage.tsx"]],
    ["StyledName", ["app", "components", "profileCardParts.tsx"]],
    ["PinnedBanner", ["app", "components", "PinnedBanner.tsx"]],
    ["CreditOverlay", ["app", "components", "CreditOverlay.tsx"]],
    ["BoardsWidget", ["app", "features", "home", "widgets", "BoardsWidget.tsx"]],
  ];
  for (const [name, p] of sites) {
    const src = read(...p);
    assert.match(src, /useNameInk\(/, `${name} draws a styled name without measuring it`);
  }
});

test("the measured spill lands on the vars the padding and the duo ramp read", () => {
  const src = read("app", "lib", "nameInk.ts");
  assert.match(src, /setProperty\("--un-ink-l"/);
  assert.match(src, /setProperty\("--un-ink-r"/);
  assert.match(src, /document\.fonts\.load\(/, "a name measured before its face loads measures the fallback");
  assert.ok(src.length > 800, "vacuity: nameInk.ts read to its end");
});

test("a name too wide for its box is shrunk to fit, never cut off", async () => {
  const { fitZoom } = await import("./nameInk.ts");
  assert.equal(fitZoom(100, 200, 1), 1, "a name that fits is left alone");
  assert.equal(fitZoom(100, 200, 1.35), 1.35, "the store preview still enlarges a short name");
  assert.equal(fitZoom(300, 150, 1), 0.5, "a long name shrinks to the box");
  assert.equal(fitZoom(1000, 150, 1), 0.4, "never below 0.4 — past that it cannot be read");
  assert.equal(fitZoom(100, 0, 1), 1, "an unmeasured box changes nothing");
  const sites = [
    ["app", "features", "store", "StoreSpend.tsx"],
    ["app", "components", "UserCard.tsx"],
    ["app", "components", "ProfileCardBody.tsx"],
    ["app", "components", "ProfileEditor.tsx"],
  ];
  for (const p of sites) assert.match(read(...p), /<StyledName[^>]*\bfit=\{/, `${p.at(-1)} previews a name that can be cut off`);
});

test("a late font load never writes one face's room onto another", () => {
  const src = read("app", "lib", "nameInk.ts");
  assert.match(src, /el\.dataset\.inkFor = key/);
  assert.match(src, /if \(!el\.isConnected \|\| el\.dataset\.inkFor !== key\) return;/);
  assert.match(src, /removeProperty\("--un-ink-l"\)/, "a new face inherits the previous face's measured room until it loads");
});
