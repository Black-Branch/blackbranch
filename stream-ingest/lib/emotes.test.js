// Emote stripping (the clean word count every scoring and memory gate reads).
// Run: node --test lib/emotes.test.js
//
// The product knows only GLOBAL emotes — ones every channel has. A channel's own emotes (its
// prefix, the third-party emotes it added) are that install's, so they come from its plugin
// (registerChannelEmotes); a product file naming one channel's emotes ships that channel to every
// install.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripEmotes, cleanWordCount, registerChannelEmotes, GLOBAL_EMOTES } from './emotes.js';

test('globals and emoticons are stripped; words stay', () => {
  assert.equal(stripEmotes('that was great KEKW LUL :) PogChamp'), 'that was great');
  assert.equal(cleanWordCount(stripEmotes('o7 see you tomorrow NotLikeThis')), 3);
  assert.equal(stripEmotes(''), '');
});

test('the product list is global emotes only — no one channel\'s', () => {
  // Twitch's own globals and the third-party globals every channel shows; nothing a channel added.
  assert.deepEqual([...GLOBAL_EMOTES].sort(), [
    'FeelsBeanMan', 'KEKL', 'KEKW', 'LUL', 'LULW', 'NotLikeThis', 'OMEGALUL', 'PepeHands', 'Pog', 'PogChamp',
    'PowerUpL', 'PowerUpR', 'TheIlluminati', 'YEP', 'o7', 'peepoHappy',
  ].sort());
  // …and the module itself names no channel prefix.
  const src = readFileSync(new URL('./emotes.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /replace\(\/\\b[a-z]+\[A-Za-z0-9\]\+/, 'a literal channel-prefix rule');
  assert.match(src, /\nexport function cleanWordCount\(clean\) \{\n/, 'vacuity: read to the end');
});

test("a channel's prefix and its own emotes come from its plugin", () => {
  // A prefix followed by lowercase/digits is invisible to the camel-case rule: only the
  // registered prefix strips it.
  assert.equal(stripEmotes('gadgetwave hi gadget99 BIGWAVE'), 'gadgetwave hi gadget99 BIGWAVE');
  registerChannelEmotes({ prefixes: ['gadget'], names: ['BIGWAVE'] });
  try {
    assert.equal(stripEmotes('gadgetwave hi gadget99 BIGWAVE'), 'hi', 'the prefix needs at least one more character');
    assert.equal(stripEmotes('gadget alone stays'), 'gadget alone stays');
    assert.equal(stripEmotes('KEKW still global'), 'still global');
  } finally { registerChannelEmotes({}); }
  assert.equal(stripEmotes('gadgetwave hi'), 'gadgetwave hi', 'cleared again');
  // A value that is not a plain word would be a regex: refused.
  assert.throws(() => registerChannelEmotes({ prefixes: ['a|b'] }), /plain letters and digits/);
  assert.throws(() => registerChannelEmotes({ names: ['.*'] }), /plain letters and digits/);
});
