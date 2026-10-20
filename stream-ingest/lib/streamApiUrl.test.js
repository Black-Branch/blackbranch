// STREAM_API_URL has no default (lib/streamApiUrl.js): a default would let an
// unset value silently point every caller at a host that may not run the
// service. These pin the rule: a missing value is an error that names itself — at boot (a real process exit, below), in the
// request client, and as a logged drop in the never-rejecting ops relay.
//
// Run: node --test lib/streamApiUrl.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { streamApiBase, StreamApiUrlMissing } = await import('./streamApiUrl.js');
const api = await import('./api.js');
const { notifyOps } = await import('./ops.js');

const realFetch = global.fetch;

async function withEnv(value, fn) {
  const before = process.env.STREAM_API_URL;
  if (value === undefined) delete process.env.STREAM_API_URL;
  else process.env.STREAM_API_URL = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.STREAM_API_URL;
    else process.env.STREAM_API_URL = before;
  }
}

test('unset or blank → a named error, never a fallback host', async () => {
  for (const v of [undefined, '', '   ']) {
    await withEnv(v, () => assert.throws(() => streamApiBase(), StreamApiUrlMissing));
  }
});

test('set → used as given, trailing slash trimmed', async () => {
  await withEnv('http://127.0.0.1:3001/', () => assert.equal(streamApiBase(), 'http://127.0.0.1:3001'));
});

test('the request client rejects with the named error and never calls fetch', async () => {
  let called = 0;
  global.fetch = async () => { called++; return new Response('{}'); };
  try {
    await withEnv(undefined, async () => {
      await assert.rejects(() => api.postChat({ text: 'x' }), StreamApiUrlMissing);
      await assert.rejects(() => api.getSupportNext(), StreamApiUrlMissing);
    });
  } finally { global.fetch = realFetch; }
  assert.equal(called, 0, 'an unset URL must not reach the network at all');
});

test('the ops relay still never rejects — it logs the drop and resolves false', async () => {
  let called = 0;
  const errors = [];
  const realError = console.error;
  global.fetch = async () => { called++; return new Response('{}'); };
  console.error = (...a) => errors.push(a.join(' '));
  try {
    await withEnv(undefined, async () => {
      assert.equal(await notifyOps('k', 't', 'm'), false);
    });
  } finally { global.fetch = realFetch; console.error = realError; }
  assert.equal(called, 0);
  assert.ok(errors.some((l) => /STREAM_API_URL is not set/.test(l)), 'the drop must be logged, not silent');
});

test('a real boot with no STREAM_API_URL exits non-zero and says why', () => {
  // ONE REAL EXECUTION: a lifecycle claim needs one.
  // cwd is an empty temp dir so dotenv finds no .env to fill the value in.
  const env = { ...process.env };
  delete env.STREAM_API_URL;
  const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'index.js')], {
    cwd: mkdtempSync(join(tmpdir(), 'ingest-boot-')),
    env: { ...env, PLATFORMS: '', GADGET_ENABLED: '0' },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(r.status, 1, `expected exit 1, got ${r.status} (signal ${r.signal})\n${r.stderr}`);
  assert.match(r.stderr, /FATAL: STREAM_API_URL is not set/);
});

test('the socket URL follows STREAM_API_URL unless STREAM_WS_URL says otherwise', async () => {
  const { streamApiWsUrl } = await import('./streamApiUrl.js');
  assert.equal(streamApiWsUrl({ STREAM_API_URL: 'http://127.0.0.1:3101/' }), 'ws://127.0.0.1:3101');
  assert.equal(streamApiWsUrl({ STREAM_API_URL: 'https://api.example.tv' }), 'wss://api.example.tv');
  assert.equal(streamApiWsUrl({ STREAM_API_URL: 'http://x:1', STREAM_WS_URL: 'ws://y:2' }), 'ws://y:2');
  assert.throws(() => streamApiWsUrl({}), StreamApiUrlMissing);
});
