#!/usr/bin/env node
// Orphaned-export guard for the BACKEND packages.
//
// WHAT THIS IS FOR. eslint does not see unused EXPORTS: a symbol that leaves its
// module is "used" as far as the linter is concerned, whoever does or does not
// import it. A function with passing tests and no caller looks wired. This gate
// finds exports that nothing references.
//
// ── Why one file at the repo root, and not one per package ──────────────────
//
// stream-api is CommonJS and stream-ingest is ESM, but a gate named
// `check-orphans` must MEAN the same thing in both packages, or the weaker of
// two definitions wins silently. So: one implementation that reads both module
// systems, invoked by each package's own `check:all` with its own scope.
//
// It lives OUTSIDE both packages on purpose. stream-api's deploy copies the
// `*.js` files of its package root, and stream-ingest is copied whole to its
// runtime — a scanner inside either one is a scanner shipped to a production
// box. `tools/` is copied by neither.
//
// It imports the comment stripper from `web/app/lib/sourceText.mjs` rather
// than carrying its own: one stripper for every gate, so no gate counts a
// symbol named in PROSE as a live call site. Running this needs the web tree
// present; in the repo and in CI it always is.
//
// ── The rule ────────────────────────────────────────────────────────────────
//
// An export that no other production file in the same package references is a
// failure, UNLESS it carries a tag in the docblock at its definition:
//
//   @test-only <why>  — the tests ARE the consumer
//   @parked <why>     — published ahead of, or behind, a consumer; needs a
//                       NAMED future consumer or a dated decision
//
// BOTH REQUIRE A REASON: a tag that can be applied without saying why is a mute
// button.
//
// CommonJS needs one thing web's version does not. `module.exports = { a, b }`
// sits at the BOTTOM of the file, nowhere near where `a` is defined, so
// "the docblock above the export" would mean the docblock above a list. A tag is
// therefore accepted in either place: above the symbol's own definition (the
// preferred spot — it is what the next reader sees), or above its line in the
// export list, for a symbol with no single definition site.
//
// Usage:  node ../tools/check-orphans.mjs <package-dir>
//
// Run: node tools/check-orphans.mjs stream-api

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../web/app/lib/sourceText.mjs";

const REPO = resolve(fileURLToPath(import.meta.url), "../..");

// Never walked. `config/` is stream-ingest's RUNTIME-ONLY behaviour directory
// (`/tune` writes it; the deploy excludes it), `vendor/` is third-party,
// `sounds/` is media, and `.next/` is web's build output — which contains
// bundled copies of the very source being scanned, so leaving it in would make
// every export look referenced by its own compiled self.
const SKIP = new Set([
  "node_modules", ".git", ".next", "config", "vendor", "sounds", "docs", "mirror",
]);

// `@test-only` / `@parked` followed by at least 8 characters of actual reason.
// The length floor is what makes the reason mandatory rather than decorative.
const TAG = /@(?:test-only|parked)\b[^\n]{8,}/;
// A comment line in any docblock form. Blank and code lines are NOT comments,
// which is what ends the block above a definition.
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

// A file whose exports exist for the test suite, not for production.
// `.ts`/`.tsx` too: web's cross-runtime parity tests are TypeScript and are the
// only consumer of several stream-api exports. A JS-only pattern would count
// them as PRODUCTION consumers and report those exports as wired — a false
// all-clear on exactly the "tested, never called" cases the report surfaces.
const isTest = (p) => /\.(test|probe)\.(js|cjs|mjs|tsx?)$/.test(p);

/**
 * The contiguous run of comment lines immediately above line `i` — a symbol's
 * own docblock, however long it has grown. One blank line ends it.
 *
 * @param {string[]} lines RAW source lines; a stripped file has no comments
 * @param {number} i
 */
function docblockAbove(lines, i) {
  let j = i - 1;
  while (j >= 0 && COMMENT_LINE.test(lines[j] ?? "")) j--;
  return lines.slice(j + 1, i).join("\n");
}

