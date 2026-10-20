// Run: node --test app/lib/currency.test.ts
// The currency's words on a FRESH install (no build values: the product defaults).
import { test } from "node:test";
import assert from "node:assert/strict";
import { INSTANCE_KEYS } from "./instanceSchema.generated.mjs";
import {
  NEUTRAL, currencyName, currencyTitle, currencyLabel, currencyIsMass, currencySymbol, currencyIcon,
  scoreName, scoreShortName,
} from "./currency.ts";

test("NEUTRAL is the schema's product defaults, word for word (one source, pinned)", () => {
  const def = (k: string) => INSTANCE_KEYS.find((e) => e.key === k)?.default;
  assert.equal(NEUTRAL.name, def("currency.name"));
  assert.equal(NEUTRAL.namePlural, def("currency.namePlural"));
  assert.equal(NEUTRAL.symbol, def("currency.symbol"));
  assert.equal(NEUTRAL.scoreName, def("community.scoreName"));
  assert.equal(def("currency.icon"), null, "no default icon: unset = the built-in coin");
});

test("a fresh install says points — singular for one, plural otherwise, grouped numbers", () => {
  assert.equal(currencyName(), "points");
  assert.equal(currencyName(1), "point");
  assert.equal(currencyName(0), "points");
  assert.equal(currencyTitle(), "Points");
  assert.equal(currencyLabel(150), "150 points");
  assert.equal(currencyLabel(1), "1 point");
  assert.equal(currencyLabel(1500), "1,500 points");
  assert.equal(currencyIsMass(), false, "point/points is a counted plural: 'are', 'them'");
  assert.equal(currencySymbol(), "pts");
  assert.equal(currencyIcon(), null);
  assert.equal(scoreName(), "Karma");
  assert.equal(scoreShortName(), "Karma");
});
