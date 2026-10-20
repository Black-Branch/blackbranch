#!/usr/bin/env node
// check-layering — guards the repo's oldest silent-failure class.
//
// globals.css is entirely unlayered (no @layer anywhere in it), while every
// Tailwind utility lives in a cascade layer. Cascade layers outrank specificity:
// an UNLAYERED rule beats a LAYERED one for the same property no matter how the
// selectors compare. So the moment an element carries both a globals.css class
// and a Tailwind utility touching the same property, the utility is dead — and
// it fails silently, because the markup still says exactly what the author
// intended.
//
// The shapes this has taken: a bar's position/z-index beating the overlay's
// utilities; a row-collapse utility's display:grid beating `hidden` on a tab
// bar wrapper; a `transition` shorthand beating `transition-transform`, so a
// reveal snaps instead of sliding.
//
// With ~35 unlayered classes that set these properties, and both files still
// growing, the pattern needs a gate rather than another round of archaeology.
//
// WHAT COUNTS AS DELIBERATE
// A globals.css declaration marked `!important` is an intentional override —
// that IS the mechanism behind the settings toggles (hide the send button, hide
// avatars, fold the tab bar), and the Tailwind utility beside it is just
// describing the on-state. Those are not reported. Anything else needs a line
// in ALLOW below, with a reason.
//
// Run: node scripts/check-layering.mjs   (also runs as a build gate)

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const APP = join(WEB, "app");

// Property families where "the unlayered rule wins" is a visible bug rather
// than a cosmetic tie. Each maps to the Tailwind utilities that set it.
const FAMILIES = {
  display: /^(hidden|block|inline|inline-block|flex|inline-flex|grid|inline-grid|contents|table|flow-root|list-item)$/,
  position: /^(static|fixed|absolute|relative|sticky)$/,
  "z-index": /^-?z-(\[.+\]|\(.+\)|\d+|auto)$/,
  visibility: /^(visible|invisible|collapse)$/,
  overflow: /^overflow(-[xy])?-(auto|hidden|clip|visible|scroll)$/,
  transform: /^-?(translate|rotate|scale|skew|transform)(-.+)?$/,
  // The `transition` shorthand sets all four longhands at once, so it collides
  // with any of their utilities. The longhands are tracked SEPARATELY because
  // that distinction is load-bearing: the Bar rules in chrome.css declare
  // property, duration and timing-function and leave transition-delay to the
  // reveal rule alone. Folding the longhands into the shorthand's entry would
  // report that as a collision; omitting them entirely lets a longhand
  // silently beat a utility, the exact bug the gate exists for.
  transition: /^(transition(-.+)?|duration-.+|ease-.+|delay-.+)$/,
  "transition-property": /^transition(-.+)?$/,
  "transition-duration": /^duration-.+$/,
  "transition-timing-function": /^ease-.+$/,
  "transition-delay": /^delay-.+$/,
  // `.glass` declares box-shadow, so `shadow-xl`/`shadow-2xl` beside it never
  // render. (ring-* and inset-shadow-* compose through the same box-shadow
  // declaration in Tailwind 4, so they lose to an unlayered box-shadow the same
  // way.)
  // Only the utilities that DECLARE box-shadow: a size, a width, `none`, or an
  // arbitrary value. Colour-only ones (`shadow-black/50`, `ring-blue-400/50`)
  // and `ring-offset-*` set custom properties and cannot lose this way.
  "box-shadow": /^(shadow|inset-shadow|ring|inset-ring)(-(2xs|xs|sm|md|lg|xl|2xl|none|\d+|\[.+\]|\(.+\)))?$/,
};

// Verified-safe combinations: file → class → FAMILY → reason. Keyed on the
// family too, not just the class — a class-only entry silences every family
// that class happens to touch, including ones the entry's reason says
// nothing about. `.bb-video-col` is exactly that trap: it sets
// `position`/`z-index` (the phone-block base rule) and `transform` too, and a
// class-scoped entry written to justify only its `transition` collision would
// silently disarm those other three — including the guard globals.css's own
// `position` comment (a few lines above this file's phone block) explicitly
// promises still exists.
//
// Keep this list short and make every entry say why it is safe. An allow-list
// entry is a deferral with a name on it, and a "known, tracked" entry can hide
// a real bug — pay entries off rather than renewing them.
//
// The entry below is different in kind: it is not a deferral, it is a proof
// this static tool cannot see. `.bb-video-col`'s `transition` (the keyboard
// ramp, globals.css phone block, `[data-kb-ramp="anim"]`) and this file's
// `transition-[flex,width,opacity]` (the panel-resize snap) genuinely never
// apply to the element at the same time — the ramp's TRANSITION only arms at
// `data-kb-ramp="anim"`, and StreamView sets that value from the same
// `snapping` boolean that gates the utility below, so one is always absent
// exactly when the other is present. The tool only reads className/globals.css
// text, so it cannot see that JS-level correlation — hence the entry, scoped
// to exactly the family it proves safe, not a fix to the CSS.
const ALLOW = {
  "app/components/StreamView.tsx": {
    "bb-video-col": {
      transition: "data-kb-ramp (the keyboard ramp) only arms the TRANSITION at value \"anim\", and StreamView " +
        "sets that from the same `snapping` boolean that gates transition-[flex,width,opacity] on this " +
        "element, so the ramp's unlayered transition and the snap's utility are mutually exclusive by " +
        "construction, never simultaneously present to collide. See StreamView.tsx's data-kb-ramp " +
        "comment. Scoped to `transition` only — `.bb-video-col` also sets position/z-index/transform " +
        "unlayered and none of those are proven safe by this reasoning.",
    },
  },
};

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.tsx$/.test(e)) yield p;
  }
}

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

