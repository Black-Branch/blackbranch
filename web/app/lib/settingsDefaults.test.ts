// Guards the single-source-of-truth rule for setting defaults.
//
// A default written THREE times — once in DEFAULTS, once as the entry's `def:`
// field, and once as the argument to its parse helper —
//
//   bgStart: "#0c1020",                                    // DEFAULTS
//   bgStart: E({ ls: "theme_bgStart", def: "#0c1020", ...  // entry
//     parse: str("#0c1020"), ...                           // parser fallback
//
// has nothing keeping the three in agreement, and a parser argument that
// disagrees with DEFAULTS silently wins for any user whose stored value is
// missing or malformed, i.e. exactly the cold-profile case.
//
// So the parse helpers only VALIDATE (returning null for absent/invalid) and
// parseValue() substitutes DEFAULTS[key]. DEFAULTS is the only place a default
// value is written in TypeScript.
//
// The two legitimate restatements outside DEFAULTS are the layout.tsx pre-paint
// script (it runs before any module can load) and CSS var fallbacks (for a cold
// profile). check-prepaint.mjs already gates the first of those.
//
// This is a static guard because settingsRegistry.ts cannot be imported here:
// it re-exports ./settingsMenu with an extensionless specifier, which node --test
// cannot resolve.
//
// Run: node --test app/lib/settingsDefaults.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "app", "lib", "settingsRegistry.ts"), "utf8");
const ENTRIES = SRC.slice(SRC.indexOf("export const ENTRIES: Record<SettingKey, Entry> = {"));

test("no registry entry carries a `def:` field any more", () => {
  assert.doesNotMatch(ENTRIES, /\bdef:\s/,
    "an entry restates its default — DEFAULTS is the only place a default belongs");
});

test("`def` is gone from the Entry type, so it cannot come back unnoticed", () => {
  const iface = SRC.slice(SRC.indexOf("interface Entry {"), SRC.indexOf("// Parse helpers"));
  assert.doesNotMatch(iface, /\bdef:/, "the Entry type accepts a default again");
});

