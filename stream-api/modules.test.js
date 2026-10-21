// modules.js: which module starts, and what the boot line says.
// Run: node --test modules.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createModules, STREAM_API_MODULES: MODULES } = require('./modules.js');
const { MODULES: ALL } = require('./instanceSchema.generated.js');

const ids = (kind) => MODULES.filter((m) => (kind === 'owner' ? m.kind === 'owner' : m.kind !== 'owner')).map((m) => m.id);
const config = (on) => ({ get: (k) => on.includes(k.replace(/^modules\./, '')), loaded: Promise.resolve() });
const logger = () => { const lines = []; return { lines, log: (l) => lines.push(l), error: (l) => lines.push(l) }; };
const starters = (list, started) => Object.fromEntries(list.map((id) => [id, () => started.push(id)]));

test('vacuity: the manifest has product and owner modules', () => {
  assert.ok(ids('product').length >= 1 && ids('owner').length >= 1);
});

test('a module only another process reads (youtube, stripe, paypal) needs no starter here and is not on the boot line', async () => {
  const others = ALL.filter((m) => !m.packages.includes('stream-api')).map((m) => m.id);
  assert.ok(others.includes('stripe') && others.includes('paypal') && others.includes('youtube'), `vacuity: ${others.join(', ')}`);
  for (const id of others) assert.ok(!MODULES.some((m) => m.id === id), `${id} is in stream-api's list`);
  const started = []; const log = logger();
  const m = createModules({ instanceConfig: config(ALL.map((x) => x.id)), starters: starters(ids('product'), started), ownerStarters: starters(ids('owner'), started), log });
  await m.started;
  for (const id of others) assert.ok(!log.lines[0].includes(id), `${id} on the boot line: ${log.lines[0]}`);
  assert.throws(() => createModules({ instanceConfig: config([]), starters: { ...starters(ids('product'), []), stripe: () => {} } }), /unknown module stripe/);
});

test('everything installed: the boot line has no "not installed" part (the owner install\'s line is unchanged)', async () => {
  const started = []; const log = logger();
  const m = createModules({ instanceConfig: config(MODULES.map((x) => x.id)), starters: starters(ids('product'), started), ownerStarters: starters(ids('owner'), started), log });
  await m.started;
  assert.deepEqual(started.sort(), MODULES.map((x) => x.id).sort());
  assert.equal(log.lines[0], `[modules] on: ${MODULES.map((x) => x.id).join(', ')} · off: —`);
});

test('no site plugin: its modules are not installed, and switching one on starts nothing', async () => {
  const started = []; const log = logger();
  const m = createModules({ instanceConfig: config(MODULES.map((x) => x.id)), starters: starters(ids('product'), started), log });
  await m.started;
  assert.deepEqual(started.sort(), ids('product').sort());
  for (const id of ids('owner')) assert.equal(m.running(id), false);
  assert.match(log.lines[0], new RegExp(` · not installed: ${ids('owner').join(', ')}$`));
});

test('a product module must have a product starter; two starters for one module is an error', () => {
  const [p] = ids('product'); const [o] = ids('owner');
  assert.throws(() => createModules({ instanceConfig: config([]), starters: {} }), new RegExp(`no starter for module ${p}`));
  const s = starters(ids('product'), []);
  assert.throws(() => createModules({ instanceConfig: config([]), starters: { ...s, [o]: () => {} }, ownerStarters: { [o]: () => {} } }), /both/);
  assert.throws(() => createModules({ instanceConfig: config([]), starters: s, ownerStarters: { nope: () => {} } }), /unknown module nope/);
});
