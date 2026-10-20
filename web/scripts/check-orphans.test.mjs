// Run: node --test scripts/check-orphans.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { findOrphans } from "./check-orphans.mjs";

const FILES = {
  "app/lib/used.ts":   `export function wired() { return 1; }`,
  "app/lib/orphan.ts": `export function neverCalled() { return 2; }`,
  "app/page.tsx":      `import { wired } from "./lib/used"; export default () => wired();`,
  "app/lib/orphan.test.ts": `import { neverCalled } from "./orphan.ts"; neverCalled();`,
  // The false-alarm case that broke the hand-rolled scan during planning: a
  // root file OUTSIDE app/ is a real consumer.
  "instrumentation.ts": `import { bootOnly } from "./app/lib/boot"; bootOnly();`,
  "app/lib/boot.ts":    `export function bootOnly() { return 3; }`,
  // A deliberate test-only export, tagged with a reason at the definition.
  "app/lib/tagged.ts": `/** @test-only exported so the cross-runtime test can reach it. */\nexport const INTERNAL_RE = /x/;`,
  // Deliberately published ahead of its consumer.
  "app/lib/parked.ts": `/** @parked the keyboard lift positions on this once it lands. */\nexport const K_SCALAR = 1;`,
  // A tag with no reason must NOT count — otherwise it is a mute button.
  "app/lib/bare.ts": `/** @test-only */\nexport const MUTED = 1;`,
  // A symbol named only in PROSE is not referenced.
  "app/lib/prose.ts":  `export function namedOnlyInAComment() { return 4; }`,
  "app/lib/reader.ts": `// use namedOnlyInAComment here one day\nexport const UNRELATED = 1;`,
  "app/page2.tsx":     `import { UNRELATED } from "./lib/reader"; export default () => UNRELATED;`,
  // In scope: a feature/component export nothing imports.
  "app/features/x/Dead.tsx":    `export function DeadPanel() { return null; }`,
  "app/components/Live.tsx":    `export function LivePanel() { return null; }`,
  "app/features/x/index.ts":    `export { LivePanel } from "../../components/Live";`,
};

test("finds a symbol reachable only from tests", () => {
  assert.deepEqual(findOrphans(FILES), [
    "app/features/x/Dead.tsx:DeadPanel",
    "app/lib/bare.ts:MUTED",
    "app/lib/orphan.ts:neverCalled",
    "app/lib/prose.ts:namedOnlyInAComment",
  ]);
});

test("a mention in a COMMENT is not a reference", () => {
  assert.ok(findOrphans(FILES).includes("app/lib/prose.ts:namedOnlyInAComment"),
    "counting prose as a call site kept 7 real exports alive on nothing");
});

test("app/features and app/components are in scope; a real barrel export still counts", () => {
  const found = findOrphans(FILES);
  assert.ok(found.includes("app/features/x/Dead.tsx:DeadPanel"),
    "an unreferenced feature component must fail — app/features is in the scan");
  assert.ok(!found.some((o) => o.endsWith(":LivePanel")),
    "re-exported through the feature barrel, which IS a reference");
});

test("a tag with no reason is refused — the reason is the point", () => {
  assert.ok(findOrphans(FILES).includes("app/lib/bare.ts:MUTED"),
    "a bare @test-only would make the gate a mute button");
});

test("@parked exempts a symbol published ahead of its consumer", () => {
  assert.ok(!findOrphans(FILES).some((o) => o.endsWith(":K_SCALAR")));
});

test("a consumer OUTSIDE app/ counts — this is the false alarm the scan must not raise", () => {
  assert.ok(!findOrphans(FILES).some((o) => o.endsWith(":bootOnly")),
    "instrumentation.ts is a real call site; missing it reports live code as dead");
});

test("an @test-only tag above the definition exempts it", () => {
  assert.ok(!findOrphans(FILES).some((o) => o.endsWith(":INTERNAL_RE")),
    "a tagged export is deliberate, not an orphan");
});

