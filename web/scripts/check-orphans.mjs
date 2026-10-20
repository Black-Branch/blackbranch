#!/usr/bin/env node
// Orphaned-mechanism guard.
//
// WHAT THIS IS FOR. A mechanism can have a dozen passing tests and ZERO
// callers: delete the code that called it and nothing notices, while a green
// suite reports it working. A test proves a mechanism is CORRECT; nothing
// proves it is still WIRED. This does.
//
// The rule: an export from the scanned roots that no production file
// references is a failure, UNLESS it carries a tag at its definition. The tag
// is documentation the next reader sees at the symbol itself — deliberately not
// a suppression list in a separate file, which is how this kind of check rots.
//
// TWO tags, because there are exactly two honest reasons to be unreferenced:
//   @test-only <why>  — the tests ARE the consumer. An internal deliberately
//                       exported so a test can reach it (blacklist.ts:termRegex
//                       says so in as many words).
//   @parked <why>     — deliberately published ahead of, or behind, a consumer.
//                       Needs a NAMED consumer or a stated decision: a plugin
//                       API a console uses, a probe kept for re-wiring.
//
// BOTH REQUIRE A REASON. A bare `@test-only` is refused, because a tag that
// can be applied without saying why is just a mute button, and "kept, it
// costs nothing" is how dead wood accumulates.
//
// The consumer scan MUST cover the whole web tree, not just app/. A scan that
// walks only app/ reports startBlocklistOverrideRefresh and
// startAutomodEventSub as dead; both are wired in instrumentation.ts. That
// false alarm is a fixture in check-orphans.test.mjs.
//
// ── Two ways a gate like this says "referenced" when it means nothing ───────
//
// 1. COUNTING PROSE. A reference test of `\bname\b` against RAW source reads a
//    symbol named only in a COMMENT as a live call site — the worst shape is
//    the honest-looking one, a note telling a FUTURE reader to use a helper.
//    Reference counting runs on `stripComments` (app/lib/sourceText.mjs), the
//    same stripper ~60 tests use, so the gate and the tests agree about what
//    code is.
//    Comments are stripped for the REFERENCE COUNT ONLY. Tag detection needs
//    them by definition, so it reads the raw text.
//
// 2. ACCEPTING A TAG THAT HAS DRIFTED OUT OF RANGE. A fixed window ("the N
//    lines above the definition") misses a real, reasoned tag whose docblock
//    grew, so the tag reads as enforced and does nothing. The window is the
//    CONTIGUOUS COMMENT BLOCK immediately above the definition, however long: a
//    tag belongs in the symbol's own docblock, and one blank line still ends
//    it. That is also strictly tighter than a fixed window — a tag above export
//    A does not leak onto the export B written directly beneath it.
//
// SCOPE. app/lib/** + lib/** (core, matching check-structure's isCore) AND
// app/features/** + app/components/**. A tag outside the scope looks identical
// to an enforced one, so the scope covers every tagged place.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../app/lib/sourceText.mjs";

const ROOT = process.cwd();
// SKIPPED AT THE ROOT ONLY. `public` is a perfectly ordinary route segment:
// skipping it at every depth would make `app/api/avatar/public/[id]/`
// invisible to the whole scan, so the export it imports would be reported as
// referenced-only-by-tests. node_modules/.next/.git stay skipped everywhere
// because they nest.
const SKIP_ROOT = new Set(["node_modules", ".next", ".git", "public", "scripts"]);
const SKIP_ANYWHERE = new Set(["node_modules", ".next", ".git"]);

// Where an unreferenced export is a FAILURE. Deliberately not the whole tree:
// app/api/** exports route handlers that Next.js calls by convention and no
// file imports, so every one of them would read as dead.
const SCOPED = ["app/lib/", "lib/", "app/features/", "app/components/"];
/** @param {string} p */
const inScope = (p) => SCOPED.some((s) => p.startsWith(s));

// `@test-only` / `@parked` followed by at least 8 characters of actual reason.
// The length floor is what makes the reason mandatory rather than decorative.
const TAG = /@(?:test-only|parked)\b[^\n]{8,}/;
// A comment line, in any of the forms a docblock uses. Blank lines and code
// lines are NOT comments, which is what ends the block above a definition.
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

