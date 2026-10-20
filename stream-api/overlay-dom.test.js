// The two OBS overlay pages stream-api serves (overlay-poll.html, overlay-sticker.html) put values
// from the PUBLIC WebSocket on screen. This runs each page's real inline script against a small fake
// DOM and feeds it hostile frames: a socket value must reach the page as text, and the sticker page
// must load only an https: image.
//
// Run: node --test overlay-dom.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function inlineScript(file) {
  const html = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1, `${file}: one inline script`);
  // End-of-script anchor: the IIFE's own closing line, so a truncated read cannot pass.
  assert.match(scripts[0], /\}\)\(\);\s*$/, `${file}: script read whole`);
  return scripts[0];
}

// An element whose innerHTML writes are recorded and whose querySelector hands out a child per
// selector, so a script that builds rows by innerHTML + querySelector can run without a parser.
function fakeElement(log) {
  const children = {};
  let inner = '';
  const el = {
    style: {},
    className: '',
    textContent: '',
    classList: { add() {}, remove() {}, toggle() {} },
    offsetWidth: 0,
    appendChild(c) { return c; },
    querySelector(sel) { return (children[sel] ||= fakeElement(log)); },
    get innerHTML() { return inner; },
    set innerHTML(v) { inner = String(v); log.push(inner); },
  };
  return el;
}

function runPage(file, extra = {}) {
  const htmlWrites = [];
  const byId = {};
  const sockets = [];
  const document = {
    getElementById: (id) => (byId[id] ||= fakeElement(htmlWrites)),
    querySelector: (sel) => (byId[sel] ||= fakeElement(htmlWrites)),
    createElement: () => fakeElement(htmlWrites),
  };
  class FakeWebSocket { constructor(url) { this.url = url; sockets.push(this); } close() {} }
  const ctx = vm.createContext({
    document, location: { protocol: 'http:', host: 'overlay.test' }, WebSocket: FakeWebSocket, URL,
    fetch: () => new Promise(() => {}), setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
    requestAnimationFrame() {}, String, Date, Math, JSON, ...extra,
  });
  vm.runInContext(inlineScript(file), ctx);
  assert.equal(sockets.length, 1, 'the page opened its socket');
  const send = (frame) => sockets[0].onmessage({ data: JSON.stringify(frame) });
  return { send, byId, htmlWrites };
}

const XSS = '<img src=x onerror=alert(1)>';

test('poll overlay: an option number and text from the socket are text, never markup', () => {
  const { send, htmlWrites } = runPage('overlay-poll.html');
  send({ type: 'pollUpdate', poll: { pollId: 'p1', status: 'active', question: 'Q', endsAt: Date.now() + 60_000,
    total: 0, tallies: {}, options: [{ n: XSS, text: XSS }, { n: 2, text: 'two' }] } });
  assert.ok(htmlWrites.length >= 2, 'the rows were built');
  for (const h of htmlWrites) assert.ok(!h.includes('onerror'), `socket value reached innerHTML: ${h}`);
  // The number still shows — as text.
  assert.ok(htmlWrites.some((h) => h.includes('<span class="num"></span>')), 'the number span is built empty and filled as text');
});

test('sticker overlay: only an https: image is loaded; javascript:, data: and http: are skipped', () => {
  const { send, byId } = runPage('overlay-sticker.html');
  const img = byId.img;
  const loaded = [];
  Object.defineProperty(img, 'src', { set(v) { loaded.push(v); }, get() { return loaded.at(-1) || ''; } });
  for (const bad of ['javascript:alert(1)', 'data:image/svg+xml,<svg onload=alert(1)>', 'http://cdn.example.test/e.png', 'not a url', '', null]) {
    send({ type: 'showSticker', emoteUrl: bad, username: 'casey' });
  }
  assert.deepEqual(loaded, [], 'no unsafe address was given to the image');
  send({ type: 'showSticker', emoteUrl: 'https://cdn.example.test/emote/1/4x.webp', username: 'casey' });
  assert.deepEqual(loaded, ['https://cdn.example.test/emote/1/4x.webp']);
  assert.equal(byId['#who .n'].textContent, 'casey', 'the sender name is text');
});
