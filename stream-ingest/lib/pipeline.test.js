// The public commands run on every platform; a reply goes only where a sender exists (Twitch
// today). `!she` SETS the pronouns, so a platform with no sender must still set them — before,
// a Kick, YouTube or stream.place `!she` was delivered and nothing else happened.
//
// Run: node --test lib/pipeline.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

// postChat and the pronoun command go through fetch to STREAM_API_URL — a made-up address, and
// fetch is stubbed.
process.env.STREAM_API_URL = 'http://stream-api.site.test';
delete process.env.ENABLE_COMMANDS;

const { processMessage } = await import('./pipeline.js');

const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });

async function run(msg, opts) {
  const calls = [];
  const realFetch = global.fetch;
  const quiet = { log: console.log, warn: console.warn };
  console.log = () => {};
  console.warn = () => {};
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (u.endsWith('/identity/pronoun-command')) return json({ matched: true, pronouns: 'she/her' });
    return json({ id: 41, canonicalId: 'c0ffee000001' });
  };
  try {
    processMessage(msg, opts);
    for (let i = 0; i < 50 && !calls.some((c) => c.url.endsWith('/identity/pronoun-command')); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    global.fetch = realFetch;
    Object.assign(console, quiet);
  }
  return calls;
}

test('a `!she` from Kick sets the pronouns with no reply sender; Twitch still replies', async () => {
  for (const platform of ['kick', 'youtube', 'streamplace']) {
    const calls = await run({ platform, userId: `u-${platform}`, username: 'casey', message: '!she' });
    const set = calls.find((c) => c.url.endsWith('/identity/pronoun-command'));
    assert.ok(set, `${platform}: the pronouns were never set`);
    assert.deepEqual(set.body, { text: '!she', canonicalId: 'c0ffee000001', platform, userId: `u-${platform}` });
  }
  const replies = [];
  const calls = await run({ platform: 'twitch', userId: 'u-7', username: 'casey', message: '!she' },
    { reply: async (t) => replies.push(t) });
  assert.ok(calls.some((c) => c.url.endsWith('/identity/pronoun-command')));
  assert.deepEqual(replies, ['@casey got it, she/her from now on.']);
});
