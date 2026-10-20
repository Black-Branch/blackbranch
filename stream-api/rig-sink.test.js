// rig-sink.js — where sounds and spoken turns are played: the audio satellite
// when AUDIO_SATELLITE_URL is set, else a connected rig page, else
// pw-play on this machine. Real execution: a child process for the satellite's env, a real socket
// for the rig page.
// Run: node --test rig-sink.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const WebSocket = require('ws');

test('AUDIO_SATELLITE_URL set: the satellite, before anything else', { timeout: 10_000 }, () => {
  const r = spawnSync(process.execPath, ['-e', `
    const { rig } = require('./rig');
    rig.init({ secret: 's' }); rig.start();
    rig.connected = () => true; // a rig page would not change the choice
    console.log(require('./rig-sink').which());
    rig.stop();`], { cwd: __dirname, env: { ...process.env, AUDIO_SATELLITE_URL: 'http://127.0.0.1:9' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'satellite');
  // and the code path matches the answer: play() asks the satellite first
  const src = fs.readFileSync(path.join(__dirname, 'rig-sink.js'), 'utf8');
  const body = src.slice(src.indexOf('function play('), src.indexOf('function playClip('));
  assert.ok(body.indexOf('satellite.enabled()') > 0 && body.indexOf('satellite.enabled()') < body.indexOf('rig.play('), 'the satellite is checked before the rig page');
  assert.match(src, /module\.exports = \{ play, playClip, which \};\s*$/);
});

test('no satellite: a connected rig page takes the clip (kind kept); with none, this machine', { timeout: 10_000 }, async (t) => {
  delete process.env.AUDIO_SATELLITE_URL;
  const { rig } = require('./rig');
  const sink = require('./rig-sink');
  assert.equal(sink.which(), 'local');
  rig.init({ secret: 'sink-test-secret' });
  rig.start();
  const server = http.createServer();
  server.on('upgrade', rig.handleUpgrade);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { rig.stop(); await new Promise((r) => server.close(r)); });
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/rig`, ['rig.v1', `rig-key.${rig.key()}`]);
  const frames = [];
  const got = (type) => new Promise((resolve) => { const tick = () => { const f = frames.find((x) => x.type === type); if (f) resolve(f); else setTimeout(tick, 5); }; tick(); });
  ws.on('message', (d) => frames.push(JSON.parse(String(d))));
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'rig.hello', level: 4 }));
  await got('rig.welcome');
  assert.equal(sink.which(), 'rig');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sink-')), 'x.mp3');
  fs.writeFileSync(file, 'ID3x');
  const p = sink.play(file, { sink: 'some-sink', kind: 'tts' });
  const f = await got('rig.play');
  assert.equal(f.kind, 'tts');
  ws.send(JSON.stringify({ type: 'rig.ended', id: f.id }));
  await p.done;
  ws.close();
});
