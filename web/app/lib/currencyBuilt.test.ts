// Run: node --test app/lib/currencyBuilt.test.ts
// The currency's words on an install that set its OWN (a mass noun with a one-letter mark — the
// shape site.test has): every helper must render them exactly, so its pages read as before.
import "./testCurrencyBuild.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { currencyName, currencyTitle, currencyLabel, currencyIsMass, currencyIcon, scoreName, scoreShortName } from "./currency.ts";
import { formatCoinsShort } from "./coins.ts";
import { FACES } from "./boardFaces.ts";
import { statementSuffixFor } from "./statementSuffix.ts";

test("an install's own word: no plural invented, no case changed", () => {
  assert.equal(currencyName(), "Credit");
  assert.equal(currencyName(1), "Credit");
  assert.equal(currencyTitle(), "Credit");
  assert.equal(currencyLabel(150), "150 Credit");
  assert.equal(currencyIsMass(), true, "singular = plural: 'is', 'it'");
  assert.equal(currencyIcon(), "/example-icon.webp");
});

test("a one-letter mark sits flush after the number, as the q glyph always has", () => {
  assert.equal(formatCoinsShort(1475), "1,475c");
  assert.equal(formatCoinsShort(0), "0c");
});

test("the vote score's name and its per-100 stem come from community.scoreName", () => {
  assert.equal(scoreName(), "Street cred");
  assert.equal(scoreShortName(), "Cred");
  const labels = FACES.map((f) => f.label);
  assert.equal(labels[0], "Earned Credit");
  assert.equal(labels[1], "Street cred");
  assert.equal(labels[2], "Cred / 100");
});

test("a points purchase's card statement suffix is the install's own name, upper-cased", () => {
  assert.equal(statementSuffixFor("coin_purchase", 10), "CREDIT");
  assert.equal(statementSuffixFor("donation", 10), "TIP", "tips and gifts are unchanged");
});
