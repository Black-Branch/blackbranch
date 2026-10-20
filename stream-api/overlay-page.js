'use strict';
// Serving an OBS overlay page (overlay-poll.html, overlay-sticker.html) with the headers a page
// needs: a Content-Security-Policy, nosniff, and no framing. An overlay renders text only today;
// the policy is defence in depth, so that a future slip (a name written as HTML) cannot run script.
//
// The pages carry their script INLINE. Rather than allow every inline script ('unsafe-inline'), the
// policy names each one by its SHA-256 hash, computed from the file as it is served — so an edited
// overlay is never blocked by a stale hash, and nothing else inline can run. Inline <style> blocks
// and style attributes are allowed (they cannot run script). Images: the sticker overlay shows emote
// pictures from the emote CDNs (https:) and may show a data: or same-origin one. Connections: the
// page's own origin (GET /poll/current) and its WebSocket (ws:/wss: — older browser-source engines
// do not count a same-host WebSocket as 'self').
//
// Framing: OBS loads a browser source as a top-level page (each file's header says so, and the
// site's overlay directory only hands out the URL), so nothing frames these — DENY.

const crypto = require('node:crypto');
const fs = require('node:fs/promises');

// Every <script> without a src attribute: its exact text is what the browser hashes.
const INLINE_SCRIPT = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;

function inlineScriptHashes(html) {
  const out = [];
  for (const m of html.matchAll(INLINE_SCRIPT)) {
    out.push(`'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  }
  return out;
}

function overlayCsp(html) {
  const scripts = inlineScriptHashes(html);
  return [
    "default-src 'self'",
    `script-src 'self'${scripts.length ? ` ${scripts.join(' ')}` : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https: data:",
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Send an overlay page with its security headers. Read per request: the file is tiny, a browser
 *  source loads it once, and the hash then always matches what is served. */
async function sendOverlayPage(res, file) {
  let html;
  try {
    html = await fs.readFile(file, 'utf8');
  } catch (e) {
    console.warn(`[overlay] ${file}: ${e.message}`);
    return res.status(500).type('text/plain').send('overlay unavailable');
  }
  res.set({
    'Content-Security-Policy': overlayCsp(html),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  return res.type('html').send(html);
}

module.exports = { sendOverlayPage };
