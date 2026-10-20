// stream-api/tts-tiers.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { donationTtsChars, spokenCharsFor, DONATION_TTS_TIERS } = require('./tts-tiers');

test('donation tiers: every boundary, both sides', () => {
  assert.equal(donationTtsChars(0), 50);
  assert.equal(donationTtsChars(4.99), 50);
  assert.equal(donationTtsChars(5), 150);
  assert.equal(donationTtsChars(9.99), 150);
  assert.equal(donationTtsChars(10), 300);
  assert.equal(donationTtsChars(24.99), 300);
  assert.equal(donationTtsChars(25), 500);
  assert.equal(donationTtsChars(1000), 500);
});

test('donation tiers: a bad amount gets the smallest tier, never a crash or a big one', () => {
  assert.equal(donationTtsChars(NaN), 50);
  assert.equal(donationTtsChars(-3), 50);
  assert.equal(donationTtsChars(undefined), 50);
});

test('spokenCharsFor: only donations are tiered; everything else keeps the card cap', () => {
  assert.equal(spokenCharsFor('donation', 3), 50);
  assert.equal(spokenCharsFor('donation', 12), 300);
  assert.equal(spokenCharsFor('donation', undefined), 50); // a donation with no amount is the smallest tier
  assert.equal(spokenCharsFor('gift', 100), 500);
  assert.equal(spokenCharsFor('sub', undefined), 500);
  assert.equal(spokenCharsFor('follow', 0), 500);
});

test('the table is descending by minUsd and ends at zero', () => {
  for (let i = 1; i < DONATION_TTS_TIERS.length; i++) {
    assert.ok(DONATION_TTS_TIERS[i].minUsd < DONATION_TTS_TIERS[i - 1].minUsd);
  }
  assert.equal(DONATION_TTS_TIERS[DONATION_TTS_TIERS.length - 1].minUsd, 0);
});
