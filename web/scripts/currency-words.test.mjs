// The operator scripts print amounts in THIS install's currency word (currency.ts, from the
// install's CURRENCY_* values), never one install's own currency name written into a string.
// Run: node --test scripts/currency-words.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

for (const file of ["provenance-report.ts", "set-e.ts"]) {
  test(`${file}: no currency name written into what it prints`, () => {
    const src = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    const printed = src.split("\n").filter((l) => /console\.(log|error|warn)\(|^\s*\+ ?[`"']/.test(l));
    assert.ok(printed.length >= 2, `vacuity: ${file} prints`);
    for (const l of printed) assert.doesNotMatch(l, /\bqorm/i, l.trim());
    assert.match(src, /currencyName\(/, "it names the currency through the install's own word");
    assert.match(src, /\n$/, "vacuity: read to the end");
  });
}
