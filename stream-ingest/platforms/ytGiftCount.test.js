// YouTube gifted memberships: the count must survive BOTH scrape paths.
// Run: node --test platforms/ytGiftCount.test.js
//
// A /gifted\s+(\d+)/ read with a silent fallback to 1 never matches the banner's
// wording ("Sent 5 <channel> gift memberships") and credits every multi-gift as
// one membership. The count is read once, on the Node side, by lib/alerts.js parseGiftCount; each path's job is
// to deliver the banner's raw text intact. These tests push real-shaped
// banners through each path end to end — the innertube renderer through
// ytClassifyItem, the DOM renderer through the in-page observer itself — and
// then through normalizeYouTubeEvent, which is what reaches /alert.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ytClassifyItem, installObserver } from './youtube.js';
import { normalizeYouTubeEvent } from '../lib/alerts.js';

// ── innertube (API) path ────────────────────────────────────────────────────

const apiGift = ({ author = 'Viewer2026', runs }) => ({
  liveChatSponsorshipsGiftPurchaseAnnouncementRenderer: {
    id: 'gift-1',
    header: {
      liveChatSponsorshipsHeaderRenderer: {
        ...(author ? { authorName: { simpleText: author } } : {}),
        primaryText: { runs },
      },
    },
  },
});

function viaApi(item) {
  const c = ytClassifyItem(item);
  assert.equal(c.kind, 'event', `the gift renderer was not delivered (${c.kind})`);
  return normalizeYouTubeEvent(c.data);
}

test('api path: "Sent 5 <channel> gift memberships" credits 5', () => {
  const a = viaApi(apiGift({ runs: [{ text: 'Sent ' }, { text: '5' }, { text: ' ' }, { text: 'Gadget Live' }, { text: ' gift memberships' }] }));
  assert.equal(a.eventType, 'membership-gift');
  assert.equal(a.username, 'Viewer2026');
  assert.equal(a.count, 5, 'a five-gift banner was credited as ' + a.count);
  assert.equal(a.countUnverified, undefined);
});

test('api path: the older "Gifted N" wording still counts', () => {
  const a = viaApi(apiGift({ runs: [{ text: 'Gifted ' }, { text: '20' }, { text: ' Gadget memberships' }] }));
  assert.equal(a.count, 20);
});

test('api path: a numeric donor name in the text is not the count', () => {
  const a = viaApi(apiGift({ author: '', runs: [{ text: 'Viewer2026 gifted 3 Gadget memberships' }] }));
  assert.equal(a.username, 'Viewer2026');
  assert.equal(a.count, 3, 'the donor name "Viewer2026" leaked into the count');
});

test('api path: a donor name containing the gift wording cannot set the count', () => {
  const named = viaApi(apiGift({ author: 'Sent 500 x', runs: [{ text: 'Sent 500 x gifted 1 membership' }] }));
  assert.equal(named.count, 1, 'the donor\'s name set the gift count');
  const unnamed = viaApi(apiGift({ author: '', runs: [{ text: 'Sent 500 x gifted 1 membership' }] }));
  assert.equal(unnamed.username, 'Sent 500 x');
  assert.equal(unnamed.count, 1, 'the donor\'s name set the gift count');
});

test('api path: unrecognised wording credits 1 flagged unverified', () => {
  const orig = console.warn;
  console.warn = () => {};
  let a;
  try { a = viaApi(apiGift({ runs: [{ text: 'Viewer2026 shared the love' }] })); } finally { console.warn = orig; }
  assert.equal(a.count, 1);
  assert.equal(a.countUnverified, true);
});

// ── DOM path: run the real in-page observer against a stub document ─────────

const GIFT_TAG = 'YT-LIVE-CHAT-SPONSORSHIPS-GIFT-PURCHASE-ANNOUNCEMENT-RENDERER';

function runObserver(nodes) {
  const saved = { document: globalThis.document, window: globalThis.window,
    MutationObserver: globalThis.MutationObserver, Node: globalThis.Node };
  const delivered = [];
  let callback = null;
  globalThis.document = { querySelector: () => null, body: {} };
  globalThis.window = { __ssOnEvent: (d) => delivered.push(d), __ssOnMessage: () => {} };
  globalThis.Node = { TEXT_NODE: 3 };
  globalThis.MutationObserver = class { constructor(cb) { callback = cb; } observe() {} };
  const quiet = { log: console.log, warn: console.warn };
  console.log = () => {}; console.warn = () => {};
  try {
    installObserver();
    assert.ok(callback, 'installObserver never created its MutationObserver');
    callback([{ addedNodes: nodes }]);
  } finally {
    Object.assign(console, quiet);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete globalThis[k]; else globalThis[k] = v;
    }
  }
  return delivered;
}

const domGift = ({ id, author, primary }) => ({
  nodeType: 1, tagName: GIFT_TAG, id,
  getAttribute: () => null,
  querySelector: (sel) => {
    if (sel === '#author-name') return author == null ? null : { textContent: author };
    if (sel === '#primary-text') return { textContent: primary };
    return null;
  },
});

test('dom path: "Sent 5 <channel> gift memberships" credits 5', () => {
  const out = runObserver([domGift({ id: 'g1', author: 'Viewer2026', primary: ' Sent 5 Gadget Live gift memberships ' })]);
  assert.equal(out.length, 1, 'the observer did not deliver the gift banner');
  const a = normalizeYouTubeEvent(out[0]);
  assert.equal(a.username, 'Viewer2026');
  assert.equal(a.count, 5, 'a five-gift banner was credited as ' + a.count);
});

test('dom path: numeric donor name with no author element', () => {
  const out = runObserver([domGift({ id: 'g2', author: null, primary: 'Viewer2026 sent 4 gift memberships' })]);
  // Without #author-name the gifter falls back to the text before the verb —
  // which must cut at "sent" as well as "gifted", or the whole banner becomes
  // the donor's name. And the name's digits must not become the count.
  assert.equal(out.length, 1, 'the observer did not deliver the gift banner');
  const a = normalizeYouTubeEvent(out[0]);
  assert.equal(a.username, 'Viewer2026');
  assert.equal(a.count, 4, 'the donor name "Viewer2026" leaked into the count');
});

test('dom path: a donor name containing the gift wording cannot set the count', () => {
  const out = runObserver([
    domGift({ id: 'g5', author: 'Sent 500 x', primary: 'Sent 500 x gifted 1 membership' }),
    domGift({ id: 'g6', author: null, primary: 'Sent 500 x gifted 1 membership' }),
  ]);
  assert.equal(out.length, 2, 'the observer did not deliver both banners');
  for (const d of out) assert.equal(normalizeYouTubeEvent(d).count, 1, 'the donor\'s name set the gift count');
});

test('dom path: every gift banner in one mutation batch is delivered with its own count', () => {
  const out = runObserver([
    domGift({ id: 'g3', author: 'casey', primary: 'Sent 2 Gadget gift memberships' }),
    domGift({ id: 'g4', author: 'Viewer2026', primary: 'Gifted 10 Gadget memberships' }),
  ]);
  assert.deepEqual(out.map((d) => normalizeYouTubeEvent(d).count), [2, 10]);
});
