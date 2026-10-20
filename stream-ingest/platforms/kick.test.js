// Run: node --test platforms/kick.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.KICK_CHANNEL_SLUG = 'testchannel';
delete process.env.KICK_CLIENT_ID;
delete process.env.KICK_CLIENT_SECRET;

const { fetchKickState } = await import('./kick.js');

const realFetch = global.fetch;
function stub(handler) {
  global.fetch = async (url, init) => handler(String(url), init);
}
function restore() { global.fetch = realFetch; }

test('confirmed offline (is_live:false) reports state:offline, not unknown', async () => {
  stub(async (url) => {
    // No KICK_CLIENT_ID set, so this hits the v2 fallback directly.
    assert.match(url, /kick\.com\/api\/v2\/channels\/testchannel/);
    return { ok: true, json: async () => ({ livestream: { is_live: false } }) };
  });
  try {
    const r = await fetchKickState();
    assert.deepEqual(r, { state: 'offline', viewers: null });
  } finally { restore(); }
});

test('a live channel with a parseable count reports state:live', async () => {
  stub(async () => ({ ok: true, json: async () => ({ livestream: { is_live: true, viewer_count: 42 } }) }));
  try {
    const r = await fetchKickState();
    assert.deepEqual(r, { state: 'live', viewers: 42 });
  } finally { restore(); }
});

test('every fetch path failing with no last-good cache reports state:unknown, not offline', async () => {
  stub(async () => { throw new Error('network down'); });
  try {
    const r = await fetchKickState();
    assert.equal(r.state, 'unknown', 'a network failure must never read the same as a confirmed offline answer');
  } finally { restore(); }
});

test('a live-but-unparseable shape still reports state:live (we know it is live, just not the count)', async () => {
  stub(async () => ({ ok: true, json: async () => ({ livestream: { is_live: true, weird_field: 42 } }) }));
  try {
    const r = await fetchKickState();
    assert.equal(r.state, 'live');
    assert.equal(r.viewers, null);
  } finally { restore(); }
});
