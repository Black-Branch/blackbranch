// The public chat socket never carries a canonical id (owner decision on the cross-platform
// link, 2026-10-17). One canonical per person rode every chat frame and the `history` replay, and
// the socket has no sign-in, so anyone could group a person's Twitch, YouTube, Kick and site lines
// by it. The frames now carry a per-platform `publicId` (pseudonym.js); the canonical stays on the
// frame for the install's own internal sockets (the chat bot keys its memory on it) and the hub
// strips it, at ANY depth, from what a public socket receives — live frames, the `history` replay
// and the connect-time state frames alike. One REAL socket of each kind.
//
// Run: node --test ws-public-ids.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const { createWsHub, makeHistoryCache } = require('./ws-hub');

const INTERNAL = 'Bearer test-secret';

function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', r)); }
function collect(url, headers, ms = 300) {
  return new Promise((resolve, reject) => {
    const got = [];
    const ws = new WebSocket(url, { headers });
    ws.on('message', (d) => got.push(String(d)));
    ws.on('error', reject);
    ws.on('open', () => setTimeout(() => {
      ws.close();
      // The hub's hello comes first (M4), saying whether this socket was taken as internal.
      assert.deepEqual(JSON.parse(got[0]), { type: 'hello', internal: !!(headers && headers.Authorization === INTERNAL) });
      resolve(got.slice(1));
    }, ms));
  });
}

test('a public socket never receives canonicalId; an internal socket does', async () => {
  const server = http.createServer();
  const hub = createWsHub({
    server,
    isInternalUpgrade: (h) => h.authorization === INTERNAL,
    connectFrames: [() => ({ type: 'probe', nested: { canonicalId: '0a1b2c3d4e5f', keep: 1 } })],
  });
  hub.bufferPush({ type: 'message', id: 1, platform: 'twitch', publicId: 'pAAAA', canonicalId: '0a1b2c3d4e5f', username: 'casey', message: 'hi' });
  await listen(server);
  const url = `ws://127.0.0.1:${server.address().port}`;
  try {
    const pubP = collect(url, {});
    const intP = collect(url, { Authorization: INTERNAL });
    await new Promise((r) => setTimeout(r, 120));
    hub.broadcast({ type: 'message', id: 2, platform: 'youtube', publicId: 'pBBBB', canonicalId: '0a1b2c3d4e5f', username: 'casey', message: 'yo' });
    const [pub, int] = await Promise.all([pubP, intP]);

    assert.equal(pub.length, 3, 'history + connect frame + one live frame');
    for (const raw of pub) assert.ok(!raw.includes('canonicalId') && !raw.includes('0a1b2c3d4e5f'), `public socket got a canonical: ${raw}`);
    const [hist, probe, live] = pub.map((s) => JSON.parse(s));
    assert.equal(hist.messages[0].publicId, 'pAAAA');
    assert.equal(probe.nested.keep, 1);
    assert.equal(live.publicId, 'pBBBB');

    const intLive = JSON.parse(int[int.length - 1]);
    assert.equal(intLive.canonicalId, '0a1b2c3d4e5f', 'the internal socket (the chat bot) still gets the canonical');
    assert.equal(JSON.parse(int[0]).messages[0].canonicalId, '0a1b2c3d4e5f');
  } finally {
    hub.wss.close();
    await new Promise((r) => server.close(r));
  }
});

test('the history cache keeps two strings and one invalidate clears both', () => {
  const buf = [{ id: 1, canonicalId: 'c1', publicId: 'p1' }];
  const cache = makeHistoryCache(buf);
  assert.ok(!cache.get(false).includes('c1'));
  assert.ok(cache.get(true).includes('c1'));
  buf.push({ id: 2, canonicalId: 'c2', publicId: 'p2' });
  cache.invalidate();
  assert.ok(cache.get(false).includes('p2') && !cache.get(false).includes('c2'));
  assert.ok(cache.get(true).includes('c2'));
});