test("the tag must be in the definition's OWN docblock, not anywhere in the file", () => {
  // The tag must sit BELOW the module header region, or the module-level
  // rule exempts the whole file and this stops testing proximity at all.
  const far = {
    ...FILES,
    "app/lib/far.ts": `${"\n".repeat(18)}/** @test-only a real reason, and still too far away. */\n${"\n".repeat(20)}export const NOT_COVERED = 1;`,
  };
  assert.ok(findOrphans(far).some((o) => o.endsWith(":NOT_COVERED")),
    "blank lines end the docblock; a tag above them covers nothing");
});

test("a LONG docblock still carries its tag — the window is the block, not 6 lines", () => {
  // A real, reasoned @test-only can drift several lines from its definition as
  // the rest of its docblock grows. A fixed window would make it do nothing.
  const grown = {
    ...FILES,
    "app/lib/grown.ts":
      `${"\n".repeat(18)}// @test-only enumerated by the test, consumed elsewhere only as a type.\n` +
      `${"// filler reasoning\n".repeat(9)}export const VOCABULARY = ["a"];`,
  };
  assert.ok(!findOrphans(grown).some((o) => o.endsWith(":VOCABULARY")),
    "a tag anywhere in the symbol's own docblock is the tag for that symbol");
});

test("a tag must NOT leak onto the export written directly beneath the tagged one", () => {
  // Strictly tighter than the 6-line window, which got this WRONG: with A and B
  // adjacent, a tag above A sat within 6 lines of B and exempted both.
  const pair = {
    ...FILES,
    "app/lib/pair.ts":
      `${"\n".repeat(18)}// @test-only the tests are the consumer of THIS one.\n` +
      `export const TAGGED = 1;\nexport const UNTAGGED = 2;`,
  };
  const found = findOrphans(pair);
  assert.ok(!found.some((o) => o.endsWith(":TAGGED")), "the tagged export is exempt");
  assert.ok(found.some((o) => o.endsWith(":UNTAGGED")),
    "an export line is not a comment line, so it ends the block above the next one");
});

test("a commented-out export is not discovered as a live one", () => {
  const disabled = {
    ...FILES,
    "app/lib/disabled.ts": `/*\nexport const SHELVED = 1;\n*/\nexport const KEPT = 1;`,
    "app/page3.tsx": `import { KEPT } from "./lib/disabled"; export default () => KEPT;`,
  };
  assert.ok(!findOrphans(disabled).some((o) => o.endsWith(":SHELVED")),
    "discovery runs on stripped source; a commented-out export does not exist");
});

test("a module-level @test-only header exempts the whole file", () => {
  const withHelper = {
    ...FILES,
    "app/lib/helper.ts": `// @test-only test infrastructure, not product code.\nexport function a() {}\nexport function b() {}`,
  };
  const found = findOrphans(withHelper).filter((o) => o.startsWith("app/lib/helper.ts"));
  assert.deepEqual(found, [], "a module tagged as test infrastructure should report nothing");
});

test("a per-export tag near the top of a file does NOT exempt the file", () => {
  // A fixed-window header would let any per-export docblock tag that sits early
  // enough exempt the WHOLE file, leaving stale exports unpoliced. The header
  // is the contiguous comment block OPENING the file; imports end it, blank
  // lines end it, and a tag below either belongs only to its own export.
  const early = {
    ...FILES,
    "app/lib/early.ts":
      `import { wired } from "./used.ts";\n\n` +
      `/** @test-only a real reason for THIS export only. */\n` +
      `export const COVERED = wired();\n` +
      `export const STALE_NEIGHBOR = 2;`,
  };
  const found = findOrphans(early);
  assert.ok(!found.some((o) => o.endsWith(":COVERED")), "the tagged export is exempt");
  assert.ok(found.some((o) => o.endsWith(":STALE_NEIGHBOR")),
    "an untagged orphan two lines into a file must be reported — a nearby " +
    "per-export tag is not a module header");
});

test("is not vacuous — an empty tree cannot report success by finding nothing to check", () => {
  assert.throws(() => findOrphans({}), /no exported symbols/);
});
