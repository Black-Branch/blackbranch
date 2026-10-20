// Coin-store sound alerts: mod-curated clips played on the
// desktop (OBS captures desktop audio — no OBS source-name coupling). Serialized
// like TTS so clips never overlap; deliberately NOT routed to the speech (tts.sink)
// PipeWire sink (that monitor drives the avatar's lip-sync — a soundboard clip
// must not puppet the avatar's mouth).
//
// Manifest: sounds/sounds.json → [{ id, label, price, file, durationMs }] with
// files in sounds/. Gate: SOUNDS_ENABLED=1 (default OFF — the store greys the
// tile out and the web route refuses to charge while disabled).

'use strict';
const fs = require('fs');
const path = require('path');
const rigSink = require('./rig-sink');

const SOUNDS_DIR = path.join(__dirname, 'sounds');
const ENABLED = process.env.SOUNDS_ENABLED === '1';

// Pure sanitization of a raw manifest array → the clamped, path-safe rows we
// serve. Kept separate from disk I/O so it's unit-testable (the path.basename
// on `file` is a traversal guard — clips must live flat in sounds/).
function sanitizeManifest(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s) => s && typeof s.id === 'string' && typeof s.file === 'string')
    .map((s) => ({
      id: s.id.slice(0, 60),
      label: String(s.label || s.id).slice(0, 80),
      price: Math.max(1, parseInt(s.price, 10) || 100),
      file: path.basename(s.file), // never a path — clips live flat in sounds/
      durationMs: Math.max(0, parseInt(s.durationMs, 10) || 0),
    }));
}

function loadManifest() {
  try {
    return sanitizeManifest(JSON.parse(fs.readFileSync(path.join(SOUNDS_DIR, 'sounds.json'), 'utf8')));
  } catch {
    return [];
  }
}

function createSounds() {
  let manifest = loadManifest();
  let chain = Promise.resolve();

  return {
    manifest: () => ({ enabled: ENABLED && manifest.length > 0, sounds: manifest }),
    /** Queue a clip; resolves true if it was accepted for playback. */
    play(id) {
      if (!ENABLED) return Promise.resolve(false);
      const clip = manifest.find((s) => s.id === id);
      if (!clip) return Promise.resolve(false);
      const file = path.join(SOUNDS_DIR, clip.file);
      if (!fs.existsSync(file)) return Promise.resolve(false);
      chain = chain.then(
        () =>
          new Promise((resolve) => {
            // The satellite, the rig page or pw-play here (rig-sink.js) — never the speech sink.
            const p = rigSink.play(file, { kind: 'sound' });
            const t = setTimeout(() => { p.kill(); resolve(); }, Math.max(clip.durationMs, 1000) + 15_000);
            p.done.then(() => { clearTimeout(t); resolve(); });
          })
      );
      return Promise.resolve(true);
    },
  };
}

module.exports = { createSounds, sanitizeManifest };
