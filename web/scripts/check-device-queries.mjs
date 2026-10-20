#!/usr/bin/env node
// Device-query guard — one spelling per question.
//
// Four legitimate device questions all share the word "mobile", and nothing
// else checks which one a call site means:
//   • "(max-width: 767px)"                          — room for two columns?
//   • "(pointer: coarse) and (max-width: 1024px)"   — paint budget / settings scope
//   • "(pointer: coarse)"                           — does touch exist?
//   • "(pointer: coarse) and (hover: none)"         — is touch PRIMARY?
// The middle two disagree between 768px and 1024px on a coarse pointer, so the
// wrong one gives a tablet mobile paint defaults inside a desktop layout. Both
// answers are correct for their own question; picking the wrong one is the bug.
//
// Two rules:
//   1. No file under app/ may spell a device media query by hand. The four
//      canonical strings live in app/lib/deviceQueries.ts and nowhere else.
//   2. The pre-paint in layout.tsx and the phone rule in globals.css CANNOT
//      import (one is a stringified inline script, the other is CSS), so their
//      literals are checked to match the canonical constant character for
//      character instead. Same pattern panelShadow.test.ts uses.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const HOME = "app/lib/deviceQueries.ts";

// Rule 1 exemptions, each for a stated reason — never "it was noisy".
const EXEMPT = new Map([
  [HOME, "the canonical home of the four literals"],
  ["app/layout.tsx", "stringified inline pre-paint; cannot import — covered by rule 2"],
]);
// No exemption here is permanent by default. A diagnostic module exempted from
// this gate can outlive its purpose and ship to every page load with no gate
// saying so: check-orphans fails only on a symbol with ZERO referencers. An
// exemption list is the other place dead code hides, because a name in it
// reads as deliberate forever. When a diagnostic is added, write its removal
// condition down with it.

const src = readFileSync(join(ROOT, HOME), "utf8");
const pick = (name) => {
  const m = src.match(new RegExp(`export const ${name} = "([^"]+)"`));
  if (!m) {
    console.error(`check-device-queries: cannot find ${name} in ${HOME}.`);
    console.error("The guard is now vacuous — fix the extraction, do not delete the check.");
    process.exit(2);
  }
  return m[1];
};
const Q_DEVICE_MOBILE = pick("Q_DEVICE_MOBILE");

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !p.includes(".test.")) out.push(p);
  }
  return out;
}

// A hand-spelled device query: any matchMedia call mentioning pointer/hover, or
// any max-width at one of our two breakpoints.
const RAW = /matchMedia\??\.?\(\s*[`"'][^`"']*(?:pointer:|hover:)[^`"']*[`"']|max-width:\s*(?:767|1024)px/;

let bad = 0;
for (const abs of walk(join(ROOT, "app"))) {
  const rel = abs.replace(ROOT + "/", "");
  if (EXEMPT.has(rel)) continue;
  readFileSync(abs, "utf8").split("\n").forEach((line, i) => {
    if (RAW.test(line)) {
      console.error(`${rel}:${i + 1}  hand-spelled device query — import it from ${HOME}`);
      console.error(`    ${line.trim()}`);
      bad++;
    }
  });
}

// Rule 2: the literals that cannot import must still agree.
const layout = readFileSync(join(ROOT, "app", "layout.tsx"), "utf8");
const occurrences = layout.split(Q_DEVICE_MOBILE).length - 1;
// One copy per device-dependent default the pre-paint mirrors (MOBILE_DEFAULTS
// in settingsRegistry.ts): shadowOn and glassOn.
if (occurrences !== 2) {
  console.error(`layout.tsx pre-paint: expected 2 copies of the canonical device query, found ${occurrences}.`);
  console.error(`Canonical: ${Q_DEVICE_MOBILE}`);
  console.error("The pre-paint cannot import, so a drifted literal here silently changes phone defaults.");
  bad++;
}

const css = readFileSync(join(ROOT, "app", "globals.css"), "utf8");
if (!css.includes(`@media ${Q_DEVICE_MOBILE}`)) {
  console.error(`globals.css: no '@media ${Q_DEVICE_MOBILE}' rule — the phone paint rules have drifted from deviceClass().`);
  bad++;
}

if (bad) {
  console.error(`\ncheck-device-queries: ${bad} violation(s).`);
  process.exit(1);
}
console.log("check-device-queries: ok");
