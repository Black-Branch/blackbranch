// Controls + text standard (docs/DESIGN-STANDARD.md).
// One look for every settings-style control: selected = light fill + dark
// content, 24px controls, a 112px label column that never wraps, the unit
// inside one fixed readout field, a site slider look, one segmented Choice,
// one field style.
//
// Run: node --test app/lib/controlsStandard.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const web = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(join(web, p), "utf8");

const controls = read("app/components/SettingsControls.tsx");
const code = stripComments(controls);
const settings = stripComments(read("app/components/ChatSettings.tsx"));
const css = read("app/globals.css");

test("vacuity anchors: every file read in full", () => {
  assert.match(controls, /export function Row\b[\s\S]*\}\s*$/, "SettingsControls.tsx truncated");
  assert.match(css, /\S[\s\S]*$/);
});

test("selected is ONE rule: light fill + dark content, never the old mid-grey", () => {
  assert.doesNotMatch(code, /bg-control-strong/, "the old grey 'on' colour is back");
  assert.doesNotMatch(settings, /bg-control-strong text-black/, "ChatSettings still hand-rolls choice chips");
  const toggle = /export function Toggle[\s\S]*?\n\}\n/.exec(code)?.[0] ?? "";
  assert.match(toggle, /bg-strong/, "switch on-state is not the light fill");
  const choice = /export function Choice[\s\S]*?\n\}\n/.exec(code)?.[0] ?? "";
  assert.match(choice, /bg-strong text-on-accent/, "Choice selected option is not light fill + dark text");
});

test("controls are 24px tall and rows at least 28px", () => {
  const field = /const FIELD\s*=\s*"([^"]*)"/.exec(code)?.[1] ?? "";
  assert.match(field, /\bh-6\b/, "the shared field style is not 24px");
  assert.match(field, /bg-surface-2/);
  assert.match(field, /border-edge\b/);
  assert.match(field, /focus/);
  assert.match(code, /const ROW\s*=\s*"[^"]*min-h-7/, "rows lost their 28px floor");
});

test("labels sit in a 112px column, truncate and carry the full text as a tooltip", () => {
  const label = /const LABEL\s*=\s*"([^"]*)"/.exec(code)?.[1] ?? "";
  assert.match(label, /\bw-28\b/);
  assert.match(label, /\btruncate\b/);
  assert.match(code, /className=\{LABEL\} title=\{label\}/);
  assert.doesNotMatch(code, /w-\[76px\]/, "the old 76px label column is back");
});

test("the slider readout is one fixed-width field with the unit INSIDE it", () => {
  const num = /function EditableNum[\s\S]*?\n\}\n/.exec(code)?.[0] ?? "";
  assert.match(num, /READOUT/, "EditableNum does not use the shared readout box");
  const readout = /const READOUT\s*=\s*"([^"]*)"/.exec(code)?.[1] ?? "";
  assert.match(readout, /\bw-16\b/);
  // The unit renders inside the bordered box, after the input.
  assert.match(num, /<label className=\{READOUT[\s\S]*<input[\s\S]*\{unit && <span/);
});

test("a word readout (not a number) is a truncated, titled field — never a wrapped column", () => {
  assert.match(code, /<span className=\{`\$\{READOUT\}[^`]*`\} title=\{title \?\? display\}>\s*<span className="truncate/);
});

test("the slider uses the site look and drives its fill from the value", () => {
  assert.match(code, /type="range"[\s\S]{0,400}className="ui-range/);
  assert.match(code, /"--fill"/);
  assert.doesNotMatch(code, /accent-secondary/);
  const rule = /\.ui-range\b[\s\S]*?\n\/\* end ui-range \*\//.exec(css)?.[0] ?? "";
  for (const sel of ["::-webkit-slider-runnable-track", "::-webkit-slider-thumb", "::-moz-range-track",
    "::-moz-range-progress", "::-moz-range-thumb", ":focus-visible"]) {
    assert.ok(rule.includes(sel), `.ui-range misses ${sel}`);
  }
});

test("ChatSettings renders choice AND weights through the one Choice control", () => {
  assert.match(settings, /case "weights":[\s\S]{0,300}<Choice/);
  assert.match(settings, /case "choice":[\s\S]{0,300}<Choice/);
});

test("Choice announces its state and wraps inside its track", () => {
  const choice = /export function Choice[\s\S]*?\n\}\n/.exec(code)?.[0] ?? "";
  assert.match(choice, /aria-pressed=\{/);
  assert.match(choice, /flex-wrap/);
  assert.match(choice, /role="group" aria-label=\{label\}/);
});

test("the font picker trigger and colour field use the shared field style", () => {
  const picker = stripComments(read("app/components/FontPicker.tsx"));
  assert.match(picker, /FIELD/);
  assert.match(code, /export const FIELD/);
  const color = /export function ColorInput[\s\S]*?\n\}\n/.exec(code)?.[0] ?? "";
  assert.match(color, /FIELD/);
  assert.match(color, /type="color"[\s\S]{0,300}rounded-md[\s\S]{0,100}border-edge/);
});

test("no .ui-range element carries a utility the unlayered class would silently beat", () => {
  // check-layering does not cover height/background/cursor/appearance/opacity,
  // so this is the guard: globals.css is unlayered and wins over any Tailwind
  // utility for the same property, whatever the markup says.
  // (The owner plugin's mod Dials slider has its own copy of this guard, in its own folder.)
  const files = ["app/components/SettingsControls.tsx"];
  let seen = 0;
  for (const f of files) {
    for (const m of read(f).matchAll(/className="(ui-range[^"]*)"/g)) {
      seen++;
      assert.doesNotMatch(m[1] ?? "", /(?:^|\s)(?:[a-z-]+:)*(?:h-|bg-|cursor-|opacity-|appearance-|rounded)/, `${f}: ${m[1]}`);
    }
  }
  assert.equal(seen, 1, "expected exactly the settings Slider");
  const comment = /\.ui-range\b[\s\S]{0,40}|⚠ Unlayered[^*]*/.exec(css)?.[0] ?? "";
  assert.doesNotMatch(css, /\(check-layering\): never put/, "the comment claims check-layering guards .ui-range; it does not");
  assert.ok(comment.length > 0);
});

test("the standard is written down and linked from the engineering standard", () => {
  const doc = readFileSync(join(web, "../docs/DESIGN-STANDARD.md"), "utf8");
  for (const step of ["text-3xs", "text-2xs", "text-xs", "text-sm", "text-base", "text-chat-"]) {
    assert.ok(doc.includes(step), `DESIGN-STANDARD.md does not name ${step}`);
  }
  for (const rule of ["raw-text-size", "raw-inline-font-size", "raw-css-font-size"]) {
    assert.ok(doc.includes(rule), `DESIGN-STANDARD.md does not name the ${rule} gate`);
  }
  for (const c of ["FIELD", "Choice", "ui-range", "bg-strong"]) {
    assert.ok(doc.includes(c), `DESIGN-STANDARD.md does not name ${c}`);
  }
  assert.match(doc, /\S[\s\S]*## Spacing[\s\S]*\S\s*$/, "doc truncated or has no spacing section");
  // The engineering standard is the maintainers' (not in the public repo); where it exists it links here.
  if (existsSync(join(web, "../docs/ENGINEERING-STANDARD.md"))) {
    assert.match(readFileSync(join(web, "../docs/ENGINEERING-STANDARD.md"), "utf8"), /DESIGN-STANDARD\.md/);
  }
});

test("end anchor", () => {
  assert.match(controls, /export function Row/);
});
