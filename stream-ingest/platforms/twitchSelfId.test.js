// The bot's own Twitch lines must carry the bot's user id.
//
// tmi's echo of a SELF message (the account this process is logged in as) has
// no `user-id` tag. Sent as `userId: ''`, stream-api's resolveOrCreate — which
// never adopts by name — would mint a fresh person for every line. tmi does learn the account's id at login (GLOBALUSERSTATE); a self message
// takes it from there.
//
// Run: node --test platforms/twitchSelfId.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { selfAwareUserId } from './twitch.js';

const tmi = { globaluserstate: { 'user-id': '890633209' } };

test('a self message with no user-id tag takes the id tmi learned at login', () => {
  assert.equal(selfAwareUserId({ isSelf: true, userId: null, raw: { tags: {} } }, tmi), '890633209');
});

test('a tagged message keeps its own id, self or not', () => {
  assert.equal(selfAwareUserId({ isSelf: true, userId: '1', raw: { tags: { 'user-id': '1' } } }, tmi), '1');
  assert.equal(selfAwareUserId({ isSelf: false, userId: null, raw: { tags: { 'user-id': '2' } } }, tmi), '2');
});

test("someone else's untagged message is NOT given the bot's id", () => {
  assert.equal(selfAwareUserId({ isSelf: false, userId: null, raw: { tags: {} } }, tmi), '');
});

test('before login state arrives the self message still has no id (never a guess)', () => {
  assert.equal(selfAwareUserId({ isSelf: true, userId: null, raw: { tags: {} } }, { globaluserstate: {} }), '');
  assert.equal(selfAwareUserId({ isSelf: true, userId: null, raw: { tags: {} } }, null), '');
});
