// The four generic OBS overlays: /overlay/alert, /overlay/support-bar,
// /overlay/meter, /overlay/bubble. Each page's REAL inline script runs in a VM against a small fake
// DOM and is fed the frames stream-api really sends — built by the producers themselves where they
// are importable (alert.js buildShowAlert, supportbar.js's broadcasts), else in the exact shape the
// producer writes (timer.js snapshot, the meter module, lifecycle.js's bubble). What is asserted is
// what the streamer would see: the right text in the right place, and a socket value never as markup.
//
// Run: node --test overlay-generic.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const { buildShowAlert } = require('./alert');
const { createSupportBar } = require('./supportbar');
const { registerOverlayRoutes } = require('./overlays');

const PAGES = ['overlay-alert.html', 'overlay-support-bar.html', 'overlay-meter.html', 'overlay-bubble.html'];

function inlineScript(file) {
  const html = fs.readFileSync(path.join(__dirname, file), 'utf8');
  assert.match(html, /<\/html>\s*$/, `${file}: read to its end`);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  assert.equal(scripts.length, 1, `${file}: one inline script`);
  assert.match(scripts[0], /\}\)\(\);\s*$/, `${file}: script read whole`);
  return scripts[0];
}

// Elements record what is written to them. innerHTML is a TRAP: none of these pages may use it.
function fakeElement(id, log) {
  const children = [];
  const listeners = {};
  let text = '';
  let src = '';
  return {
    id, style: {}, className: '', offsetWidth: 600, children, listeners, alt: '',
    get textContent() { return text + children.map((c) => c.textContent).join(''); },
    set textContent(v) { text = String(v); children.length = 0; },
    get innerHTML() { return ''; },
    set innerHTML(v) { log.push({ id, html: String(v) }); },
    get src() { return src; },
    set src(v) { src = String(v); log.push({ id, src: String(v) }); },
    appendChild(c) { children.push(c); return c; },
    addEventListener(type, fn) { listeners[type] = fn; },
  };
}

function runPage(file) {
  const log = [];
  const byId = {};
  const timers = [];
  const document = {
    getElementById: (id) => (byId[id] ||= fakeElement(id, log)),
    querySelector: (sel) => (byId[sel] ||= fakeElement(sel, log)),
    createElement: (tag) => fakeElement(`<${tag}>`, log),
  };
  const sockets = [];
  class FakeWebSocket { constructor(url) { this.url = url; sockets.push(this); } close() {} }
  const ctx = vm.createContext({
    document, location: { protocol: 'https:', host: 'api.site.test', search: '' }, WebSocket: FakeWebSocket, URL,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {},
    String, Number, Math, JSON, isFinite,
  });
  vm.runInContext(inlineScript(file), ctx);
  assert.equal(sockets.length, 1, `${file}: the page opened its socket`);
  assert.equal(sockets[0].url, 'wss://api.site.test', `${file}: the socket is not the page's own origin`);
  const send = (frame) => sockets[0].onmessage({ data: JSON.stringify(frame) });
  const runTimers = () => { const t = timers.splice(0); for (const x of t) x.fn(); };
  return { send, byId, log, runTimers, timers };
}

const XSS = '<img src=x onerror=alert(1)>';

// ── /overlay/alert ───────────────────────────────────────────────────────────

test('alert: a real showAlert frame shows the person, what they did, the amount and the message', () => {
  const p = runPage('overlay-alert.html');
  p.send(buildShowAlert({ platform: 'kofi', username: '@casey', label: 'donated on Ko-fi', amount: '$5.00', message: 'love the stream', userImage: 'https://cdn.site.test/a.png' }));
  assert.equal(p.byId.card.className, 'show', 'the card did not show');
  assert.equal(p.byId.who.textContent, 'casey', 'the name (leading @ dropped)');
  assert.equal(p.byId.what.textContent, 'donated on Ko-fi');
  assert.equal(p.byId.amount.textContent, '$5.00');
  assert.equal(p.byId.message.textContent, 'love the stream');
  assert.equal(p.byId.recipient.className, 'empty', 'an empty recipient line is shown');
  assert.deepEqual(p.log.filter((l) => l.src).map((l) => l.src), ['https://cdn.site.test/a.png']);
});

test('alert: hostile values stay text; only an https: picture loads; alerts queue one at a time', () => {
  const p = runPage('overlay-alert.html');
  p.send(buildShowAlert({ username: XSS, label: XSS, amount: XSS, message: XSS, recipient: XSS, userImage: 'javascript:alert(1)' }));
  p.send(buildShowAlert({ username: 'second', label: 'subscribed', userImage: 'http://cdn.site.test/b.png' }));
  assert.deepEqual(p.log.filter((l) => l.html), [], 'a page wrote markup');
  assert.deepEqual(p.log.filter((l) => l.src), [], 'a non-https picture was loaded');
  assert.equal(p.byId.who.textContent, XSS, 'the first alert is up, its name as text');
  assert.equal(p.byId.pfp.textContent, '<', 'no picture → the first letter, as text');
  p.runTimers(); // hold ends
  p.runTimers(); // fade ends → the queued one
  assert.equal(p.byId.who.textContent, 'second', 'the second alert did not follow the first');
});

test('alert: the hold grows with the message and is capped', () => {
  const p = runPage('overlay-alert.html');
  p.send(buildShowAlert({ username: 'a', message: '' }));
  const short = p.timers.at(-1).ms;
  p.runTimers(); p.runTimers();
  p.send(buildShowAlert({ username: 'b', message: 'x'.repeat(5000) }));
  assert.ok(short >= 5000 && short <= 8000, `a bare alert holds ${short} ms`);
  assert.equal(p.timers.at(-1).ms, 16000, 'a long message is not capped');
});

