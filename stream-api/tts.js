// ElevenLabs TTS for the unified alert system (stream-api).
//
// Dual voice (instance key tts.dualVoice): a spoken turn is split into casual/loud RUNS
// (`splitRuns`/`isLoud`) and each run is synthesized with the matching ElevenLabs voice —
// ELEVENLABS_VOICE_CASUAL vs ELEVENLABS_VOICE_LOUD (Flash v2.5, default voice settings).
// Audio is synthesized to a file and PLAYED to completion (the player exits when done →
// exact end-of-speech, no guessing), so the bot's avatar can be raised while speaking and
// hidden the instant playback ends.
//
// Playback runs host-side into a PipeWire sink whose monitor can feed a lip-sync avatar and
// OBS capture. Turns are serialized so overlapping speak() calls queue instead of fighting
// over the avatar.

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const rigSink = require('./rig-sink');
const { instanceConfig } = require('./instance-config');

// Instance key elevenlabs.apiKey (env ELEVENLABS_API_KEY, else the stored credential), read at
// call time so a key saved on the Credentials page applies without a restart.
const apiKey = () => instanceConfig.get('elevenlabs.apiKey') || '';
const MODEL = process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5';
const VOICE_CASUAL = process.env.ELEVENLABS_VOICE_CASUAL || '';
const VOICE_LOUD = process.env.ELEVENLABS_VOICE_LOUD || '';
const OUTPUT_FORMAT = process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_128';
// Instance key tts.dualVoice (env TTS_DUAL_VOICE), read per turn. Off = one voice for every run.
const dualVoice = () => instanceConfig.get('tts.dualVoice') === true;
const MAX_TURN_MS = Number(process.env.TTS_MAX_TURN_MS || 90000); // hard guard
const TMP_DIR = process.env.TTS_TMP_DIR || os.tmpdir();
// Instance key tts.sink (env TTS_SINK): the persistent PipeWire sink speech is played into;
// its `.monitor` can feed a lip-sync avatar + OBS (stream audio). An always-present sink means
// routing is wired once. Unset = the default output. Read per clip.
const ttsSink = () => instanceConfig.get('tts.sink') || null;

// The bot's own one-shots — breaths, throat clears, coughs, scoffs. They play through
// playFile like every other turn, which means through the speech sink, which means they MOVE
// THE AVATAR'S MOUTH. That is the opposite of sounds.js, routed away from this sink on purpose
// because a soundboard clip must not puppet the avatar. A breath is the bot; a donation ding
// is not.
//
// Instance key tts.clipsDir (env TTS_CLIPS_DIR); a relative path is resolved inside this
// package's folder. Unset = no clips (noisePath answers null). Read per clip.
// The directory is NOT shipped by the deploy loop (`for f in *.js`); it is copied once.
function clipsDir() {
  const d = instanceConfig.get('tts.clipsDir');
  return d ? path.resolve(__dirname, d) : null;
}
// stream-ingest sends `<id>.v<n>`; this process appends .mp3 and resolves BY CONVENTION.
// There is no manifest on this side — the convention is the whole contract, and
// stream-ingest's noises-manifest.test.js is what pins it.
const NOISE_FILE_RE = /^[\w-]+\.v[0-2]\.mp3$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// A pad is a sleep THIS process performs between a clip and his words, on the one
// serialized chain every spoken turn and every donation alert waits behind. The queue
// owns the ceiling, not just the /speak route: an in-process caller reaches _speak
// without passing through any route, and a 600000 would park the chain for ten minutes
// — the exact wedge the max-turn guard exists to prevent. 2s is far past the longest
// gap that sounds natural.
const PAD_MAX_MS = 2000;
// The two default gaps, tuned by ear: after a throat clear, and before an exhale.
const PAD_DEFAULTS = { before: 350, after: 250 };
/**
 * The ONE pad rule. money.js's parseSpeakBody clamps /speak bodies with this same
 * function, so the boundary and the queue can never disagree about what a value means.
 *
 * Not `Number(raw)` on its own: `Number(null)`, `Number('')` and `Number([])` are all
 * 0, not NaN. An absent pad must fall back to the default gap — only a caller who
 * actually wrote 0 gets no gap at all.
 */
function clampPadMs(raw, def) {
  const n = typeof raw === 'number' ? raw
    : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
  if (!Number.isFinite(n)) return def;
  return Math.min(PAD_MAX_MS, Math.max(0, Math.round(n)));
}

