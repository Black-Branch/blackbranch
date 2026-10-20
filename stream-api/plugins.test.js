'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadOwnerPlugin } = require('./plugins.js');

test('no owner folder → no plugin', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-'));
  assert.equal(loadOwnerPlugin(dir), null);
});

test('an owner folder is loaded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-'));
  fs.mkdirSync(path.join(dir, 'owner'));
  fs.writeFileSync(path.join(dir, 'owner', 'index.js'), "module.exports = { id: 'x' };\n");
  assert.equal(loadOwnerPlugin(dir).id, 'x');
});

test('a broken owner plugin fails loudly instead of reading as absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-'));
  fs.mkdirSync(path.join(dir, 'owner'));
  fs.writeFileSync(path.join(dir, 'owner', 'index.js'), "throw new Error('boom');\n");
  assert.throws(() => loadOwnerPlugin(dir), /boom/);
});

