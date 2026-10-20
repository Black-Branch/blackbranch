// check-tokens — the text-scale rules. The build refuses off-scale text: a
// Tailwind arbitrary px/rem size, a numeric or px/rem inline fontSize, or a
// CSS font-size literal outside the scale. em/%/var()/calc stay allowed.
// Each case runs the real script against a fixture directory.
//
// Run: node --test scripts/check-tokens.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "check-tokens.mjs");

function run(files) {
  const dir = mkdtempSync(join(tmpdir(), "tokens-"));
  try {
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), body);
    }
    const r = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
    return { code: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an arbitrary px/rem text size fails the build", () => {
  const r = run({ "a.tsx": `export const A = () => <p className="text-[13px]">x</p>;` });
  assert.equal(r.code, 1);
  assert.match(r.out, /raw-text-size/);
  const rem = run({ "a.tsx": `export const A = () => <p className="text-[0.8rem]">x</p>;` });
  assert.equal(rem.code, 1);
});

test("an em text size is relative by design and passes", () => {
  const r = run({ "a.tsx": `export const A = () => <p className="text-[0.8em]">x</p>;` });
  assert.equal(r.code, 0, r.out);
});

test("a numeric or px/rem inline fontSize fails; a token or em passes", () => {
  for (const bad of [`fontSize: 13`, `fontSize: "13px"`, `fontSize: '0.8rem'`]) {
    const r = run({ "a.tsx": `export const s = { ${bad} };` });
    assert.equal(r.code, 1, bad);
    assert.match(r.out, /raw-inline-font-size/);
  }
  for (const ok of [`fontSize: "var(--text-chat-md)"`, `fontSize: "0.85em"`, `fontSize: "calc(var(--x) * 2)"`]) {
    assert.equal(run({ "a.tsx": `export const s = { ${ok} };` }).code, 0, ok);
  }
});

test("a CSS font-size must be a scale value, var(), em, % or calc", () => {
  const bad = run({ "a.css": `.a { font-size: .8125rem; }` });
  assert.equal(bad.code, 1);
  assert.match(bad.out, /raw-css-font-size/);
  assert.equal(run({ "a.css": `.a { font-size: 13px; }` }).code, 1);
  for (const ok of [".75rem", "0.875rem", "12px", "1rem", "var(--text-xs)", "0.82em", "90%", "calc(1rem + 1px)", ".6875rem", ".625rem"]) {
    assert.equal(run({ "a.css": `.a { font-size: ${ok}; }` }).code, 0, ok);
  }
});

test("globals.css is held to the text scale too (it is exempt from the colour rules only)", () => {
  const bad = run({ "globals.css": `.a { font-size: 13px; }` });
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /raw-css-font-size/);
  // A custom property whose NAME ends in font-size is a token definition, not a use.
  assert.equal(run({ "globals.css": `:root { --chat-font-size: 1.352rem; }` }).code, 0);
  assert.equal(run({ "a.css": `.a { --x-font-size: 13px; }` }).code, 0);
});

test("the broadcast overlay and the image renderer are exempt, with reasons", () => {
  const r = run({
    "components/CreditOverlay.tsx": `export const s = { fontSize: 68 };`,
    "opengraph-image.tsx": `export const s = { fontSize: 64 };`,
  });
  assert.equal(r.code, 0, r.out);
});

test("the real tree passes", () => {
  const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