/** Absolute path for a clip id, or null. basename first (a caller never supplies a
 *  path), then the filename rule, then the file has to actually be there. Same shape as
 *  sounds.js's traversal guard. */
function noisePath(id) {
  const file = path.basename(`${String(id == null ? '' : id)}.mp3`);
  if (!NOISE_FILE_RE.test(file)) return null;
  const dir = clipsDir();
  if (!dir) return null;
  const p = path.join(dir, file);
  if (fs.existsSync(p)) return p;
  // Say so. A well-formed id with no file behind it is the shape a never-copied
  // clips folder takes on the server (the deploy loop ships *.js only), and in silence
  // that is indistinguishable from the picker simply choosing nothing all night.
  console.warn(`[tts] clip not found: ${file.replace(/\.mp3$/, '')}`);
  return null;
}

// Strip URLs + :emote: tokens, collapse whitespace. Applied inside speak() to EVERY turn —
// alerts, paid TTS and the bot's /speak lines alike — because the text is forwarded to
// ElevenLabs as-is and a `<break>`, `<prosody>` or other SSML-like tag must never reach the
// engine. Markup goes BEFORE the split (a tag can hold spaces: `<break time="10s"/>`). Two
// passes: whole tags first (so a tag's attributes are not read aloud), then EVERY remaining `<`
// and `>` becomes a space — one tag pass alone is beaten by nesting (`<break time="10s"<b>/>`
// loses the inner `<b>` and reassembles the outer tag). Idempotent, so a caller that already
// cleaned its text loses nothing.
const TAG_RE = /<[/!?A-Za-z][^<>]*>/g;
function cleanForTTS(text) {
  if (!text) return '';
  const out = [];
  for (const w of String(text).replace(TAG_RE, ' ').replace(/[<>]/g, ' ').split(/\s+/)) {
    if (!w) continue;
    if (/^https?:\/\//i.test(w)) continue;                                  // drop URLs
    if (w.length > 2 && w[0] === ':' && w[w.length - 1] === ':' &&
        /^[A-Za-z0-9_]+$/.test(w.slice(1, -1))) continue;                   // drop :emote:
    out.push(w);
  }
  return out.join(' ');
}

// ── Dual-voice run splitting ────────────────────────────────────────────────
// A run is "loud" if it contains an ALL-CAPS word (2+ letters, so a lone "I"
// doesn't count) or a run of "!".
function isLoud(clause) {
  if (/\b[A-Z]{2,}\b/.test(clause)) return true;
  if (/!\s*!/.test(clause) || /!{2,}/.test(clause)) return true;
  return false;
}
// Split a turn into ordered { text, loud } runs: break on sentence boundaries,
// classify each, then merge adjacent same-kind pieces to avoid over-fragmenting.
function splitRuns(text) {
  const pieces = text.split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter(Boolean);
  if (pieces.length <= 1) return [{ text, loud: isLoud(text) }];
  const runs = [];
  for (const p of pieces) {
    const loud = isLoud(p);
    const last = runs[runs.length - 1];
    if (last && last.loud === loud) last.text += ' ' + p;
    else runs.push({ text: p, loud });
  }
  return runs;
}

// The voice for one run (loud vs casual).
// @parked plugin API: an install's owner plugin voices its own lines with it (the radio DJ, owner/radio-dj.js)
function voiceFor(loud) {
  return (loud ? VOICE_LOUD : VOICE_CASUAL) || VOICE_CASUAL || VOICE_LOUD;
}

// ── ElevenLabs synthesis (raw REST; Node fetch) ─────────────────────────────
// Returns a Buffer of mp3 audio for one run, or throws.
// @parked plugin API: an install's owner plugin voices its own lines with it (the radio DJ, owner/radio-dj.js)
async function synthRun(text, voiceId) {
  if (!apiKey()) throw new Error('ELEVENLABS_API_KEY not set');
  if (!voiceId) throw new Error('no voiceId configured');
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${encodeURIComponent(OUTPUT_FORMAT)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey(), 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: MODEL }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`ElevenLabs ${res.status}: ${detail.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function writeTemp(buf, ext = 'mp3') {
  // The bundle's TTS_TMP_DIR is a folder on the media volume that nothing else creates.
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const p = path.join(TMP_DIR, `tts-${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`);
  fs.writeFileSync(p, buf);
  return p;
}

// Play one clip into the TTS sink through the rig sink (rig-sink.js: the satellite, the rig page in
// OBS, or pw-play here). Every path resolves `done` only when the audio has really ended — pw-play
// blocks until the sink drains, the satellite long-polls that, the rig page reports its <audio>
// element's end — so `await done` is the DEFINITIVE end of audio. kill() backs the max-turn guard.
function playFile(file) {
  return rigSink.play(file, { sink: ttsSink(), kind: 'tts' });
}

// ── Public: speak a turn ────────────────────────────────────────────────────
// Turns are serialized through one chain (never overlap on the audio sink). The
// bot avatar's presence is owned by obs.setSpeaking: flipped true the moment a
// turn is queued and false only when the queue fully drains, so the avatar stays
// up across back-to-back alerts / AI turns instead of flickering per-turn. (On the
// always-on scene, obs.botShowScene, obs keeps it visible regardless.)
let chain = Promise.resolve();
let pending = 0;
// End of the last audio that actually played on this queue (see _speak's tail).
let lastEndedAt = 0;

/**
 * One turn on the audio queue.
 *
 * @param {{text?:string, noise?:string, noiseBefore?:string, noiseAfter?:string,
 *          padBeforeMs?:number, padAfterMs?:number}} turn
 * @param {{play?:Function, synth?:Function, obs?:object, wait?:Function}} [deps]
 *   injected only by tts.test.js, so the play ORDER can be asserted without an audio
 *   device, a network call or OBS. Production passes nothing. `wait` is never awaited
 *   bare — see `pad` below, which races it against the max-turn guard.
 */
async function _speak(turn, deps = {}) {
  const {
    play = playFile,
    synth = synthRun,
    obs = require('./obs'),
    wait = sleep,
  } = deps;

  const t = String((turn && turn.text) || '').trim();
  const before = turn && turn.noiseBefore ? noisePath(turn.noiseBefore) : null;
  const after = turn && turn.noiseAfter ? noisePath(turn.noiseAfter) : null;
  // `noise` is the text-less form: a clip on its own, in the gap while he thinks or in a
  // quiet stretch. It is honoured only when there is no text, so one request can never
  // queue three clips around nothing.
  // `testClip` (the OBS page's "Test voice", rig.js): a clip made in memory, played as the turn's
  // only audio — everything after synthesis is the real path, the avatar included.
  const testFile = (!t && turn && Buffer.isBuffer(turn.testClip)) ? writeTemp(turn.testClip, 'wav') : null;
  const solo = (!t && turn && turn.noise) ? noisePath(turn.noise) : testFile;
  if (!t && !solo) return false;

  // Clamped HERE, not only at the route: /speak is one caller, and the chain is shared.
  const padBefore = clampPadMs(turn.padBeforeMs, PAD_DEFAULTS.before);
  const padAfter = clampPadMs(turn.padAfterMs, PAD_DEFAULTS.after);

  // Synthesize all runs up front (parallel), preserving order. A failed run is
  // dropped rather than aborting the whole turn. The avatar is NOT shown yet —
  // synth latency would leave him on screen, silent.
  const runs = t ? (dualVoice() ? splitRuns(t) : [{ text: t, loud: false }]) : [];
  const synthAt = Date.now();
  const buffers = await Promise.all(runs.map(async (r) => {
    try { return await synth(r.text, voiceFor(r.loud)); }
    catch (e) { console.warn(`[tts] synth failed (${r.loud ? 'loud' : 'casual'}): ${e.message}`); return null; }
  }));
  if (runs.length) turn.synthMs = Date.now() - synthAt;
  const files = buffers.filter(Boolean).map(writeTemp);
  // No sound without a voice. If nothing synthesized, the clips around the line do not
  // play either — a throat clear followed by silence is worse than silence, and the
  // caller gets `false` so it knows the turn was a no-op.
  if (t && files.length === 0) return false;

  const players = [];
  // `aborted` is load-bearing. Killing only the players ALREADY in the array would,
  // on a multi-run turn, kill the file that is playing and let the loop spawn the
  // NEXT file with no remaining timeout. A turn could run arbitrarily past
  // MAX_TURN_MS and, because speak() serializes on `chain`, wedge the entire TTS
  // queue behind it.
  let aborted = false;
  // A pad must not outlive the turn it paces. `wait` is a plain sleep and the guard
  // cannot interrupt one, so the guard hands the in-flight pad its own resolve and ends
  // it. Otherwise the abort lands and the chain stays parked for the rest of the sleep,
  // which is the same wedge by a different route.
  let releasePad = null;
  const guard = setTimeout(() => {
    aborted = true;
    console.warn('[tts] max-turn guard fired — aborting remaining runs this turn');
    players.forEach((p) => p.kill());
    if (releasePad) releasePad();
  }, MAX_TURN_MS);
  let played = false;
  const playOne = async (file) => {
    const p = play(file);
    players.push(p);
    await p.done; // pw-play blocks until the sink fully drains = definitive end
    played = true;
  };
  // Sleep `ms`, or until the guard fires — whichever is first. A clamped-to-0 pad is
  // no sleep at all, not a zero-length one.
  const pad = (ms) => new Promise((resolve) => {
    if (aborted || !(ms > 0)) return resolve();
    releasePad = resolve;
    Promise.resolve().then(() => wait(ms)).then(resolve, resolve);
  }).finally(() => { releasePad = null; });
  try {
    obs.setSpeaking(true); // show as audio begins — synced to the voice, not enqueue
    turn.startedAt = Date.now();
    if (solo) {
      await playOne(solo);
    } else {
      // Every leg re-checks `aborted` AFTER its pad, never before it. A guard that
      // fires DURING a sleep would otherwise be followed by a freshly spawned player
      // with nothing left to kill it — the guard has already swept the array.
      if (before && !aborted) { await playOne(before); await pad(padBefore); }
      for (const f of files) {
        if (aborted) break; // guard fired (possibly during that pad) — no new run
        await playOne(f);
      }
      if (after) { await pad(padAfter); if (!aborted) await playOne(after); }
    }
  } finally {
    clearTimeout(guard);
    if (testFile) { try { fs.unlinkSync(testFile); } catch { /* best-effort temp cleanup, as below */ } }
    for (const f of files) { try { fs.unlinkSync(f); } catch { /* best-effort temp cleanup in a finally — a file we cannot delete must not mask the real error */ } }
  }
  // When his audio REALLY ended — the last clip drained — and how long the air had been
  // quiet before it began. /speak hands these to the brain on request (`wait`), so his
  // next line is timed off the real end instead of a character-count guess, and this log
  // line is the record of his speech times (the brain's own estimate never was one).
  if (played) {
    turn.endedAt = Date.now();
    if (lastEndedAt) turn.quietBeforeMs = turn.startedAt - lastEndedAt;
    lastEndedAt = turn.endedAt;
    console.log(`[tts] played: synth ${turn.synthMs ?? 0}ms, audio ${turn.endedAt - turn.startedAt}ms, quiet before ${turn.quietBeforeMs ?? '-'}ms`);
  }
  return true;
}

/** Queue a turn. A bare string still means `{ text }` — alert.js and money.js's paid-TTS
 *  path both call it that way and are unchanged. */
function speak(input) {
  const turn = typeof input === 'string' ? { text: input } : (input || {});
  // Cleaned IN PLACE: /speak's `wait` caller reads the timings back off this same object.
  if (turn.text != null) turn.text = cleanForTTS(turn.text);
  const hasText = !!String(turn.text || '').trim();
  const hasNoise = !!(turn.noise || turn.noiseBefore || turn.noiseAfter || Buffer.isBuffer(turn.testClip));
  if (!hasText && !hasNoise) return chain; // ignore empty — don't touch presence
  pending++;
  chain = chain
    .then(() => _speak(turn))
    .catch((e) => { console.warn('[tts] speak error:', e.message); })
    // Hide only when the whole queue has drained (and obs keeps him up anyway on
    // the BRB scene). Showing is owned by _speak so it tracks real playback.
    .finally(() => { pending--; if (pending === 0) require('./obs').setSpeaking(false); });
  return chain;
}

/** The OBS page's "Test voice": a made-up clip through the whole spoken-turn path. */
function speakTest(clip) {
  return speak({ testClip: clip });
}

module.exports = {
  speak, speakTest,
  noisePath,
  cleanForTTS,
  // money.js's /speak validation clamps with these — one rule, one copy of the numbers.
  clampPadMs, PAD_DEFAULTS,
  // exposed for tests / ad-hoc
  splitRuns, isLoud, synthRun, voiceFor, speakTurn: _speak,
  config: {
    MODEL, VOICE_CASUAL, VOICE_LOUD, get hasKey() { return !!apiKey(); },
    get sink() { return ttsSink(); }, get dualVoice() { return dualVoice(); }, get clipsDir() { return clipsDir(); },
  },
};
