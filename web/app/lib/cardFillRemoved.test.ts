// web/app/lib/cardFillRemoved.test.ts
// There is no card fill: the cards take the pop-ups' look. The three nudges
// are .glass; the popout is a PAGE and takes the page background. No trace of
// the setting may remain.
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/cardFillRemoved.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments, stripCssComments } from "./testSource.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(here, "..", rel), "utf8");
const NUDGES = ["components/SecureAccountPromptInner.tsx", "components/PwaInstallNudge.tsx", "components/MatrixAppsHint.tsx"];
const GONE = /--bg-surface\b|--bg-surface-2\b|bgSurface2?\b|theme_surface2?\b/;

test("the three nudges are glass, with no inline fill or shadow of their own", () => {
  for (const f of NUDGES) {
    const src = stripComments(read(f));
    assert.match(src, /className="pointer-events-auto[^"]*\bglass\b/, `${f}: .glass`);
    assert.doesNotMatch(src, /linear-gradient|boxShadow/, `${f}: .glass brings its own fill and shadow`);
    assert.match(src, /\}\s*$/, `${f}: vacuity anchor`);
  }
});

test("the popout is a page: page background", () => {
  const src = stripComments(read("components/PopoutView.tsx"));
  assert.match(src, /background:\s*"var\(--bg-page\)"/);
  assert.match(src, /\}\s*$/, "vacuity anchor");
});

// Distinctive TAILS, not a bare "}": a negative scan over a truncated read
// passes over the hole, so each file must be read to
// its real end before its absence can mean anything.
const TAILS: Record<string, RegExp> = {
  "lib/settingsRegistry.ts": /\.\/settingsMenu — the direction of the dependency is then one-way and obvious\.\s*$/,
  "lib/settingsMenu.ts": /\.filter\(\(sec\) => sec\.items\.length > 0\);\s*\}\s*$/,
  "layout.tsx": /<\/body>\s*<\/html>\s*\);\s*\}\s*$/,
};

test("every scanned file was read to its real end", () => {
  for (const [f, tail] of Object.entries(TAILS)) assert.match(read(f), tail, `${f}: vacuity anchor`);
});

test("no trace of Card fill anywhere", () => {
  for (const f of [...NUDGES, "components/PopoutView.tsx", "lib/settingsRegistry.ts", "lib/settingsMenu.ts", "layout.tsx"]) {
    assert.doesNotMatch(stripComments(read(f)), GONE, f);
  }
  const css = stripCssComments(read("globals.css"));
  assert.doesNotMatch(css, GONE, "globals.css");
  assert.ok(css.trim().endsWith("}"), "vacuity anchor: globals.css read to its end");
});
