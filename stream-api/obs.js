// OBS WebSocket control for the alert system — the `obs` module (config/modules.mjs).
//
// One persistent, auto-reconnecting obs-websocket-js (v5) connection to OBS on the streaming
// computer, started only when the module is switched on (start()). It provides:
//   • playSound()       — retrigger the alert sound (toggle a media source off→on)
//   • setSpeaking(s)    — queue-drain latch (owned by tts.js) that shows/hides
//                         the bot avatar source while TTS plays
//   • getCurrentScene() / onSceneChange() — for timer pause on the pause scene
//
// Resilient by design: if OBS is down — or the module is off — every method returns quietly
// rather than throwing; a missing OBS must never crash an alert. Scene-item ids are resolved by
// NAME at use time (and cache-invalidated on every reconnect) so the calls survive OBS scene
// edits. Never rename a scene or source here without renaming it in OBS.

'use strict';
const { OBSWebSocket } = require('obs-websocket-js');
const { createEpisodeLog } = require('./episode-log');
const { instanceConfig } = require('./instance-config');
const { rig } = require('./rig');

// Instance key obs.url (env OBS_WS_URL), read at start(). Unset = no OBS WebSocket at all: the
// module then works through the rig page alone (rig.js), which is the path for an
// install whose server cannot reach OBS. Set = this bridge connects there as well.
let URL = null;
// Instance key obs.password (env OBS_WS_PASSWORD, else the stored credential), read at every
// connect attempt — a saved password applies at the next reconnect.
const password = () => instanceConfig.get('obs.password') || '';
const AUDIO_SCENE = process.env.OBS_AUDIO_SCENE || 'Audio';
// The names below are the install's own (instance keys obs.soundSource / obs.botScene /
// obs.botSource / obs.botShowScene), read at use time so a saved name applies at once. Each one
// unset switches off only what it drives, without a log line: no sound source = no alert sound,
// no avatar scene or source = no avatar toggling, no always-on scene = visible only while speaking.
const soundSource = () => instanceConfig.get('obs.soundSource') || null;
const botScene = () => instanceConfig.get('obs.botScene') || null;
const botSource = () => instanceConfig.get('obs.botSource') || null;
const botShowScene = () => instanceConfig.get('obs.botShowScene') || null;
const RECONNECT_MS = 5000;
const SOUND_RETRIGGER_MS = 80;

const obs = new OBSWebSocket();
let started = false;       // the module is on and start() ran
let connected = false;
let reconnectTimer = null;
let currentScene = null;   // last known OBS program scene
let speaking = false;      // TTS active or queued (set by tts.js via setSpeaking)
const sceneChangeCbs = new Set();
const itemIdCache = new Map(); // `${scene}\u0000${source}` → sceneItemId

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// OBS is closed most of the day. The retry cadence below stays at RECONNECT_MS
// so OBS attaches seconds after it opens — only the LOG is rationed: the first
// failure of an outage, then one summary per ten minutes (episode-log.js).
const connectLog = createEpisodeLog({ everyMs: 600_000 });

async function connect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  try {
    await obs.connect(URL, password() || undefined);
    // 'Identified' fires inside connect(); mark ready here.
    connected = true;
    itemIdCache.clear();
    connectLog.end();
    console.log(`[obs] connected ${URL}`);
    syncScene(); // enforce the avatar's presence for the current scene on (re)connect
  } catch (err) {
    connected = false;
    const { log, suppressed } = connectLog.note();
    if (log) {
      console.warn(`[obs] connect failed (${err.message}); retrying every ${RECONNECT_MS}ms`
        + (suppressed ? ` — ${suppressed} more attempts since the last line` : ' — further failures are summarised every 10 min'));
    }
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, RECONNECT_MS);
}

obs.on('ConnectionClosed', () => {
  if (connected) console.warn('[obs] connection closed');
  connected = false;
  itemIdCache.clear();
  scheduleReconnect();
});
obs.on('ConnectionError', (err) => {
  // While disconnected this fires once per failed attempt with the same text
  // connect()'s own catch reports — say it only for an ESTABLISHED connection.
  if (connected) console.warn('[obs] connection error:', err?.message || err);
});
obs.on('CurrentProgramSceneChanged', ({ sceneName }) => {
  currentScene = sceneName;
  applyAvatarPresence(); // show on the always-on scene, hide elsewhere (unless speaking)
  for (const cb of sceneChangeCbs) { try { cb(sceneName); } catch (e) { console.warn('[obs] sceneChange cb:', e.message); } }
});