test("no parse helper is passed a default value", () => {
  // str/int/bool1 take no arguments at all now; flt takes only a predicate.
  assert.doesNotMatch(ENTRIES, /parse: (?:str|int|bool1)\(/,
    "a parser is being called with an argument — it should be passed bare");
  assert.doesNotMatch(ENTRIES, /parse: flt\(\s*-?[\d.]/,
    "flt() is being given a default again; it takes only a validity predicate");
});

test("the parse helpers return null rather than a default", () => {
  const helpers = SRC.slice(SRC.indexOf("// Parse helpers"), SRC.indexOf("// slider mapping factories"));
  for (const name of ["str", "flt", "int", "bool1"]) {
    assert.match(helpers, new RegExp(`const ${name} =`), `parse helper ${name} vanished`);
  }
  assert.doesNotMatch(helpers, /\(def:/, "a parse helper takes a default parameter again");
  assert.match(helpers, /SettingValue \| null/, "the helpers no longer signal absence with null");
});

test("no entry defines its parser inline", () => {
  // An inline arrow that returns a literal instead of null silently re-creates
  // the second default this whole file exists to ban, invisible to the
  // helper-call regexes above. So: no `parse: (…) =>` inside ENTRIES at all.
  // Validation logic goes in a named helper next to str/int/bool1/boolStr/
  // oneOf, where the null-on-invalid contract is reviewable.
  assert.doesNotMatch(ENTRIES, /parse:\s*\(/,
    "an entry defines its parser inline — move it to a named helper that returns null for absent/invalid");
});

test("parseValue is the ONE place a default is substituted", () => {
  // Sliced on "function parseValue", NOT "export function parseValue": it is
  // not exported (setValue() is its only caller), and a marker carrying the
  // modifier would silently slice from -1 instead.
  assert.ok(SRC.includes("function parseValue"), "premise: parseValue still exists to slice");
  const fn = SRC.slice(SRC.indexOf("function parseValue"), SRC.indexOf("export function applyEffect"));
  // The fallback goes through defaultFor(), which is DEFAULTS unless the key
  // is device-dependent (mobile shadows). The choke point is unchanged — that
  // indirection is exactly what keeps it a single point.
  assert.match(fn, /v === null \? defaultFor\(key\) : v/,
    "parseValue no longer falls back to a default — absent values would become null");
  const df = SRC.slice(SRC.indexOf("export function defaultFor"), SRC.indexOf("function parseValue"));
  assert.match(df, /DEFAULTS\[key\]/,
    "defaultFor stopped consulting DEFAULTS, so DEFAULTS is no longer the base truth");
});

test("every entry still declares a parse (no silent pass-through)", () => {
  const entryCount = (ENTRIES.match(/: E\(\{/g) ?? []).length;
  const parseCount = (ENTRIES.match(/parse: /g) ?? []).length;
  assert.ok(entryCount > 60, `only found ${entryCount} entries — re-scope this guard`);
  assert.equal(parseCount, entryCount,
    `${entryCount} entries but ${parseCount} parse fields — one lost its parser in the sweep`);
});

test("DEFAULTS is still what the Values type is derived from", () => {
  // If this stops being true, the registry keys and the defaults can drift apart
  // without the compiler noticing — which is the whole safety net here.
  assert.match(SRC, /export type Values = typeof DEFAULTS;/);
  assert.match(SRC, /export const ENTRIES: Record<SettingKey, Entry>/,
    "ENTRIES is no longer keyed by SettingKey, so a missing entry would compile");
});

// ─── the one default that lives in CSS too ───────────────────────────────────
//
// `--chat-font-size` in app/globals.css is a THIRD restatement of a default.
// Both files carry a comment saying they MUST agree, and both record why:
// SettingsHydrator applies the registry default unconditionally when the user
// has no saved size, so a disagreement is a visible font jump on every cold
// page load (0.875rem painted, then a jump to 1.352rem).
//
// Derived, not hardcoded: the expected value is recomputed from MIN_REM, MAX_REM
// and DEFAULT_REM as the registry itself defines them, so this test cannot drift
// into asserting a stale literal.

const CSS = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");

const num = (src: string, name: string): number => {
  const raw = new RegExp(`\\b${name}\\s*=\\s*([\\d.]+)`).exec(src)?.[1];
  assert.ok(raw, `${name} is gone from settingsRegistry.ts — this guard is now vacuous`);
  return Number(raw);
};

test("globals.css --chat-font-size equals the registry default's slider round-trip", () => {
  const MIN_REM = num(SRC, "MIN_REM");
  const MAX_REM = num(SRC, "MAX_REM");
  const DEFAULT_REM = num(SRC, "DEFAULT_REM");

  // The registry's own two helpers, mirrored here because settingsRegistry.ts
  // cannot be imported (see the header). If either changes shape, the assertion
  // below fails loudly rather than passing on a stale formula.
  const remToSlider = (rem: number) => Math.round(((rem - MIN_REM) / (MAX_REM - MIN_REM)) * 100);
  const sliderToRem = (val: number) =>
    (MIN_REM + (val / 100) * (MAX_REM - MIN_REM)).toFixed(3) + "rem";

  const expected = sliderToRem(remToSlider(DEFAULT_REM));

  const painted = /--chat-font-size:\s*([^;]+);/.exec(CSS)?.[1]?.trim();
  assert.ok(painted, "--chat-font-size is gone from globals.css — this guard is now vacuous");
  assert.equal(painted, expected,
    `globals.css paints --chat-font-size: ${painted} but the registry settles at ` +
    `${expected} — that difference is a visible font jump on every cold load`);
});

test("DEFAULT_REM round-trips through the slider exactly", () => {
  const MIN_REM = num(SRC, "MIN_REM");
  const MAX_REM = num(SRC, "MAX_REM");
  const DEFAULT_REM = num(SRC, "DEFAULT_REM");
  const step = Math.round(((DEFAULT_REM - MIN_REM) / (MAX_REM - MIN_REM)) * 100);
  const back = Number((MIN_REM + (step / 100) * (MAX_REM - MIN_REM)).toFixed(3));
  assert.equal(back, DEFAULT_REM,
    `DEFAULT_REM ${DEFAULT_REM} does not land on a whole slider step (round-trips to ` +
    `${back}) — the registry would disagree with itself, which is why it is 1.352 not 1.35`);
});
