// Twitch token manager: single-flight refresh + rotation persistence.
//
// The two exposures:
//   • Without single-flight: poller.js (401 retry) and the chat client's
//     reconnect tokenProvider both call refreshAccessToken at expiry — the exact
//     moment both notice at once. The provider ROTATES the refresh token on use,
//     so a second concurrent call would spend an already-consumed refresh token.
//   • With rotation only in memory: a restart re-reads TWITCH_REFRESH_TOKEN from
//     .env — a token possibly revoked by rotation hours ago — and the failure
//     lands at the NEXT expiry, hours later, far from its cause.
//
// Persistence contract: rotations are written to a state file (runtime
// config/, which deploys exclude). The file records the .env refresh token it
// superseded — if .env changed since (re-minted by hand), .env wins and the
// stale file is ignored.
//
// Run: node --test lib/twitchToken.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let importSeq = 0;
// Module state (tokens, seeded flag) is bound at import — each test gets a
// fresh instance via a cache-busting specifier.
async function freshModule({ env, stateFile } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'twtok-'));
  const statePath = join(dir, 'twitch-token.json');
  if (stateFile) writeFileSync(statePath, JSON.stringify(stateFile));
  process.env.TWITCH_OAUTH_TOKEN = env?.access ?? 'seed-access';
  process.env.TWITCH_REFRESH_TOKEN = env?.refresh ?? 'env-refresh';
  process.env.TWITCH_TOKEN_STATE_PATH = statePath;
  importSeq += 1;
  const mod = await import(`./twitchToken.js?fresh=${importSeq}`);
  return { mod, statePath };
}

const refreshOk = (token, refresh) => new Response(
  JSON.stringify(refresh ? { token, refresh } : { token }),
  { status: 200, headers: { 'content-type': 'application/json' } });

test('concurrent refresh calls share ONE request (single-flight)', async () => {
  const { mod } = await freshModule();
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  globalThis.fetch = async () => {
    calls += 1;
    await gate;
    return refreshOk('new-access');
  };
  const p1 = mod.refreshAccessToken();
  const p2 = mod.refreshAccessToken();
  release();
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(calls, 1, 'two concurrent callers each spent the (rotating) refresh token');
  assert.equal(a, 'new-access');
  assert.equal(b, 'new-access');
});

test('sequential refreshes still each hit the provider (single-flight is not a cache)', async () => {
  const { mod } = await freshModule();
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return refreshOk(`access-${calls}`); };
  assert.equal(await mod.refreshAccessToken(), 'access-1');
  assert.equal(await mod.refreshAccessToken(), 'access-2');
  assert.equal(calls, 2);
});

test('a rotated refresh token is persisted with the .env value it supersedes', async () => {
  const { mod, statePath } = await freshModule({ env: { refresh: 'env-refresh' } });
  globalThis.fetch = async () => refreshOk('new-access', 'rotated-refresh');
  await mod.refreshAccessToken();
  assert.ok(existsSync(statePath), 'rotation was not persisted — a restart resurrects the dead token');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(state.refresh, 'rotated-refresh');
  assert.equal(state.envRefresh, 'env-refresh');
});

test('startup prefers the persisted rotation over a stale .env token', async () => {
  const { mod } = await freshModule({
    env: { refresh: 'env-refresh' },
    stateFile: { refresh: 'rotated-refresh', envRefresh: 'env-refresh' },
  });
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(String(url)); return refreshOk('new-access'); };
  await mod.refreshAccessToken();
  assert.equal(urls.length, 1);
  assert.match(urls[0], /rotated-refresh/, 'refresh used the .env token that rotation already revoked');
});

test('a re-minted .env token beats a persisted rotation of the OLD lineage', async () => {
  // A fresh pair minted by hand → .env's refresh no longer matches the one the
  // state file superseded. The file describes a dead lineage; .env wins.
  const { mod } = await freshModule({
    env: { refresh: 'brand-new-env-refresh' },
    stateFile: { refresh: 'rotated-refresh', envRefresh: 'old-env-refresh' },
  });
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(String(url)); return refreshOk('new-access'); };
  await mod.refreshAccessToken();
  assert.match(urls[0], /brand-new-env-refresh/,
    'a stale state file overrode a deliberate re-mint');
});

test('a refresh failure leaves the current access token in place', async () => {
  const { mod } = await freshModule();
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  assert.equal(await mod.refreshAccessToken(), 'seed-access');
});
