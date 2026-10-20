#!/usr/bin/env node
'use strict';
// audio-satellite — plays audio on the stream rig for a stream-api that lives
// elsewhere (a server that is not the streaming PC). The PipeWire graph OBS
// captures (the TTS sink, alert sounds) exists only on the streaming PC. This daemon is the rig's ears: it accepts audio BYTES over LAN HTTP
// and plays them with pw-play, preserving the one semantic the TTS pipeline
// depends on — the response body completes only when pw-play exits, i.e. when
// the sink has fully DRAINED, so a long-poll await on the client is still the
// definitive end of audio. Bytes travel in the request because TTS clips are
// synthesized per-turn — there is no pre-synced media copy that could serve them.
//
// No auth beyond a source-IP allowlist: LAN-only, carries no secrets, plays
// sounds. SATELLITE_ALLOW must list every caller — the default covers loopback
// only, so the server's IP has to be added or nothing remote can play.
//
// Runs as a systemd USER service (with linger enabled): PipeWire lives in the
// user session, which is why this cannot be a system unit without grafting the
// session's env onto it.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

const PORT = Number(process.env.SATELLITE_PORT || 3005);
const PLAY_CMD = process.env.SATELLITE_PLAY_CMD || 'pw-play'; // tests stub this
const ALLOW = new Set(
  (process.env.SATELLITE_ALLOW || '127.0.0.1,::1').split(',').map((s) => s.trim()).filter(Boolean)
);
const MAX_BODY = 32 * 1024 * 1024; // TTS turns are ~100s of KB; this is a backstop
const MAX_PLAYERS = 8; // backstop against a runaway caller
// If the caller's kill can never arrive (network gone), a clip must still end:
const MAX_PLAY_MS = Number(process.env.SATELLITE_MAX_PLAY_MS || 10 * 60 * 1000);

const players = new Map(); // id → child process

function allowed(req) {
  // remoteAddress arrives IPv4-mapped (::ffff:a.b.c.d) on a dual-stack listener.
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return ALLOW.has(ip);
}

function handlePlay(req, res, url) {
  if (players.size >= MAX_PLAYERS) { res.writeHead(429); res.end('busy'); return; }
  const sink = url.searchParams.get('sink') || '';
  if (sink && !/^[\w.-]+$/.test(sink)) { res.writeHead(400); res.end('bad sink'); return; }
  const chunks = [];
  let size = 0;
  req.on('error', () => { /* aborted upload — nothing was spawned yet */ });
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) { res.writeHead(413); res.end('too large'); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (size === 0) { res.writeHead(400); res.end('empty body'); return; }
    const id = randomUUID();
    const file = path.join(os.tmpdir(), `satellite-${id}.audio`);
    let child;
    try {
      fs.writeFileSync(file, Buffer.concat(chunks));
      child = spawn(PLAY_CMD, sink ? [`--target=${sink}`, file] : [file], { stdio: 'ignore' });
    } catch (e) {
      try { fs.unlinkSync(file); } catch { /* never existed */ }
      res.writeHead(500);
      res.end(String(e.message));
      return;
    }
    players.set(id, child);
    const started = Date.now();
    // Flush the id NOW: fetch() resolves on headers, so the caller can kill a
    // play whose long-poll body is still streaming.
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Play-Id': id });
    res.flushHeaders();
    const backstop = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, MAX_PLAY_MS);
    child.on('error', (e) => console.warn('[satellite] play error:', e.message));
    child.on('close', (code, signal) => {
      clearTimeout(backstop);
      players.delete(id);
      try { fs.unlinkSync(file); } catch { /* already cleaned */ }
      // A caller that disconnected mid-play gets a dead socket here — harmless;
      // like the local spawn, playback itself is never cut by a lost parent.
      if (!res.writableEnded) {
        res.end(JSON.stringify({ done: true, killed: signal === 'SIGKILL', ms: Date.now() - started }));
      }
    });
  });
}

const server = http.createServer((req, res) => {
  if (!allowed(req)) { res.writeHead(403); res.end('forbidden'); return; }
  const url = new URL(req.url, 'http://satellite');
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, playing: players.size }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/play') { handlePlay(req, res, url); return; }
  const kill = req.method === 'DELETE' && url.pathname.match(/^\/play\/([0-9a-f-]{36})$/);
  if (kill) {
    const child = players.get(kill[1]);
    if (!child) { res.writeHead(404); res.end('gone'); return; }
    try { child.kill('SIGKILL'); } catch { /* exited between get and kill — the outcome we wanted */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ killed: true }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`[satellite] listening on ${server.address().port} (cmd=${PLAY_CMD})`);
});

// systemd stop: children of a user service die with the cgroup anyway, but be
// explicit so a manual run behaves the same.
process.on('SIGTERM', () => {
  for (const child of players.values()) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});
