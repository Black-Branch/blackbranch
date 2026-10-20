// Run: node --test scripts/check-chrome.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { findChromeViolations } from "./check-chrome.mjs";

const OK = {
  "app/components/chrome/Sections.tsx": `export function Sections() { return <div role="tablist"><button role="tab" /></div>; }`,
  "app/components/chrome/index.ts": `export { Sections } from "./Sections";`,
  "app/features/store/StoreContent.tsx": `import { Sections } from "@/app/components/chrome";\nexport default () => <Sections />;`,
  // a comment naming role="tab" is prose, not markup
  "app/features/x/Prose.tsx": `// the old strip had role="tab" here\nexport const P = 1;`,
};

test("a clean tree has no findings", () => {
  assert.deepEqual(findChromeViolations(OK), []);
});

test('role="tab" / role="tablist" outside app/components/chrome/ is refused', () => {
  const files = { ...OK, "app/features/moderation/ModPanel.tsx": `<div role="tablist">\n<button role="tab">x</button>\n</div>` };
  assert.deepEqual(findChromeViolations(files), [
    'app/features/moderation/ModPanel.tsx:1: role="tablist" outside app/components/chrome/ — render Sections / Segmented / Chips / Rail from "@/app/components/chrome"',
    'app/features/moderation/ModPanel.tsx:2: role="tab" outside app/components/chrome/ — render Sections / Segmented / Chips / Rail from "@/app/components/chrome"',
  ]);
});

test("importing a file INSIDE the module is refused; the index is the only door", () => {
  const files = { ...OK, "app/components/Foo.tsx": `import { Sections } from "@/app/components/chrome/Sections";\nimport { Rail } from "../components/chrome/Rail";` };
  const found = findChromeViolations(files);
  assert.equal(found.length, 2);
  assert.match(found[0], /^app\/components\/Foo\.tsx:1: imports app\/components\/chrome\/Sections directly/);
  assert.match(found[1], /^app\/components\/Foo\.tsx:2: imports app\/components\/chrome\/Rail directly/);
});

test("the retired chrome classes are refused wherever they reappear", () => {
  const files = { ...OK, "app/features/chat/ChatTabBar.tsx": `<div className="chat-tabbar flex" />\n<div className={\`composer-shell \${x}\`} />\n<div className="meta-bar" />\n<span className="mx-panel-header" />\n<div className="collapse-row is-collapsed" />\n<div className="chat-folded-ctl" />\n<button className="chat-tab-btn" />` };
  const found = findChromeViolations(files);
  assert.equal(found.length, 7, found.join("\n"));
  for (const cls of ["chat-tabbar", "composer-shell", "meta-bar", "mx-panel-header", "collapse-row", "chat-folded-ctl", "chat-tab-btn"]) {
    assert.ok(found.some((f) => f.includes(`retired chrome class \`${cls}\``)), `${cls} not refused`);
  }
});

test("retired boundary: chat-tabbar-hidden (the html setting class) and meta-bar-x are NOT chat-tabbar / meta-bar", () => {
  const files = { ...OK, "app/lib/settingsRegistry.ts": `cls("chat-tabbar-hidden", v)\nconst x = "meta-bar-x";\n<div className="xmeta-bar" />` };
  assert.deepEqual(findChromeViolations(files), []);
});

test("retired names are escaped before they become a regex", () => {
  const files = { ...OK, "app/x/A.tsx": `<div className="a.b" />\n<div className="axb" />` };
  assert.deepEqual(findChromeViolations(files, { retired: ["a.b"] }), [
    "app/x/A.tsx:1: retired chrome class `a.b` — its surface is a Bar / Window now",
  ]);
});

test("scripts, tests and node_modules are out of scope", () => {
  const files = { ...OK, "app/lib/chromeSkins.test.ts": `assert.match(src, /role="tab"/)`, "node_modules/x/y.tsx": `<b role="tab" />` };
  assert.deepEqual(findChromeViolations(files), []);
});

test("the underline-tab idiom (border-b-2) is refused outside chrome", () => {
  const files = { ...OK, "app/features/moderation/ModPanel.tsx": `<button className="px-2 border-b-2 border-edge">x</button>` };
  assert.deepEqual(findChromeViolations(files), [
    'app/features/moderation/ModPanel.tsx:1: the underline-tab idiom (`border-b-2`) — render Sections from "@/app/components/chrome"',
  ]);
});

test("border-b-2 inside app/components/chrome/ is not a finding", () => {
  const files = { ...OK, "app/components/chrome/Extra.tsx": `export const X = () => <button className="border-b-2" />;` };
  assert.deepEqual(findChromeViolations(files), []);
});

