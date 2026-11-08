// Unit tests for blacklist.js — the separator-tolerant matcher and its ReDoS guard.
// Run: node --test blacklist.test.js
//
// Mirror of the same logic in web/app/lib/blacklist.ts (separate runtimes) — if
// termRegex changes here, change it there too.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { termRegex } = require('./blacklist');

test('matches a plain whole word (case-insensitive)', () => {
  const re = termRegex('slur', 'gi');
  assert.equal(re.test('you SLUR here'), true);
});

test('tolerates separator-evasion between letters', () => {
  assert.equal(termRegex('slur', 'gi').test('s.l u*r'), true);
  assert.equal(termRegex('slur', 'gi').test('s-l-u-r'), true);
});

test('does not match a substring inside a longer word (Scunthorpe guard)', () => {
  // ASCII-letter lookaround: the term must be its own word.
  assert.equal(termRegex('slur', 'gi').test('slurred'), false);
  assert.equal(termRegex('slur', 'gi').test('unslur'), false);
});

test('plural forms of a term are the same term (a plural is not a bypass)', () => {
  // "faggots man" sailed through both runtimes — the boundary lookaround read
  // the plural s as "inside a longer word". Mirrors web blocklistClassify.test.
  assert.equal(termRegex('slur', 'gi').test('slurs'), true);
  assert.equal(termRegex('slur', 'gi').test('s l u r s'), true);
  assert.equal(termRegex('tranny', 'gi').test('trannies'), true);
  assert.equal(termRegex('tranny', 'gi').test('trannys'), true);
  // ...but a plural tail is not a license to match other suffixes.
  assert.equal(termRegex('slur', 'gi').test('slurred'), false);
  assert.equal(termRegex('slur', 'gi').test('slushy'), false);
});

test('the plural tail takes "es" only after s, x, z, ch, sh or o (spic does not match Spices)', () => {
  // Prod 2026-10-29: three "Pumpkin Spices ..." lines were held as the level-4
  // racial term "spic" — the old tail allowed an optional "e" before the "s"
  // after ANY stem, so "spic" + "es" read as a plural. English adds "es" only
  // after a hissing ending (boxes, classes, buzzes, churches, wishes) and after
  // "o" (the "o" ending is where a real slur plural lives: "-oes").
  const spic = termRegex('spic', 'i');
  for (const innocent of ['Pumpkin Spices', 'spices', 'spice', 'spiced', 'Spices are great']) {
    assert.equal(spic.test(innocent), false, `"spic" matched "${innocent}"`);
  }
  for (const hit of ['spic', 'spics', 's.p.i.c.s', 'S P I C', 'you spics there']) {
    assert.equal(spic.test(hit), true, `"spic" missed "${hit}"`);
  }
  // A stem that does take "es" keeps it, with the same separator tolerance.
  for (const [stem, plural] of [['box', 'boxes'], ['class', 'classes'], ['buzz', 'buzzes'],
    ['church', 'churches'], ['wish', 'wishes'], ['hero', 'heroes'], ['box', 'b o x e s']]) {
    assert.equal(termRegex(stem, 'i').test(plural), true, `"${stem}" missed its plural "${plural}"`);
    assert.equal(termRegex(stem, 'i').test(`${stem}s`), true, `"${stem}" missed "${stem}s"`);
  }
  // A real list term ending in "o" still catches its "-oes" plural.
  assert.equal(termRegex('negro', 'i').test('negroes'), true);
  // beaner / beaners and the y → ies branch are unchanged.
  assert.equal(termRegex('beaner', 'i').test('beaner'), true);
  assert.equal(termRegex('beaner', 'i').test('beaners'), true);
  assert.equal(termRegex('beaner', 'i').test('beaneres'), false);
  assert.equal(termRegex('tranny', 'i').test('trannies'), true);
  assert.equal(termRegex('tranny', 'i').test('trannys'), true);
  assert.equal(termRegex('tranny', 'i').test('tranny'), true);
});

test('restart: a fresh load of the module rebuilds the list with the same plural rule', () => {
  // stream-api compiles its list at start and again on every override refresh
  // (setOverrides). Both compiled paths must carry the rule, not only termRegex.
  delete require.cache[require.resolve('./blacklist')];
  const fresh = require('./blacklist');
  try {
    assert.equal(fresh.classify('Pumpkin Spices latte').action, 'allow');
    assert.equal(fresh.classify('spics').action, 'block');
    fresh.setOverrides([{ term: 'spic', severity: 4 }]);
    assert.equal(fresh.classify('Pumpkin Spices latte').action, 'allow');
    assert.equal(fresh.classify('s p i c s').action, 'block');
    assert.equal(fresh.maskBlacklist('Pumpkin Spices'), 'Pumpkin Spices');
  } finally {
    fresh.setOverrides([]);
  }
});

test('retry: the same line classified and masked twice gets the same verdict', () => {
  // The mask patterns are global ("gi") regexes; a second pass over the same
  // line must not inherit a lastIndex from the first.
  const { classify, maskBlacklist } = require('./blacklist');
  for (let i = 0; i < 2; i++) {
    assert.equal(classify('Pumpkin Spices').action, 'allow', `attempt ${i + 1}`);
    assert.equal(maskBlacklist('Pumpkin Spices'), 'Pumpkin Spices', `attempt ${i + 1}`);
    assert.equal(classify('spics').action, 'block', `attempt ${i + 1}`);
    assert.equal(maskBlacklist('spics'), '*****', `attempt ${i + 1}`);
  }
});

test('reduces a term to letters before building the pattern', () => {
  // Punctuation in the term is stripped, not treated as a literal — so a term
  // authored with stray separators still matches the letters-only word.
  assert.equal(termRegex('s.l.u.r', 'gi').test('slur'), true);
});

test('returns null for a term with no letters', () => {
  assert.equal(termRegex('***', 'gi'), null);
  assert.equal(termRegex('---', 'gi'), null);
  assert.equal(termRegex('', 'gi'), null);
});

test('ReDoS guard: hostile punctuation run resolves fast', () => {
  // The pre-fix construction could backtrack pathologically when a term itself
  // contained separator-class chars. Letters-only terms keep the interleaved
  // separator class disjoint from every literal, so matching is linear even
  // against a long adversarial run. Bound: must finish well under a second.
  const re = termRegex('slur', 'gi');
  const hostile = '-'.repeat(5000) + 'Z';
  const start = Date.now();
  re.test(hostile);
  const ms = Date.now() - start;
  assert.ok(ms < 250, `expected <250ms, took ${ms}ms`);
});
