'use strict';

// The bot's account is CONFIGURED (instance key bot.matrixId) — there is no hardcoded default, so the test says which account is the bot.
process.env.BOT_MATRIX_ID = '@helperbot:site.test';
// …and its name (bot.name), which a statement addressed to it ("gadget my pronouns are …") drops.
process.env.BOT_NAME = 'Gadget';
// Pronouns on the chat path: every chat frame carries the sender's
// pronouns so the site can draw ♂ ♀ ⚲; a plain statement of one's own pronouns is
// saved silently BEFORE the broadcast (so Gadget's lookup for his reply already
// sees it); Twitch chatters are offered to alejo.io, un-awaited. Executed through
// the routes with a recording pool.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createChat } = require('./chat');

function harness({ current = null } = {}) {
  const calls = { set: [], alejo: [], order: [] };
  const frames = [];
  const pronouns = {
    get: async () => current,
    set: async (cid, v, source) => { calls.set.push([cid, v, source]); calls.order.push('set'); current = v; return true; },
    maybeAlejo: (cid, login) => { calls.alejo.push([cid, login]); return new Promise(() => {}); },
  };
  const pool = { query: async () => ({ rows: [{ id: 1 }], rowCount: 1 }) };
  const chat = createChat({
    pool, resolveOrCreate: async () => 'abc', resolveCanonical: async () => 'abc', pronouns,
    pollEngine: { active: () => false, vote: async () => {} }, msgBuffer: [],
    broadcast: (m) => { calls.order.push('broadcast'); frames.push(m); }, bufferPush: () => {},
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
  return { calls, frames, post: (b) => call('POST /chat', b), native: (b) => call('POST /chat/native', b) };
}

const plat = (over = {}) => ({ platform: 'youtube', userId: 'u1', username: 'kate', message: 'hello there', ...over });
const site = (over = {}) => ({ matrixId: '@kate:site.test', username: 'kate', message: 'hello there', ...over });

test('a platform frame carries the sender\'s pronouns; none set → no field', async () => {
  const h = harness({ current: 'she/her' });
  await h.post(plat());
  assert.equal(h.frames[0].pronouns, 'she/her');
  const n = harness();
  await n.post(plat());
  assert.equal('pronouns' in n.frames[0], false);
});

test('a site frame carries them too', async () => {
  const h = harness({ current: 'they/them' });
  await h.native(site());
  assert.equal(h.frames.at(-1).pronouns, 'they/them');
});

test('"my pronouns are she/her" is saved as self BEFORE the broadcast, and that same frame shows it', async () => {
  const h = harness();
  await h.post(plat({ message: 'gadget my pronouns are she/her' }));
  assert.deepEqual(h.calls.set, [['abc', 'she/her', 'self']]);
  assert.deepEqual(h.calls.order, ['set', 'broadcast']);
  assert.equal(h.frames[0].pronouns, 'she/her');
  const s = harness();
  await s.native(site({ message: 'my pronouns are he/him' }));
  assert.deepEqual(s.calls.set, [['abc', 'he/him', 'self']]);
});

test('a bot line, Gadget\'s own site line, an encrypted line and ordinary chat never save', async () => {
  const h = harness();
  await h.post(plat({ message: 'my pronouns are she/her', isBot: true }));
  await h.post(plat({ message: 'she said my pronouns are she/her' }));
  await h.native(site({ matrixId: '@helperbot:site.test', message: 'my pronouns are he/him' }));
  await h.native(site({ message: 'my pronouns are he/him', encryptedText: 'x' }));
  assert.deepEqual(h.calls.set, []);
});

test('Twitch chatters are offered to alejo.io with their login, un-awaited; other platforms and bots are not', async () => {
  const h = harness();
  const res = await h.post(plat({ platform: 'twitch', username: 'CleoMarsh', login: 'cleomarsh' }));
  assert.ok(res.body, 'answered although the lookup never settles');
  assert.deepEqual(h.calls.alejo, [['abc', 'cleomarsh']]);
  await h.post(plat({ platform: 'twitch', username: 'NoLoginField' }));
  assert.deepEqual(h.calls.alejo.at(-1), ['abc', 'nologinfield'], 'falls back to the lowercased name');
  await h.post(plat({ platform: 'kick' }));
  await h.post(plat({ platform: 'twitch', isBot: true, login: 'gadget' }));
  assert.equal(h.calls.alejo.length, 2);
});

test('wiring: index.js builds the one pronouns module, registers its routes and hands it to chat', () => {
  const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  assert.match(src, /const pronouns = createPronouns\(\{ pool, resolveCanonical, resolveOrCreate \}\);/);
  assert.match(src, /pronouns\.registerPronounRoutes\(app, \{ requireInternal, wrap \}\);/);
  assert.match(src, /createChat\(\{ pool, resolveOrCreate, resolveCanonical, pronouns, banHold, pollEngine,/);
  const chat = fs.readFileSync(path.join(__dirname, 'chat.js'), 'utf8');
  assert.match(chat.slice(-120), /module\.exports = \{ createChat \};\s*$/, 'END anchor');
});