/**
 * The file's MODULE header — the leading comment block, but only when it is one.
 *
 * The distinction is structural, not positional (a fixed first-N-lines window
 * would read the FIRST SYMBOL's tag as a module-level exemption and stop
 * checking every other export in the file): a module header is separated
 * from the code by a blank line. A comment block welded to the declaration
 * below it is that declaration's docblock and speaks only for it.
 *
 * @param {string[]} lines
 */
function moduleHeader(lines) {
  if (!COMMENT_LINE.test(lines[0] ?? "")) return "";
  let j = 0;
  while (j < lines.length && COMMENT_LINE.test(lines[j] ?? "")) j++;
  // Welded to the code below → it is that symbol's docblock, not the file's.
  if ((lines[j] ?? "").trim() !== "") return "";
  return lines.slice(0, j).join("\n");
}

/**
 * Every line index at which `name` is DEFINED at the top level of `lines`.
 *
 * Used to find where a CommonJS export's tag would live, since its
 * `module.exports` entry is nowhere near the definition.
 *
 * @param {string[]} lines
 * @param {string} name
 */
function definitionLines(lines, name) {
  const re = new RegExp(
    `^\\s*(?:async\\s+)?(?:function|const|let|class)\\s+${name}\\b|` +
      `^\\s*(?:async\\s+)?function\\s*\\*\\s*${name}\\b`
  );
  const out = [];
  lines.forEach((l, i) => { if (re.test(l)) out.push(i); });
  return out;
}

/**
 * Names exported by `src`, with the line each was declared on.
 *
 * Discovery runs on STRIPPED text so a commented-out `export function` is not
 * discovered as a live one. stripComments preserves line count, so the index
 * still addresses the raw lines for the tag lookup.
 *
 * @param {string} src raw source
 * @returns {{name: string, line: number}[]}
 */
export function exportedNames(src) {
  const stripped = stripComments(src).split("\n");
  /** @type {{name: string, line: number}[]} */
  const out = [];
  const add = (name, line) => {
    if (name && !out.some((e) => e.name === name)) out.push({ name, line });
  };

  stripped.forEach((line, i) => {
    // ESM: export function|const|class|let NAME
    const decl = /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|class|let)\s+([A-Za-z0-9_$]+)/.exec(line);
    if (decl) add(decl[1], i);
    // CommonJS: exports.NAME = …
    const single = /^(?:module\.)?exports\.([A-Za-z0-9_$]+)\s*=/.exec(line);
    if (single) add(single[1], i);
    // CommonJS: module.exports = someIdentifier;
    const whole = /^module\.exports\s*=\s*([A-Za-z0-9_$]+)\s*;?\s*$/.exec(line);
    if (whole) add(whole[1], i);
  });

  // Braced lists, in both dialects: `export { a, b as c }` and
  // `module.exports = { a, b: impl }`.
  //
  // DEPTH-AWARE: a flat `[^}]*` stops at the first closing brace, so for
  //   module.exports = { playSound, config: { URL, AUDIO_SCENE, … } };
  // it would capture the NESTED keys and report `AUDIO_SCENE` as a dead
  // top-level export. It is not an export at all; it is a property of one.
  const joined = stripped.join("\n");
  for (const m of joined.matchAll(/^(?:export\s*|module\.exports\s*=\s*)\{/gm)) {
    const open = m.index + m[0].length - 1;
    const startLine = joined.slice(0, open).split("\n").length - 1;
    let depth = 0;
    let line = startLine;
    for (let i = open; i < joined.length; i++) {
      const ch = joined.charAt(i);
      if (ch === "\n") { line++; continue; }
      if (ch === "{" || ch === "[" || ch === "(") { depth++; continue; }
      if (ch === "}" || ch === "]" || ch === ")") { depth--; if (depth === 0) break; continue; }
      if (depth !== 1 || !/[A-Za-z_$]/.test(ch)) continue;
      // A key starts right after `{` or `,`, whitespace aside.
      const prev = joined.slice(0, i).replace(/\s+$/, "").slice(-1);
      if (prev !== "{" && prev !== ",") continue;
      // `a`, `a: impl`, `a as b` — the EXPORTED name is the left of `:` and the
      // right of `as`.
      const entry = /^([A-Za-z0-9_$]+)(\s+as\s+([A-Za-z0-9_$]+))?\s*[,:}\n]/.exec(joined.slice(i));
      if (!entry) continue;
      add(entry[3] ?? entry[1], line);
      i += entry[1].length - 1;
    }
  }
  return out;
}

