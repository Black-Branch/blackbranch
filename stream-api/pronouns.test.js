'use strict';
// Pronouns: ONE parser for every way people type them, ONE writer
// whose SQL keeps an alejo.io fill from ever overwriting a person or a mod, and a
// silent save when someone plainly states their own. Web and stream-ingest used
// to carry two regexes of their own; both now ask the route below.
const test = require('node:test');
const { NATIVE_PLATFORM } = require('./native-platform');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
// The bot's name is the instance key bot.name (env BOT_NAME), read per call.
process.env.BOT_NAME = 'Gadget';
const {
  parsePronounCommand, parseSelfStatement, fromAlejo, createPronouns, PRONOUN_VALUES,
} = require('./pronouns');

test('the three values, exactly (no it/its)', () => {
  assert.deepEqual(PRONOUN_VALUES, ['he/him', 'she/her', 'they/them']);
});

test('every spelling people try sets the value', () => {
  const cases = {
    '!he': 'he/him', '!she': 'she/her', '!they': 'they/them', '!SHE': 'she/her',
    '!he/him': 'he/him', '!she/her': 'she/her', '!they/them': 'they/them',
    '!hehim': 'he/him', '!sheher': 'she/her', '!theythem': 'they/them',
    '!pronouns she': 'she/her', '!pronouns she/her': 'she/her', '!pronoun he/him': 'he/him',
    '!pronouns her': 'she/her', '!pronouns They/Them': 'they/them', '  !pronouns  she/her  ': 'she/her',
    '!pronouns she/they': 'she/her', '!pronouns he/they': 'he/him', '!pronouns sheher': 'she/her',
    '!pronouns she/her pronouns': 'she/her',
  };
  for (const [text, v] of Object.entries(cases)) assert.deepEqual(parsePronounCommand(text), { set: v }, text);
});

test('any / all / none / clear clears (any/all = not set)', () => {
  for (const t of ['!pronouns any', '!pronouns all', '!pronouns none', '!pronouns clear', '!pronouns any/all'])
    assert.deepEqual(parsePronounCommand(t), { clear: true }, t);
});

test('a pronoun command we cannot read gets the usage line, never silence', () => {
  for (const t of ['!pronouns', '!pronouns banana', '!pronouns it/its', '!pronouns xe/xem', '!pronoun'])
    assert.deepEqual(parsePronounCommand(t), { usage: true }, t);
});

test('anything else is not a pronoun command (other ! commands pass through)', () => {
  for (const t of ['!dono', '!karma', '!hello', '!her', '!them', '!he said that', '!she is right', 'she/her', '', null, undefined, '!theyre'])
    assert.equal(parsePronounCommand(t), null, String(t));
});

test('a plain statement of your OWN pronouns is read', () => {
  const cases = {
    'my pronouns are she/her': 'she/her', 'My pronouns are he/him.': 'he/him', 'my pronouns are they': 'they/them',
    'gadget my pronouns are she/her': 'she/her', '@gadget, my pronouns are they/them!': 'they/them',
    'hey gadget, i go by she/her': 'she/her', 'i use they/them': 'they/them', 'I use he/him pronouns': 'he/him',
    'use she/her for me': 'she/her', 'please use she/her for me': 'she/her', "i'm she/her": 'she/her',
    'I’m he/him': 'he/him', 'im they/them': 'they/them', 'i am she/her': 'she/her', 'my pronouns are she/they': 'she/her',
    'my pronouns are she/her please': 'she/her',
  };
  for (const [text, v] of Object.entries(cases)) assert.equal(parseSelfStatement(text), v, text);
});

