// How many characters the voice reads of a donation message, by the GROSS
// amount the donor paid in USD. Never
// keyed on take-home — the donor chose the gross number, so that is the
// number the promise is made against.
//
// MIRRORED in web/app/lib/donationTts.ts. web/app/lib/donationTts.parity.test.ts
// requires THIS file and asserts the two tables agree at every boundary, so a
// change here that is not made there fails the web suite.
'use strict';

const DONATION_TTS_TIERS = Object.freeze([
  Object.freeze({ minUsd: 25, chars: 500 }),
  Object.freeze({ minUsd: 10, chars: 300 }),
  Object.freeze({ minUsd: 5, chars: 150 }),
  Object.freeze({ minUsd: 0, chars: 50 }),
]);

// The card's own cap (buildShowAlert slices the message at 500) — what every
// non-donation event keeps speaking, unchanged.
const DEFAULT_SPOKEN_CHARS = 500;

function donationTtsChars(usd) {
  const n = Number(usd);
  const smallest = DONATION_TTS_TIERS[DONATION_TTS_TIERS.length - 1].chars;
  if (!Number.isFinite(n) || n < 0) return smallest;
  for (const tier of DONATION_TTS_TIERS) if (n >= tier.minUsd) return tier.chars;
  return smallest;
}

function spokenCharsFor(eventType, grossUSD) {
  return eventType === 'donation' ? donationTtsChars(grossUSD) : DEFAULT_SPOKEN_CHARS;
}

module.exports = { DONATION_TTS_TIERS, donationTtsChars, spokenCharsFor };
