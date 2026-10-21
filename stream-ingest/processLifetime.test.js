// The process's lifetime, run for real: index.js against a stand-in stream-api (HTTP + its
// WebSocket), on an install with no platform set up (PLATFORMS=none) — the shape of a fresh install.
//
// There the internal socket to stream-api is the process's ONLY live handle — every timer is
// unref'd — so when stream-api closes it (a restart, an update's two restarts) the event loop
// could empty, node exit 0, and Docker restart-loop it. The process must outlive the socket and
// reconnect.
// Run: node --test processLifetime.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const until = async (cond, ms, what) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

test('🔴 stream-api closing the internal socket does not end the process: it keeps running and reconnects', async (t) => {
  // The stand-in stream-api: an empty settings layer, every other call answered with an empty ok.
  const server = createServer((req, res) => {
    const url = req.url || '';
    const body = url.startsWith('/config/secrets') ? { values: {} } : url === '/config' ? { values: {} }
      : url === '/content' ? { content: {} } : { ok: true };
    // No keep-alive: an idle pooled HTTP connection is a live handle too, and it hid the defect on
    // one run in four (it held the loop open across the reconnect wait by chance).
    res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
    res.end(JSON.stringify(body));
  });
  const wss = new WebSocketServer({ server });
  const sockets = [];
  wss.on('connection', (ws) => { sockets.push(ws); ws.send(JSON.stringify({ type: 'hello' })); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // Its own empty folder as the working directory: no .env of this checkout is read.
  const cwd = mkdtempSync(path.join(tmpdir(), 'ingest-life-'));
  const env = { PATH: process.env.PATH, HOME: cwd, STREAM_API_URL: `http://127.0.0.1:${port}`, STREAM_API_SECRET: 'test-secret',
    SITE_ORIGIN: 'https://site.test', SITE_NAME: 'Life Test', PLATFORMS: 'none', POLLER_ENABLED: '0' };
  const child = spawn(process.execPath, [path.join(here, 'index.js')], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  t.after(() => {
    if (!exited) child.kill('SIGKILL');
    wss.close(); server.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  await until(() => sockets.length >= 1 || exited, 20_000, 'the first socket');
  assert.equal(exited, null, `the process ended before it connected:\n${out}`);
  // stream-api restarts, three times (an update restarts it twice): each time the socket closes from
  // its side, and the reconnect waits 5 s (lib/instanceConfig.js RECONNECT_MS) — the process must be
  // alive through every wait. Three, because a stray handle (an outbound fetch still in flight) can
  // hold the loop open across one wait by chance; it cannot be counted on three times.
  for (let n = 1; n <= 3; n += 1) {
    sockets[n - 1].close(1012, 'restarting');
    await until(() => sockets.length > n || exited, 15_000, `socket ${n + 1}`).catch((e) => { if (!exited) throw e; });
    assert.equal(exited, null, `the process EXITED (${JSON.stringify(exited)}) when stream-api closed its socket (restart ${n}):\n${out}`);
  }
  assert.equal(sockets.length, 4, 'it connected again after every restart');
  // The plugin line is one plain statement on every install, never an alarm-looking "not present".
  assert.match(out, /^\[main\] site plugin: (loaded|none)$/m, out);
  assert.doesNotMatch(out, /owner plugin/, out);

  // And it still stops cleanly when asked.
  child.kill('SIGTERM');
  await until(() => exited, 10_000, 'the process to stop');
  assert.deepEqual(exited, { code: 0, signal: null }, out);
});
