// Unit tests for the dual-voice split logic in tts.js (ported from speakerbot.js), and
// for the clip-around-speech ORDER the noises feature added. Pure text logic plus one
// injected-deps play trace — no network, no secrets, no audio device.
// Run: node --test tts.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A throwaway clip directory, populated with the REAL filenames the build produces.
// The clips folder (instance key tts.clipsDir) is read from env per clip; set here once.
const CLIPS = fs.mkdtempSync(path.join(os.tmpdir(), 'gadget-noises-'));
for (const name of ['clears_throat2.v0.mp3', 'breaths_out.v1.mp3', 'gadget_burp.v2.mp3']) {
  fs.writeFileSync(path.join(CLIPS, name), Buffer.alloc(32, 1));
}
process.env.TTS_CLIPS_DIR = CLIPS;
process.env.TTS_DUAL_VOICE = '1'; // speakTurn's run split is what several tests assert
// MAX_TURN_MS is read at module load too. A short one lets the max-turn guard fire
// inside a test instead of 90 s from now; every other test here finishes in well under
// a millisecond, so none of them reaches it.
process.env.TTS_MAX_TURN_MS = '120';

const { isLoud, splitRuns, noisePath, speakTurn } = require('./tts');

// console.warn is the ONLY signal that a clip is missing, so the tests that trigger one
// capture it — asserted, and out of the suite's output.
async function captureWarn(fn) {
  const lines = [];
  const real = console.warn;
  console.warn = (...a) => lines.push(a.join(' '));
  try { return { lines, value: await fn() }; } finally { console.warn = real; }
}

test('isLoud', () => {
  assert.equal(isLoud('WHAT THE FUCK'), true);   // ALL-CAPS words
  assert.equal(isLoud('OMG'), true);
  assert.equal(isLoud('stop!!'), true);          // run of !
  assert.equal(isLoud('hey !  ! there'), true);  // spaced !! still counts
  assert.equal(isLoud('yeah whatever man'), false);
  assert.equal(isLoud('hello!'), false);         // single ! is not loud
  assert.equal(isLoud('I am right here'), false); // lone capital "I" doesn't count
});

test('splitRuns: casual → loud transition', () => {
  const runs = splitRuns('yeah whatever man... WHAT THE FUCK IS YOUR PROBLEM');
  assert.equal(runs.length, 2);
  assert.equal(runs[0].loud, false);
  assert.equal(runs[1].loud, true);
  assert.match(runs[0].text, /yeah whatever man/);
  assert.match(runs[1].text, /WHAT THE FUCK/);
});

test('splitRuns: single sentence → one run', () => {
  const runs = splitRuns('hello there friend');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].loud, false);
  assert.equal(runs[0].text, 'hello there friend');
});

test('splitRuns: merges adjacent same-kind sentences', () => {
  const runs = splitRuns('one thing. another thing. a third thing.');
  assert.equal(runs.length, 1); // all casual → merged
  assert.equal(runs[0].loud, false);
});

test('splitRuns: loud then casual', () => {
  const runs = splitRuns('STOP. okay now we can talk.');
  assert.equal(runs.length, 2);
  assert.equal(runs[0].loud, true);
  assert.equal(runs[1].loud, false);
});

// ── Clips around his speech ─────────────────────────────────────────────────
// Donation alerts share this queue, so a throat clear sent as its own request can be
// followed by a donation alert and only THEN his line. The clips therefore ride in the
// same turn as the line, and the default pacings (350ms after a throat clear, 250ms
// before an exhale) are sleeps this queue performs — the queue has no other gap control.

function harness(overrides = {}) {
  const log = [];
  const deps = {
    // A synthesized run lands in a temp file named tts-*; a clip keeps its own name.
    play: (file) => {
      const base = path.basename(file);
      log.push(base.startsWith('tts-') ? 'voice' : base);
      return { done: Promise.resolve(), kill: () => {} };
    },
    synth: async (text) => Buffer.from(`audio:${text}`),
    obs: { setSpeaking: () => {} },
    wait: async (ms) => { log.push(`pad:${ms}`); },
    ...overrides,
  };
  return { log, deps };
}

test('a turn plays before-clip, pad, his words, pad, after-clip — in that order', async () => {
  const { log, deps } = harness();
  const ok = await speakTurn({
    text: 'yeah whatever man',
    noiseBefore: 'clears_throat2.v0',
    noiseAfter: 'breaths_out.v1',
    padBeforeMs: 350,
    padAfterMs: 250,
  }, deps);
  assert.equal(ok, true);
  assert.deepEqual(log, ['clears_throat2.v0.mp3', 'pad:350', 'voice', 'pad:250', 'breaths_out.v1.mp3']);
});

