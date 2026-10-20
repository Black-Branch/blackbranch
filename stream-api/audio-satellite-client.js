'use strict';
// Client half of the audio satellite (see audio-satellite.js). When
// AUDIO_SATELLITE_URL is set, tts.js and sounds.js ship audio bytes to the rig
// instead of spawning pw-play locally; unset (the default) leaves the local
// spawn path untouched. play() mirrors the {done, kill} contract of tts.js's local
// playFile: `done` resolves at sink drain (the satellite ends the long-poll
// body only when pw-play exits) and NEVER rejects — audio is best-effort, like
// OBS.

const fs = require('fs');

const BASE = (process.env.AUDIO_SATELLITE_URL || '').replace(/\/$/, '');

function enabled() {
  return !!BASE;
}

function play(file, { sink } = {}) {
  let playId = null;
  let aborted = false;
  const sendKill = () => {
    fetch(`${BASE}/play/${playId}`, { method: 'DELETE' }).catch((e) =>
      console.warn('[satellite] kill failed:', e.message)
    );
  };
  const done = (async () => {
    try {
      const body = fs.readFileSync(file);
      const res = await fetch(`${BASE}/play${sink ? `?sink=${encodeURIComponent(sink)}` : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body,
      });
      // The id is flushed in the headers before playback ends, so a kill can
      // land mid-play; fetch resolves on headers, res.text() is the long-poll.
      playId = res.headers.get('x-play-id');
      if (aborted && playId) sendKill(); // kill() fired while the POST was in flight
      await res.text(); // completes only when the sink has drained (or the play was killed)
    } catch (e) {
      console.warn('[satellite] play failed:', e.message);
    }
  })();
  return {
    done,
    kill: () => {
      aborted = true;
      if (playId) sendKill();
    },
  };
}

module.exports = { enabled, play };
