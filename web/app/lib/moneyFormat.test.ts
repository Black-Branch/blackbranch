// One currency for every route that charges, one way to write an amount.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatPrice, currencySign, paypalCurrencyCode, SITE_CURRENCY } from "./moneyFormat.ts";

test("an amount in minor units is written in its own currency, a whole one without .00", () => {
  assert.equal(formatPrice(500, "usd"), "$5");
  assert.equal(formatPrice(450, "usd"), "$4.50");
  assert.equal(formatPrice(700, "eur"), "€7");
  assert.equal(formatPrice(500, "jpy"), "¥500", "a zero-decimal currency's minor unit IS the unit");
  assert.equal(formatPrice(500), formatPrice(500, SITE_CURRENCY), "the default is the site currency");
});

test("an unknown currency code does not throw — it is written out", () => {
  assert.match(formatPrice(500, "zzz"), /^ZZZ\s5$/);
});

test("the amount box's prefix and PayPal's code come from the same currency", () => {
  assert.equal(currencySign("usd"), "$");
  assert.equal(currencySign("eur"), "€");
  assert.equal(paypalCurrencyCode(), SITE_CURRENCY.toUpperCase());
});

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("every route that charges reads SITE_CURRENCY — no route types its own currency literal", () => {
  for (const p of [
    "app/api/billing/donate/route.ts",
    "app/api/billing/points/route.ts",
    "app/api/billing/paypal/order/route.ts",
    "app/lib/paypalClient.ts",
    "app/lib/paypalCapture.ts",
    "app/features/support/PayPalButton.tsx",
  ]) {
    const src = read(p);
    assert.match(src, /SITE_CURRENCY|paypalCurrencyCode\(\)/, `${p} reads the one currency`);
    assert.doesNotMatch(src, /currency(_code)?: ["']usd["']|currency(_code)?: ["']USD["']|'usd', \$/i, `${p} has no currency literal`);
  }
  // The gift charges the subscription price's own currency, never a literal.
  const gift = read("app/api/billing/gift/route.ts");
  assert.match(gift, /currency: price\.currency/);
  assert.match(gift, /giftAmountMinor\(price\.amount, months, count\)/);
});

test("the tip presets and the amount box are written by formatPrice/currencySign, never a literal $", () => {
  const src = read("app/features/support/TipForm.tsx");
  assert.match(src, /\{formatPrice\(p \* 100\)\}/);
  assert.match(src, /\{currencySign\(\)\}/);
  assert.doesNotMatch(src, /^\s*\$\{p\}\s*$/m, "the old `${p}` preset label is gone");
  // Vacuity anchor at the END: the scan read the whole file.
  assert.match(src.trimEnd(), /\}$/);
});