test("border-b-2 boundary: border-b-20 and xborder-b-2 do not match", () => {
  const files = {
    ...OK,
    "app/features/x/A.tsx": `<button className="border-b-20" />`,
    "app/features/x/B.tsx": `<button className="xborder-b-2" />`,
  };
  assert.deepEqual(findChromeViolations(files), []);
});

test("the explicit /index import path is refused too — only the bare specifier is the door", () => {
  const files = { ...OK, "app/components/Foo.tsx": `import { Sections } from "@/app/components/chrome/index";` };
  const found = findChromeViolations(files);
  assert.equal(found.length, 1);
  assert.match(found[0], /^app\/components\/Foo\.tsx:1: imports app\/components\/chrome\/index directly/);
});

test("retired-class boundary: meta-bar does not match meta-bar-x or x-meta-bar", () => {
  const files = {
    ...OK,
    "app/features/x/A.tsx": `<div className="meta-bar-x" />`,
    "app/features/x/B.tsx": `<div className="x-meta-bar" />`,
    "app/features/x/C.tsx": `<div className="meta-bar" />`,
  };
  assert.deepEqual(findChromeViolations(files, { retired: ["meta-bar"] }), [
    "app/features/x/C.tsx:1: retired chrome class `meta-bar` — its surface is a Bar / Window now",
  ]);
});

test("findings sort numerically by line, not lexicographically (line 2 before line 10)", () => {
  const lines = Array.from({ length: 10 }, (_, i) => (i === 1 || i === 9 ? `<div role="tab" />` : "//"));
  const files = { ...OK, "app/features/x/Many.tsx": lines.join("\n") };
  const found = findChromeViolations(files);
  assert.deepEqual(
    found.map((f) => f.split(":")[1]),
    ["2", "10"],
  );
});

const FLOOR_TSX = "a floor (`min-h-* / minHeight`) inside app/components/chrome/ — a Bar is exactly its token tall";
const FLOOR_CSS = "a floor (`min-height`) inside app/components/chrome/ — a Bar is exactly its token tall";

test("rule 3: a floor inside the chrome module is refused (chrome carries heights, not floors)", () => {
  // Both spellings: the utility, and the inline style that no utility scan sees.
  const files = {
    ...OK,
    "app/components/chrome/Bar.tsx": `export const Bar = () => <div className="min-h-9" />;\nexport const B2 = () => <div style={{ minHeight: 36 }} />;`,
  };
  assert.deepEqual(findChromeViolations(files), [
    `app/components/chrome/Bar.tsx:1: ${FLOOR_TSX}`,
    `app/components/chrome/Bar.tsx:2: ${FLOOR_TSX}`,
  ]);
  const css = { ...OK, "app/components/chrome/chrome.css": `@layer components { .chrome-bar-top { min-height: 36px; } }` };
  assert.deepEqual(findChromeViolations(css), [`app/components/chrome/chrome.css:1: ${FLOOR_CSS}`]);
});

test("chrome.css is stripped AS CSS — stripComments would delete every custom-property line", () => {
  // stripComments' final pass deletes any line starting with `--` (SQL comments
  // living in template literals); in a stylesheet that is EVERY custom-property
  // declaration, which sourceText.mjs says in as many words. Pointed at CSS it
  // would take line 5 with it — floor and all — and rule 5 would then scan the
  // same mutilated text for retired classes.
  //
  // Line 4 is the benign shape (a floor on the line AFTER a custom property);
  // line 5 is the one that discriminates, because only a line that STARTS with
  // `--` is deleted. Both must be refused.
  const files = {
    ...OK,
    "app/components/chrome/chrome.css": [
      "@layer components {",
      "  .chrome-band {",
      "    --a: 1px;",
      "    min-height: 36px;",
      "    --b: 2px; min-height: 24px;",
      "  }",
      "}",
    ].join("\n"),
  };
  assert.deepEqual(findChromeViolations(files), [
    `app/components/chrome/chrome.css:4: ${FLOOR_CSS}`,
    `app/components/chrome/chrome.css:5: ${FLOOR_CSS}`,
  ]);
});

// ── Rule 3, the consumer half ───────────────────────────────────────────────
//
// A floor "on a chrome consumer's bar element" is refused too: otherwise a
// consumer could write `[data-bar="chat-top"] { min-height: 40px }` in
// globals.css and pass. `Bar` has no className door, so that `[data-bar…]`
// hook is the ONE way a consumer can reach the bar's own box: globals.css is
// in scope for this rule, and for this rule only.
const FLOOR_GLOBALS = "a floor (`min-height`) on a Bar consumer hook `[data-bar…]` in globals.css — a Bar is exactly its token tall";

