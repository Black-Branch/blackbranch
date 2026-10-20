// @test-only test infrastructure — source-reading helpers for guard tests, not product code.
// Reading SOURCE files in tests, with the comments taken out first.
//
// A large number of tests here assert things about source code — "this guard runs
// before that one", "this handler is wired to that route" — because the invariant
// lives in a hook or a .tsx the test runner cannot execute. Every one of them has
// to strip comments first, and for a reason that is not hypothetical:
//
// A SOURCE SCAN THAT READS COMMENTS IS TESTING THE EXPLANATION, NOT THE CODE.
//
// ── Why this file is three lines ─────────────────────────────────────────────
//
// `scripts/check-orphans.mjs` is a plain node gate and cannot import a .ts file,
// and it needs the same stripper (counting references against RAW source reads
// a dead export as live when a comment names it). Rather than give the gate its
// own copy, the implementation lives in `app/lib/sourceText.mjs`, which BOTH
// worlds can import. The reasoning, the scanner's design and its one accepted
// limitation all live there.
//
// This file is the TypeScript face of it: ~60 test files import
// `./testSource.ts`.
import { readFileSync } from "node:fs";
import { stripComments as stripJs, stripCssComments as stripCss } from "./sourceText.mjs";
export { stripComments, stripCssComments, cssAtRuleBodies } from "./sourceText.mjs";


/**
 * Every `--font-*` variable the site actually serves. The Google families are self-hosted:
 * `app/fonts/google/fonts.css` (written by scripts/vendor-google-fonts.mjs) declares each one on
 * :root. The rest come from a next/font/local call in layout.tsx, which counts only when its
 * `.variable` class is on <html> — a declared face that is never spread there is not served.
 * One answer for every test that asks "does the site serve this font?", so none of them needs
 * to know where fonts are declared.
 */
export function servedFontVariables(): Set<string> {
  const app = new URL("../", import.meta.url);
  const layout = stripJs(readFileSync(new URL("layout.tsx", app), "utf8"));
  const css = stripCss(readFileSync(new URL("fonts/google/fonts.css", app), "utf8"));
  const served = new Set<string>();
  const root = /:root \{\n([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  for (const m of root.matchAll(/^\s*(--font-[\w-]+):/gm)) if (m[1]) served.add(m[1]);
  const html = /className=\{\[([\s\S]*?)\]/.exec(layout)?.[1] ?? "";
  for (const m of layout.matchAll(/const (\w+)\s*=\s*localFont\(\{\s*variable: "(--font-[\w-]+)"/g)) {
    if (m[1] && m[2] && new RegExp(`\\b${m[1]}\\.variable\\b`).test(html)) served.add(m[2]);
  }
  return served;
}
