// The currency glyph has ONE spelling, and `¢` is not it.
//
// Run: node --test --experimental-strip-types app/lib/coinSymbol.test.ts
//
// WHY THIS IS A GUARD AND NOT A CODE REVIEW. `¢` is a claim — it says the
// thing being counted is denominated in US cents — and Qorm is not: it is a
// virtual currency spent in the store, never cashed out. A balance chip
// written "34¢" makes that false claim, so the glyph is not a styling
// preference that can drift back on the next component someone writes.
//
// `¢` REMAINS CORRECT where the number really is dollars: the admin price
// prompts state the 1 Qorm = 1¢ PURCHASE peg, which is a true statement about
// money. Those files are named below. A new file needing `¢` has to be added
// here deliberately, which is the point — the question "is this number
// dollars?" gets asked once per site instead of never.
//
// Comments are stripped first, for the reason testSource.ts's header gives at
// length: a scan that reads comments tests the explanation, not the code. The
// explanation above formatCoinsShort says `¢` several times.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
import { formatCoinsShort } from "./coins.ts";
import { currencySymbol } from "./currency.ts";

const APP = join(import.meta.dirname, "..");

/** Files where `¢` is a true statement about US dollars, not a Qorm quantity.
 *  Both are admin-only prompts describing the purchase peg. */
const USD_SITES = new Set([
  "features/moderation/sections/BadgesSection.tsx",
  "features/store/StoreSpend.tsx",
]);

function sourceFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const here = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...sourceFiles(join(dir, entry.name), here));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    // Test files describe prices in prose assertions ("bought at 34¢"); they
    // render nothing, so they are not part of the surface this guards.
    if (entry.name.includes(".test.")) continue;
    out.push(here);
  }
  return out;
}

test("no product file spells a Qorm amount with `¢`", () => {
  const offenders: string[] = [];
  for (const rel of sourceFiles(APP)) {
    if (USD_SITES.has(rel)) continue;
    const src = stripComments(readFileSync(join(APP, rel), "utf8"));
    if (src.includes("¢")) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    "these render `¢`. If the number is really US dollars, add the file to USD_SITES " +
      "with a reason; otherwise use formatCoinsShort from coins.ts (the install's currency.symbol)."
  );
});

test("the allowlist is not stale — every USD site still contains a `¢`", () => {
  // A vacuity guard, following cross-package-drift.test.js: an allowlist whose
  // entries no longer apply silently widens the rule it was carved out of.
  for (const rel of USD_SITES) {
    const src = stripComments(readFileSync(join(APP, rel), "utf8"));
    assert.ok(
      src.includes("¢"),
      `${rel} is allowlisted for the USD peg but no longer renders one — drop it from USD_SITES`
    );
  }
});

test("the glyph is the install's currency.symbol — never `¢`; a fresh install's is `pts`", () => {
  // Pinned as a value, not just as a shape: the whole guard above is worthless if the glyph
  // itself is edited back to "¢". It is a setting (CURRENCY_SYMBOL); this process
  // has no build, so it reads the product default. The one-letter flush form ("1,475q", an
  // install's own) is pinned in currencyBuilt.test.ts.
  assert.equal(currencySymbol(), "pts");
  assert.notEqual(currencySymbol(), "¢");
  assert.equal(formatCoinsShort(1475), "1,475\u00a0pts", "a mark longer than one letter gets a no-break space");
});

test("formatCoinsShort groups thousands and rounds to whole points", () => {
  // Points are integral everywhere else; a balance chip showing "1474.6" would be
  // the only place in the product that implies they are not.
  assert.equal(formatCoinsShort(0), "0\u00a0pts");
  assert.equal(formatCoinsShort(1474.6), "1,475\u00a0pts");
  assert.equal(formatCoinsShort(1_000_000), "1,000,000\u00a0pts");
});
