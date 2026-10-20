// L14: no journal line in alert.js names a donor. The money path's failure and clamp lines used
// to print `username` (and a raw caller value); the journal is kept and read far from the people
// who gave, so these lines carry event ids and amounts only.
// Run: node --test alert-log-privacy.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scanSource } = require('./testlib/source.js');

// Every console.* call, with its full argument list (balanced parentheses, strings skipped).
function consoleCalls(src) {
  const out = [];
  const re = /console\.(log|warn|error|info)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = re.lastIndex;
    let quote = null;
    for (; i < src.length && depth > 0; i++) {
      const c = src[i];
      if (quote) {
        if (c === '\\') { i++; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '\'' || c === '"' || c === '`') quote = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    out.push(src.slice(m.index, i));
  }
  return out;
}

test('no console.* call in alert.js interpolates a username', () => {
  // The tail anchor is the module.exports line: a short read cannot pass the negative check below.
  const src = scanSource('alert.js', /module\.exports = \{ createAlert, cleanForTTS,[^\n]*\};\s*$/);
  const calls = consoleCalls(src);
  assert.ok(calls.length >= 8, `the scan found only ${calls.length} console calls — it is not reading alert.js`);
  for (const call of calls) {
    assert.doesNotMatch(call, /\busername\b|\bdonor\b|\bgifter\b|\bsubscriber\b/,
      `a journal line names a person:\n${call}`);
  }
});

test('the scanner itself catches a username in a log call (positive control)', () => {
  const calls = consoleCalls("x(); console.error('[alert] failed username=%s', username); y();");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\busername\b/);
});
