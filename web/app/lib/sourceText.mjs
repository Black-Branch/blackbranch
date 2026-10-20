// @test-only / gate-only: reading SOURCE files with the comments taken out first.
//
// A SOURCE SCAN THAT READS COMMENTS IS TESTING THE EXPLANATION, NOT THE CODE.
// It fails in both directions. It passes against a migration whose CHECK
// constraint has been deleted when the comment above the table quotes the
// constraint verbatim. It fails against correct code when a comment explaining
// why `wsClear` must precede `wsPin` mentions `wsPin` 450 characters before the
// call. And it reads a dead export as live when a comment elsewhere merely
// names it.
//
// ── Why this is a .mjs and not part of testSource.ts ─────────────────────────
//
// Two consumers need it and they run in different worlds: ~60 test files import
// it as TypeScript, and `scripts/check-orphans.mjs` is a plain node script that
// cannot load a .ts file at all. A second copy for the gate is exactly the
// mistake this file exists to prevent — these scans measure POSITIONS in the
// returned string, so a subtly weaker stripper is a subtly wrong answer.
// `.mjs` is the one form both can import, so the implementation lives here and
// `app/lib/testSource.ts` re-exports it with types.

/**
 * Source with comments removed: JSX `{/* … *\/}`, block `/* … *\/`, line `//`,
 * and SQL `--`.
 *
 * A single left-to-right pass with a mode for strings ('', "", ``) and both JS
 * comment kinds — NOT a regex pipeline. A pipeline that strips block comments
 * FIRST with a blind regex lets a `/*` appearing inside a `//` line comment (a
 * comment that mentions a glob like `/timer/*`) open a phantom block that
 * swallows everything to the next `*\/` — a whole file can vanish from a scan
 * that way. The scanner can't be fooled like that: by the time a `/*` is seen,
 * it is provably not inside a line comment or a string.
 *
 * Behaviors it guarantees:
 * URLs survive by CONSTRUCTION — `"https://x"` and protocol-relative
 *   `"//cdn.example.com/x"` sit inside string mode, where `//` is data.
 * Block comments become a SPACE, not nothing, so removing one cannot weld
 *   two tokens into one that the source never contained. JSX `{/* … *\/}`
 *   needs no special case: the braces stay, the block becomes the space.
 * SQL `--` is anchored to the start of a line (whitespace aside), so it
 *   cannot eat a decrement or a subtraction: `a--b` is untouched. It runs as a
 *   final per-line pass because SQL lives in template literals here, which the
 *   scanner deliberately preserves.
 *
 * Known limitation, accepted: no regex-LITERAL mode. A regex whose source
 * text contains `/*` or `//` unescaped (e.g. a character class `[/*]`) would
 * still confuse it. That shape does not occur in this repo's source; strings
 * and comments — the cases that matter — are handled for real.
 *
 * @param {string} src
 * @returns {string}
 */
export function stripComments(src) {
  let out = "";
  let i = 0;
  /** @type {"code" | "line" | "block" | "'" | '"' | "`"} */
  let mode = "code";
  // A block opened as `{/*` withholds its `{`: if the close is `*/}` the whole
  // JSX comment (braces included) collapses to one space, else the `{` is
  // restored — same net shape as the old JSX-first regex, without its blindness.
  let jsxBrace = false;
  while (i < src.length) {
    const c = /** @type {string} */ (src[i]);
    const d = src[i + 1];
    if (mode === "code") {
      if (c === "/" && d === "/") { mode = "line"; i += 2; continue; }
      if (c === "/" && d === "*") { mode = "block"; jsxBrace = false; i += 2; continue; }
      if (c === "{" && d === "/" && src[i + 2] === "*") { mode = "block"; jsxBrace = true; i += 3; continue; }
      if (c === "'" || c === '"' || c === "`") mode = c;
      out += c; i++; continue;
    }
    if (mode === "line") {
      if (c === "\n") { mode = "code"; out += c; }
      i++; continue;
    }
    if (mode === "block") {
      if (c === "*" && d === "/") {
        mode = "code";
        if (jsxBrace && src[i + 2] === "}") { out += " "; i += 3; }
        else { out += (jsxBrace ? "{ " : " "); i += 2; }
        jsxBrace = false;
        continue;
      }
      if (c === "\n") out += c; // keep line positions stable for scans that count lines
      i++; continue;
    }
    // string modes: escapes pass through wholesale; the matching quote closes
    if (c === "\\") { out += c + (d ?? ""); i += 2; continue; }
    if (c === mode) mode = "code";
    out += c; i++; continue;
  }
  return out.replace(/^\s*--.*$/gm, "");
}

/**
 * The same job for a STYLESHEET, and deliberately not the same function.
 *
 * stripComments must never be pointed at CSS. Its final pass deletes any
 * line starting with `--` (SQL comments living inside template literals), and
 * in a stylesheet that is the shape of every custom-property declaration:
 * `  --color-surface-1: …` disappears, so a scan looking for a token finds
 * nothing and reports it missing. CSS has no `//` comment form and no string
 * modes worth tracking, so the block form is genuinely all there is to remove.
 *
 * Same space-not-nothing rule as stripComments, for the same reason: removing a
 * comment must not weld two tokens into one the source never contained.
 *
 * @param {string} src
 * @returns {string}
 */
export function stripCssComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/**
 * The BODIES of every at-rule in `css` whose prelude contains `prelude`,
 * found by brace-matching rather than by proximity.
 *
 * Why this exists. A guard written as `css.slice(css.indexOf("prefers-
 * reduced-motion"))` then `assert.match(rm, /player-fold-region[\s\S]{0,200}
 * transition:\s*none/)` proves only that two strings sit near each other:
 * replacing the whole `@media (prefers-reduced-motion: reduce) { … }` wrapper
 * with a plain `.player-fold-region.never-matches { transition: none; }`
 * leaves it green. The project constraint — reduced motion substitutes an
 * instant change for EVERY animation — needs a real guard behind it.
 *
 * Nesting is handled: a returned body may itself contain at-rules, and an
 * at-rule nested inside another is found by searching the returned body again.
 *
 * @param {string} css  stylesheet source, comments already stripped
 * @param {string} prelude  a substring of the at-rule's prelude, e.g.
 *   "@media (prefers-reduced-motion: reduce)"
 * @returns {string[]} one entry per matching at-rule, in source order
 */
export function cssAtRuleBodies(css, prelude) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = css.indexOf(prelude, from);
    if (at === -1) return out;
    const open = css.indexOf("{", at + prelude.length);
    if (open === -1) return out;
    let depth = 0;
    let i = open;
    for (; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) break;
    }
    out.push(css.slice(open + 1, i));
    from = i + 1;
  }
}