test('the address it drops is the configured bot name, and none when the name is unset', () => {
  assert.equal(parseSelfStatement('hey ava, i go by she/her', 'Ava'), 'she/her');
  assert.equal(parseSelfStatement('@a.b my pronouns are he/him', 'a.b'), 'he/him', 'the name is matched literally');
  assert.equal(parseSelfStatement('axb my pronouns are he/him', 'a.b'), null, 'a regex character in the name is not a wildcard');
  assert.equal(parseSelfStatement('hey ava, i go by she/her', null), null);
  assert.equal(parseSelfStatement('i go by she/her', null), 'she/her');
});

test('questions, quotes, negations, other people and longer sentences are NOT saved', () => {
  for (const t of [
    'my pronouns are she/her?', 'are my pronouns she/her', 'is it "my pronouns are he/him"',
    'she said “my pronouns are she/her”', 'my pronouns are not he/him', "i'm not she/her",
    'her pronouns are she/her', 'his pronouns are he/him', 'their pronouns are they/them',
    'lol my pronouns are he/him and i hate this', 'my pronouns are she/her but gadget never listens',
    'i use he/him when i talk about casey', 'my pronouns are it/its', 'my pronouns are xe/xem',
    "i'm she", 'i am he', 'i go by she', 'gadget', '', null,
  ]) assert.equal(parseSelfStatement(t), null, String(t));
});

test('alejo.io: only the three, a pair takes the first, anything else is not set', () => {
  assert.equal(fromAlejo({ pronoun_id: 'sheher', alt_pronoun_id: null }), 'she/her');
  assert.equal(fromAlejo({ pronoun_id: 'hehim' }), 'he/him');
  assert.equal(fromAlejo({ pronoun_id: 'theythem', alt_pronoun_id: 'sheher' }), 'they/them');
  assert.equal(fromAlejo({ pronoun_id: 'sheher', alt_pronoun_id: 'theythem' }), 'she/her');
  for (const id of ['any', 'itits', 'faefaer', 'other', 'xexem', '', undefined]) assert.equal(fromAlejo({ pronoun_id: id }), null, String(id));
  assert.equal(fromAlejo(null), null);
});

function recordingPool(rowsFor = () => ({ rows: [], rowCount: 1 })) {
  const queries = [];
  return { queries, query: async (sql, params) => { queries.push({ sql, params }); return rowsFor(sql, params); } };
}

test('the precedence lives in the UPDATE: an alejo write needs NULL or alejo as the current source', async () => {
  const pool = recordingPool();
  const p = createPronouns({ pool });
  await p.set('abc', 'she/her', 'alejo');
  const { sql, params } = pool.queries[0];
  assert.match(sql, /UPDATE stream\.users SET pronouns = \$1::text, pronouns_source = \$3::text/);
  // A value with NO source is a person's (older rows carry none), so alejo may only fill a row that is empty AND unowned.
  assert.match(sql, /WHERE id = \$2 AND \(\$3::text <> 'alejo' OR pronouns_source = 'alejo' OR \(pronouns IS NULL AND pronouns_source IS NULL\)\)/);
  assert.deepEqual(params, ['she/her', 'abc', 'alejo']);
});

test('a clear keeps its source, so alejo.io cannot refill someone who chose "not set"', async () => {
  const pool = recordingPool();
  await createPronouns({ pool }).set('abc', null, 'self');
  assert.deepEqual(pool.queries[0].params, [null, 'abc', 'self']);
});

test('set refuses a value or source outside the lists', async () => {
  const p = createPronouns({ pool: recordingPool() });
  await assert.rejects(p.set('abc', 'it/its', 'self'), /bad pronouns/);
  await assert.rejects(p.set('abc', 'she/her', 'gadget'), /bad source/);
});

test('get caches per person for 60 s and a write drops the entry at once', async () => {
  let t = 0; let value = 'he/him';
  const pool = recordingPool((sql) => (/^SELECT/.test(sql) ? { rows: [{ pronouns: value }] } : { rows: [], rowCount: 1 }));
  const p = createPronouns({ pool, now: () => t });
  assert.equal(await p.get('abc'), 'he/him');
  value = 'she/her';
  assert.equal(await p.get('abc'), 'he/him', 'cached');
  t = 61_000;
  assert.equal(await p.get('abc'), 'she/her', 'expired');
  value = 'they/them';
  await p.set('abc', 'they/them', 'self');
  assert.equal(await p.get('abc'), 'they/them', 'a write invalidates');
  assert.equal(await p.get(null), null);
});

