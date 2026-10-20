// Platform-chat pronoun commands: stream-api's /identity/pronoun-command is the ONE
// parser; ingest only turns its answer into a reply. A command it cannot read gets a
// usage line, never silence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handlePronounCommand } from './commands.js';

const msg = { message: '!pronouns she/her', username: 'kate', canonicalId: 'abc', platform: 'twitch', userId: '9' };
const asking = (answer) => {
  const calls = [];
  return { calls, ask: async (body) => { calls.push(body); if (answer instanceof Error) throw answer; return answer; } };
};

test('every answer becomes its reply; the text and identity go to stream-api as-is', async () => {
  const set = asking({ matched: true, pronouns: 'she/her' });
  assert.equal(await handlePronounCommand(msg, set), '@kate got it, she/her from now on.');
  assert.deepEqual(set.calls, [{ text: '!pronouns she/her', canonicalId: 'abc', platform: 'twitch', userId: '9' }]);
  assert.equal(await handlePronounCommand(msg, asking({ matched: true, pronouns: null })), '@kate cleared your pronouns.');
  assert.equal(await handlePronounCommand(msg, asking({ matched: true, usage: true })),
    '@kate set them with !he, !she or !they (or !pronouns she/her).');
});

test('not a pronoun command → null, so !dono and the rest still get their turn', async () => {
  assert.equal(await handlePronounCommand({ ...msg, message: '!dono' }, asking({ matched: false })), null);
});

test('only !-lines that could be pronouns are sent at all (no request per !command)', async () => {
  const a = asking({ matched: false });
  for (const text of ['!dono', '!karma', '!7tv', 'hello']) await handlePronounCommand({ ...msg, message: text }, a);
  assert.equal(a.calls.length, 0);
  for (const text of ['!he', '!She/her', '!theythem', '!pronouns', '!pronoun he']) await handlePronounCommand({ ...msg, message: text }, a);
  assert.equal(a.calls.length, 5);
});

test('stream-api down → no reply and no throw', async () => {
  assert.equal(await handlePronounCommand(msg, asking(new Error('POST /identity/pronoun-command -> 502'))), null);
});

test('commands.js carries no pronoun list of its own (one parser, in stream-api)', async () => {
  const src = await readFile(new URL('./commands.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /PRONOUN_CMD|'he\/him'|setPronouns/);
  assert.match(src, /return \/\^!dono\\b\/i\.test/, 'END-side anchor (the file ends in a comment block)');
});

test('the Twitch login reaches stream-api for the alejo.io lookup', async () => {
  const twitch = await readFile(new URL('../platforms/twitch.js', import.meta.url), 'utf8');
  assert.match(twitch, /username: m\.chatname,\n[\s\S]{0,200}login: tags\.username \|\| tags\.login \|\| undefined,/);
  const pipeline = await readFile(new URL('./pipeline.js', import.meta.url), 'utf8');
  assert.match(pipeline, /avatarUrl: msg\.avatarUrl \|\| undefined,\n\s*login: msg\.login \|\| undefined,/);
});
