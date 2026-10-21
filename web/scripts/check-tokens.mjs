#!/usr/bin/env node
// Guard for the design-system token layer (north-star Step 2).
//
// Every color in the app must come from a semantic role, and every chat-relative
// font size from a named step — both defined in the @theme block of
// app/globals.css. This script fails the build when a raw value reappears, so
// the design system stays an enforced LAYER rather than a convention that decays
// one hurried commit at a time.
//
// Why a build script and not an ESLint rule:
//   • it matches the precedent already in this repo (check-prepaint.mjs), and
//   • the banned values also appear inside inline style={{}} strings and
//     template literals, which a className-oriented lint rule never sees, and
//   • deploys ship a compiled build, so you cannot ship past this.
//
// MODE is "error": the sweep is complete and the tree is clean, so any raw value
// is a regression and fails the build. "warn" (report the count, exit 0) exists
// for a future migration that needs the same never-red-mid-sweep property.
//
// Run: node scripts/check-tokens.mjs   (exit 1 on violations, when MODE=error)
// Spec: the design-system step 2 plan

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const MODE = "error"; // "warn" | "error"

const here = dirname(fileURLToPath(import.meta.url));
// An optional directory argument replaces app/ — how check-tokens.test.mjs runs
// the real rules against fixtures.
const appDir = process.argv[2] ?? join(here, "../app");

// Files that legitimately contain raw values.
//   globals.css      — where the tokens are DEFINED; the raw values live here by
//                      definition, and this is the one file allowed to have them.
//   api/avatar/**    — server-rendered SVG strings, not Tailwind; the avatar
//                      fallback inlines font-family/fill into an <svg> response.
//   global-error.tsx — renders OUTSIDE the root layout when React itself has
//                      failed, so no stylesheet is guaranteed to be loaded. Its
//                      styles must be self-contained inline literals.
//   offline.html/route.ts — the service worker's offline page. Shown when the
//                      network is GONE, so it can load no stylesheet: its CSS is
//                      a self-contained <style> block. (Its font sizes are still
//                      on the text scale — that rule applies to exempt files.)
const EXEMPT_FILES = [
  "globals.css",
  "global-error.tsx",
  "offline.html/route.ts",
];
const EXEMPT_DIRS = ["api/avatar"];

// Chat-relative calc() forms that are NOT typography and must stay raw:
//   *-scale vars size avatars/icons and ride a DIFFERENT user setting;
//   the interpolated forms (${v}, _tss, _ins) are settings-driven and live in
//   the settings controls + the layout.tsx prepaint <script>, which is itself
//   guarded by check-prepaint.mjs — editing it in a token sweep would fail that
//   check by design.
const CALC_CARVE_OUTS = /--chat-(pfp|icon)-scale|\$\{|_tss|_ins/;

// ── the text scale (④ controls + text standard, docs/DESIGN-STANDARD.md) ──────
// Interface text: 10 · 11 · 12 · 14 · 16px (text-3xs/2xs/xs/sm/base), headings
// Tailwind lg–3xl, chat-relative text through var(--text-chat-*). A CSS
// font-size literal must be one of these values; em, %, var() and calc() are
// relative by design and always allowed.
const SCALE_PX = new Set([10, 11, 12, 14, 16, 18, 20, 24, 30, 36]);
const onScale = (value) => {
  const m = /^(\d*\.?\d+)(px|rem)$/.exec(value);
  if (!m) return true;
  const px = m[2] === "rem" ? parseFloat(m[1]) * 16 : parseFloat(m[1]);
  return SCALE_PX.has(px);
};

// Files exempt from ONE rule, each with its reason.
const RULE_EXEMPT = {
  "raw-inline-font-size": [
    // The OBS credit overlay is drawn on a fixed 1920×1080 broadcast canvas;
    // its sizes are canvas pixels, not interface text.
    "components/CreditOverlay.tsx",
    // Rendered to a PNG by next/og, which has no stylesheet and no tokens.
    "opengraph-image.tsx",
  ],
};

const RULES = [
  {
    id: "raw-text-size",
    // A one-off Tailwind size. em stays allowed: it is relative to its parent.
    re: /\btext-\[\d*\.?\d+(?:px|rem)\]/g,
    hint: "use a scale step: text-3xs/2xs/xs/sm/base (10/11/12/14/16px) or text-chat-xs|sm|md|lg",
  },
  {
    id: "raw-inline-font-size",
    re: /\bfontSize:\s*(?:\d|["'`]\d*\.?\d+(?:px|rem)["'`])/g,
    hint: "use var(--text-chat-*) or an em size, or a text-* class",
  },
  {
    id: "raw-css-font-size",
    // Filtered per match by onScale() below. The lookbehind skips a custom
    // property whose name ends in font-size (--chat-font-size is a definition).
    re: /(?<![-\w])font-size:\s*(\d*\.?\d+(?:px|rem))/g,
    appliesToExemptFiles: true,
    hint: "use a scale value (10/11/12/14/16px or their rem), var(), em, % or calc()",
  },
  {
    id: "raw-zinc",
    // Any Tailwind zinc utility, in any channel.
    re: /\b(?:text|bg|border|ring|divide|placeholder|from|to|via|fill|stroke|outline|caret|accent|shadow)-zinc-\d{2,3}\b/g,
    hint: "use a semantic role: text-strong/heading/body/body-dim/secondary/muted/faint, bg-surface-1..4, border-edge[-strong], text-on-accent",
  },
  {
    id: "raw-text-white",
    // The ladder's top rung. Matches inside hover:/focus:/group-hover: too.
    re: /\btext-white\b/g,
    hint: "use text-strong",
  },
  {
    id: "raw-white-alpha",
    // bg-white/[0.08], border-white/10, ring-white/25 — all spellings.
    // The channel list matches raw-zinc's ON PURPOSE: a shorter list misses
    // things like `placeholder-white/25` (failing AA in the composer) while
    // `placeholder` is covered for zinc. One list, kept identical.
    re: /\b(?:text|bg|border|ring|divide|placeholder|from|to|via|fill|stroke|outline|caret|accent|shadow)-white\/(?:\[[\d.]+\]|\d{1,3})/g,
    hint: "use bg-surface-1..4 / border-edge / border-edge-strong / text-muted",
  },
  {
    id: "raw-black-alpha",
    re: /\b(?:text|bg|border|ring|divide|placeholder|from|to|via|fill|stroke|outline|caret|accent|shadow)-black\/(?:\[[\d.]+\]|\d{1,3})/g,
    hint: "use bg-scrim / bg-scrim-heavy",
  },
  {
    id: "raw-chat-multiplier",
    // A bare numeric multiplier on the chat font size. The carve-outs above are
    // filtered per-match, not excluded from the pattern, so a geometry calc that
    // ALSO hardcodes a type multiplier still gets caught.
    re: /calc\(\s*var\(--chat-font-size[^)]*\)\s*\*\s*[\d.]+\s*\)/g,
    hint: "use var(--text-chat-xs|sm|md|lg)",
  },
  {
    id: "raw-duration",
    // A hardcoded transition length. These are the quietest kind of drift: the
    // numbers MATCHED the tokens exactly (150/200/500), so nothing looked wrong
    // — but retuning --anim-default would have moved 5 transitions and silently
    // left 14 behind, and motion timing is only coherent if it moves together.
    re: /\bduration-(?:\d+|\[[^\]]+\])/g,
    hint: "use duration-(--anim-fast|--anim-default|--anim-slow|--anim-slower)",
  },
];

// ── walk app/ ────────────────────────────────────────────────────────────────
const EXTS = /\.(tsx?|css)$/;
const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (EXTS.test(entry)) files.push(full);
  }
})(appDir);

