// Memory's embedder (lib/embeddings.js): the opt-out is asked FIRST and never bypassed, nothing
// is sent anywhere while memory is not 'on', and a failure that will not clear by itself asks
// stream-api to PAUSE memory instead of failing silently message after message.
//
// Hermetic: stream-api AND the embedder are one stubbed global fetch (the adapter calls fetch at
// call time), so nothing leaves the machine and "was the text sent out" is a request log.
//
// Run: node --test lib/embeddingsOptOut.test.js

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { NATIVE_PLATFORM } from './native-platform.js';

process.env.STREAM_API_URL = 'http://stream-api.test';
process.env.OPENAI_API_KEY = 'sk-test';

const { instanceConfig } = await import('./instanceConfig.js');
const { embedMessage, embedText, nativeFrameToRemember } = await import('./embeddings.js');

const DIM = 8;
const ON = { model: 'embed-model', connection: 'openai', dim: DIM, since: '2026-06-22T00:00:00.000Z', status: 'on' };
let world;
const b64 = (n) => Buffer.from(new Float32Array(n).fill(0.25).buffer).toString('base64');

function setWorld(over = {}) {
  world = {
    values: { 'memory.enabled': true, 'memory.state': ON, 'ai.embeddings': { connection: 'openai', model: 'embed-model' } },
    allowed: true, embedStatus: 200, dim: DIM, storeStatus: 200, ...over, calls: [],
  };
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  world.calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/config')) return json({ values: world.values });
  if (url.includes('/config/secrets')) return json({ values: {}, unreadable: [] });
  if (url.endsWith('/content')) return json({ content: {} });
  if (url.endsWith('/memory/allowed')) return world.allowed === 'down' ? new Response('boom', { status: 500 }) : json({ allowed: world.allowed });
  if (url.endsWith('/memory/pause')) return json({ ok: true, paused: true });
  if (url.endsWith('/embedding')) return world.storeStatus === 200 ? json({ ok: true }) : json({ error: 'memory_paused' }, world.storeStatus);
  if (url === 'https://api.openai.com/v1/embeddings') {
    if (world.embedStatus !== 200) return json({ error: { message: 'nope', type: 'x' } }, world.embedStatus);
    return json({ data: [{ index: 0, embedding: b64(world.dim) }], model: 'embed-model', usage: { prompt_tokens: 3 } });
  }
  throw new Error(`unexpected fetch ${url}`);
};

async function load(over) {
  setWorld(over);
  assert.equal(await instanceConfig.load(), true, 'the settings layer did not load from the stub');
  world.calls.length = 0;
}
const hit = (suffix) => world.calls.filter((c) => c.url.endsWith(suffix));
const sentToEmbedder = () => hit('/v1/embeddings').length > 0;
const msg = { source: 'platform', sourceId: 42, username: 'someone', message: 'a message long enough to embed' };

beforeEach(() => setWorld());

test('an allowed message is embedded and stored, with the state\'s model (proves the stub path works)', async () => {
  await load();
  await embedMessage(msg);
  assert.ok(sentToEmbedder(), 'the embedder was never called — the refusals below would be vacuous');
  assert.ok(world.calls[0].url.endsWith('/memory/allowed'), 'the opt-out was not asked FIRST');
  assert.deepEqual(world.calls[0].body, { source: 'platform', source_id: 42, target_name: null });
  const stored = hit('/embedding')[0].body;
  assert.equal(stored.embedding.length, DIM);
  assert.equal(stored.model, 'embed-model');
  assert.equal(hit('/v1/embeddings')[0].body.encoding_format, 'base64', 'not the shape the OpenAI SDK asked for');
});

test('an opted-out person is never sent to the embedder', async () => {
  await load({ allowed: false });
  await embedMessage(msg);
  assert.ok(world.calls.length === 1 && world.calls[0].url.endsWith('/memory/allowed'));
  assert.ok(!sentToEmbedder() && hit('/embedding').length === 0);
});

test('stream-api failing to answer means "not remembered", never "embed anyway"', async () => {
  await load({ allowed: 'down' });
  await assert.rejects(embedMessage(msg));
  assert.ok(!sentToEmbedder() && hit('/embedding').length === 0);
});

test('memory off, paused or unset: nothing is asked, embedded or stored', async () => {
  for (const values of [
    { 'memory.enabled': false, 'memory.state': ON },
    { 'memory.enabled': true, 'memory.state': { ...ON, status: 'paused', pausedReason: 'quota' } },
    { 'memory.enabled': true },
  ]) {
    await load({ values: { ...values, 'ai.embeddings': { connection: 'openai', model: 'embed-model' } } });
    await embedMessage(msg);
    assert.equal(await embedText('a search question'), null);
    assert.equal(world.calls.length, 0, `something was sent with ${JSON.stringify(values)}`);
  }
});

test('a wrong-length vector is never stored and asks for ONE pause (dim_mismatch)', async () => {
  await load({ dim: DIM + 1 });
  await embedMessage(msg);
  await embedMessage({ ...msg, sourceId: 43 });
  assert.equal(hit('/embedding').length, 0);
  const pauses = hit('/memory/pause');
  assert.equal(pauses.length, 1, 'one ask per pause, not one per message');
  assert.deepEqual(pauses[0].body, { reason: 'dim_mismatch' });
});

test('a rejected key asks for a pause (key_rejected); a 5xx does not', async () => {
  await load({ embedStatus: 401 });
  await assert.rejects(embedText('question one'), (e) => e.code === 'key_rejected');
  assert.deepEqual(hit('/memory/pause').map((c) => c.body), [{ reason: 'key_rejected' }]);
  await load({ embedStatus: 503 });
  await assert.rejects(embedText('question two'), (e) => e.code === 'server_error');
  assert.equal(hit('/memory/pause').length, 0, 'a transient failure paused memory');
  assert.equal(hit('/v1/embeddings').length, 3, 'a 5xx is retried twice');
});

test('a store refused because memory paused meanwhile is not an error', async () => {
  await load({ storeStatus: 409 });
  await embedMessage(msg);
  assert.equal(hit('/embedding').length, 1);
});

test('the live feed remembers other people\'s site chat lines only', () => {
  const base = { type: 'message', platform: NATIVE_PLATFORM, id: 7, username: 'a', message: 'four words right here', matrixId: '@a:x' };
  assert.equal(nativeFrameToRemember(base, '@bot:x', 4), true);
  assert.equal(nativeFrameToRemember({ ...base, message: 'three words only' }, '@bot:x', 4), false, 'the word floor');
  assert.equal(nativeFrameToRemember({ ...base, matrixId: '@bot:x' }, '@bot:x', 4), false, 'the bot\'s own line');
  assert.equal(nativeFrameToRemember({ ...base, system: 'donation' }, '@bot:x', 4), false, 'a tip card');
  assert.equal(nativeFrameToRemember({ ...base, deleted: true }, '@bot:x', 4), false, 'a deleted line');
  assert.equal(nativeFrameToRemember({ ...base, platform: 'twitch' }, '@bot:x', 4), false, 'platform chat is the pipeline\'s');
  assert.equal(nativeFrameToRemember({ ...base, id: null }, '@bot:x', 4), false, 'no row id');
  assert.equal(nativeFrameToRemember({ type: 'history', messages: [base] }, '@bot:x', 4), false, 'a history replay is not backfilled');
});
