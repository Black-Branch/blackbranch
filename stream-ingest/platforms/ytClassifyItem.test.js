// Every way a YouTube chat item can be discarded.
// Run: node --test platforms/ytClassifyItem.test.js
//
// The failure guarded against is not "an item parsed wrong", it is "an item
// vanished and nothing said so": the dedup set can grow while zero rows reach
// chat_log and every poll counter looks healthy. Poll health measures the
// FETCH; the loss is in the drain.
//
// So each fate is pinned by name. `drop-text` and `drop-event` are the loss
// surface, and the counters that report them are only meaningful if these
// branches are.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ytClassifyItem } from './youtube.js';

const textItem = (over = {}) => ({
  liveChatTextMessageRenderer: {
    id: 'msg1',
    authorName: { simpleText: 'someviewer' },
    message: { runs: [{ text: 'hello' }] },
    ...over,
  },
});

test("a normal text message is delivered", () => {
  const r = ytClassifyItem(textItem());
  assert.equal(r.kind, 'text');
  assert.equal(r.data.text, 'hello');
  assert.equal(r.data.author, 'someviewer');
});

test("an emoji-only message still carries text, so it is NOT discarded", () => {
  // Pinned so it cannot regress quietly: a
  // message of nothing but emoji must survive, because `emojiId` is the
  // character itself.
  const r = ytClassifyItem(textItem({ message: { runs: [{ emoji: { emojiId: '🔥' } }] } }));
  assert.equal(r.kind, 'text');
  assert.equal(r.data.text, '🔥');
});

test("a custom emote resolves through its shortcut and is kept", () => {
  const r = ytClassifyItem(textItem({
    message: { runs: [{ emoji: {
      isCustomEmoji: true,
      shortcuts: [':kek:'],
      image: { thumbnails: [{ url: 'https://yt3.ggpht.com/kek.png' }] },
    } }] },
  }));
  assert.equal(r.kind, 'text');
  assert.equal(r.data.text, ':kek:');
  assert.equal(r.data.emotes[':kek:'], 'https://yt3.ggpht.com/kek.png');
});

test("a custom emote with NO shortcut leaves empty text — and is DISCARDED", () => {
  // A real candidate for a silent loss, and the reason the counter exists:
  // this produces nothing.
  const r = ytClassifyItem(textItem({
    message: { runs: [{ emoji: { isCustomEmoji: true, image: { thumbnails: [{ url: 'x' }] } } }] },
  }));
  assert.equal(r.kind, 'drop-text');
});

test("a text message with no author is DISCARDED", () => {
  const r = ytClassifyItem(textItem({ authorName: undefined }));
  assert.equal(r.kind, 'drop-text');
});

test("a superchat is delivered as an event", () => {
  const r = ytClassifyItem({
    liveChatPaidMessageRenderer: {
      id: 'sc1',
      authorName: { simpleText: 'bigspender' },
      purchaseAmountText: { simpleText: '$5.00' },
      message: { runs: [{ text: 'nice stream' }] },
    },
  });
  assert.equal(r.kind, 'event');
  assert.equal(r.data.kind, 'superchat');
  assert.equal(r.data.amount, '$5.00');
});

test("a recognised event with no author is DISCARDED, not delivered", () => {
  // `deliverEvent` requires an author; without one the item is dropped.
  // Distinguishing it from `other` is what tells whether a gap ate real
  // monetisation events.
  const r = ytClassifyItem({
    liveChatPaidMessageRenderer: { id: 'sc2', purchaseAmountText: { simpleText: '$1.00' } },
  });
  assert.equal(r.kind, 'drop-event');
});

test("an unrecognised renderer is 'other', which is expected and not a loss", () => {
  // Placeholders and engagement notices. They carry no renderer id, so they
  // never enter the dedup set either — which is what makes a GROWING `seen`
  // during a gap mean real messages arrived.
  assert.equal(ytClassifyItem({ liveChatPlaceholderItemRenderer: { id: 'p1' } }).kind, 'other');
  assert.equal(ytClassifyItem({ liveChatViewerEngagementMessageRenderer: {} }).kind, 'other');
  assert.equal(ytClassifyItem({}).kind, 'other');
  assert.equal(ytClassifyItem(null).kind, 'other');
});

test("a link run is unwrapped only from YouTube's own redirect shim", () => {
  const link = (url) => ytClassifyItem(textItem({ message: { runs: [
    { text: 'https://site.test/a…', navigationEndpoint: { urlEndpoint: { url } } },
  ] } })).data.text;
  const target = 'https://site.test/a/long/path';
  const q = `?q=${encodeURIComponent(target)}`;
  assert.equal(link(`https://www.youtube.com/redirect${q}`), target);
  assert.equal(link(`https://youtube.com/redirect${q}`), target);
  // A host that merely ends in "youtube.com" is not YouTube's shim: nothing is unwrapped, so the
  // run keeps its display text.
  assert.equal(link(`https://notyoutube.com/redirect${q}`), 'https://site.test/a…');
});