const violations = [];
for (const file of files) {
  const rel = relative(appDir, file);
  // An exempt file is exempt from the colour/type-token rules, but not from the
  // text scale: globals.css is where the colour tokens are DEFINED, yet a
  // font-size written there is a use like any other.
  const exemptFile = EXEMPT_FILES.some((f) => rel.endsWith(f)) || EXEMPT_DIRS.some((d) => rel.startsWith(d));

  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");

  for (const rule of RULES) {
    if (exemptFile && !rule.appliesToExemptFiles) continue;
    for (const [i, line] of lines.entries()) {
      // A line-level carve-out, so an avatar-sizing calc doesn't trip the rule.
      if (rule.id === "raw-chat-multiplier" && CALC_CARVE_OUTS.test(line)) continue;
      if (RULE_EXEMPT[rule.id]?.some((f) => rel.endsWith(f))) continue;
      let found = line.match(rule.re);
      if (found && rule.id === "raw-css-font-size") {
        found = found.filter((hit) => !onScale(hit.replace(/^font-size:\s*/, "")));
      }
      if (found) {
        for (const hit of found) {
          violations.push({ file: rel, line: i + 1, rule: rule.id, hit, hint: rule.hint });
        }
      }
    }
  }
}

if (!violations.length) {
  console.log(`✓ design tokens: no raw color/type values in ${files.length} files`);
  process.exit(0);
}

// ── report ───────────────────────────────────────────────────────────────────
const byRule = new Map();
for (const v of violations) byRule.set(v.rule, (byRule.get(v.rule) ?? 0) + 1);
const byFile = new Map();
for (const v of violations) byFile.set(v.file, (byFile.get(v.file) ?? 0) + 1);

const label = MODE === "error" ? "✗" : "⚠";
console[MODE === "error" ? "error" : "log"](
  `${label} design tokens: ${violations.length} raw value(s) across ${byFile.size} file(s)`
);
for (const rule of RULES) {
  const n = byRule.get(rule.id);
  if (n) console.log(`    ${String(n).padStart(5)}  ${rule.id.padEnd(20)} → ${rule.hint}`);
}

if (MODE === "error") {
  // Only in error mode is the per-site list actionable; in warn mode it's noise
  // on every single build during the migration.
  const worst = [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.error("\n  worst files:");
  for (const [file, n] of worst) console.error(`    ${String(n).padStart(5)}  ${file}`);
  console.error("\n  → replace with the semantic role, or add a carve-out to this script WITH A REASON.\n");
  process.exit(1);
}

console.log("    (warn mode — migration in progress; flip MODE to \"error\" in batch 6)");
