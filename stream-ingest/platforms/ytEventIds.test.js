// Every YouTube money event is named by the banner's own YouTube id.
//
// stream-api's ledger refuses a second credit by event id. A Super Chat, Super Sticker
// or membership event that carried no id got one minted from the clock
// (normalizeYouTubeEvent → eventIdFor), so the same banner read twice — a second read
// path, a reconnect, a restart re-reading the page — was two events and two credits.
// The gift renderer was fixed first (ytGiftCount.test.js, ticket #168); these are the
// other three kinds, on both read paths.
//
// Run: node --test platforms/ytEventIds.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { ytClassifyItem, installObserver } from './youtube.js';
import { normalizeYouTubeEvent } from '../lib/alerts.js';

const quiet = (fn) => {
  const saved = { log: console.log, warn: console.warn };
  console.log = () => {}; console.warn = () => {};
  try { return fn(); } finally { Object.assign(console, saved); }
};

// ── innertube (api) path ────────────────────────────────────────────────────
const API = {
  superchat: (id) => ({ liveChatPaidMessageRenderer: { id, authorName: { simpleText: '@casey' },
    purchaseAmountText: { simpleText: '$5.00' }, message: { runs: [{ text: 'keep going' }] } } }),
  supersticker: (id) => ({ liveChatPaidStickerRenderer: { id, authorName: { simpleText: '@casey' },
    purchaseAmountText: { simpleText: '$2.00' } } }),
  membership: (id) => ({ liveChatMembershipItemRenderer: { id, authorName: { simpleText: '@casey' },
    headerSubtext: { runs: [{ text: 'Welcome to Gadget Club!' }] } } }),
};

function viaApi(item) {
  const c = ytClassifyItem(item);
  assert.equal(c.kind, 'event', `the renderer was not delivered (${c.kind})`);
  return quiet(() => normalizeYouTubeEvent(c.data));
}

// ── page (DOM) path: the real in-page observer against a stub document ──────
const TAG = {
  superchat: 'YT-LIVE-CHAT-PAID-MESSAGE-RENDERER',
  supersticker: 'YT-LIVE-CHAT-PAID-STICKER-RENDERER',
  membership: 'YT-LIVE-CHAT-MEMBERSHIP-ITEM-RENDERER',
};
const TEXT = {
  '#author-name': '@casey',
  '#purchase-amount': '$5.00',
  '#purchase-amount-chip': '$2.00',
  '#message': 'keep going',
  '#header-subtext': 'Welcome to Gadget Club!',
};
const domNode = (kind, id) => ({
  nodeType: 1, tagName: TAG[kind], id,
  getAttribute: () => null,
  querySelector: (sel) => (sel in TEXT ? { textContent: TEXT[sel] } : null),
});

function viaPage(kind, id) {
  const saved = { document: globalThis.document, window: globalThis.window,
    MutationObserver: globalThis.MutationObserver, Node: globalThis.Node };
  const delivered = [];
  let callback = null;
  globalThis.document = { querySelector: () => null, body: {} };
  globalThis.window = { __ssOnEvent: (d) => delivered.push(d), __ssOnMessage: () => {} };
  globalThis.Node = { TEXT_NODE: 3 };
  globalThis.MutationObserver = class { constructor(cb) { callback = cb; } observe() {} };
  try {
    quiet(() => { installObserver(); callback([{ addedNodes: [domNode(kind, id)] }]); });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete globalThis[k]; else globalThis[k] = v;
    }
  }
  assert.equal(delivered.length, 1, `the page path did not deliver the ${kind}`);
  return quiet(() => normalizeYouTubeEvent(delivered[0]));
}

for (const kind of ['superchat', 'supersticker', 'membership']) {
  const id = `ChwKGkNK-${kind}-0001`;

  test(`${kind} original path: the event id is the banner's own YouTube id`, () => {
    assert.equal(viaApi(API[kind](id)).eventId, `youtube:${id}`);
    assert.equal(viaPage(kind, id).eventId, `youtube:${id}`);
  });

  test(`${kind} retry: the same banner read twice is ONE event`, () => {
    assert.equal(viaApi(API[kind](id)).eventId, viaApi(API[kind](id)).eventId,
      'reading the same banner twice made two events (two credits)');
  });

  test(`${kind} restart: the api path and the page path give the same id`, () => {
    assert.equal(viaPage(kind, id).eventId, viaApi(API[kind](id)).eventId,
      'after a restart onto the other read path the same event would be credited again');
  });
}