async function itemId(scene, source) {
  const key = `${scene}\u0000${source}`;
  if (itemIdCache.has(key)) return itemIdCache.get(key);
  const { sceneItemId } = await obs.call('GetSceneItemId', { sceneName: scene, sourceName: source });
  itemIdCache.set(key, sceneItemId);
  return sceneItemId;
}

async function setEnabled(scene, source, enabled) {
  if (!connected) {
    if (started && URL) console.warn(`[obs] not connected; skip setEnabled ${scene}/${source}`);
    return false;
  }
  try {
    const sceneItemId = await itemId(scene, source);
    await obs.call('SetSceneItemEnabled', { sceneName: scene, sceneItemId, sceneItemEnabled: enabled });
    return true;
  } catch (err) {
    itemIdCache.delete(`${scene}\u0000${source}`); // maybe the source was renamed/moved
    console.warn(`[obs] setEnabled ${scene}/${source}=${enabled} failed: ${err.message}`);
    return false;
  }
}

// Retrigger the alert sound: hide the media source, then re-show it (OBS replays
// a media source from the start when it becomes active). Matches dispatch.cs.
async function playSound() {
  const source = soundSource();
  if (!source) return false;
  if (!connected) {
    if (started && URL) console.warn('[obs] not connected; skip playSound');
    return false;
  }
  await setEnabled(AUDIO_SCENE, source, false);
  await sleep(SOUND_RETRIGGER_MS);
  return setEnabled(AUDIO_SCENE, source, true);
}

// ── Bot avatar presence ─────────────────────────────────────────────────────
// The rig page draws its own avatar from the same latch (rig.setSpeaking), so both follow one
// speaking state.
// Visible when on the always-on scene OR while speaking. tts.js flips `speaking` for the
// whole speech queue (true on first enqueue, false when the queue drains) so the
// avatar stays up across queued alerts/AI turns instead of flickering per-turn.
function avatarShouldShow() {
  const show = botShowScene();
  return (show !== null && currentScene === show) || speaking;
}
function applyAvatarPresence() {
  const scene = botScene();
  const source = botSource();
  if (!scene || !source) return Promise.resolve(false);
  return setEnabled(scene, source, avatarShouldShow());
}
function setSpeaking(s) {
  speaking = !!s;
  rig.setSpeaking(speaking);
  return applyAvatarPresence();
}
// Resolve the current scene then enforce presence (used on connect/reconnect).
async function syncScene() {
  const s = await getCurrentScene();
  if (s != null) currentScene = s;
  return applyAvatarPresence();
}

async function getCurrentScene() {
  // Without the WebSocket, the scene the rig page last reported (null when none is connected).
  if (!connected) return rig.currentScene();
  try {
    const r = await obs.call('GetCurrentProgramScene');
    // Field name varies by obs-websocket version (currentProgramSceneName in 5.x).
    return r.currentProgramSceneName ?? r.currentProgramScene ?? r.sceneName ?? null;
  } catch (err) {
    console.warn('[obs] getCurrentScene failed:', err.message);
    return null;
  }
}

function onSceneChange(cb) { sceneChangeCbs.add(cb); return () => sceneChangeCbs.delete(cb); }
// The rig page's scene reports feed the same callbacks (the timer's pause scene), but only while the
// WebSocket is not connected — with both, OBS's own event is the one source.
rig.onSceneChange((name) => {
  if (connected) return;
  currentScene = name;
  for (const cb of sceneChangeCbs) { try { cb(name); } catch (e) { console.warn('[obs] sceneChange cb:', e.message); } }
});

/** Switch the module on (the starter in index.js calls this when `modules.obs` is on): the rig
 *  page's socket opens, and with an OBS address set the WebSocket bridge starts connecting (safe if
 *  OBS is closed — it retries). Idempotent. */
function start() {
  if (started) return;
  started = true;
  rig.start();
  URL = instanceConfig.get('obs.url') || null;
  if (URL) connect();
  else console.log('[obs] no OBS WebSocket address (obs.url) — the rig page is the only path to OBS');
}

module.exports = {
  start, playSound, setSpeaking, getCurrentScene, onSceneChange,
  /** The Credentials page's OBS check: the live connection's state (connect() authenticates
   *  with the password, so "identified" is the password working). */
  isConnected: () => connected,
  config: {
    get URL() { return URL; }, AUDIO_SCENE,
    get soundSource() { return soundSource(); }, get botScene() { return botScene(); },
    get botSource() { return botSource(); }, get botShowScene() { return botShowScene(); },
  },
};
