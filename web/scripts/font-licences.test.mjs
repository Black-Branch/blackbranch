// Every font file the site ships travels with its licence text (OFL-1.1 condition 2, Apache-2.0
// §4(a)): the public repo and every release are copies of them. scripts/vendor-google-fonts.mjs
// writes the texts (`--licences` alone rewrites them without touching a font).
//   node --test scripts/font-licences.test.mjs   (from web/)
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fontsDir = path.join(here, "..", "app", "fonts");
const googleDir = path.join(fontsDir, "google");
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const LICENCE = /SIL OPEN FONT LICENSE\s+Version 1\.1|Apache License\s+Version 2\.0/;

/** fonts.css → each file in files/ and the family that declares it (a face's url, or its preload comment). */
function familiesByFile() {
  const css = readFileSync(path.join(googleDir, "fonts.css"), "utf8");
  const byFile = new Map();
  let family = null;
  for (const line of css.split("\n")) {
    const head = /^\/\* (.+?) — --[\w-]+ \*\/$/.exec(line);
    if (head) { family = head[1]; continue; }
    for (const m of line.matchAll(/files\/([\w.-]+\.woff2)/g)) byFile.set(m[1], family);
  }
  return byFile;
}

/** A licence file: the family's name first, then the licence text itself. */
function assertLicence(file, family) {
  assert.ok(existsSync(file), `${path.relative(fontsDir, file)} is missing (${family})`);
  const text = readFileSync(file, "utf8");
  assert.ok(text.startsWith(`${family} — `), `${path.relative(fontsDir, file)} names ${family} first`);
  assert.match(text, LICENCE, `${path.relative(fontsDir, file)} holds the licence text`);
}

test("every vendored Google font file belongs to a family whose licence text sits beside the files", () => {
  const files = readdirSync(path.join(googleDir, "files")).filter((f) => f.endsWith(".woff2"));
  assert.ok(files.length >= 100, `the font files were read (${files.length})`);
  const byFile = familiesByFile();
  const families = new Set();
  for (const f of files) {
    const family = byFile.get(f);
    assert.ok(family, `${f}: fonts.css names no family for it`);
    families.add(family);
  }
  assert.ok(families.size >= 50, `fonts.css was read (${families.size} families)`);
  for (const family of families) assertLicence(path.join(googleDir, "licenses", `${slug(family)}.txt`), family);
});

test("every font file bundled from app/fonts itself has its licence text in app/fonts/licenses", () => {
  const files = readdirSync(fontsDir).filter((f) => f.endsWith(".woff2"));
  assert.ok(files.length >= 4, `the bundled font files were read (${files.length})`);
  const texts = readdirSync(path.join(fontsDir, "licenses")).filter((f) => f.endsWith(".txt"));
  for (const f of files) {
    const own = texts.find((t) => f.startsWith(`${t.slice(0, -4)}-`));
    assert.ok(own, `${f}: no licence in app/fonts/licenses names it`);
    const family = readFileSync(path.join(fontsDir, "licenses", own), "utf8").split(" — ")[0];
    assertLicence(path.join(fontsDir, "licenses", own), family);
  }
});

test("font files sit only in the two directories the checks above read, so a new one cannot ship unchecked", () => {
  const dirs = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith(".woff2") && !dirs.includes(d)) dirs.push(d);
    }
  };
  walk(fontsDir);
  assert.deepEqual(dirs.map((d) => path.relative(fontsDir, d)).sort(), ["", "google/files"], "the font directories are the two known ones");
});

test("vacuity: this file was read to its end", () => {
  const me = readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.match(me, /\n\/\/ END: font-licences\.test\.mjs\n$/);
});

// END: font-licences.test.mjs