/**
 * The contiguous run of comment lines immediately above line `i` — a symbol's
 * own docblock, however long it has grown. One blank line ends it.
 *
 * @param {string[]} lines  RAW source lines; a stripped file has no comments to find
 * @param {number} i
 */
function docblockAbove(lines, i) {
  let j = i - 1;
  while (j >= 0 && COMMENT_LINE.test(/** @type {string} */ (lines[j]))) j--;
  return lines.slice(j + 1, i).join("\n");
}

/**
 * @param {Record<string,string>} files  repo-relative path -> source text
 * @returns {string[]} "path:symbol" for every untagged, unreferenced export
 */
export function findOrphans(files) {
  const exports = [];
  for (const [path, raw] of Object.entries(files)) {
    // Both core roots, because check-structure.mjs treats them as one:
    // `isCore = p.startsWith("app/lib/") || p.startsWith("lib/")`. If the two
    // guards disagree about what core is, the smaller definition wins
    // silently.
    if (!inScope(path) || path.includes(".test.")) continue;
    const lines = raw.split("\n");
    // A module-level `@test-only` in the HEADER exempts the whole file, for
    // modules that ARE test infrastructure (testDom, testSource, and metrics
    // files whose test is the consumer by design). Tagging each of their
    // exports individually would be noise that hides the one fact worth
    // stating: this file exists for tests.
    //
    // "Header" = the CONTIGUOUS comment block starting on line 1 of the file,
    // ended by the first blank or code line — not a fixed N-line window, where
    // a per-EXPORT docblock tag that happens to sit near the top of a file
    // would exempt the WHOLE file and leave its stale exports unpoliced. Every
    // real module-header tag opens its file; a blank line before a tag means
    // the tag belongs to the export below it, which docblockAbove handles.
    // stripComments preserves line count, so "comment line" = raw non-blank
    // that strips to blank.
    const strippedLines = stripComments(raw).split("\n");
    let headerEnd = 0;
    while (
      headerEnd < lines.length &&
      lines[headerEnd].trim() !== "" &&
      strippedLines[headerEnd].trim() === ""
    ) headerEnd++;
    if (TAG.test(lines.slice(0, headerEnd).join("\n"))) continue;
    // Discovery runs on the STRIPPED text so a commented-out `export function`
    // is not discovered as a live one; stripComments preserves line count, so
    // index `i` still addresses the raw lines for the tag lookup below.
    stripComments(raw).split("\n").forEach((line, i) => {
      const m = /^export (?:default )?(?:async )?(?:function|const|class) ([A-Za-z0-9_]+)/.exec(line);
      if (!m) return;
      if (TAG.test(docblockAbove(lines, i))) return;
      exports.push({ path, name: m[1] });
    });
  }
  if (!exports.length) throw new Error("check-orphans: no exported symbols found — the scan is vacuous");

  // Comments stripped HERE and only here. A mention is not a call site.
  const prod = Object.entries(files)
    .filter(([p]) => !p.includes(".test."))
    .map(([p, text]) => [p, stripComments(text)]);
  const orphans = [];
  for (const { path, name } of exports) {
    const word = new RegExp(`\\b${name}\\b`);
    if (!prod.some(([p, text]) => p !== path && word.test(text))) orphans.push(`${path}:${name}`);
  }
  return orphans.sort();
}

function readTree(dir, out = {}) {
  const atRoot = dir === ROOT;
  for (const e of readdirSync(dir)) {
    if ((atRoot ? SKIP_ROOT : SKIP_ANYWHERE).has(e)) continue;
    const abs = join(dir, e);
    if (statSync(abs).isDirectory()) readTree(abs, out);
    else if (/\.(tsx?|mjs)$/.test(abs)) out[abs.replace(ROOT + "/", "")] = readFileSync(abs, "utf8");
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const orphans = findOrphans(readTree(ROOT));
  if (orphans.length) {
    console.error("check-orphans: exported but referenced only by tests —");
    for (const o of orphans) console.error(`  ${o}`);
    console.error("\nEither wire it up, delete it, or tag it above the definition:");
    console.error("  @test-only <why>  — the tests are the consumer");
    console.error("  @parked <why>     — named future consumer, or a dated decision");
    console.error("A bare tag is refused; the reason is the point.");
    console.error("A tested mechanism nothing calls is the clampGeom failure.");
    process.exit(1);
  }
  console.log("check-orphans: ok");
}
