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

// ── Ticket #168: the 10-07 gift of ten, end to end ──────────────────────────
// A gift of ten memberships (2026-10-07 02:21 PT) was booked as ONE: the parser of the
// day read /gifted\s+(\d+)/ and the banner said "Sent 10 <channel> gift memberships".
// These rebuild that banner as YouTube sends it (bold runs, the gifter's @handle in the
// header, the channel name in the middle of the sentence) on both read paths, in both
// wordings YouTube has used. stream-api's alert-gift-count.test.js takes it from /alert.

const GIFT_ID = 'ChwKGkNKdTEwX2dpZnRfcHVyY2hhc2VfMTAwNw';
const tenGiftRenderer = (runs, id = GIFT_ID) => ({
  liveChatSponsorshipsGiftPurchaseAnnouncementRenderer: {
    id,
    timestampUsec: '1791364860000000',
    authorExternalChannelId: 'UCabcdefghijklmnopqrstuv',
    header: {
      liveChatSponsorshipsHeaderRenderer: {
        authorName: { simpleText: '@casey' },
        authorPhoto: { thumbnails: [{ url: 'https://yt3.example.test/a.jpg', width: 64, height: 64 }] },
        primaryText: { runs },
        image: { thumbnails: [{ url: 'https://www.example.test/gift.png' }] },
      },
    },
  },
});
const bold = (text) => ({ text, bold: true });
const SENT_TEN = [bold('Sent '), bold('10'), bold(' '), bold('Gadget Live'), bold(' gift memberships')];

test('#168 original path (api): the 10-07 "Sent 10 … gift memberships" banner credits 10', () => {
  const a = viaApi(tenGiftRenderer(SENT_TEN));
  assert.equal(a.username, '@casey');
  assert.equal(a.count, 10, 'a ten-gift was credited as ' + a.count);
  assert.equal(a.label, 'gifted 10 memberships');
  assert.equal(a.countUnverified, undefined);
});

test('#168 original path (api): the older "Gifted 10 … memberships" wording credits 10', () => {
  const a = viaApi(tenGiftRenderer([bold('Gifted '), bold('10'), bold(' '), bold('Gadget Live'), bold(' memberships')]));
  assert.equal(a.count, 10);
});

test('#168 original path (dom): the 10-07 banner as the page renders it credits 10', () => {
  const out = runObserver([domGift({ id: GIFT_ID, author: '@casey', primary: '\n      Sent 10 Gadget Live gift memberships\n    ' })]);
  assert.equal(out.length, 1);
  assert.equal(normalizeYouTubeEvent(out[0]).count, 10);
});

// stream-api's ledger refuses a second credit by event id. A gift with no id of its own
// got one minted from the clock ("youtube:mvenyvlu.1" on 10-18), so the same banner read
// twice — a second read path, a reconnect, a restart re-reading the page — was two events
// and two credits. The renderer's own id is the event id.
test('#168 retry: the same gift renderer read twice is the SAME event', () => {
  const first = viaApi(tenGiftRenderer(SENT_TEN));
  const again = viaApi(tenGiftRenderer(SENT_TEN));
  assert.equal(first.eventId, `youtube:${GIFT_ID}`, 'the gift event id is not the renderer id');
  assert.equal(again.eventId, first.eventId, 'reading the same banner twice made two events');
});

test('#168 restart: the page path gives the gift the same event id as the api path', () => {
  const api = viaApi(tenGiftRenderer(SENT_TEN));
  const out = runObserver([domGift({ id: GIFT_ID, author: '@casey', primary: 'Sent 10 Gadget Live gift memberships' })]);
  assert.equal(normalizeYouTubeEvent(out[0]).eventId, api.eventId,
    'after a restart onto the other read path the same gift would be credited again');
});
