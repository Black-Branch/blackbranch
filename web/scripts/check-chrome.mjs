#!/usr/bin/env node
// check-chrome — the chrome module is the ONLY place tab / bar / window chrome
// is rendered. Without a rule, tab strips multiply in as many spellings.
//
// Rules, each a fixed token — never a heuristic, so it cannot false-positive:
//   1. role="tab" / role="tablist" outside app/components/chrome/.
//   2. an import of a FILE inside app/components/chrome/ (the index is the
//      door) — including the explicit `/index` path; only the bare
//      "@/app/components/chrome" specifier is allowed.
//   3. a FLOOR, in EXACTLY two places: `min-h-*` / `minHeight` / `min-height`
//      inside app/components/chrome/, and `min-height` inside any `[data-bar…]`
//      rule in app/globals.css. A bar is EXACTLY one of the two height tokens
//      tall, because a floor is not a height: a bar that asks for `min-h-9` can
//      be beaten by an unlayered `.collapse-row > * { min-height: 0 }` and
//      render 22px (see chrome.css's own header).
//      Rule 3 is the only rule that fires INSIDE the module — and, through the
//      globals.css half, the only one that reaches a CONSUMER's stylesheet.
//      `[data-bar…]` is that half's whole scope because `Bar` has no className
//      door: the hook is the only way a consumer can reach the bar's own box.
//      A consumer's own WRAPPER around a Bar is out of scope by design — a
//      wrapper's floor is the wrapper's box, never the bar's.
//      globals.css is admitted for rule 3 ONLY. Roles and imports are not CSS
//      shapes, and the retired-class guard for globals.css lives in
//      app/lib/chromeSkins.test.ts, per-class and with its own reasons; a
//      second owner here is how one copy goes stale while the other is fixed.
//   4. the underline-tab idiom (`border-b-2`) outside app/components/chrome/.
//   5. a RETIRED chrome class reappearing anywhere: chat-tabbar, chat-tab-btn,
//      composer-shell, meta-bar, mx-panel-header, collapse-row,
//      chat-folded-ctl, modal-overlay.
//
// Comments are stripped before scanning (a symbol named in prose is not a call
// site), but NOT with one stripper: chrome.css goes through `stripCssComments`
// and everything else through `stripComments`.
// They are not interchangeable. stripComments ends with a pass that deletes
// any line starting with `--` — SQL comments living inside template literals —
// and in a stylesheet that is the shape of every custom-property declaration,
// so `--ind-x: 0px;` would vanish from this gate's view of chrome.css (and rule
// 5 would then hunt retired classes through the mutilated text). sourceText.mjs
// carries the same warning at the definition.
// globals.css goes through NEITHER: rule 3's `[data-bar…]` half is a brace
// matcher, so it tokenises comments itself and keeps the raw line numbers (see
// findBarHookFloors — `stripCssComments` collapses a multi-line comment to one
// space, which would shift every line under it by hundreds).
//
// Test files and node_modules are out of scope. The walk starts at app/ only —
// lib/ holds no UI, so it cannot render a tab, a bar or a window.
//
// Run: node scripts/check-chrome.mjs   (also runs as a build gate via check:all)

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripComments, stripCssComments } from "../app/lib/sourceText.mjs";

const WEB = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CHROME_DIR = "app/components/chrome/";
const GLOBALS_CSS = "app/globals.css";
const RETIRED = ["chat-tabbar", "chat-tab-btn", "composer-shell", "meta-bar", "mx-panel-header", "collapse-row", "chat-folded-ctl", "modal-overlay"];