test('alejo.io: one claimed lookup per person, the value lands as alejo, never throws', async () => {
  const pool = recordingPool((sql) => (/alejo_checked_at = now\(\)/.test(sql) ? { rows: [{ id: 'abc' }], rowCount: 1 } : { rows: [], rowCount: 1 }));
  const urls = [];
  const fetchImpl = async (url) => { urls.push(url); return { ok: true, json: async () => ({ pronoun_id: 'sheher', alt_pronoun_id: 'theythem' }) }; };
  const p = createPronouns({ pool, fetchImpl });
  assert.equal(await p.maybeAlejo('abc', 'CleoMarsh'), true);
  assert.deepEqual(urls, ['https://api.pronouns.alejo.io/v1/users/cleomarsh']);
  const claim = pool.queries.find((q) => /alejo_checked_at = now\(\)/.test(q.sql)).sql;
  assert.match(claim, /\(pronouns_source = 'alejo' OR \(pronouns IS NULL AND pronouns_source IS NULL\)\)/);
  assert.match(claim, /alejo_checked_at < now\(\) - interval '7 days'/);
  assert.deepEqual(pool.queries.at(-1).params, ['she/her', 'abc', 'alejo']);
  assert.equal(await p.maybeAlejo('abc', 'cleomarsh'), false, 'asked once per process');
  assert.equal(urls.length, 1);
});

test('alejo.io: a name that is not a Twitch login, a lost claim, a 404, a throw or a hang all end quietly', async () => {
  const claimed = (rowCount) => recordingPool((sql) => (/alejo_checked_at = now\(\)/.test(sql) ? { rows: [], rowCount } : { rows: [], rowCount: 1 }));
  let fetches = 0;
  const count = async () => { fetches++; return { ok: false, json: async () => ({}) }; };
  assert.equal(await createPronouns({ pool: claimed(1), fetchImpl: count }).maybeAlejo('a', '日本語'), false);
  assert.equal(await createPronouns({ pool: claimed(1), fetchImpl: count }).maybeAlejo('a', 'x'), false);
  assert.equal(await createPronouns({ pool: claimed(0), fetchImpl: count }).maybeAlejo('a', 'someone'), false, 'checked this week / not ours');
  assert.equal(fetches, 0);
  assert.equal(await createPronouns({ pool: claimed(1), fetchImpl: count }).maybeAlejo('a', 'someone'), false, '404');
  assert.equal(await createPronouns({ pool: claimed(1), fetchImpl: async () => { throw new Error('down'); } }).maybeAlejo('a', 'someone'), false);
  const hang = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('timeout'))));
  const started = Date.now();
  assert.equal(await createPronouns({ pool: claimed(1), fetchImpl: hang, alejoTimeoutMs: 50 }).maybeAlejo('a', 'someone'), false);
  assert.ok(Date.now() - started < 1000);
});

function routes(p) {
  const r = {};
  const reg = (m) => (route, ...h) => { r[`${m} ${route}`] = h[h.length - 1]; };
  p.registerPronounRoutes({ post: reg('POST') }, { requireInternal: (q, s, n) => n(), wrap: (fn) => fn });
  return async (key, body) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await r[key]({ body }, res);
    return res;
  };
}

