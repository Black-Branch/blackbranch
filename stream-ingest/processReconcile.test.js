// Settings reconcile + GET /health, run for real: index.js against a stand-in stream-api.
//
// The install starts with no platform. An admin saves a stream.place account in the Admin Panel:
// stream-api sends `config_changed` on the internal socket, and the reader must start with no
// restart (not only at boot and on the first settings load).
// Cleared, it stops. Saved again and the process restarted — twice, the first signal hitting the
// old process — it comes back up reading. /health says each state on the way, and the Credentials
// report stops calling the saved account "pending restart" once the reader runs with it.
//
// The stream.place reader really dials stream.place for the made-up account; whether that
// connects does not matter here (the reader is `running` once started — it reconnects on its own).
// Run: node --test processReconcile.test.js
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
const DID = 'did:plc:caseyreconciletest';
const until = async (cond, ms, what) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

test('🔴 a platform saved after boot starts without a restart, cleared it stops, and a restart (twice) brings it back — /health says so', async (t) => {
  const stored = {};
  const reports = [];
  const server = createServer((req, res) => {
    const url = req.url || '';
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      if (url === '/config/report') { try { reports.push(JSON.parse(raw)); } catch { /* not JSON */ } }
      const body = url.startsWith('/config/secrets') ? { values: {} } : url === '/config' ? { values: { ...stored } }
        : url === '/content' ? { content: {} } : { ok: true };
      res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify(body));
    });
  });
  const wss = new WebSocketServer({ server });
  let sockets = [];
  wss.on('connection', (ws) => { sockets.push(ws); ws.on('close', () => { sockets = sockets.filter((s) => s !== ws); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const apiPort = server.address().port;
  const healthPort = await freePort();
  const changed = (key) => { for (const ws of sockets) ws.send(JSON.stringify({ type: 'config_changed', keys: [key] })); };
  const health = async () => {
    try { return await (await fetch(`http://127.0.0.1:${healthPort}/health`, { signal: AbortSignal.timeout(2000) })).json(); } catch { return null; }
  };

  const cwd = mkdtempSync(path.join(tmpdir(), 'ingest-reconcile-'));
  const env = { PATH: process.env.PATH, HOME: cwd, STREAM_API_URL: `http://127.0.0.1:${apiPort}`, STREAM_API_SECRET: 'test-secret',
    SITE_ORIGIN: 'https://site.test', SITE_NAME: 'Reconcile Test', POLLER_ENABLED: '0',
    INGEST_HEALTH_PORT: String(healthPort), INGEST_HEALTH_BIND: '127.0.0.1' };
  let child = null;
  let out = '';
  let exited = null;
  const spawnIngest = () => {
    exited = null;
    child = spawn(process.execPath, [path.join(here, 'index.js')], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const me = child;
    me.on('exit', (code, signal) => { if (me === child) exited = { code, signal }; });
  };
  const stopIngest = async () => {
    child.kill('SIGTERM');
    await until(() => exited, 15_000, 'the process to stop');
    assert.deepEqual(exited, { code: 0, signal: null }, out);
  };
  t.after(() => {
    if (child && !exited) child.kill('SIGKILL');
    wss.close(); server.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  // 1. A fresh install: nothing set up, healthy (nothing is asked for).
  spawnIngest();
  await until(async () => (await health())?.readers?.streamplace?.state === 'off' && sockets.length > 0, 20_000, 'the first /health and socket');
  const h0 = await health();
  assert.equal(h0.ok, true, JSON.stringify(h0));
  assert.deepEqual(Object.keys(h0.readers).sort(), ['kick', 'streamplace', 'twitch', 'youtube']);
  assert.equal(h0.bot, 'off');

  // 2. The admin saves the account: config_changed → the reader starts, no restart.
  stored['platform.streamplace.did'] = DID;
  changed('platform.streamplace.did');
  await until(async () => (await health())?.readers?.streamplace?.state === 'running', 15_000, 'stream.place running after the save');
  assert.equal(exited, null, 'the process restarted itself');
  assert.equal((await health()).ok, true);
  assert.match(out, /\[main\] streamplace started/);
  await until(() => reports.some((r) => r.keys?.['platform.streamplace.did']?.display === DID), 10_000, 'the report to show the account as applied');

  // 3. Cleared: it stops.
  delete stored['platform.streamplace.did'];
  changed('platform.streamplace.did');
  await until(async () => (await health())?.readers?.streamplace?.state === 'off', 15_000, 'stream.place off after clearing');
  assert.match(out, /\[main\] streamplace stopped \(switched off in the settings\)/);

  // 4. Saved again, then restarted twice: it comes back up reading at boot each time.
  stored['platform.streamplace.did'] = DID;
  changed('platform.streamplace.did');
  await until(async () => (await health())?.readers?.streamplace?.state === 'running', 15_000, 'stream.place running again');
  for (let n = 1; n <= 2; n += 1) {
    await stopIngest();
    spawnIngest();
    await until(async () => (await health())?.readers?.streamplace?.state === 'running', 20_000, `stream.place running after restart ${n}`);
  }
  await stopIngest();
});
