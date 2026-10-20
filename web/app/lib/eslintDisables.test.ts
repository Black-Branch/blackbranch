// Every inline lint suppression in web/ must say why it is there.
//
// Run: node --test --experimental-strip-types app/lib/eslintDisables.test.ts
//
// THE FAILURE THIS EXISTS FOR. Suppressions accumulate into an
// undocumented policy: a rule can be suppressed at many sites inline while
// left unsuppressed at others, a policy that exists unwritten and inconsistent
// with nobody having decided it — and a reason written in prose can simply be
// untrue (a closure said to capture "state setters only" that captures state).
//
// A reason written in prose ABOVE the directive is not the same thing as a
// reason attached TO it. The prose drifts: a docblock grows, someone inserts a
// line, and the explanation now sits above a different statement while still
// reading as deliberate (a real `@test-only` tag can end up outside
// check-orphans' window — enforced-looking and completely inert). ESLint's own
// `-- description` syntax cannot separate from its directive, so that is the
// form this test requires.
//
// THIS SCAN MUST READ RAW SOURCE. It is the exact inverse of check-orphans,
// which strips comments before counting references: there, a comment is not a
// call site; here, the comment IS the thing under test. Do not "fix" this by
// reaching for stripComments.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const APP = join(import.meta.dirname, "..");

// Built at runtime rather than written out, so this file's own prose above does
// not read as a suppression to its own scanner. THIS_FILE covers the regexes
// themselves, which cannot be spelled any other way.
const D = "eslint" + "-disable";
const THIS_FILE = "eslintDisables.test.ts";

/** A suppression, in any of the three spellings ESLint accepts. `-enable` is
 *  deliberately not one: it withdraws a suppression rather than making one. */
const DIRECTIVE = new RegExp(`(?://|/\\*)\\s*${D}(?:-next-line|-line)?\\b([^\\n]*)`);

/** ESLint's own description syntax: everything after a ` -- ` separator. */
const DESCRIPTION = /\s--\s*(.+)/;

/** Reasons this short are a gesture, not a reason — same bar as the ≥8-char
 *  `@test-only`/`@parked` tags check-orphans enforces, a little higher because
 *  a suppression hides a rule that was written to catch something. */
const MIN_REASON = 12;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

type Site = { file: string; line: number; text: string; rest: string };

function findDirectives(): Site[] {
  const out: Site[] = [];
  for (const file of walk(APP)) {
    if (basename(file) === THIS_FILE) continue;
    readFileSync(file, "utf8").split("\n").forEach((text, i) => {
      const m = DIRECTIVE.exec(text);
      if (m) out.push({ file: file.slice(APP.length + 1), line: i + 1, text, rest: m[1] ?? "" });
    });
  }
  return out;
}

test("the scanner recognises all three spellings, and ignores -enable", () => {
  // Positive anchor. The assertion below is a NEGATIVE one ("none of them
  // lacks a reason"), which goes green over an empty scan or a regex that
  // stopped matching — so the regex is pinned against known input first.
  const yes = [`// ${D}-next-line some/rule -- why`, `}, [x]); // ${D}-line a/b -- why`, `/* ${D} a/b -- why */`];
  for (const s of yes) assert.match(s, DIRECTIVE, `should be read as a suppression: ${s}`);
  assert.doesNotMatch(`/* eslint-enable a/b */`, DIRECTIVE, "-enable withdraws a suppression, it does not make one");
});

test("every inline suppression carries a reason ATTACHED to the directive", () => {
  const sites = findDirectives();

  // The other half of the vacuity anchor: a walk that returned nothing, or one
  // that stopped seeing .tsx files, would satisfy the loop below perfectly.
  assert.ok(sites.length >= 15,
    `only ${sites.length} suppressions found — the walk is broken, not the codebase clean`);

  const bare = sites.filter((s) => {
    const d = DESCRIPTION.exec(s.rest);
    return !d || (d[1] ?? "").trim().length < MIN_REASON;
  });

  assert.deepEqual(bare.map((s) => `${s.file}:${s.line}`), [],
    `these suppressions state no reason (add ' -- why' to the directive itself, ` +
    `or fix the code — there is no third disposition):\n` +
    bare.map((s) => `  ${s.file}:${s.line}  ${s.text.trim()}`).join("\n"));
});