test("rule 3: globals.css may reach a Bar through [data-bar…] — but not to put a floor on it", () => {
  // What the real stylesheet does: hide the whole bar. It reaches through the
  // hook and never touches the bar's height.
  const ok = {
    ...OK,
    "app/globals.css": `.chat-tabbar-hidden [data-bar="chat-top"] { display: none !important; }`,
  };
  assert.deepEqual(findChromeViolations(ok), []);

  // The floor. Reported at the DECLARATION's line, not the selector's — a
  // selector list can sit several lines above the declaration that offends.
  const bad = {
    ...OK,
    "app/globals.css": `[data-bar="mx-header"],\n.pin-row { padding-right: 1rem; min-height: 40px; }`,
  };
  assert.deepEqual(findChromeViolations(bad), [`app/globals.css:2: ${FLOOR_GLOBALS}`]);
});

test("rule 3: a floor in globals.css on anything that is NOT a Bar hook is none of this gate's business", () => {
  // The rule is about the bar's own box. globals.css is full of legitimate
  // floors on ordinary rows, and a blanket `min-height` ban would be a
  // heuristic — the one thing every rule in this gate refuses to be.
  const files = { ...OK, "app/globals.css": `.something-else { min-height: 40px }` };
  assert.deepEqual(findChromeViolations(files), []);
});

test("rule 3 is BRACE-matched in globals.css: a [data-bar] rule nested in a @media block is still refused", () => {
  // A per-line scan would miss this, and a media query is precisely where a
  // consumer reaches for a mobile floor. The enclosing `@media` prelude carries
  // no `[data-bar`; the rule inside it does, and its declaration is two lines
  // below its own selector.
  const files = {
    ...OK,
    "app/globals.css": [
      "@media (max-width: 767px) {",
      '  [data-bar="chat-top"] {',
      "    padding: 0;",
      "    min-height: 40px;",
      "  }",
      "}",
    ].join("\n"),
  };
  assert.deepEqual(findChromeViolations(files), [`app/globals.css:4: ${FLOOR_GLOBALS}`]);
});

test("the reported line survives a MULTI-LINE comment above the rule", () => {
  // `stripCssComments` replaces a comment with one SPACE, so a multi-line
  // comment collapses and every line after it shifts. Against the real
  // globals.css that put the fold rule at line 708 when it lives at 1383 — a
  // finding naming a line the reader cannot find. The walk therefore takes the
  // RAW stylesheet and skips comments itself.
  const files = {
    ...OK,
    "app/globals.css": [
      "/* Tab bar: fold the whole bar away.",
      "   A floating control keeps the switches reachable while it's folded.",
      "   Three lines of prose, and the declaration is below them. */",
      '[data-bar="chat-top"] { min-height: 40px; }',
    ].join("\n"),
  };
  assert.deepEqual(findChromeViolations(files), [`app/globals.css:4: ${FLOOR_GLOBALS}`]);
});

test("a comment INSIDE a selector drops out of it without truncating it", () => {
  // The other half of tokenising comments. Dropping a comment must not take
  // the selector text BEFORE it as well — that would lose the `[data-bar` hook
  // and wave the floor straight through, which is a false NEGATIVE in a gate
  // whose whole value is that it cannot be talked out of a finding.
  const files = {
    ...OK,
    "app/globals.css": `[data-bar="chat-top"] /* the fold hook */ { min-height: 40px; }`,
  };
  assert.deepEqual(findChromeViolations(files), [`app/globals.css:1: ${FLOOR_GLOBALS}`]);
});

test("a brace inside prose does not move the scope of the rules after it", () => {
  // The walk MATCHES BRACES, so an unbalanced `{` in a comment would push a
  // phantom rule and every selector after it would be read inside the wrong
  // scope — here it would put `.ordinary-row` inside the `[data-bar]` rule and
  // invent a finding on a stylesheet that has none. Comments are tokenised, so
  // it does not.
  const files = {
    ...OK,
    "app/globals.css": [
      '/* the hook used to be written `[data-bar="chat-top"] {` here */',
      '[data-bar="chat-top"] { display: none; }',
      ".ordinary-row { min-height: 40px; }",
    ].join("\n"),
  };
  assert.deepEqual(findChromeViolations(files), []);
});

test("globals.css is in scope for rule 3 ONLY — its retired-class guard lives in chromeSkins.test.ts", () => {
  // Admitting globals.css to `inScope` must not quietly arm rules 1, 2, 4 and 5
  // over it: role and import are not CSS shapes at all, and the retired chrome
  // classes in globals.css are already pinned — each with its own reason — by
  // app/lib/chromeSkins.test.ts. Two owners for one invariant is how a stale
  // copy outlives the fix to the other.
  const files = {
    ...OK,
    "app/globals.css": `.mx-panel-header { color: red; }\n.collapse-row > * { min-height: 0; }\n.x { border-b-2: 0; }`,
  };
  assert.deepEqual(findChromeViolations(files), []);
});
