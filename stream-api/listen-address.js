// Where this process listens: STREAM_API_PORT / STREAM_API_HOST from the install env, with the
// defaults this service has always used. A malformed value is an error, never a silent default —
// a typo'd port that fell back to 3001 would collide with whatever already owns it.

'use strict';

const DEFAULT_PORT = 3001;
const DEFAULT_HOST = '0.0.0.0';

function listenAddress(env = process.env) {
  const rawPort = String(env.STREAM_API_PORT ?? '').trim();
  const rawHost = String(env.STREAM_API_HOST ?? '').trim();
  let port = DEFAULT_PORT;
  if (rawPort) {
    if (!/^[0-9]{1,5}$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
      return { error: `STREAM_API_PORT must be a port number (1-65535), got "${rawPort}"` };
    }
    port = Number(rawPort);
  }
  return { port, host: rawHost || DEFAULT_HOST, error: null };
}

module.exports = { listenAddress };
