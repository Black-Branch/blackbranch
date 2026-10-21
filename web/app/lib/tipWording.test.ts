import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

const webRoot = join(import.meta.dirname, "../..");
const read = (p: string) => stripComments(readFileSync(join(webRoot, p), "utf8"));
const rawRead = (p: string) => readFileSync(join(webRoot, p), "utf8");

const SCANNED_FILES = [
  "app/api/billing/donate/route.ts",
  "app/components/chatEventBody.tsx",
  "app/components/SupportContent.tsx",
  "app/features/support/TipForm.tsx",
  "app/features/support/TipPayButton.tsx",
];

test("every scanned file is whole", () => {
  for (const p of SCANNED_FILES) {
    assert.ok(rawRead(p).trimEnd().endsWith("}"), `${p} truncated — the negative assertions below are vacuous`);
  }
});

test("the checkout line item says Tip, not Donation", () => {
  const src = read("app/api/billing/donate/route.ts");
  assert.match(src, /product_data: \{ name: `Tip to \$\{siteName\(\)\}` \}/);
  assert.ok(!/Donation to/.test(src));
});

test("the chat card verb is 'tipped'", () => {
  const src = read("app/components/chatEventBody.tsx");
  assert.match(src, /label\(<>tipped \{formatMoney/);
  assert.ok(!/label\(<>donated \{formatMoney/.test(src));
});

test("SupportContent: the donation section heading says Tip", () => {
  // The button and checkbox wording moved into TipForm (below) when the
  // donation section was extracted — the heading stays here because the
  // caller owns the section's chrome, not the shared form.
  const src = read("app/components/SupportContent.tsx");
  assert.match(src, /One-time tip/);
  assert.ok(!src.includes("One-time donation"));
});

test("TipForm: the checkbox says Tip", () => {
  const src = read("app/features/support/TipForm.tsx");
  assert.match(src, /Tip anonymously/);
  assert.ok(!src.includes("Donate anonymously"));
});

// The submit button's wording lives in TipPayButton — the split
// "Tip $X via <method> [▾]" button: the card half, the ▾'s label logic, and
// the "Tipping $X via PayPal/Venmo" line under PayPal/Venmo, not TipForm.
//
// The PayPal/Venmo caption is a template literal inside a `points ? … : …`
// ternary (the points half reads "Buying <N> <currency>", the tip half
// `Tipping ${tipAmount}` — the amount written by moneyFormat's formatPrice in the
// site's currency, never a literal "$") followed by the JSX expression's closing
// `}` and the literal " via " text.
test("TipPayButton: the card button and the PayPal/Venmo line both say Tip(ping), never Donat(e/ion)", () => {
  const src = read("app/features/support/TipPayButton.tsx");
  assert.match(src, /`Tip \$\{tipAmount\}`/);
  assert.match(src, /`Tipping \$\{tipAmount\}`\} via/);
  assert.match(src, /const tipAmount = amount \? formatPrice\(/, "the amount is formatted in the site's currency");
  assert.ok(!src.includes("Donate"));
  assert.ok(!src.includes("Donation"));
});
