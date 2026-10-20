// Tests for the platform-moderation mirror parsers (Kick realtime events +
// YouTube innertube actions → postPlatformDelete payloads).
// kick.js/youtube.js import ws/playwright, so run after `npm ci`:
//   node --test platforms/moderation.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKickModeration } from './kick.js';
import { ytParseModerationAction } from './youtube.js';

// ── Kick ─────────────────────────────────────────────────────────────────────

test('kick MessageDeletedEvent → single-message payload', () => {
  const data = JSON.stringify({ id: 'evt-1', message: { id: 'abc-123-uuid' } });
  assert.deepEqual(parseKickModeration('App\\Events\\MessageDeletedEvent', data),
    { platform: 'kick', platformMsgId: 'abc-123-uuid' });
});

test('kick MessageDeletedEvent without message.id → null (never guesses the event id)', () => {
  const data = JSON.stringify({ id: 'evt-1' });
  assert.equal(parseKickModeration('App\\Events\\MessageDeletedEvent', data), null);
});

test('kick UserBannedEvent → user-clear payload with id + username', () => {
  const data = JSON.stringify({ id: 'evt-2', user: { id: 42, username: 'Troll', slug: 'troll' }, banned_by: { username: 'ModGuy' } });
  assert.deepEqual(parseKickModeration('App\\Events\\UserBannedEvent', data),
    { platform: 'kick', platformUserId: '42', username: 'Troll' });
});

test('kick UserBannedEvent with only a slug still resolves a username', () => {
  const data = JSON.stringify({ user: { slug: 'troll' } });
  assert.deepEqual(parseKickModeration('App\\Events\\UserBannedEvent', data),
    { platform: 'kick', platformUserId: undefined, username: 'troll' });
});

test('kick unknown event / malformed JSON → null', () => {
  assert.equal(parseKickModeration('App\\Events\\ChatroomClearEvent', '{}'), null);
  assert.equal(parseKickModeration('App\\Events\\MessageDeletedEvent', 'not json'), null);
});

// ── YouTube ──────────────────────────────────────────────────────────────────

test('yt markChatItemAsDeletedAction → single-message payload', () => {
  const a = { markChatItemAsDeletedAction: { targetItemId: 'ChwKGkNQdm0', deletedStateMessage: {} } };
  assert.deepEqual(ytParseModerationAction(a), { platform: 'youtube', platformMsgId: 'ChwKGkNQdm0' });
});

test('yt markChatItemsByAuthorAsDeletedAction → user-clear payload', () => {
  const a = { markChatItemsByAuthorAsDeletedAction: { externalChannelId: 'UCabc123' } };
  assert.deepEqual(ytParseModerationAction(a), { platform: 'youtube', platformUserId: 'UCabc123' });
});

test('yt addChatItemAction (a normal message) → null', () => {
  assert.equal(ytParseModerationAction({ addChatItemAction: { item: {} } }), null);
  assert.equal(ytParseModerationAction({}), null);
  assert.equal(ytParseModerationAction(null), null);
});
