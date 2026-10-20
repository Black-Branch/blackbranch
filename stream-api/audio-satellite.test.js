'use strict';
// Real-execution tests for the audio satellite: the server is
// spawned as an actual child process — the lifecycle rule, nothing here mocks
// the HTTP or process layer. pw-play is stubbed with a shell script (env
// SATELLITE_PLAY_CMD exists for exactly this) that logs its argv and sleeps,
// so "drain semantics" are asserted by wall-clock: the long-poll body must not
// complete before the stub exits.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, 'audio-satellite.js');
const STUB_MS = 400;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'satellite-test-'));
const argLog = path.join(tmp, 'args.log');
const stub = path.join(tmp, 'fake-play.sh');
fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> ${argLog}\nsleep ${STUB_MS / 1000}\n`);
fs.chmodSync(stub, 0o755);
const clip = path.join(tmp, 'clip.bin');
fs.writeFileSync(clip, Buffer.alloc(64, 7));

const children = [];
function startServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, SATELLITE_PORT: '0', SATELLITE_PLAY_CMD: stub, ...env },
    });
    children.push(child);
    let out = '';
    child.stdout.on('data', (c) => {
      out += c;
      const m = out.match(/listening on (\d+)/);
      if (m) resolve({ child, port: Number(m[1]) });
    });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`server exited early (${code}): ${out}`)));
  });
}

test('audio satellite', async (t) => {
  const { port } = await startServer({});
  const base = `http://127.0.0.1:${port}`;

  await t.test('health responds', async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });

  await t.test('play long-polls until the player exits (drain), passes sink, cleans up', async () => {
    const started = Date.now();
    const res = await fetch(`${base}/play?sink=test-sink`, { method: 'POST', body: fs.readFileSync(clip) });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('x-play-id'), 'play id must be flushed in headers');
    const out = await res.json(); // the long-poll
    const elapsed = Date.now() - started;
    assert.equal(out.done, true);
    assert.equal(out.killed, false);
    assert.ok(elapsed >= STUB_MS - 50, `body completed in ${elapsed}ms — before the sink drained`);
    const argv = fs.readFileSync(argLog, 'utf8');
    assert.match(argv, /--target=test-sink /, 'sink must reach the player as --target');
    const played = argv.trim().split(' ').pop();
    assert.ok(!fs.existsSync(played), 'temp audio file must be deleted after playback');
  });

  await t.test('DELETE /play/<id> kills mid-play', async () => {
    const started = Date.now();
    const res = await fetch(`${base}/play`, { method: 'POST', body: fs.readFileSync(clip) });
    const id = res.headers.get('x-play-id');
    const killRes = await fetch(`${base}/play/${id}`, { method: 'DELETE' });
    assert.equal(killRes.status, 200);
    const out = await res.json();
    assert.equal(out.killed, true);
    assert.ok(Date.now() - started < STUB_MS - 50, 'killed play must end before full duration');
  });

  await t.test('rejects an empty body and a shell-ish sink name', async () => {
    assert.equal((await fetch(`${base}/play`, { method: 'POST' })).status, 400);
    assert.equal((await fetch(`${base}/play?sink=a;rm`, { method: 'POST', body: 'x' })).status, 400);
  });

  await t.test('client module: drain + kill against the real server', async () => {
    process.env.AUDIO_SATELLITE_URL = base;
    const client = require('./audio-satellite-client');
    assert.equal(client.enabled(), true);

    let started = Date.now();
    await client.play(clip, { sink: 'client-sink' }).done;
    assert.ok(Date.now() - started >= STUB_MS - 50, 'client done must resolve at drain, not at send');

    started = Date.now();
    const p = client.play(clip);
    p.kill(); // fires before the POST resolves — the in-flight path
    await p.done;
    assert.ok(Date.now() - started < STUB_MS - 50, 'client kill must cut playback short');

    started = Date.now();
    await client.play(path.join(tmp, 'no-such-file.bin')).done; // done never rejects
    assert.ok(Date.now() - started < 200, 'a failed play resolves immediately, best-effort');
  });

  await t.test('source-IP allowlist denies a caller not on it', async () => {
    const denied = await startServer({ SATELLITE_ALLOW: '192.0.2.1' });
    const res = await fetch(`http://127.0.0.1:${denied.port}/health`);
    assert.equal(res.status, 403);
  });
});

test.after(() => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* already gone */ } }
  fs.rmSync(tmp, { recursive: true, force: true });
});
