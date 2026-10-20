// Plain-words decline copy for a Stripe payment failure (spec Part 1). The
// four fraud-family codes collapse to one generic line — naming fraud to the
// cardholder is useless or actively bad. decline_code is checked first: a
// Radar "highest risk" block surfaces as code: 'card_declined', decline_code:
// 'fraudulent'.
//
// The specific-reason lookup below checks decline_code before code for the
// same reason: Stripe reports a bank decline as code: 'card_declined' with
// the actual reason in decline_code ('insufficient_funds', 'do_not_honor',
// …) — the real shape of Stripe's own test card 4000 0000 0000 9995. Looking
// only at code sent every real bank decline to the generic FALLBACK line.
const FRAUD_FAMILY = new Set(["fraudulent", "stolen_card", "lost_card", "merchant_blacklist"]);

const TITLE_BY_CODE = new Map<string, string>([
  ["insufficient_funds", "Insufficient funds."],
  ["incorrect_cvc", "Incorrect security code."],
  ["expired_card", "This card has expired."],
  ["incorrect_number", "Incorrect card number."],
  ["processing_error", "A processing error occurred."],
  ["authentication_required", "Your bank needs extra verification for this payment."],
  ["do_not_honor", "Your bank declined this payment."],
  ["generic_decline", "Your bank declined this payment."],
  ["transaction_not_allowed", "Your bank blocked this type of payment."],
  ["card_not_supported", "This card doesn't support this kind of payment."],
  ["currency_not_supported", "This card doesn't support this currency."],
]);

const GENERIC = "Your bank declined this payment.";
const FALLBACK = "Your payment didn't go through.";

export function declineCopy(
  code: string | null | undefined,
  declineCode: string | null | undefined
): { title: string; body: string; canRetry: boolean } {
  const dc = declineCode?.trim() || null;
  const c = code?.trim() || null;
  const title =
    (dc && FRAUD_FAMILY.has(dc)) || (c && FRAUD_FAMILY.has(c))
      ? GENERIC
      : (dc && TITLE_BY_CODE.get(dc)) ?? (c && TITLE_BY_CODE.get(c)) ?? FALLBACK;
  return { title, body: `${title} You were not charged. Try another payment method or card.`, canRetry: true };
}
