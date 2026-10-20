'use strict';

// Reading another file's SOURCE for a guard test.
//
// THIS DIRECTORY IS NOT DEPLOYED, AND THAT IS WHY IT IS A DIRECTORY.
// The stream-api deploy copies the top-level `*.js`, non-recursively. A
// top-level `test-source.js` would be copied onto the runtime box; nothing under
// testlib/ can be. The same non-recursive read is what `sql-parse.test.js` and
// the owner's retrieve test use to enumerate "every module in the package", so
// putting a helper here also keeps it out of *their* scans.
//
// ── Why a tail anchor is mandatory rather than optional ─────────────────────
//
// Half the guards in this suite read a file and assert something about the text.
// When that read silently comes back SHORT, the failure is not symmetric:
//
//   • a POSITIVE assertion (`assert.match(src, /x/)`) goes RED. It is safe by
//     construction — truncation looks exactly like deletion, which is the thing
//     it exists to catch.
//   • a NEGATIVE assertion (`assert.doesNotMatch(src, /x/)`) goes GREEN, and
//     stays green while the code it protects is gone. That is the whole bug.
//
// So `scanSource` REQUIRES an anchor, and the anchor must match near the END of
// the scanned file. Truncation eats the tail, so a top anchor stays green while
// everything under test has vanished. Prefer the file's `module.exports` line:
// it is last by convention here, and it changes only when the module's shape
// really does change, which is a review you want anyway.
//
// ── What the comment stripper does and does not handle ──────────────────────
//
// A guard that greps RAW source is defeated by a comment in both directions: it
// reads a mention in prose as a reference (false green), and it reads a comment
// saying "X must never appear here" as an occurrence of X (false red). So
// comments come out first.
//
// Line comments are removed BEFORE block comments: a `//` line containing a `/*`
// (a comment mentioning a glob) is already gone by the time the block regex
// runs, so it cannot open a phantom block that swallows code up to the next
// terminator.
//
// Known limitation, accepted: a TRAILING `//` comment containing an unbalanced
// `/*` can still open a phantom block as far as the block regex is concerned,
// and so can a `/*` inside a string literal.
// This is a deliberately simple stripper and the anchor is what covers it —
// that is the division of labour. web/app/lib/testSource.ts has a
// character-mode scanner immune to both; it is not duplicated here on purpose,
// because a second copy in a second runtime is a parity twin that then needs its
// own drift test to stay honest.

const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const assert = require('node:assert/strict');

const ROOT = join(__dirname, '..');

/**
 * Source of `file` (relative to the stream-api package root) with comments
 * removed, having proved the read reached the end of the file.
 *
 * @param {string} file        e.g. 'supportbar.js'
 * @param {RegExp} tailAnchor  something that appears near the END of that file
 */
function scanSource(file, tailAnchor) {
  const src = readFileSync(join(ROOT, file), 'utf8')
    .split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(
    src, tailAnchor,
    `the ${file} scan lost the END of the file — the anchor ${tailAnchor} is gone, so the read ` +
    'was truncated or the module was restructured. Every NEGATIVE assertion made against this ' +
    'text is now passing vacuously. Fix the anchor only after confirming the code still exists.'
  );
  return src;
}

/**
 * `indexOf` that cannot return -1.
 *
 * An ordering assertion written on raw indexOf passes VACUOUSLY when the needle
 * is missing: `-1 < anyRealIndex` is true, so deleting the very branch being
 * ordered leaves the test green.
 */
function at(hay, needle) {
  const i = hay.indexOf(needle);
  assert.ok(i >= 0, `source scan: ${JSON.stringify(needle)} not found — the guard cannot be checked`);
  return i;
}

module.exports = { scanSource, at };
