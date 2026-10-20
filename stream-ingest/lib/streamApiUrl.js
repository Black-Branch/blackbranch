// Where stream-api is. ONE reader for every caller in this process.
//
// NO DEFAULT, on purpose. A default address would let an unset env quietly send
// chat, bot traces and ops alerts to a machine that may not run the service. A
// missing value is an error that names itself: index.js checks it at boot and exits, so systemd
// shows a failed unit instead of a healthy-looking process delivering nothing.
//
// Read at CALL time, not import time: tests set the env before they call, and a
// module-load throw would break every suite that merely imports a module that
// imports this one.

export class StreamApiUrlMissing extends Error {
  constructor() {
    super('STREAM_API_URL is not set — stream-ingest cannot reach stream-api (no default: set it in .env)');
    this.name = 'StreamApiUrlMissing';
  }
}

/** The stream-api base URL with no trailing slash. Throws when unset. */
export function streamApiBase() {
  const raw = (process.env.STREAM_API_URL || '').trim();
  if (!raw) throw new StreamApiUrlMissing();
  return raw.replace(/\/$/, '');
}

/**
 * The stream-api WebSocket URL: STREAM_WS_URL when set, else STREAM_API_URL with its scheme
 * swapped (http → ws, https → wss) — the socket is served by the same process and port.
 * Throws when neither is set. `env` is injectable for callers that take one.
 */
export function streamApiWsUrl(env = process.env) {
  const explicit = String(env.STREAM_WS_URL || '').trim();
  if (explicit) return explicit;
  const raw = String(env.STREAM_API_URL || '').trim();
  if (!raw) throw new StreamApiUrlMissing();
  return raw.replace(/\/$/, '').replace(/^http(s?):\/\//i, 'ws$1://');
}
