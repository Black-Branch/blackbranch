// The two OBS overlay pages stream-api serves (/overlay/poll, /overlay/sticker) arrive with a
// Content-Security-Policy that lets their OWN inline script run and nothing else, nosniff, and no
// framing (review round 3, CSP assessment). Read AS DELIVERED: the real register functions on a
// real express server, fetched over HTTP — a header set on a constant proves nothing about the wire.
//
// Run: node --test overlay-headers.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { registerPollRoutes } = require('./poll');
const { createMoney } = require('./money');

const pass = (req, res, next) => next();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function serve() {
  const app = express();
  registerPollRoutes(app, { pollEngine: { current: () => null }, pool: null, resolveCanonical: async () => null, requireInternal: pass, wrap });
  createMoney({}).registerMoneyRoutes(app, { requireInternal: pass, wrap });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

// The policy's directives as a map: name -> [sources].
function directives(csp) {
  const out = {};
  for (const part of csp.split(';')) {
    const [name, ...src] = part.trim().split(/\s+/);
    if (name) out[name] = src;
  }
  return out;
}

// Each inline script's hash, computed independently of the module under test.
function inlineHashes(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => `'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
}

for (const [route, file] of [['/overlay/poll', 'overlay-poll.html'], ['/overlay/sticker', 'overlay-sticker.html']]) {
  test(`${route} is delivered with a CSP that runs only its own script, nosniff and no framing`, async (t) => {
    const srv = await serve();
    t.after(srv.close);
    const res = await fetch(srv.base + route);
    assert.equal(res.status, 200);
    const body = await res.text();
    const html = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.equal(body, html, 'the page served is not the file');
    assert.match(res.headers.get('content-type') || '', /^text\/html/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');

    const csp = res.headers.get('content-security-policy');
    assert.ok(csp, 'no Content-Security-Policy on the wire');
    const d = directives(csp);
    assert.deepEqual(d['default-src'], ["'self'"]);
    const hashes = inlineHashes(html);
    assert.ok(hashes.length >= 1, `premise: ${file} has an inline script to allow`);
    for (const h of hashes) assert.ok(d['script-src'].includes(h), `${file}'s own inline script is not allowed — the overlay would go dark on stream`);
    assert.ok(!d['script-src'].includes("'unsafe-inline'") && !d['script-src'].includes("'unsafe-eval'"), 'any inline script may run');
    assert.ok(d['style-src'].includes("'unsafe-inline'"), 'the page\'s own <style> block would be blocked');
    assert.deepEqual(d['connect-src'], ["'self'", 'ws:', 'wss:'], 'the page could not reach its WebSocket / fetch');
    assert.ok(d['img-src'].includes('https:'), 'emote pictures from the CDNs would be blocked');
    assert.deepEqual(d['frame-ancestors'], ["'none'"]);
    assert.deepEqual(d['object-src'], ["'none'"]);
    // Vacuity: the file was read to its end.
    assert.match(html, /<\/html>\s*$/);
  });
}

test('a hash for a DIFFERENT script is not what is sent (the hash follows the file)', async (t) => {
  const srv = await serve();
  t.after(srv.close);
  const csp = (await fetch(`${srv.base}/overlay/poll`)).headers.get('content-security-policy');
  const sticker = inlineHashes(fs.readFileSync(path.join(__dirname, 'overlay-sticker.html'), 'utf8'));
  for (const h of sticker) assert.ok(!csp.includes(h), 'the poll page allows the sticker page\'s script');
});
