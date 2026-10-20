// The public id: one per person per platform, unlinkable without the install's key, and read
// back only by a holder of that key. These are the properties the public chat surfaces lean on.
const test = require('node:test');
const assert = require('node:assert/strict');
const { publicIdFor, parsePublicId, _resetPseudonymKeyForTests } = require('./pseudonym');
const { ERASED_CANONICAL } = require('./account-erase');

const ENV = { STREAM_API_SECRET: 'test-secret-for-public-ids' };

test('the same person on two platforms gets two ids, and neither contains the canonical', () => {
  _resetPseudonymKeyForTests(ENV);
  const tw = publicIdFor('0a1b2c3d4e5f', 'twitch');
  const yt = publicIdFor('0a1b2c3d4e5f', 'youtube');
  assert.ok(tw && yt);
  assert.notEqual(tw, yt);
  for (const id of [tw, yt]) {
    assert.match(id, /^p[A-Za-z0-9_-]+$/);
    assert.ok(!id.includes('0a1b2c3d4e5f'));
  }
});

test('stable: the same person and platform always give the same id (ignore and reply jumps hold)', () => {
  _resetPseudonymKeyForTests(ENV);
  assert.equal(publicIdFor('0a1b2c3d4e5f', 'kick'), publicIdFor('0a1b2c3d4e5f', 'kick'));
  assert.equal(publicIdFor('0a1b2c3d4e5f', 'Kick'), publicIdFor('0a1b2c3d4e5f', 'kick'));
  assert.notEqual(publicIdFor('0a1b2c3d4e5f', 'kick'), publicIdFor('0a1b2c3d4e60', 'kick'));
});

test('read back with the key; nothing else reads as a public id', () => {
  _resetPseudonymKeyForTests(ENV);
  const id = publicIdFor('0a1b2c3d4e5f', 'native');
  assert.deepEqual(parsePublicId(id), { canonical: '0a1b2c3d4e5f', platform: 'native' });
  assert.equal(parsePublicId('0a1b2c3d4e5f'), null);          // a canonical
  assert.equal(parsePublicId('@casey:site.test'), null);      // a Matrix id
  assert.equal(parsePublicId(id.slice(0, -2)), null);         // truncated
  const flipped = id.slice(0, 5) + (id[5] === 'A' ? 'B' : 'A') + id.slice(6);
  assert.equal(parsePublicId(flipped), null);                 // forged
  assert.equal(parsePublicId(undefined), null);
});

test('another key (another install, a rotated secret) cannot read the id', () => {
  _resetPseudonymKeyForTests(ENV);
  const id = publicIdFor('0a1b2c3d4e5f', 'twitch');
  _resetPseudonymKeyForTests({ STREAM_API_SECRET: 'a-different-secret' });
  assert.equal(parsePublicId(id), null);
  _resetPseudonymKeyForTests(ENV);
  assert.deepEqual(parsePublicId(id), { canonical: '0a1b2c3d4e5f', platform: 'twitch' });
});

test('no canonical, and the shared erased-person row, have no public id', () => {
  _resetPseudonymKeyForTests(ENV);
  assert.equal(publicIdFor(null, 'twitch'), null);
  assert.equal(publicIdFor('', 'twitch'), null);
  assert.equal(publicIdFor(ERASED_CANONICAL, 'twitch'), null);
  assert.equal(publicIdFor('0a1b2c3d4e5f', ''), null);
});
