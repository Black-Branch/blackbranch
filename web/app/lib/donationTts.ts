// How many characters the voice reads of a donation message, by the gross
// amount the donor pays. MIRROR of stream-api/tts-tiers.js;
// donationTts.parity.test.ts requires that file and holds the two together.
//
// The top tier (500) sits exactly at Stripe's 500-character ceiling for a
// Checkout Session metadata VALUE — the donate route stores the message in
// `metadata.message` (web/app/api/billing/donate/route.ts) rather than a
// column of its own, since the webhook is the only writer of the donation row
// and it reads the message back off the session. A tier above 500 would need
// a different carrier for the message.
const TIERS: ReadonlyArray<{ minUsd: number; chars: number }> = [
  { minUsd: 25, chars: 500 },
  { minUsd: 10, chars: 300 },
  { minUsd: 5, chars: 150 },
  { minUsd: 0, chars: 50 },
];

export function donationTtsChars(usd: number): number {
  const smallest = TIERS[TIERS.length - 1]!.chars;
  if (!Number.isFinite(usd) || usd < 0) return smallest;
  for (const t of TIERS) if (usd >= t.minUsd) return t.chars;
  return smallest;
}

/** The sentence the form shows under the message box. */
export function donationTtsLine(usd: number): string {
  return `Reads up to ${donationTtsChars(usd)} characters on stream`;
}
