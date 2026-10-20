// Where stream-api's sounds and spoken turns are played — the "rig sink".
//
// One choice, in order:
//   1. the audio satellite — AUDIO_SATELLITE_URL set (an install whose server is not the streaming
//      PC and whose PC runs audio-satellite.js on the same network);
//   2. the rig page — a browser source in OBS connected to /rig (rig.js): the page plays the clip
//      and OBS mixes the browser source's audio;
//   3. this machine — pw-play into a PipeWire sink (stream-api on the streaming PC itself).
// Every path returns the same { done, kill }: `done` resolves at the end of the audio and never
// rejects, which is what the TTS queue and the avatar wait on.

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');
const satellite = require('./audio-satellite-client');
const { rig } = require('./rig');

/** Which path a clip would take now: 'satellite' | 'rig' | 'local'. */
function which() {
  if (satellite.enabled()) return 'satellite';
  if (rig.connected()) return 'rig';
  return 'local';
}

function playLocal(file, sink) {
  let child;
  const done = new Promise((resolve) => {
    child = spawn('pw-play', [...(sink ? [`--target=${sink}`] : []), file], { stdio: 'ignore' });
    child.on('error', (e) => { console.warn('[audio] pw-play error:', e.message); resolve(); });
    child.on('close', () => resolve());
  });
  return { done, kill: () => { try { child && child.kill('SIGKILL'); } catch { /* already exited — kill() throws ESRCH, which is the outcome we wanted */ } } };
}

/**
 * @param {string} file
 * @param {{ sink?: string|null, kind: 'tts'|'sound' }} o  sink: the PipeWire sink (satellite and local
 *   paths); kind: 'tts' moves the rig page avatar's mouth, 'sound' never does.
 */
function play(file, { sink = null, kind }) {
  if (satellite.enabled()) return satellite.play(file, sink ? { sink } : {});
  const viaRig = rig.play(file, { kind });
  if (viaRig) return viaRig;
  return playLocal(file, sink);
}

/** Play bytes made in memory (the OBS page's "Test sound") as a sound, then remove the temp file. */
function playClip(buf, { kind = 'sound' } = {}) {
  const dir = process.env.TTS_TMP_DIR || os.tmpdir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `clip-${Date.now()}-${randomUUID().slice(0, 8)}.wav`);
  fs.writeFileSync(file, buf);
  const p = play(file, { kind });
  p.done.finally(() => fs.rm(file, { force: true }, () => {}));
  return p;
}

module.exports = { play, playClip, which };
