// stream.place connector — connects to stream.place's own per-channel chat
// WebSocket (wss://stream.place/api/websocket/{streamerDid}), discovered by
// inspecting the official chat popout. Browser-free, no auth; frames are
// fully-hydrated JSON discriminated by $type. The chat frame
// (place.stream.chat.defs#messageView) carries author DID + handle + badges +
// text inline, so no DID->handle resolution is needed.
//
// Why not the public ATProto Jetstream: stream.place chat federates to the main
// relay too unreliably for live use (the streamer's own messages did not
// show up there in real time). This per-channel socket is the feed the
// stream.place player/popout itself uses, so it's complete and immediate.

import WebSocket from 'ws';
import { processMessage } from '../lib/pipeline.js';
import { instanceConfig } from '../lib/instanceConfig.js';
import { payloadShape } from '../lib/logShape.js';

const CHAT_MSG = 'place.stream.chat.defs#messageView';

// chatProfile.color is {red,green,blue} (0-255) → "#rrggbb".
function rgbToHex(c) {
  if (!c || !Number.isFinite(c.red)) return undefined;
  const h = (n) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, '0');
  return `#${h(c.red)}${h(c.green)}${h(c.blue)}`;
}

function flagsFromBadges(badges) {
  const types = (badges || []).map((b) => (b?.badgeType || '').toLowerCase());
  const has = (s) => types.some((t) => t.includes(s));
  return {
    isMod: has('streamer') || has('moderator'), // streamer = the broadcaster
    isVip: has('vip'),
    isMember: has('subscriber') || has('member'),
    tier: '',
  };
}

