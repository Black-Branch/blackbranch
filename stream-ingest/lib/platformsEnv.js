// Which platform chats this process reads: env PLATFORMS, a comma list of
// twitch, kick, youtube, streamplace.
//
// PLATFORMS, when set, is the install's explicit list and wins ("none" = no platform). Unset or
// empty, the process reads what its SETTINGS set up — each platform whose channel is set, and
// YouTube only while its module switch is on — so an install never dials a platform it has no
// channel on. The boot line says which source it used. A name this build has no reader for is
// reported, not silently dropped.

/**
 * @param {string|undefined} raw   the PLATFORMS value
 * @param {string[]} known         the platform names this build can start
 * @returns {{ enabled: string[], unknown: string[], note: string }}
 */
export function parsePlatforms(raw, known) {
  const text = String(raw ?? '').trim();
  if (!text) {
    return { enabled: [], unknown: [], note: `PLATFORMS unset — reading no platform chat (set e.g. PLATFORMS=${known.join(',')})` };
  }
  const names = text.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (names.length === 1 && names[0] === 'none') {
    return { enabled: [], unknown: [], note: 'PLATFORMS=none — reading no platform chat' };
  }
  const enabled = [...new Set(names.filter((n) => known.includes(n)))];
  const unknown = names.filter((n) => !known.includes(n) && n !== 'none');
  const note = `platforms: ${enabled.join(', ') || '(none)'}${unknown.length ? ` — ignoring unknown name(s): ${unknown.join(', ')}` : ''}`;
  return { enabled, unknown, note };
}

/**
 * The platforms the settings set up (PLATFORMS unset). `get` is the settings layer's resolver.
 * @param {(key: string) => unknown} get
 * @returns {{ enabled: string[], unknown: string[], note: string }}
 */
function platformsFromSettings(get) {
  const set = (k) => { const v = get(k); return typeof v === 'string' && v.trim() !== ''; };
  const enabled = [];
  if (set('platform.twitch.channel')) enabled.push('twitch');
  if (set('platform.kick.slug')) enabled.push('kick');
  if (get('modules.youtube') === true && set('platform.youtube.channelId')) enabled.push('youtube');
  if (set('platform.streamplace.did')) enabled.push('streamplace');
  const yt = get('modules.youtube') === true ? '' : ' (YouTube is switched off)';
  return { enabled, unknown: [], note: `PLATFORMS unset — reading the platforms set up in the settings: ${enabled.join(', ') || '(none)'}${yt}` };
}

/**
 * The settings each reader is started with. A reader whose values change is restarted with the
 * new ones (lib/platformStarter.js), and these keys then count as applied (the Credentials page
 * stops showing them as waiting for a restart).
 */
export const PLATFORM_KEYS = {
  twitch: ['platform.twitch.channel'],
  kick: ['platform.kick.slug', 'kick.chatroomId', 'kick.channelId'],
  youtube: ['platform.youtube.channelId', 'modules.youtube'],
  streamplace: ['platform.streamplace.did'],
};

/**
 * One string per platform naming the values its reader would start with now. Pure.
 * @param {string[]} names  @param {(key: string) => unknown} get
 * @returns {Record<string, string>}
 */
function platformSignatures(names, get) {
  const out = {};
  for (const name of names) out[name] = JSON.stringify((PLATFORM_KEYS[name] || []).map((k) => get(k) ?? null));
  return out;
}

/**
 * PLATFORMS when it says anything (unset, empty and "none" all say "not set here"), else the settings.
 * `signatures` names the values each chosen reader would start with (see platformSignatures).
 * @param {string|undefined} raw  @param {string[]} known  @param {(key: string) => unknown} get
 * @returns {{ enabled: string[], unknown: string[], note: string, signatures: Record<string, string> }}
 */
export function choosePlatforms(raw, known, get) {
  const text = String(raw ?? '').trim();
  const chosen = text ? parsePlatforms(raw, known) : platformsFromSettings(get);
  return { ...chosen, signatures: platformSignatures(chosen.enabled, get) };
}