test('the pads default to the two tuned gaps', async () => {
  const { log, deps } = harness();
  await speakTurn({ text: 'hello there friend', noiseBefore: 'clears_throat2.v0', noiseAfter: 'breaths_out.v1' }, deps);
  assert.deepEqual(log, ['clears_throat2.v0.mp3', 'pad:350', 'voice', 'pad:250', 'breaths_out.v1.mp3']);
});

test('no sound without a voice: every run failing plays NOTHING, clips included', async () => {
  const { log, deps } = harness({ synth: async () => { throw new Error('ElevenLabs 503'); } });
  const { lines, value: ok } = await captureWarn(() => speakTurn({
    text: 'yeah whatever man', noiseBefore: 'clears_throat2.v0', noiseAfter: 'breaths_out.v1',
  }, deps));
  assert.equal(ok, false);
  assert.deepEqual(log, [], 'a throat clear followed by silence is worse than silence');
  assert.ok(lines.some((l) => l.includes('synth failed')), 'and the failure is reported');
});

test('a clip that is not on disk is skipped, and his line still goes out — audibly noted', async () => {
  const { log, deps } = harness();
  const { lines, value: ok } = await captureWarn(
    () => speakTurn({ text: 'hello there friend', noiseBefore: 'never_rendered.v0' }, deps));
  assert.equal(ok, true);
  assert.deepEqual(log, ['voice']);
  assert.deepEqual(lines, ['[tts] clip not found: never_rendered.v0'],
    'a never-copied gadget-noises/ on the VM must not look exactly like a quiet picker');
});

test('a text-less noise turn plays the clip alone', async () => {
  const { log, deps } = harness();
  const ok = await speakTurn({ noise: 'gadget_burp.v2' }, deps);
  assert.equal(ok, true);
  assert.deepEqual(log, ['gadget_burp.v2.mp3']);
});

test('the OBS page\'s test clip plays alone through the real path, raises the avatar, and its temp file is removed', async () => {
  const played = [];
  const speaking = [];
  const { deps } = harness({
    play: (file) => { played.push({ file, there: fs.existsSync(file), head: fs.readFileSync(file).subarray(0, 4).toString('latin1') }); return { done: Promise.resolve(), kill: () => {} }; },
    synth: async () => { throw new Error('a test clip is never synthesized'); },
    obs: { setSpeaking: (s) => speaking.push(s) },
  });
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(40)]);
  assert.equal(await speakTurn({ testClip: wav }, deps), true);
  assert.equal(played.length, 1);
  assert.match(played[0].file, /\.wav$/);
  assert.equal(played[0].there, true);
  assert.equal(played[0].head, 'RIFF');
  assert.deepEqual(speaking, [true]);
  assert.equal(fs.existsSync(played[0].file), false, 'the temp file is gone afterwards');
  // A test clip never rides along with words: text wins, the clip is ignored.
  const { log, deps: d2 } = harness();
  await speakTurn({ text: 'hello', testClip: wav }, d2);
  assert.deepEqual(log, ['voice']);
});

test('an empty turn does nothing at all', async () => {
  const { log, deps } = harness();
  assert.equal(await speakTurn({}, deps), false);
  const { value } = await captureWarn(() => speakTurn({ noise: 'never_rendered.v0' }, deps));
  assert.equal(value, false);
  assert.deepEqual(log, []);
});

// The clips are decoration; the chain they ride on is not. Every pad below is a sleep
// this process performs while every other spoken turn AND every donation alert waits.

test('the queue clamps its own pads — a caller that never sees the route cannot park the chain', async () => {
  const { log, deps } = harness();
  await speakTurn({
    text: 'hello there friend', noiseBefore: 'clears_throat2.v0', noiseAfter: 'breaths_out.v1',
    padBeforeMs: 600000, padAfterMs: -50,
  }, deps);
  // 600000 would hold the one serialized chain for ten minutes; a negative pad is no
  // sleep at all rather than a zero-length one, so `wait` is never even called for it.
  assert.deepEqual(log, ['clears_throat2.v0.mp3', 'pad:2000', 'voice', 'breaths_out.v1.mp3']);
});

test('a pad VALUE means the same thing here as it does at the route', async () => {
  const { log, deps } = harness();
  await speakTurn({
    text: 'hello there friend', noiseBefore: 'clears_throat2.v0', noiseAfter: 'breaths_out.v1',
    padBeforeMs: '600', padAfterMs: null,
  }, deps);
  // A numeric string is a number and a null is absent — money.js's parseSpeakBody clamps
  // with this same function, so the boundary cannot accept what the queue then rejects.
  // (600, not the 350 default: a rule that only ever returned the default would pass an
  // assertion written against the default.)
  assert.deepEqual(log, ['clears_throat2.v0.mp3', 'pad:600', 'voice', 'pad:250', 'breaths_out.v1.mp3']);
});

