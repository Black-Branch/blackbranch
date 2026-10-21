// GET /health — is every chat reader the settings ask for actually reading?
//
// `docker compose ps` says "running" even when every reader has failed to start: the process is
// up and nothing is read. The bundle's healthcheck, the Doctor's "Chat readers
// started" row and the Admin Panel's Stream tab all read this one answer:
//
//   { "ok": bool,
//     "readers": { "<platform>": { "state": "running"|"starting"|"failed"|"off", "since": iso, "error": one line } },
//     "bot": "running"|"off" }
//
// ok = every platform the settings enable is `running`, or `starting` for under 120 s. An install
// with no platform set up is ok (nothing is asked for). The error is the reader's own one line
// (lib/platformStarter.js oneLine): no payloads, no viewer names.
//
// Bind: INGEST_HEALTH_PORT (default 3010) on INGEST_HEALTH_BIND (default 0.0.0.0 — inside the bundle
// the web container and the healthcheck reach it on the compose network; a systemd install sets
// 127.0.0.1). It answers nothing else and reads nothing from the request.

import { createServer } from 'node:http';

const STARTING_GRACE_MS = 120_000;

/**
 * Pure: the /health body from the starter's states.
 * @param {{ readers: Record<string, { state: string, since: string, error: string }>, wanted: (name: string) => boolean, bot: boolean, now?: number }} input
 */
export function healthBody({ readers, wanted, bot, now = Date.now() }) {
  let ok = true;
  for (const [name, r] of Object.entries(readers)) {
    if (!wanted(name)) continue;
    if (r.state === 'running') continue;
    if (r.state === 'starting' && now - Date.parse(r.since) < STARTING_GRACE_MS) continue;
    ok = false;
  }
  return { ok, readers, bot: bot ? 'running' : 'off' };
}

/**
 * @param {{ snapshot: () => object, port?: number, host?: string, log?: Pick<Console, 'log'|'error'> }} opts
 * @returns {{ ready: Promise<number|null>, stop: () => Promise<void> }} ready resolves the bound port (null when it could not bind)
 */
export function startHealthServer({ snapshot, port = Number(process.env.INGEST_HEALTH_PORT ?? 3010), host = process.env.INGEST_HEALTH_BIND || '127.0.0.1', log = console }) {
  const server = createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (req.method !== 'GET' || path !== '/health') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    let body;
    try { body = snapshot(); } catch (e) { body = { ok: false, readers: {}, bot: 'off', error: String(e?.message || e).split('\n')[0] }; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  });
  const ready = new Promise((resolve) => {
    server.once('error', (e) => {
      // A port already taken must not take the chat readers down with it: said once, loudly.
      log.error(`[health] cannot listen on ${host}:${port} (${e.code || e.message}) — /health is unavailable`);
      resolve(null);
    });
    server.listen(port, host, () => {
      const bound = server.address().port;
      log.log(`[health] listening on ${host}:${bound}`);
      resolve(bound);
    });
  });
  return {
    ready,
    host,
    stop: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}
