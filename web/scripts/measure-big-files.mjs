#!/usr/bin/env node
//
// Print the largest non-test source files under web/app and web/lib.
//
// WHY THIS EXISTS. A hand-written "biggest files" list goes stale in BOTH
// directions — listing files long since decomposed, omitting ones that grew,
// understating others. A measurement written by hand into prose has no way to
// notice the code moving, so cite this script instead of restating numbers;
// the numbers are computed on demand.
//
// Deliberately NOT a build gate. File size is not a violation — a split should
// follow the seams a design actually needs, so a threshold here would nag
// about files that are fine and imply a fix that is not wanted yet. This just
// answers "what is biggest right now", accurately.
//
// Usage:  node scripts/measure-big-files.mjs [N]        # default 15
//         node scripts/measure-big-files.mjs 10 --md    # markdown table

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const WEB = process.cwd().endsWith("/web") ? process.cwd() : join(process.cwd(), "web");
const ROOTS = ["app", "lib"];
const SKIP = new Set(["node_modules", ".next", ".git"]);

/** Source files that count: .ts/.tsx, excluding tests. */
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = ROOTS.flatMap((r) => {
  try { return statSync(join(WEB, r)).isDirectory() ? walk(join(WEB, r)) : []; }
  catch { return []; }
});

if (files.length === 0) {
  console.error("measure-big-files: found no source files — run from the repo root or web/");
  process.exit(1);
}

const args = process.argv.slice(2);
const md = args.includes("--md");
const n = Number(args.find((a) => /^\d+$/.test(a))) || 15;

const rows = files
  .map((f) => ({
    path: relative(WEB, f),
    lines: readFileSync(f, "utf8").split("\n").length,
  }))
  .sort((a, b) => b.lines - a.lines)
  .slice(0, n);

const stamp = new Date().toISOString().slice(0, 10);

if (md) {
  console.log(`<!-- generated ${stamp} by web/scripts/measure-big-files.mjs -- do not hand-edit -->`);
  console.log("| Lines | File |");
  console.log("|---:|---|");
  for (const r of rows) console.log(`| ${r.lines} | \`${r.path}\` |`);
} else {
  console.log(`Largest ${rows.length} non-test source files under web/{app,lib} — ${stamp}`);
  console.log(`(total counted: ${files.length} files)\n`);
  for (const r of rows) console.log(`${String(r.lines).padStart(5)}  ${r.path}`);
}
