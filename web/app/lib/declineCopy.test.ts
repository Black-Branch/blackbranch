// web/app/lib/declineCopy.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { declineCopy } from "./declineCopy.ts";

const ROWS: Array<[string | null, string | null, string]> = [
  [null, "fraudulent", "Your bank declined this payment."],
  [null, "stolen_card", "Your bank declined this payment."],
  [null, "lost_card", "Your bank declined this payment."],
  [null, "merchant_blacklist", "Your bank declined this payment."],
  ["card_declined", "fraudulent", "Your bank declined this payment."],
  ["card_declined", "insufficient_funds", "Insufficient funds."],
  ["insufficient_funds", null, "Insufficient funds."],
  ["incorrect_cvc", null, "Incorrect security code."],
  ["expired_card", null, "This card has expired."],
  ["incorrect_number", null, "Incorrect card number."],
  ["processing_error", null, "A processing error occurred."],
  ["authentication_required", null, "Your bank needs extra verification for this payment."],
  ["do_not_honor", null, "Your bank declined this payment."],
  ["generic_decline", null, "Your bank declined this payment."],
  ["transaction_not_allowed", null, "Your bank blocked this type of payment."],
  ["card_not_supported", null, "This card doesn't support this kind of payment."],
  ["currency_not_supported", null, "This card doesn't support this currency."],
  ["something_unlisted", null, "Your payment didn't go through."],
  [null, null, "Your payment didn't go through."],
  ["", "", "Your payment didn't go through."],
];

test("every table row maps to its title", () => {
  for (const [code, declineCode, title] of ROWS) {
    assert.equal(declineCopy(code, declineCode).title, title, `code=${code} decline_code=${declineCode}`);
  }
});

test("every body is the title's sentence + the reassurance + a retry invite", () => {
  for (const [code, declineCode] of ROWS) {
    const { title, body } = declineCopy(code, declineCode);
    assert.equal(body, `${title} You were not charged. Try another payment method or card.`);
  }
});

test("canRetry is true for every row", () => {
  for (const [code, declineCode] of ROWS) assert.equal(declineCopy(code, declineCode).canRetry, true);
});

test("decline_code wins over an unrelated code (a Radar block: card_declined/fraudulent)", () => {
  assert.equal(declineCopy("card_declined", "stolen_card").title, "Your bank declined this payment.");
});