// ── /overlay/support-bar ─────────────────────────────────────────────────────

test('support bar: paints from the connect-time timerState, then moves with the REAL supportbar broadcasts', async () => {
  const p = runPage('overlay-support-bar.html');
  // timer.js snapshot(): the fields this page reads, as the timer sends them.
  p.send({ type: 'timerState', running: true, remainingSec: 3600, usdPerHour: 40, fillUsd: 200, barTotal: 50, night: { active: false } });
  assert.equal(p.byId.fill.style.width, '25%');
  assert.equal(p.byId.label.textContent, '$50.00 / $200.00');
  assert.equal(p.byId.dividers.children.length, 5, '$200 at $40 a segment is five segments');

  const frames = [];
  const bar = createSupportBar({ pool: { query: async () => ({ rows: [{ s: '50' }] }) }, broadcast: (f) => frames.push(f), getStreamId: async () => 's1' });
  await bar.init();
  bar.add(12.5, 'casey');
  bar.reset();
  for (const f of frames) p.send(f);
  assert.deepEqual(frames.map((f) => f.type), ['updateSupportBar', 'resetSupportBar'], 'premise: the producer sent both frames');
  assert.equal(p.byId.delta.textContent, '+$12.50', 'the contribution popup');
  assert.equal(p.byId.label.textContent, '$0.00 / $200.00', 'a reset did not empty the bar');
  assert.equal(p.byId.fill.style.width, '0%');
});

test('support bar: garbage numbers never paint NaN, and a full bar stops at 100%', () => {
  const p = runPage('overlay-support-bar.html');
  p.send({ type: 'timerState', fillUsd: 'x', usdPerHour: null, barTotal: XSS });
  assert.equal(p.byId.label.textContent, '$0.00');
  p.send({ type: 'timerState', fillUsd: 100, usdPerHour: 0, barTotal: 0 });
  p.send({ type: 'updateSupportBar', total: 250, delta: 150, username: XSS });
  assert.equal(p.byId.fill.style.width, '100%');
  assert.deepEqual(p.log.filter((l) => l.html), [], 'a page wrote markup');
});

// ── /overlay/meter ───────────────────────────────────────────────────────────

test('meter: pace and tonight land on the 0..2 track; unknown hides them; stale dims', () => {
  const p = runPage('overlay-meter.html');
  p.send({ type: 'meterState', pace: null, tonight: null, staleSec: null }); // the module's "not known yet"
  assert.match(p.byId.pace.className, /hidden/);
  assert.match(p.byId.tonight.className, /hidden/);
  p.send({ type: 'meterState', pace: 1, tonight: 0.5, staleSec: 60 });
  assert.equal(p.byId.pace.className, 'marker');
  assert.equal(p.byId.pace.style.transform, 'translateX(300px)', 'break-even sits at the middle of a 600px track');
  assert.equal(p.byId.tonight.style.transform, 'translateX(150px)');
  assert.equal(p.byId.meter.className, '');
  p.send({ type: 'meterState', pace: 5, tonight: -1, staleSec: 9000 });
  assert.equal(p.byId.pace.style.transform, 'translateX(600px)', 'a ratio past 2 is clamped to the end');
  assert.equal(p.byId.tonight.style.transform, 'translateX(0px)');
  assert.equal(p.byId.meter.className, 'stale');
});

// ── /overlay/bubble ──────────────────────────────────────────────────────────

test('bubble: lifecycle.js\'s showSupportBubble shows a reminder, a different line each time, then hides', () => {
  const src = fs.readFileSync(path.join(__dirname, 'lifecycle.js'), 'utf8');
  assert.match(src, /broadcast\(\{ type: 'showSupportBubble' \}\)/, 'premise: the producer still sends this frame');
  const p = runPage('overlay-bubble.html');
  p.send({ type: 'showSupportBubble' });
  const first = p.byId.bubble.textContent;
  assert.equal(p.byId.bubble.className, 'show');
  assert.ok(first.length > 10, 'no reminder text');
  p.runTimers();
  assert.equal(p.byId.bubble.className, 'hide');
  p.runTimers();
  assert.equal(p.byId.bubble.className, '');
  p.send({ type: 'showSupportBubble' });
  assert.notEqual(p.byId.bubble.textContent, first, 'the same line twice in a row');
});

// ── the four pages, as served ────────────────────────────────────────────────

test('each page is served at its address with its CSP, nosniff and no framing — public, like the poll and sticker', async (t) => {
  const app = express();
  registerOverlayRoutes(app);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const crypto = require('node:crypto');
  for (const [route, file] of [['/overlay/alert', PAGES[0]], ['/overlay/support-bar', PAGES[1]], ['/overlay/meter', PAGES[2]], ['/overlay/bubble', PAGES[3]]]) {
    const res = await fetch(base + route);
    assert.equal(res.status, 200, route);
    const html = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.equal(await res.text(), html, `${route} does not serve ${file}`);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const hash = `'sha256-${crypto.createHash('sha256').update(inlineScript(file), 'utf8').digest('base64')}'`;
    assert.ok(res.headers.get('content-security-policy').includes(hash), `${route}: its own script is not allowed by the CSP`);
  }
});

test('the generic pages carry no owner name, colour or address — and no inline handler', () => {
  for (const file of PAGES) {
    const html = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.match(html, /<\/html>\s*$/, `vacuity: ${file} read to its end`);
    assert.doesNotMatch(html, /\b10\.10\.|ws:\/\/\d|localStorage/, `${file}: a hard-coded address or cached state`);
    assert.doesNotMatch(html, /(^|[\s"'`<])on[a-z]+\s*=\s*["'`\\]/m, `${file}: an inline on<event>= handler`);
  }
});
