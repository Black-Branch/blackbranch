// No symbol-only buttons without a name, and a bypass link for the keyboard.
//
// A button whose entire content is "✕" or "←" has NO accessible name — a SR
// announces "button", full stop (close/back glyphs in the community panels,
// the reply banner, the spend chip). This is a SWEEP test, not a site list: it
// re-runs the scan, so the next nameless glyph button fails the suite without
// anyone remembering the existing ones.
//
// Scanner honesty: a button whose children contain a JSX expression is SKIPPED
// (its name may live inside the expression — this scan proves the certain
// cases, not all cases), and `title=` counts as a name because the accname
// algorithm falls back to it. Both tolerances make the assertion NARROWER,
// never vacuous — the zero it asserts is over literal, provably nameless
// buttons only.
//
// Run: node --test app/lib/iconButtonNames.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) tsxFiles(p, out);
    else if (p.endsWith(".tsx") && !p.includes(".test.")) out.push(p);
  }
  return out;
}

test("every symbol-only button carries an accessible name", () => {
  const files = tsxFiles(join(webRoot, "app"));
  assert.ok(files.length > 100, `only ${files.length} .tsx files found — the walk is broken`);
  const nameless: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const re = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
    for (let m; (m = re.exec(src)); ) {
      const [, props, inner] = m;
      if (/aria-label|aria-labelledby|title=/.test(props!)) continue;
      if (inner!.includes("{")) continue; // name may live in the expression
      const text = inner!.replace(/<[^>]*>/g, " ").trim();
      if (text === "" || /[\p{L}\p{N}]/u.test(text)) continue; // empty or has real text
      const line = src.slice(0, m.index).split("\n").length;
      nameless.push(`${relative(webRoot, f)}:${line} [${text}]`);
    }
  }
  assert.deepEqual(nameless, [],
    `symbol-only buttons with no accessible name — a SR announces each as just "button":\n` +
    nameless.join("\n"));
});

test("the main layout offers a bypass link to its landmark", () => {
  const src = readFileSync(join(webRoot, "app/(main)/layout.tsx"), "utf8");
  assert.match(src, /<main id="main-content"/, "the skip link's target id is gone from <main>");
  assert.match(src, /href="#main-content"/, "the skip link is gone");
  assert.match(src, /sr-only focus:not-sr-only/,
    "the skip link must be invisible until keyboard-focused — always-visible it is chrome, " +
    "never rendered it is a no-op");
});