// The classes a rule actually styles are the ones in its SUBJECT — the last
// compound selector. `.player-radio .player-area { display: flex }` styles
// .player-area, not .player-radio, and `.no-scrollbar::-webkit-scrollbar
// { display: none }` styles a scrollbar box that no utility can reach. Reading
// every class in the selector instead is what makes a naive sweep cry wolf.
function subjectClasses(selectorList) {
  const out = new Set();
  for (const one of selectorList.split(",")) {
    // Drop :not(...) args — those classes are EXCLUDED by the rule, not styled.
    const sel = one.replace(/:not\([^)]*\)/g, "");
    let depth = 0, last = "";
    for (const ch of sel.trim()) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      if (depth === 0 && /[\s>+~]/.test(ch)) last = "";
      else last += ch;
    }
    if (last.includes("::")) continue; // pseudo-element box, not the element's own
    for (const m of last.matchAll(/\.([a-zA-Z][\w-]*)/g)) out.add(m[1]);
  }
  return out;
}

// ── 1. globals.css → which classes set which families, and with !important? ──
function readGlobals() {
  const css = stripComments(readFileSync(join(APP, "globals.css"), "utf8"));
  const classes = new Map(); // class → Map(family → {important, selectors:Set})
  const stack = [];
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === "{") {
      stack.push(css.slice(start, i).trim());
      start = i + 1;
    } else if (ch === "}") {
      const body = css.slice(start, i).split("{")[0];
      const sel = stack.pop() ?? "";
      start = i + 1;
      if (!sel || sel.startsWith("@")) continue;
      for (const family of Object.keys(FAMILIES)) {
        const decl = body.match(new RegExp(`(?:^|[;{\\s])${family}\\s*:([^;}]*)`));
        if (!decl) continue;
        const important = /!important/.test(decl[1]);
        for (const cls of subjectClasses(sel)) {
          if (!classes.has(cls)) classes.set(cls, new Map());
          const fam = classes.get(cls);
          const prev = fam.get(family);
          // A class is "deliberate" for a family only if EVERY rule that sets it
          // says !important — one plain declaration is enough to lose silently.
          fam.set(family, {
            important: prev ? prev.important && important : important,
            selectors: new Set([...(prev?.selectors ?? []), sel]),
          });
        }
      }
    } else if (ch === ";" && stack.length === 0) {
      start = i + 1;
    }
  }
  return classes;
}

// ── 2. every className attribute, as ONE element's worth of classes ──
// Extracting the whole attribute value (string, or brace-matched expression) is
// what keeps this honest: a context window of nearby lines picks up comments and
// CHILD elements, which is most of what a naive sweep reports.
function classNameExpressions(src) {
  const out = [];
  const re = /className\s*=\s*/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    const q = src[i];
    if (q === '"' || q === "'") {
      const end = src.indexOf(q, i + 1);
      if (end === -1) continue;
      out.push({ text: src.slice(i + 1, end), at: i });
    } else if (q === "{") {
      let depth = 0;
      for (let j = i; j < src.length; j++) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}" && --depth === 0) {
          out.push({ text: src.slice(i + 1, j), at: i });
          i = j;
          break;
        }
      }
    }
    re.lastIndex = i;
  }
  return out;
}

// Class tokens live in the literal parts of the expression. Interpolations
// (${...}) are kept, since a conditional branch still lands on this element,
// but nested quoted strings that are not class lists (titles, aria labels) are
// not reachable from a className expression, so everything here is fair game.
const tokensOf = (expr) =>
  stripComments(expr)
    .split(/[`"'${}()?:,\n]+/)
    .flatMap((chunk) => chunk.trim().split(/\s+/))
    .filter(Boolean);

const lineOf = (src, index) => src.slice(0, index).split("\n").length;

const globals = readGlobals();
const findings = [];

for (const file of walk(APP)) {
  const rel = relative(WEB, file);
  const src = readFileSync(file, "utf8");
  for (const expr of classNameExpressions(src)) {
    const tokens = tokensOf(expr.text);
    const present = tokens.filter((t) => globals.has(t));
    if (!present.length) continue;
    // Tailwind utilities may carry variant prefixes (md:, hover:, group-*:) —
    // the variant changes WHEN it applies, not whether the layer beats it.
    const bare = tokens.map((t) => t.replace(/^.*:/, "").replace(/^!/, ""));
    for (const cls of new Set(present)) {
      for (const [family, info] of globals.get(cls)) {
        if (info.important) continue; // deliberate override mechanism
        const util = bare.find((t) => t !== cls && FAMILIES[family].test(t));
        if (!util) continue;
        const why = ALLOW[rel]?.[cls]?.[family];
        if (why) continue;
        findings.push({
          rel,
          line: lineOf(src, expr.at),
          cls,
          family,
          util,
          selectors: [...info.selectors].join(", "),
        });
      }
    }
  }
}

const dangerCount = [...globals.values()].filter((f) => [...f.values()].some((i) => !i.important)).length;

if (findings.length) {
  console.error("check-layering: unlayered globals.css classes are silently beating Tailwind utilities\n");
  for (const f of findings) {
    console.error(`  ${f.rel}:${f.line}`);
    console.error(`    .${f.cls} sets ${f.family} (${f.selectors}) — unlayered, so it beats \`${f.util}\` on the same element`);
    console.error(`    fix: drop the utility, scope the globals rule away from this form, or allowlist it with a reason\n`);
  }
  console.error(`${findings.length} collision(s). globals.css has ${dangerCount} unlayered classes touching these properties.`);
  process.exit(1);
}

console.log(`check-layering: OK — no unlayered/Tailwind collisions (${dangerCount} unlayered classes checked across these properties)`);