test('the guard cuts a pad short, and no clip is started after it fires', { timeout: 5000 }, async () => {
  const { log, deps } = harness();
  // A pad that never ends on its own: the ONLY thing that can finish this turn is the
  // max-turn guard releasing the sleep. If it cannot, this test hangs until the timeout
  // — which is precisely the wedge, reproduced.
  let pads = 0;
  deps.wait = (ms) => {
    log.push(`pad:${ms}`);
    return (++pads === 2) ? new Promise(() => {}) : Promise.resolve();
  };
  const { lines } = await captureWarn(() => speakTurn({
    text: 'hello there friend', noiseBefore: 'clears_throat2.v0', noiseAfter: 'breaths_out.v1',
  }, deps));
  assert.ok(lines.some((l) => l.includes('max-turn guard fired')), 'the guard must have fired');
  assert.deepEqual(log, ['clears_throat2.v0.mp3', 'pad:350', 'voice', 'pad:250'],
    'the after-clip is spawned AFTER the guard swept the players — nothing would be left to kill it');
});

test('noisePath refuses anything that is not a rendered clip name', () => {
  assert.ok(noisePath('clears_throat2.v0').endsWith('/clears_throat2.v0.mp3'));
  assert.equal(noisePath('clears_throat2.v3'), null, 'only three variants exist');
  assert.equal(noisePath('clears_throat2'), null, 'a bare id is not a file');
  assert.equal(noisePath('../../../etc/passwd'), null);
  assert.equal(noisePath(''), null);
  assert.equal(noisePath(null), null);
  // A traversal that would still name a real clip is reduced to its basename, never
  // resolved outside the clip directory.
  assert.equal(noisePath('../../clears_throat2.v0'), path.join(CLIPS, 'clears_throat2.v0.mp3'));
});

// ── When his audio really started and ended ────────────────────
// pw-play blocks until the sink drains, so the moment `done` resolves IS the end of his
// audio. The turn records it, with how long synthesis took and how long the air had been
// quiet before it began, so /speak can hand the brain the real end instead of a guess.
test('a turn records when its audio really started and ended, and how long synthesis took', async () => {
  const { deps } = harness({
    play: () => ({ done: new Promise((r) => setTimeout(r, 30)), kill: () => {} }),
    synth: async (text) => { await new Promise((r) => setTimeout(r, 15)); return Buffer.from(text); },
  });
  const turn = { text: 'hello there friend', noiseAfter: 'breaths_out.v1' };
  const t0 = Date.now();
  assert.equal(await speakTurn(turn, deps), true);
  assert.ok(turn.startedAt >= t0 && turn.endedAt >= turn.startedAt + 50, JSON.stringify(turn));
  assert.ok(turn.synthMs >= 10 && turn.synthMs < 1000, `synthMs ${turn.synthMs}`);
  assert.ok(turn.endedAt <= Date.now(), 'the end is when the LAST clip drained, not before');
});

test('the quiet before a turn is measured from the end of the one before it', async () => {
  const { deps } = harness();
  const a = { text: 'first line here' };
  await speakTurn(a, deps);
  await new Promise((r) => setTimeout(r, 40));
  const b = { text: 'second line here' };
  await speakTurn(b, deps);
  assert.ok(b.quietBeforeMs >= 30 && b.quietBeforeMs < 1000, `quietBeforeMs ${b.quietBeforeMs}`);
});

test('a turn that plays nothing records no end', async () => {
  const { deps } = harness({ synth: async () => { throw new Error('elevenlabs down'); } });
  const turn = { text: 'hello there friend' };
  await captureWarn(() => speakTurn(turn, deps));
  assert.equal(turn.endedAt, undefined);
});

// L7: the bot's /speak lines reach tts.speak WITHOUT going through an alert path, so the markup
// strip lives inside speak() itself — every caller is covered. The turn is cleaned in place
// (it is the object the engine is handed, and the one /speak's `wait` reads timings back from).
test('speak() strips markup and stray angle brackets from every turn before the engine sees it', async () => {
  const { speak } = require('./tts');
  const turn = { text: 'hi <break time="10s"/> there <prosody rate="x-fast">fast</prosody> 3 < 5' };
  const done = captureWarn(() => speak(turn)); // no key in tests: the engine refuses, which is fine
  assert.equal(turn.text, 'hi there fast 3 5');
  assert.doesNotMatch(turn.text, /[<>]/);
  await done;
});

test('speak() on an alert line that was already cleaned changes nothing (idempotent)', async () => {
  const { speak, cleanForTTS } = require('./tts');
  const once = cleanForTTS('thanks <b>casey</b> :wave: https://x.test');
  const turn = { text: once };
  const done = captureWarn(() => speak(turn));
  assert.equal(turn.text, once);
  await done;
});