/**
 * @param {Record<string,string>} files package-relative path -> raw source.
 *   Where exports are DISCOVERED — one package at a time.
 * @param {Record<string,string>} [world] repo-relative path -> raw source for
 *   the WHOLE monorepo. Where references are COUNTED.
 * @returns {{dead: string[], testOnly: string[]}} "path:symbol", sorted
 *
 * THE TWO SCOPES ARE DIFFERENT ON PURPOSE. Counting references only within the
 * package would call link-gate.js exports dead that web's
 * `linkGateParity.test.ts` reaches with `require("../../../stream-api/link-gate.js")`
 * — the two files are a deliberate cross-runtime pair and that test is what
 * stops them diverging. A narrow scan does not report less; it reports WRONG.
 *
 * TWO populations, kept apart so the report is a work queue rather than one
 * undifferentiated list.
 *
 *   dead     — referenced by NOTHING. Not production, not even a test. There is
 *              no argument for keeping it and nothing to read to find out what
 *              it was for. This is what fails the build.
 *   testOnly — referenced only by the test suite. That is a real consumer and
 *              usually a deliberate one: these modules export internals so a
 *              unit test can reach them, which this codebase does on purpose and
 *              at scale. Reported, never fatal — see the note by the exit code.
 */
export function findOrphans(files, world = files) {
  /** @type {{path: string, name: string}[]} */
  const exports = [];
  let discovered = 0;
  for (const [path, raw] of Object.entries(files)) {
    if (isTest(path)) continue;
    const lines = raw.split("\n");
    const names = exportedNames(raw);
    discovered += names.length;
    // A module-level tag in the header exempts the whole file, for modules that
    // ARE test infrastructure. Tagging each of their exports individually would
    // be noise hiding the one fact worth stating: this file exists for tests.
    if (TAG.test(moduleHeader(lines))) continue;

    for (const { name, line } of names) {
      // Tagged at the export site, or at any definition of the same name.
      const spots = [line, ...definitionLines(lines, name)];
      if (spots.some((i) => TAG.test(docblockAbove(lines, i)))) continue;
      exports.push({ path, name });
    }
  }
  // Anchored on what was DISCOVERED, not on what survived the tag filter.
  // Counting the survivors conflates "the scan read nothing" with "every export
  // is legitimately tagged" — the first is a broken scan and the second is a
  // clean package, and throwing on the second would punish the tidiest possible
  // state. Same distinction as anchoring a source scan on the file WALK rather
  // than on the item count, which can legitimately reach zero.
  if (!discovered) {
    throw new Error("check-orphans: no exported symbols found — the scan is vacuous");
  }

  // Comments stripped HERE and only here. A mention is not a call site: a
  // comment naming a dead export (even one telling a future reader to use it)
  // must not keep it alive.
  const stripped = Object.entries(world)
    .map(([p, text]) => /** @type {[string,string]} */ ([p, stripComments(text)]));
  const prod = stripped.filter(([p]) => !isTest(p));
  const tests = stripped.filter(([p]) => isTest(p));

  // A world path is repo-relative and a package path is package-relative, so
  // "the defining file" is matched by SUFFIX. Exact enough here: the packages
  // have no colliding basenames across directories that also share a symbol.
  const isSelf = (worldPath, pkgPath) => worldPath === pkgPath || worldPath.endsWith(`/${pkgPath}`);

  const dead = [];
  const testOnly = [];
  for (const { path, name } of exports) {
    const word = new RegExp(`\\b${name}\\b`);
    if (prod.some(([p, text]) => !isSelf(p, path) && word.test(text))) continue;
    (tests.some(([, text]) => word.test(text)) ? testOnly : dead).push(`${path}:${name}`);
  }
  return { dead: dead.sort(), testOnly: testOnly.sort() };
}

