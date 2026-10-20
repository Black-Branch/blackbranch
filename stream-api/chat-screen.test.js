// The chat bot's output check (chat-screen.js): a reply meets the bar a person's message meets —
// the word filter and the link gate — and anything that would be held for a person is not sent.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { screen } = require('./chat-screen');
const linkGate = require('./link-gate');

test('plain text passes; a blocked word does not; nothing empty or oversized does', () => {
  assert.deepEqual(screen('Next stream is Friday at 8.'), { ok: true });
  assert.equal(screen('you arsebandit').ok, false);
  assert.match(screen('you arsebandit').reason, /^words:/);
  assert.deepEqual(screen('   '), { ok: false, reason: 'length' });
  assert.deepEqual(screen('x'.repeat(2001)), { ok: false, reason: 'length' });
});

test('links: held when the gate holds, delivered in flag mode (as for people), free when it is off', () => {
  const before = linkGate.currentPosture();
  try {
    linkGate.setLinkPosture('hold');
    assert.equal(screen('see https://unknown-host.example/x').ok, false);
    linkGate.setLinkPosture('flag');
    assert.equal(screen('see https://unknown-host.example/x').ok, true);
    linkGate.setLinkPosture('off');
    assert.equal(screen('see https://unknown-host.example/x').ok, true);
  } finally {
    linkGate.setLinkPosture(before);
  }
});

test('encodings that hide a word are refused or folded: zero-width, ||marks||, full-width letters', () => {
  assert.deepEqual(screen('you arse\u200bbandit'), { ok: false, reason: 'hidden_characters' });
  assert.deepEqual(screen('you \u202earsebandit'), { ok: false, reason: 'hidden_characters' });
  assert.equal(screen('you ||arsebandit||').ok, false, 'redaction marks let a word through');
  assert.equal(screen('you arse||bandit').ok, false, 'a mark splitting a word let it through');
  assert.equal(screen('you ａｒｓｅｂａｎｄｉｔ').ok, false, 'full-width letters let a word through');
  assert.equal(screen('a line\nwith a newline').ok, true, 'a newline is not a hiding character (the sender folds it)');
});
