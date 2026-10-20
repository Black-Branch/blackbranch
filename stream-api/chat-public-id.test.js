'use strict';

// Every chat frame carries the sender's per-platform PUBLIC id (pseudonym.js) — what the site's
// per-person features key on now that the canonical id leaves the public socket (ws-hub strips it,
// ws-public-ids.test.js). One person chatting on Twitch, YouTube and the site shows three ids that
// nothing outside the install ties together. Executed through the routes with a recording pool.
process.env.STREAM_API_SECRET = process.env.STREAM_API_SECRET || 'test-secret-for-public-ids';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createChat } = require('./chat');
const { parsePublicId } = require('./pseudonym');

function harness() {
  const frames = [];
  const pool = {
    query: async (sql) => {
      if (/WITH ins AS/.test(sql)) return { rows: [{ id: 1, first_msg: false }], rowCount: 1 };
      if (/AS first_msg/.test(sql)) return { rows: [{ first_msg: false }], rowCount: 1 };
      return { rows: [{ id: 1 }], rowCount: 1 };
    },
  };
  const chat = createChat({
    pool, resolveOrCreate: async () => '0a1b2c3d4e5f', resolveCanonical: async () => '0a1b2c3d4e5f',
    pronouns: { get: async () => null, set: async () => true, maybeAlejo: () => {} },
    pollEngine: { active: () => false, vote: async () => {} }, msgBuffer: [],
    broadcast: (m) => frames.push(m), bufferPush: () => {},
  });
  const routes = {};
  const reg = (method) => (p, ...h) => { routes[`${method} ${p}`] = h[h.length - 1]; };
  chat.registerChatRoutes(
    { post: reg('POST'), get: reg('GET'), patch: reg('PATCH'), delete: reg('DELETE'), put: reg('PUT') },
    { requireInternal: (req, res, next) => next(), wrap: (fn) => fn },
  );
  const call = async (route, body) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await routes[route]({ body, ip: '127.0.0.1' }, res);
    await new Promise((r) => setImmediate(r));
    return res;
  };
  return { frames, post: (b) => call('POST /chat', b), native: (b) => call('POST /chat/native', b) };
}

test('one person on two platforms and the site: three public ids, each reading back to its platform', async () => {
  const h = harness();
  await h.post({ platform: 'twitch', userId: 'u1', username: 'casey', message: 'hello there' });
  await h.post({ platform: 'youtube', userId: 'UCx', username: 'casey', message: 'hello again' });
  await h.native({ matrixId: '@casey:site.test', username: 'casey', message: 'and from the site' });
  const ids = h.frames.filter((f) => f.type === 'message').map((f) => f.publicId);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3, 'the same person shares a public id across platforms — the link is public again');
  assert.deepEqual(ids.map((id) => parsePublicId(id)?.platform), ['twitch', 'youtube', 'native']);
  for (const id of ids) assert.equal(parsePublicId(id)?.canonical, '0a1b2c3d4e5f');
});

// The frame builders may keep canonicalId for the internal sockets ONLY because the hub strips it
// for every public socket; this pins that the strip list still names it, so a rename of either
// side cannot quietly put the canonical back on the public socket.
test('the canonical id the builders keep is on the hub\'s internal-only list', () => {
  const hub = fs.readFileSync(path.join(__dirname, 'ws-hub.js'), 'utf8');
  assert.match(hub, /const INTERNAL_ONLY_KEYS = new Set\(\[[^\]]*'canonicalId'/);
  const chatSrc = fs.readFileSync(path.join(__dirname, 'chat.js'), 'utf8');
  assert.equal((chatSrc.match(/publicId:\s+publicIdFor\(/g) || []).length, 2, 'both frame builders stamp a public id');
  // vacuity anchor: the file still ends with its export.
  assert.match(chatSrc.trimEnd(), /module\.exports = \{ createChat \};$/);
});
