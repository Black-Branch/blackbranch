// Unit tests for the soundboard manifest sanitizer. The path.basename() on
// `file` is a path-traversal guard, so it's worth pinning. Run:
//   node --test sounds.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeManifest } = require('./sounds');

test('non-array input yields an empty manifest', () => {
  assert.deepEqual(sanitizeManifest(null), []);
  assert.deepEqual(sanitizeManifest({}), []);
  assert.deepEqual(sanitizeManifest('nope'), []);
});

test('rows missing id or file are dropped', () => {
  const out = sanitizeManifest([
    { id: 'ok', file: 'a.mp3' },
    { id: 'no-file' },
    { file: 'orphan.mp3' },
    null,
    { id: 42, file: 'a.mp3' },      // non-string id
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'ok');
});

test('file is reduced to its basename (traversal guard)', () => {
  const out = sanitizeManifest([
    { id: 'a', file: '../../etc/passwd' },
    { id: 'b', file: '/abs/path/horn.mp3' },
    { id: 'c', file: 'plain.mp3' },
  ]);
  assert.equal(out[0].file, 'passwd');
  assert.equal(out[1].file, 'horn.mp3');
  assert.equal(out[2].file, 'plain.mp3');
});

test('price defaults to 100 and floors at 1', () => {
  const out = sanitizeManifest([
    { id: 'a', file: 'a.mp3' },                 // no price → 100
    { id: 'b', file: 'b.mp3', price: 0 },        // 0 is falsy → default 100
    { id: 'c', file: 'c.mp3', price: -50 },      // negative parses truthy → floored to 1
    { id: 'd', file: 'd.mp3', price: 250 },      // kept
    { id: 'e', file: 'e.mp3', price: 'junk' },   // unparseable → 100
  ]);
  assert.deepEqual(out.map((s) => s.price), [100, 100, 1, 250, 100]);
});

test('id and label are length-capped; label defaults to id', () => {
  const out = sanitizeManifest([
    { id: 'x'.repeat(100), file: 'a.mp3' },
    { id: 'short', file: 'b.mp3' },              // no label → id
    { id: 'y', file: 'c.mp3', label: 'L'.repeat(200) },
  ]);
  assert.equal(out[0].id.length, 60);
  assert.equal(out[1].label, 'short');
  assert.equal(out[2].label.length, 80);
});

test('durationMs floors at 0 and defaults to 0', () => {
  const out = sanitizeManifest([
    { id: 'a', file: 'a.mp3' },                    // → 0
    { id: 'b', file: 'b.mp3', durationMs: -500 },  // → 0
    { id: 'c', file: 'c.mp3', durationMs: 1500 },  // kept
  ]);
  assert.deepEqual(out.map((s) => s.durationMs), [0, 0, 1500]);
});
