// The shared comment stripper, tested.
//
// WHY THIS FILE EXISTS. `stripComments` is depended on by many test files that
// measure POSITIONS in its output — "this guard appears before that one".
// Untested, it would be the least-guarded piece of code in the suite while
// being the most widely relied upon. Breaking its URL handling would break no
// other test, because none of them happens to scan a source line containing a
// URL.
//
// Run: node --test app/lib/testSource.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { stripComments, stripCssComments } from "./testSource.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

// ── The guard that ten copies were missing ───────────────────────────────────

test("a URL survives — `//` after a colon is not a comment", () => {
  // The classic defect: `/\/\/.*$/` truncates any line containing a URL:
  // `const u = "https://x"` becomes `const u = "https:` — silently deleting the
  // rest of a line the test then measures.
  assert.equal(stripComments('const u = "https://example.com/x";'),
    'const u = "https://example.com/x";');
  assert.equal(stripComments('fetch("http://a.test/b"); // note').trimEnd(),
    'fetch("http://a.test/b");');
  // Protocol-relative and doubled slashes inside strings survive too.
  assert.equal(stripComments('const p = "//cdn.example.com/x";'), 'const p = "//cdn.example.com/x";');
});

// ── The comment forms it removes ─────────────────────────────────────────────

test("line, block and JSX comments all go", () => {
  assert.equal(stripComments("const a = 1; // trailing").trimEnd(), "const a = 1;");
  assert.equal(stripComments("// whole line\nconst b = 2;").trim(), "const b = 2;");
  assert.equal(stripComments("/* block */const c = 3;").trim(), "const c = 3;");
  assert.equal(stripComments("/* multi\n   line */const d = 4;").trim(), "const d = 4;");
});

test("JSX comments are stripped BEFORE block comments, leaving no stray braces", () => {
  // Order is load-bearing: `{/* … */}` is a block comment inside braces, so
  // stripping `/* … */` first leaves a bare `{}` in the markup and changes the
  // shape of what follows — which is exactly what a positional scan measures.
  const out = stripComments("<div>{/* note */}<b/></div>");
  assert.ok(!out.includes("{"), `a stray brace survived: ${out}`);
  assert.ok(!out.includes("}"), `a stray brace survived: ${out}`);
  assert.ok(out.includes("<b/>"), "the markup after the comment was eaten");
});

test("a block comment becomes a SPACE, so removing it cannot weld two tokens", () => {
  // `a/* x */b` must not become `ab` — a token the source never contained, which
  // a scan could then match on.
  assert.equal(stripComments("a/* x */b").trim(), "a b");
});

test("SQL `--` comments go, but only at the start of a line", () => {
  // SQL lives in template literals here, so a note inside a query is still
  // JavaScript source as far as a regex is concerned.
  assert.match(stripComments("const q = `SELECT a\n  -- why\n  FROM t`;"), /SELECT a[\s\S]*FROM t/);
  assert.doesNotMatch(stripComments("const q = `SELECT a\n  -- why\n  FROM t`;"), /why/);
  // …and it must not eat a decrement or a subtraction. A line that BEGINS
  // with `--` is not valid JavaScript, which is what makes the anchor safe.
  assert.equal(stripComments("const dec = a-- b;"), "const dec = a-- b;");
  assert.equal(stripComments("const n = x - -y;"), "const n = x - -y;");
});

// ── What it must not do ──────────────────────────────────────────────────────

test("code with no comments is returned unchanged", () => {
  const src = 'const a = 1;\nfunction f() { return "x"; }\n';
  assert.equal(stripComments(src), src);
});

test("line numbering is preserved, because scans report positions", () => {
  // Removing a comment LINE must leave the newline behind, or every reported
  // offset after it shifts and an ordering assertion can silently invert.
  const before = "a\n// note\nb";
  assert.equal(stripComments(before).split("\n").length, 3);
});

// ── The stylesheet variant ───────────────────────────────────────────────────

test("stripCssComments keeps custom properties that stripComments would delete", () => {
  // The whole reason there are two functions. `--x: 1` at the head of a line is
  // indistinguishable from a SQL comment, and a stylesheet is nothing but.
  const css = ":root {\n  --color-surface-1: #111;\n}\n/* note */\n.a { color: red; }";
  assert.match(stripCssComments(css), /--color-surface-1/);
  assert.doesNotMatch(stripComments(css), /--color-surface-1/);
  // And it still removes what it is for.
  assert.doesNotMatch(stripCssComments(css), /note/);
  assert.match(stripCssComments(css), /\.a \{ color: red; \}/);
});

test("a removed CSS comment leaves a separator behind", () => {
  assert.equal(stripCssComments(".a/*x*/.b").includes(".a .b"), true);
});

// ── It is actually the one everybody uses ────────────────────────────────────

test("no test file carries its own comment stripper any more", () => {
  // ONE stripper, not copies. Copies in diverging behaviours are not merely
  // untidy: these tests measure positions in the stripped string, so a subtly
  // weaker copy produces a subtly different string and the test silently
  // measures something else.
  //
  // Deliberately checks EVERY test file, not a list — a new file with a fresh
  // copy is exactly how this grows back.
  //
  // The walk starts at app/, not at app/lib/: test files outside app/lib can
  // carry a private `/\/\*[\s\S]*?\*\//` too. A guard quoted as covering the
  // tree has to walk the tree — a narrow scan reports something DIFFERENT, not
  // less.
  //
  // This file's own detector is written with escapes (`replace\(\/\\\/…`), so
  // it is not itself a match — the one file allowed to name the pattern is the
  // one hunting for it.
  const dir = join(HERE, "..");
  const offenders: string[] = [];
  // A negative assertion over a walk goes green on a walk that found NOTHING,
  // so the count is asserted too.
  let seen = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.test\.tsx?$/.test(e.name)) continue;
      seen += 1;
      const src = readFileSync(p, "utf8");
      // The signature of a hand-rolled stripper: a block-comment regex.
      if (/replace\(\/\\\/\\\*\[\\s\\S\]\*\?\\\*\\\//.test(src)) offenders.push(relative(dir, p));
    }
  };
  walk(dir);
  assert.ok(seen > 0, `vacuity anchor: the walk from ${dir} found no test files at all`);
  assert.deepEqual(offenders, [],
    `these files strip comments themselves instead of importing stripComments: ${offenders.join(", ")}`);
});