test('POST /identity/pronoun-command answers matched / usage / not-ours, and saves as self', async () => {
  const pool = recordingPool();
  const call = routes(createPronouns({ pool, resolveCanonical: async (c, m) => c || (m ? 'fromMatrix' : null) }));
  assert.deepEqual((await call('POST /identity/pronoun-command', { text: '!dono', canonicalId: 'abc' })).body, { matched: false });
  assert.deepEqual((await call('POST /identity/pronoun-command', { text: '!pronouns banana', canonicalId: 'abc' })).body, { matched: true, usage: true });
  assert.equal(pool.queries.length, 0, 'nothing written for a usage answer');
  assert.deepEqual((await call('POST /identity/pronoun-command', { text: '!she', matrixId: '@k:site.test' })).body, { matched: true, pronouns: 'she/her', canonicalId: 'fromMatrix' });
  assert.deepEqual(pool.queries.at(-1).params, ['she/her', 'fromMatrix', 'self']);
  assert.deepEqual((await call('POST /identity/pronoun-command', { text: '!pronouns any', canonicalId: 'abc' })).body, { matched: true, pronouns: null, canonicalId: 'abc' });
  assert.equal((await call('POST /identity/pronoun-command', { text: '!she' })).statusCode, 404);
});

test('a brand-new site account (no identity yet) is created by its first pronoun command, like its first message', async () => {
  const pool = recordingPool();
  const created = [];
  const call = routes(createPronouns({ pool, resolveCanonical: async () => null,
    resolveOrCreate: async (platform, id, name) => { created.push([platform, id, name]); return 'fresh'; } }));
  assert.deepEqual((await call('POST /identity/pronoun-command', { text: '!she', matrixId: '@newbie:site.test', username: 'New Bie' })).body,
    { matched: true, pronouns: 'she/her', canonicalId: 'fresh' });
  assert.deepEqual(created, [[NATIVE_PLATFORM, '@newbie:site.test', 'New Bie']]);
  assert.deepEqual(pool.queries.at(-1).params, ['she/her', 'fresh', 'self']);
  await call('POST /identity/pronouns', { matrixId: '@other:site.test', pronouns: 'he/him' });
  assert.deepEqual(created.at(-1), [NATIVE_PLATFORM, '@other:site.test', 'other'], 'no name given → the Matrix localpart');
  assert.equal(created.length, 2);
  await call('POST /identity/pronoun-command', { text: '!pronouns banana', matrixId: '@x:site.test' });
  assert.equal(created.length, 2, 'a usage answer creates nothing');
});

test('a mod (web checks the role; the route is internal) sets someone through the same parser, as mod', async () => {
  const pool = recordingPool();
  const call = routes(createPronouns({ pool, resolveCanonical: async (c) => c }));
  assert.deepEqual((await call('POST /identity/pronoun-command', { text: '!pronouns she', canonicalId: 'abc', source: 'mod' })).body, { matched: true, pronouns: 'she/her', canonicalId: 'abc' });
  assert.deepEqual(pool.queries.at(-1).params, ['she/her', 'abc', 'mod']);
  assert.equal((await call('POST /identity/pronoun-command', { text: '!she', canonicalId: 'abc', source: 'alejo' })).statusCode, 400);
});

