// One currency for every route that charges, one way to write an amount.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { formatPrice, currencySign, paypalCurrencyCode, SITE_CURRENCY } from "./moneyFormat.ts";
import { stripComments } from "./testSource.ts";

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

// ── #188 / A1-10: the viewer's browser locale must never change the site's money ─────────────────
//
// formatPrice and currencySign formatted in the VIEWER's locale (`Intl.NumberFormat(undefined, …)`):
// presets read "US$5" (en-GB), "5 $US" (fr-FR), "USD 5" (en-AU) — "$ and US traded places" — the
// "Other" box's one-character prefix slot overlapped a three-letter "US$", and a server-rendered
// page changed its text on hydration. The site's money is written in ONE locale, whoever reads it.

/** formatPrice/currencySign run in a fresh process whose default locale is `locale`. */
function inLocale(locale: string) {
  const mod = fileURLToPath(new URL("./moneyFormat.ts", import.meta.url));
  const script = `const m = await import(${JSON.stringify(mod)});
    console.log(JSON.stringify({ preset: m.formatPrice(500), cents: m.formatPrice(450), sign: m.currencySign(), eur: m.formatPrice(700, "eur"),
      control: new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(5) }));`;
  const r = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], { env: { ...process.env, LC_ALL: locale, LANG: locale }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout) as { preset: string; cents: string; sign: string; eur: string; control: string };
}

test("the viewer's browser locale never changes the currency word or its place", () => {
  for (const locale of ["fr_FR.UTF-8", "en_GB.UTF-8", "en_AU.UTF-8", "es_ES.UTF-8", "de_DE.UTF-8"]) {
    const r = inLocale(locale);
    // Vacuity: the child really ran in another locale (its own default formatting moved).
    assert.notEqual(r.control, "$5.00", `${locale}: the child process did not take the locale — the test would prove nothing`);
    assert.deepEqual({ preset: r.preset, cents: r.cents, sign: r.sign, eur: r.eur }, { preset: "$5", cents: "$4.50", sign: "$", eur: "€7" }, locale);
  }
});

test("the amounts a viewer sees elsewhere — chat card, pin, stream stats — use the one formatter", () => {
  assert.equal(formatPrice(500, "usd", "minor"), "$5.00", "an amount that happened keeps its cents");
  assert.equal(formatPrice(12809, "usd", "whole"), "$128");
  assert.equal(formatPrice(500, "jpy", "minor"), "¥500", "a zero-decimal currency has no cents to keep");
  for (const p of ["app/lib/moneyFormat.ts", "app/lib/chatFormat.ts", "app/lib/pinSnapshot.ts", "app/lib/streamStats.ts", "app/lib/chatMsg.ts", "app/components/chatEventBody.tsx"]) {
    const src = stripComments(read(p));
    assert.doesNotMatch(src, /Intl\.NumberFormat\(undefined/, `${p} formats money in the viewer's locale`);
    assert.doesNotMatch(src, /`\$\$\{/, `${p} writes a literal dollar sign before an amount`);
  }
  for (const p of ["app/lib/chatFormat.ts", "app/lib/pinSnapshot.ts", "app/lib/streamStats.ts"]) {
    assert.doesNotMatch(stripComments(read(p)), /Intl\.NumberFormat\([^)]*currency/, `${p} keeps a private money formatter`);
  }
  assert.match(read("app/components/chatEventBody.tsx"), /tipped \{formatPrice\(msg\.amount \?\? 0, msg\.currency \?\? SITE_CURRENCY, "minor"\)\}/);
  assert.match(read("app/lib/pinSnapshot.ts"), /formatPrice\(c, cur, "minor"\)/);
  assert.match(read("app/lib/streamStats.ts"), /formatPrice\(cents, LEDGER_CURRENCY, whole \? "whole" : "minor"\)/);
});

test("the Other box's prefix sits in the flow, so a longer sign cannot run into the digits", () => {
  const src = stripComments(read("app/features/support/TipForm.tsx"));
  const box = src.slice(src.indexOf("{currencySign()}") - 400, src.indexOf("{currencySign()}") + 900);
  assert.doesNotMatch(box, /absolute left-3/, "an absolutely placed prefix over a fixed padding overlaps any sign wider than one character");
  assert.match(box, /<label className="flex[^"]*focus-within:/, "the box is a flex row; the focus ring moves to it");
  assert.match(src.trimEnd(), /\}$/, "vacuity anchor: the scan read the whole file");
});

// W4 R3: two more private money formatters (the mod Payments list wrote "US$5.00" for an en-GB mod
// and divided every currency by 100, so ¥500 showed as ¥5; the Stripe price Check kept its own
// copy) and two tip refusals that typed a literal "$" before the amount.
test("no literal $ and no private money formatter on the mod Payments list, the price Check and the tip refusals", () => {
  const SURFACES: [string, RegExp][] = [
    ["app/features/moderation/sections/PaymentsSection.tsx", /\);\n\}$/],
    ["app/lib/setup/setupChecks.ts", /return formatPrice\(amount, currency\.toLowerCase\(\), "minor"\);\n\}$/],
    ["app/api/billing/donate/route.ts", /return Response\.json\(\{ clientSecret: checkout\.client_secret, sessionId: checkout\.id \}\);\s*\}$/],
    ["app/api/billing/paypal/order/route.ts", /return Response\.json\(\{ orderId \}\);\s*\}$/],
    ["app/api/billing/points/route.ts", /return Response\.json\(\{ clientSecret: checkout\.client_secret, sessionId: checkout\.id \}\);\s*\}$/],
  ];
  for (const [p, tail] of SURFACES) {
    const raw = read(p);
    // Vacuity anchor at the END: the negative assertions below go green over a short read.
    assert.match(raw.trimEnd().split("\n").slice(-3).join("\n"), tail, `${p} was not read to its end`);
    const src = stripComments(raw);
    assert.doesNotMatch(src, /Intl\.NumberFormat\(/, `${p} keeps a private money formatter`);
    assert.doesNotMatch(src, /\$\$\{|["'`]\$["'`]/, `${p} writes a literal dollar sign`);
    assert.match(src, /formatPrice\(/, `${p} writes money with the one formatter`);
  }
  // The yen case the mod list got wrong, through the formatter it now uses.
  assert.equal(formatPrice(500, "jpy", "minor"), "¥500");
});
