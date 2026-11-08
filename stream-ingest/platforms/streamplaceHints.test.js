// The stream.place reader's push hints, against a fake stream.place socket: the first livestream
// frame whose record carries `endedAt` notes a stop hint, and a live reading after a non-live one
// notes a live hint (ADR 0134 E7/E11). A hint only wakes the poller (lib/liveHints.js); the ended
// stamp itself is already the certain answer (streamplaceObservation).
//
// The socket replays the latest record on every connect, so a reconnect that replays the same
// ended record is not a new end and notes nothing.
//
// Run: node --test platforms/streamplaceHints.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';

const DID = 'did:plc:hinttest';
process.env.STREAMPLACE_STREAMER_DID = DID;
process.env.STREAMPLACE_STALE_MS = '600000';

const { startStreamplace } = await import('./streamplace.js');
const { onHint, lastHint } = await import('../lib/liveHints.js');

async function waitFor(pred, what, ms = 5000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const URI = (n) => `at://${DID}/place.stream.livestream/${n}`;
const view = (n, record) => JSON.stringify({ $type: 'place.stream.livestream#livestreamView', uri: URI(n), author: { did: DID }, record });
const liveRecord = () => ({ $type: 'place.stream.livestream', title: 'a stream', idleTimeoutSeconds: 300, lastSeenAt: new Date().toISOString() });
const endedRecord = () => ({ ...liveRecord(), lastSeenAt: new Date(Date.now() - 60_000).toISOString(), endedAt: new Date(Date.now() - 30_000).toISOString() });
const viewers = (n) => JSON.stringify({ $type: 'place.stream.livestream#viewerCount', count: n });

async function fakeStreamplace() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const conns = [];
  wss.on('connection', (sock, req) => conns.push({ sock, req }));
  return {
    url: `ws://127.0.0.1:${wss.address().port}/api/websocket/${DID}`,
    conns,
    close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(r); }),
  };
}

function quietConsole() {
  const orig = { log: console.log, warn: console.warn };
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  return { lines, restore: () => Object.assign(console, orig) };
}

test('the ended stamp notes one stop hint; a live reading after it one live hint; a reconnect replaying the same record notes nothing', async () => {
  const server = await fakeStreamplace();
  const out = quietConsole();
  const heard = [];
  const off = onHint((h) => { if (h.platform === 'streamplace') heard.push(h.kind); });
  let h;
  try {
    h = await startStreamplace({ socketUrl: server.url });
    const first = await waitFor(() => server.conns[0], 'connection');
    assert.equal(first.req.url, `/api/websocket/${DID}`);

    // On connect stream.place replays the previous stream's record: ended.
    first.sock.send(view(1, endedRecord()));
    await waitFor(() => heard.length === 1, 'the stop hint');
    assert.deepEqual(heard, ['stop']);
    assert.equal(lastHint('streamplace').kind, 'stop');

    // More ended frames (and a viewer frame) are the same end, not a new one.
    first.sock.send(view(1, endedRecord()));
    first.sock.send(viewers(0));
    // A new stream: its record has no endedAt and was just seen → live, after a non-live reading.
    first.sock.send(view(2, liveRecord()));
    await waitFor(() => heard.length === 2, 'the live hint');
    assert.deepEqual(heard, ['stop', 'live']);
    first.sock.send(view(2, liveRecord()));
    first.sock.send(view(2, endedRecord()));
    await waitFor(() => heard.length === 3, 'the second stop hint');
    assert.deepEqual(heard, ['stop', 'live', 'stop'], 'a repeat live frame notes nothing; the new end notes one stop');

    // A reconnect: the socket replays the same ended record. Not a new end.
    first.sock.close();
    const second = await waitFor(() => server.conns[1], 'the reconnect', 4000);
    second.sock.send(view(2, endedRecord()));
    await waitFor(() => h.getObservation().evidence === 'ended-stamp', 'the replayed record read');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(heard, ['stop', 'live', 'stop']);
  } finally {
    off();
    h?.stop();
    out.restore();
    await server.close();
  }
});

test('an idle record (seen too long ago, no endedAt) notes no stop hint: only the ended stamp does', async () => {
  const server = await fakeStreamplace();
  const out = quietConsole();
  const heard = [];
  const off = onHint((h) => { if (h.platform === 'streamplace') heard.push(h.kind); });
  let h;
  try {
    h = await startStreamplace({ socketUrl: server.url });
    const conn = await waitFor(() => server.conns[0], 'connection');
    conn.sock.send(view(3, { ...liveRecord(), lastSeenAt: new Date(Date.now() - 900_000).toISOString() }));
    await waitFor(() => h.getObservation().evidence === 'record-idle', 'the idle record read');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(heard, []);
  } finally {
    off();
    h?.stop();
    out.restore();
    await server.close();
  }
});