test('a mod names someone: resolved by who CHATTED under that name (30 days), never the first-ever holder of it', async () => {
  const people = (ids) => recordingPool((sql) => (/FROM stream\.chat_log/.test(sql) ? { rows: ids.map((user_id) => ({ user_id })), rowCount: ids.length } : { rows: [], rowCount: 1 }));
  let pool = people(['abc']);
  let call = routes(createPronouns({ pool }));
  assert.deepEqual((await call('POST /identity/pronoun-command', { text: '!pronouns she', name: '@Kate', source: 'mod' })).body,
    { matched: true, pronouns: 'she/her', canonicalId: 'abc' });
  const lookup = pool.queries.find((q) => /FROM stream\.chat_log/.test(q.sql));
  assert.match(lookup.sql, /SELECT DISTINCT user_id FROM stream\.chat_log\s+WHERE created_at > now\(\) - interval '30 days' AND lower\(username\) = \$1 AND NOT is_bot\s+LIMIT 2/);
  assert.deepEqual(lookup.params, ['kate']);
  assert.doesNotMatch(lookup.sql, /nameidx/);
  pool = people(['abc', 'def']);
  call = routes(createPronouns({ pool }));
  assert.deepEqual((await call('POST /identity/pronoun-command', { text: '!pronouns she', name: 'kate', source: 'mod' })).body, { matched: true, ambiguous: true });
  assert.equal(pool.queries.filter((q) => /^UPDATE/.test(q.sql)).length, 0, 'nothing written for an ambiguous name');
  pool = people([]);
  call = routes(createPronouns({ pool }));
  assert.deepEqual((await call('POST /identity/pronoun-command', { text: '!pronouns she', name: 'nobody', source: 'mod' })).body, { matched: true, notFound: true });
  pool = people(['abc']);
  call = routes(createPronouns({ pool }));
  assert.equal((await call('POST /identity/pronoun-command', { text: '!she', name: 'kate' })).statusCode, 400, 'only a mod names someone else');
});

test('a mod\'s name lookup can be asked WITHOUT a write (resolveOnly): web checks the moderation ceiling on the person first', async () => {
  const people = (ids) => recordingPool((sql) => (/FROM stream\.chat_log/.test(sql) ? { rows: ids.map((user_id) => ({ user_id })), rowCount: ids.length } : { rows: [], rowCount: 1 }));
  const pool = people(['abc']);
  const call = routes(createPronouns({ pool }));
  assert.deepEqual((await call('POST /identity/pronoun-command', { text: '!pronouns she', name: 'kate', source: 'mod', resolveOnly: true })).body,
    { matched: true, canonicalId: 'abc', resolveOnly: true });
  assert.equal(pool.queries.filter((q) => /^\s*UPDATE/.test(q.sql)).length, 0, 'a resolveOnly lookup wrote pronouns');
  const amb = routes(createPronouns({ pool: people(['abc', 'def']) }));
  assert.deepEqual((await amb('POST /identity/pronoun-command', { text: '!pronouns she', name: 'kate', source: 'mod', resolveOnly: true })).body, { matched: true, ambiguous: true });
  assert.equal((await call('POST /identity/pronoun-command', { text: '!she', canonicalId: 'abc', source: 'mod', resolveOnly: true })).statusCode, 400,
    'resolveOnly is for a name lookup only');
});

test('POST /identity/pronouns takes self or mod, never alejo from a caller', async () => {
  const pool = recordingPool();
  const call = routes(createPronouns({ pool, resolveCanonical: async (c) => c }));
  assert.equal((await call('POST /identity/pronouns', { canonicalId: 'abc', pronouns: 'she/her', source: 'mod' })).statusCode, 200);
  assert.deepEqual(pool.queries.at(-1).params, ['she/her', 'abc', 'mod']);
  await call('POST /identity/pronouns', { canonicalId: 'abc', pronouns: 'he/him' });
  assert.deepEqual(pool.queries.at(-1).params, ['he/him', 'abc', 'self']);
  assert.equal((await call('POST /identity/pronouns', { canonicalId: 'abc', pronouns: 'she/her', source: 'alejo' })).statusCode, 400);
  assert.equal((await call('POST /identity/pronouns', { canonicalId: 'abc', pronouns: 'it/its' })).statusCode, 400);
});

test('END anchor: identity.js no longer carries a pronoun list or writer of its own', () => {
  const identity = fs.readFileSync(path.join(__dirname, 'identity.js'), 'utf8');
  assert.doesNotMatch(identity, /PRONOUN_SET|app\.post\('\/identity\/pronouns'/);
  const src = fs.readFileSync(path.join(__dirname, 'pronouns.js'), 'utf8');
  assert.match(src.slice(-200), /module\.exports = \{[^}]*createPronouns[^}]*\};\s*$/);
});