/**
 * @param {string} dir
 * @param {string} root paths in the result are relative to this
 * @param {RegExp} ext which files to read
 * @param {Record<string,string>} out
 */
function readTree(dir, root, ext, out = {}) {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const abs = join(dir, e);
    if (statSync(abs).isDirectory()) readTree(abs, root, ext, out);
    else if (ext.test(abs) && !abs.endsWith("eslint.config.mjs")) {
      out[relative(root, abs)] = readFileSync(abs, "utf8");
    }
  }
  return out;
}

/** Backend source: where exports are discovered. */
const BACKEND = /\.(js|mjs|cjs)$/;
// The reference sweep must include `.ts`/`.tsx`. web's parity tests are
// TypeScript and they are the ONLY consumer of several stream-api exports; a
// JS-only sweep would call them dead.
const ANY_SOURCE = /\.(js|mjs|cjs|tsx?)$/;

if (import.meta.url === `file://${process.argv[1]}`) {
  const pkg = process.argv[2];
  if (!pkg) {
    console.error("usage: node tools/check-orphans.mjs <package-dir>");
    process.exit(2);
  }
  const root = resolve(REPO, pkg);
  const own = readTree(root, root, BACKEND);

  // The world a reference may come from: this package, plus every file ANYWHERE
  // in the repo that actually imports from this package by path.
  //
  // NOT simply "the whole repo": either bound is wrong in one direction.
  // Package-only misses web's parity tests, which
  // `require("../../../stream-api/link-gate.js")` and are the sole consumer of
  // several exports. Repo-wide lets an unrelated same-named constant elsewhere
  // (a `COOLDOWN_MS` in web) keep a genuinely dead export alive. A bare word
  // match cannot tell two same-named symbols apart; requiring the file to
  // import the package is what can.
  const importsPkg = new RegExp(`(?:require\\(|from\\s+)["'][^"']*${pkg}/`);
  const world = { ...own };
  for (const [path, text] of Object.entries(readTree(REPO, REPO, ANY_SOURCE))) {
    if (!path.startsWith(`${pkg}/`) && importsPkg.test(text)) world[path] = text;
  }

  const { dead, testOnly } = findOrphans(own, world);

  // testOnly is REPORTED, NOT FATAL, on purpose. Requiring a written reason on
  // every internal a unit test reaches would mean a hand-authored tag on each,
  // written to clear a build rather than because it is meant. The shape it
  // would catch — tested, never called — is still worth seeing, so it prints
  // every run.
  if (testOnly.length && process.env.CHECK_ORPHANS_QUIET !== "1") {
    console.log(`check-orphans (${pkg}): ${testOnly.length} exports reached only by tests`);
    for (const o of testOnly) console.log(`  · ${o}`);
    console.log("  (not a failure — but a tested mechanism nothing CALLS is the clampGeom shape)");
  }

  if (dead.length) {
    console.error(`\ncheck-orphans (${pkg}): exported and referenced by NOTHING —`);
    for (const o of dead) console.error(`  ${o}`);
    console.error("\nNot production, not even a test. Delete it, wire it up, or tag it");
    console.error("above the definition:");
    console.error("  @test-only <why>  — the tests are the consumer");
    console.error("  @parked <why>     — named future consumer, or a dated decision");
    console.error("A bare tag is refused; the reason is the point.");
    process.exit(1);
  }
  console.log(`check-orphans (${pkg}): ok`);
}