const ROLE_RE = /role=["'](tablist|tab)["']/g;
const BORDER_B2_RE = /(?:^|[\s"'`])border-b-2(?:[\s"'`]|$)/;
const DIRECT_IMPORT_RE = /from\s+["'](?:@\/app\/components\/chrome\/|(?:\.\.?\/)+(?:app\/)?components\/chrome\/)([A-Za-z][\w-]*)["']/g;

function inScope(rel) {
  if (!rel.startsWith("app/")) return false;
  if (rel.includes("node_modules/")) return false;
  if (/\.test\.(ts|tsx|mjs)$/.test(rel)) return false;
  // Two stylesheets are in scope, both for rule 3 and for different halves of
  // it: chrome.css because the module's own heights are half CSS, and
  // globals.css because `[data-bar…]` is the only door a consumer has onto a
  // bar's box (see rule 3 — globals.css gets rule 3 and nothing else).
  return /\.(ts|tsx)$/.test(rel) || rel === `${CHROME_DIR}chrome.css` || rel === GLOBALS_CSS;
}

// A retired name may itself carry regex-special characters someday (it's a
// free-text list, not a fixed pattern) — escape it before it becomes one.
function escapeToken(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const BAR_HOOK = "[data-bar";
const FLOOR_DECL = "min-height";

/**
 * Rule 3's globals.css half: `min-height` inside any `[data-bar…]` rule.
 *
 * Brace-matched, not line-matched, and that is the whole point. A selector list
 * can sit lines above its declarations (`[data-bar="mx-header"],\n.pin-row {`),
 * and a consumer reaching for a mobile floor writes it inside a `@media` block,
 * where the enclosing prelude carries no hook at all. Both shapes are invisible
 * to a per-line regex.
 *
 * The walk keeps a STACK of preludes — everything since the last `{`, `}` or
 * `;` — and reports each `min-height` whose enclosing rules include one whose
 * selector carries `[data-bar`. Reporting per declaration rather than per rule
 * is what makes the finding land on the offending LINE, and it is also what
 * keeps a hook nested inside a hook from reporting the same line twice.
 *
 * It takes the RAW stylesheet and skips comments and strings ITSELF, rather
 * than being handed `stripCssComments` output like every line-based rule here.
 * Two reasons, and both bite:
 *   · LINE NUMBERS. `stripCssComments` replaces a comment with ONE SPACE, so a
 *     multi-line comment collapses and every line after it shifts. Pointed at
 *     globals.css — 1400 lines, comments in most of them — it would report a
 *     rule at line 708 that lives at 1383. A finding that names the wrong line
 *     sends a reader hunting through a file the gate has already read.
 *   · BRACE DEPTH. This is a brace matcher, so a `{` or `}` inside prose — or
 *     inside `content: "}"` — would corrupt the stack and silently move the
 *     scope of every rule after it. A parser that matches braces has to
 *     tokenise comments and strings whether or not anything stripped them.
 * Prose still cannot count as a rule: the comment is skipped, so its text
 * reaches neither a prelude nor a declaration.
 *
 * @param {string} rel  path, for the finding
 * @param {string} raw  the stylesheet as written — NOT comment-stripped
 */
function findBarHookFloors(rel, raw) {
  const out = [];
  // The enclosing rules' preludes, outermost first. ACCUMULATED rather than
  // sliced out of `raw`, so a comment can be dropped from the middle of a
  // selector without cutting the selector in two.
  const stack = [];
  let prelude = "";
  let line = 1;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "/" && raw[i + 1] === "*") {
      const end = raw.indexOf("*/", i + 2);
      const stop = end === -1 ? raw.length : end + 2;
      for (let j = i; j < stop; j++) if (raw[j] === "\n") line += 1;
      // A comment contributes NOTHING to the prelude — a selector quoted in a
      // note is prose, not a rule — but it must not TRUNCATE one either:
      // `[data-bar="x"] /* why */ { … }` is one rule, and dropping the text
      // before the comment would lose the hook and let the floor through.
      i = stop - 1;
      continue;
    }
    if (ch === "\n") { line += 1; prelude += " "; continue; }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < raw.length && raw[j] !== ch) {
        if (raw[j] === "\\") { if (raw[j + 1] === "\n") line += 1; j += 1; }
        else if (raw[j] === "\n") line += 1;
        j += 1;
      }
      prelude += raw.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === "{") { stack.push(prelude); prelude = ""; continue; }
    if (ch === "}") { stack.pop(); prelude = ""; continue; }
    if (ch === ";") { prelude = ""; continue; }
    if (raw.startsWith(FLOOR_DECL, i)) {
      if (stack.some((p) => p.includes(BAR_HOOK))) {
        out.push({
          path: rel,
          line,
          message: `a floor (\`${FLOOR_DECL}\`) on a Bar consumer hook \`${BAR_HOOK}…]\` in globals.css — a Bar is exactly its token tall`,
        });
      }
      prelude += FLOOR_DECL;
      i += FLOOR_DECL.length - 1;
      continue;
    }
    prelude += ch;
  }
  return out;
}

/** files: { "<rel path>": "<source>" } → sorted findings "<path>:<line>: <reason>" */
export function findChromeViolations(files, { retired = RETIRED } = {}) {
  const found = [];
  for (const [rel, raw] of Object.entries(files)) {
    if (!inScope(rel)) continue;
    // globals.css is a CONSUMER's stylesheet: rule 3's `[data-bar…]` half, and
    // nothing else. Rules 1 and 2 have no CSS shape, and rule 5's guard for
    // this file already lives — per class, with its reasons — in
    // app/lib/chromeSkins.test.ts. It is handed the RAW text on purpose: the
    // brace matcher tokenises comments itself, which is the only way the line
    // it reports is the line a reader will find (see findBarHookFloors).
    if (rel === GLOBALS_CSS) {
      found.push(...findBarHookFloors(rel, raw));
      continue;
    }
    // CSS is stripped AS CSS. stripComments' final pass deletes any line
    // starting with `--`, which in a stylesheet is every custom-property
    // declaration (sourceText.mjs says so too) — pointed at chrome.css it
    // would silently delete `--ind-x: 0px;` and anything sharing that line.
    const src = /\.css$/.test(rel) ? stripCssComments(raw) : stripComments(raw);
    const lines = src.split("\n");
    const inside = rel.startsWith(CHROME_DIR);
    lines.forEach((line, i) => {
      const n = i + 1;
      if (!inside) {
        for (const m of line.matchAll(ROLE_RE)) {
          found.push({
            path: rel,
            line: n,
            message: `role="${m[1]}" outside ${CHROME_DIR} — render Sections / Segmented / Chips / Rail from "@/app/components/chrome"`,
          });
        }
        if (BORDER_B2_RE.test(line)) {
          found.push({
            path: rel,
            line: n,
            message: 'the underline-tab idiom (`border-b-2`) — render Sections from "@/app/components/chrome"',
          });
        }
      }
      if (inside) {
        const isCss = /\.css$/.test(rel);
        if (isCss ? /min-height/.test(line) : /(?:^|[\s"'`])min-h-|minHeight/.test(line)) {
          found.push({
            path: rel,
            line: n,
            message: `a floor (\`${isCss ? "min-height" : "min-h-* / minHeight"}\`) inside ${CHROME_DIR} — a Bar is exactly its token tall`,
          });
        }
      }
      for (const m of line.matchAll(DIRECT_IMPORT_RE)) {
        if (inside) continue;
        found.push({
          path: rel,
          line: n,
          message: `imports ${CHROME_DIR}${m[1]} directly — import "@/app/components/chrome" (the index) instead`,
        });
      }
      for (const cls of retired) {
        const token = escapeToken(cls);
        if (new RegExp(`(?:^|[\\s"'\`])${token}(?:[\\s"'\`]|$)`).test(line)) {
          found.push({
            path: rel,
            line: n,
            message: `retired chrome class \`${cls}\` — its surface is a Bar / Window now`,
          });
        }
      }
    });
  }
  // Numeric by line within each file — a string sort would put line 10 before
  // line 2 (lexicographic: "1" < "2").
  found.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  return found.map((f) => `${f.path}:${f.line}: ${f.message}`);
}

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

function main() {
  const files = {};
  for (const p of walk(join(WEB, "app"))) {
    const rel = relative(WEB, p);
    if (inScope(rel)) files[rel] = readFileSync(p, "utf8");
  }
  const findings = findChromeViolations(files);
  if (findings.length) {
    console.error(`check-chrome: ${findings.length} violation(s)\n`);
    for (const f of findings) console.error("  " + f);
    console.error("\n  → tab chrome is rendered by app/components/chrome only; consumers pass { items, value, onChange, label }.");
    process.exit(1);
  }
  console.log(`check-chrome: OK — ${Object.keys(files).length} files, chrome rendered only inside ${CHROME_DIR}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