export async function startStreamplace() {
  const did = instanceConfig.get('platform.streamplace.did');
  if (!did) { console.warn('[streamplace] platform.streamplace.did is not set (STREAMPLACE_STREAMER_DID) — not connecting'); return { stop() {}, getViewers: () => null }; }
  const url = `wss://stream.place/api/websocket/${did}`;
  let ws = null;
  let stopped = false;
  let backoff = 1000;
  let connectedAt = 0;
  const seen = new Set(); // message uris — intra-session dedup across reconnects

  // Latest viewer count off the socket's livestream frames, read by the viewer
  // poller via the handle's getViewers(). Staleness-capped so a dead/quiet WS
  // reads as "unknown" (null), never a frozen number.
  let lastViewers = null; // { count, at }
  let loggedViewerFrame = false;
  let loggedLivestreamViewFrame = false;
  const VIEWER_STALE_MS = 5 * 60 * 1000;

  // Half-open-socket watchdog: reconnect-on-close alone cannot notice a socket
  // that goes silent WITHOUT firing 'close' (TCP still up, no frames, hung
  // forever). kick.js has the same guard. Difference here: a
  // live-but-quiet chat produces no application frames, so we drive it off a
  // WebSocket-level ping — stream.place's server auto-answers with a pong, and
  // `lastActiveAt` advances on ANY frame OR a pong. Only a truly dead socket
  // (no frames AND no pong reply) trips the STALE_MS terminate → 'close' →
  // reconnect. So a silent-but-alive stream is never torn down by mistake.
  const STALE_MS = Number(process.env.STREAMPLACE_STALE_MS || 180_000);
  let lastActiveAt = Date.now();
  let watchdog = null;
  const stopWatchdog = () => { if (watchdog) { clearInterval(watchdog); watchdog = null; } };

  const connect = () => {
    if (stopped) return;
    // handshakeTimeout: without it a handshake that never completes emits no
    // event at all — the watchdog is only armed inside 'open', so the connector
    // would hang forever with no log. See the same guard in kick.js.
    ws = new WebSocket(url, { headers: { Origin: 'https://stream.place' }, handshakeTimeout: 15_000 });

    ws.on('open', () => {
      connectedAt = Date.now();
      lastActiveAt = Date.now();
      console.log(`[streamplace] connected (${did})`);
      backoff = 1000;
      stopWatchdog();
      watchdog = setInterval(() => {
        if (stopped) return;
        if (Date.now() - lastActiveAt > STALE_MS) {
          console.warn(`[streamplace] no frames/pong for ${Math.round((Date.now() - lastActiveAt) / 1000)}s — socket is half-open, forcing reconnect`);
          try { ws.terminate(); } catch { /* already gone */ } // terminate() runs the 'close' handler → reconnect
          return;
        }
        try { ws.ping(); } catch { /* socket already dead; watchdog will terminate next tick */ }
      }, Math.min(STALE_MS / 3, 30_000)).unref?.();
    });

    ws.on('pong', () => { lastActiveAt = Date.now(); });

    ws.on('message', (buf) => {
      lastActiveAt = Date.now();
      let e;
      try {
        e = JSON.parse(buf.toString());
      } catch {
        return;
      }
      // place.stream.livestream#viewerCount frames carry the concurrent-viewer
      // count — capture it for the snapshot poller. Exact field name unconfirmed
      // until seen live: probe, and log one frame's SHAPE (id + keys, never values —
      // lib/logShape.js) for mapping if none matches.
      // (#livestreamView is a stream-status record with NO count — ignore it and
      // every other non-chat frame silently.)
      if (typeof e.$type === 'string' && e.$type.endsWith('#viewerCount')) {
        const raw = e.viewerCount ?? e.count ?? e.viewers ?? e.record?.viewerCount ?? e.record?.count;
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0) {
          lastViewers = { count: n, at: Date.now() };
        } else if (!loggedViewerFrame) {
          loggedViewerFrame = true;
          console.log(`[streamplace] viewerCount frame (map viewer field): ${payloadShape(e)} record=${payloadShape(e.record)}`);
        }
        return;
      }
      if (typeof e.$type === 'string' && e.$type.endsWith('#livestreamView') && !loggedLivestreamViewFrame) {
        loggedLivestreamViewFrame = true;
        console.log(`[streamplace] livestreamView frame (map liveness field): ${payloadShape(e)} record=${payloadShape(e.record)}`);
      }
      if (e.$type !== CHAT_MSG) return; // ignore livestreamView / segment / other non-chat frames

      const uri = e.uri;
      if (uri) {
        if (seen.has(uri)) return;
        seen.add(uri);
        if (seen.size > 5000) seen.clear();
      }
      const rec = e.record || {};
      // The socket replays a recent backlog on connect — skip it and only ingest
      // genuinely live messages, like every other platform connector.
      const ts = Date.parse(rec.createdAt || '');
      if (Number.isFinite(ts) && ts < connectedAt - 10000) return;

      // Native ATProto threading: the messageView hydrates the parent as `replyTo`
      // (author + record) when the message is a reply. (record.reply carries the
      // raw root/parent strong-refs if deeper resolution is ever needed.)
      const replyToUsername = e.replyTo?.author?.handle || undefined;
      const replyToText = e.replyTo?.record?.text || undefined;

      processMessage({
        platform: 'streamplace',
        userId: e.author?.did || '',
        username: e.author?.handle || e.author?.did || 'streamplace',
        message: rec.text || '',
        ...flagsFromBadges(e.badges),
        replyToUsername,
        replyToText,
        platformMsgId: e.uri || undefined,
        usernameColor: rgbToHex(e.chatProfile?.color),
      });
    });

    ws.on('close', () => {
      stopWatchdog(); // no socket to watch until the next 'open'
      if (stopped) return;
      console.warn(`[streamplace] disconnected; reconnecting in ${backoff}ms`);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30000);
    });

    ws.on('error', (err) => console.warn('[streamplace] ws error:', err.message));
  };

  connect();
  console.log(`[streamplace] watching chat for ${did}`);
  return {
    stop: () => {
      stopped = true;
      stopWatchdog();
      if (ws) ws.close();
    },
    // Latest viewer count, or null if none seen within the staleness window.
    getViewers: () =>
      lastViewers && Date.now() - lastViewers.at < VIEWER_STALE_MS ? lastViewers.count : null,
  };
}
