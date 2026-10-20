// Round 7 (ingest-logs): the chat pipeline's journal lines carry the platform and the platform
// USER ID, never the viewer's name — and for a command, only the command's name (`!karma`), never
// the rest of what the viewer typed. A name is personal data the journal keeps for months
// (stream-api/log-names.test.js). The bot's reply preview stays: it is the bot's text.
//
// Run: node --test lib/pipelineLogs.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { format } from 'node:util';

// postChat goes through fetch to STREAM_API_URL — a made-up address, and fetch is stubbed.
process.env.STREAM_API_URL = 'http://stream-api.site.test';
delete process.env.ENABLE_COMMANDS;

const { processMessage } = await import('./pipeline.js');

async function run(msg, opts, respond) {
  const lines = [];
  const orig = {};
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
    orig[k] = console[k];
    console[k] = (...a) => lines.push(format(...a)); // what console itself prints
  }
  const realFetch = global.fetch;
  let done;
  const delivered = new Promise((r) => { done = r; });
  global.fetch = async (url) => {
    const res = respond(String(url));
    done();
    return res;
  };
  try {
    processMessage(msg, opts);
    await delivered;
    await new Promise((r) => setTimeout(r, 30)); // the rest of deliver() after the POST
  } finally {
    Object.assign(console, orig);
    global.fetch = realFetch;
  }
  return lines;
}

const ok = () => new Response(JSON.stringify({ id: 41, canonicalId: 'c0ffee000001' }),
  { status: 200, headers: { 'content-type': 'application/json' } });

function assertClean(lines, ...secrets) {
  for (const l of lines) for (const s of secrets) assert.ok(!l.includes(s), `"${s}" reached the journal: ${l}`);
}

test('a failed POST /chat logs the platform and the user id — not the name', async () => {
  const lines = await run({ platform: 'twitch', userId: 'u-5150', username: 'casey', message: 'hello all' }, {},
    () => new Response('boom', { status: 500 }));
  assertClean(lines, 'casey', 'hello all');
  const line = lines.find((l) => l.includes('POST /chat failed'));
  assert.ok(line, lines.join('\n'));
  assert.match(line, /twitch user=u-5150/);
});

test('a failed POST /chat with no user id says so with "?"', async () => {
  const lines = await run({ platform: 'kick', username: 'Gadget', message: 'hey' }, {},
    () => new Response('boom', { status: 500 }));
  assertClean(lines, 'Gadget');
  assert.ok(lines.some((l) => /POST \/chat failed \(kick user=\?\)/.test(l)), lines.join('\n'));
});

test('a command line logs the user id and the command name — not the name or the rest of the line', async () => {
  const replies = [];
  const lines = await run({ platform: 'twitch', userId: 'u-7', username: 'casey', message: '!frobnicate Gadget is my secret' },
    { reply: async (t) => replies.push(t) }, ok);
  assertClean(lines, 'casey', 'Gadget', 'my secret');
  const line = lines.find((l) => l.startsWith('[cmd-debug]'));
  assert.ok(line, lines.join('\n'));
  assert.match(line, /twitch user=u-7 /);
  assert.match(line, / cmd=!frobnicate /);
  assert.match(line, /-> null$/);
});

test('the bot reply preview stays in the command line', async () => {
  const lines = await run({ platform: 'twitch', userId: 'u-7', username: 'casey', message: '!dono casey' },
    { reply: async () => {} }, ok);
  assertClean(lines, 'casey');
  const line = lines.find((l) => l.startsWith('[cmd-debug]'));
  assert.match(line, /cmd=!dono .*-> "support the stream/);
});

test('the reply preview masks the @mention the bot addresses the viewer by', async () => {
  const lines = await run({ platform: 'twitch', userId: 'u-9', username: 'casey', message: '!he' },
    { reply: async () => {} },
    (url) => (url.includes('/identity/pronoun-command')
      ? new Response(JSON.stringify({ matched: true, pronouns: 'he/him' }), { status: 200, headers: { 'content-type': 'application/json' } })
      : ok()));
  assertClean(lines, 'casey');
  const line = lines.find((l) => l.startsWith('[cmd-debug]'));
  assert.match(line, /cmd=!he .*-> "@… got it, he\/him from now on\."$/);
});

test('a SKIPPED command (no reply channel) is logged the same way', async () => {
  const lines = await run({ platform: 'youtube', userId: 'UCx9', username: 'Sprocket', message: '!karma @casey please' }, {}, ok);
  assertClean(lines, 'Sprocket', 'casey', 'please');
  const line = lines.find((l) => l.includes('SKIPPED'));
  assert.ok(line, lines.join('\n'));
  assert.match(line, /SKIPPED youtube user=UCx9 cmd=!karma /);
});

test('an over-long command word is cut, so a pasted line cannot ride in as the "command"', async () => {
  const long = `!${'casey'.repeat(20)}`;
  const lines = await run({ platform: 'twitch', userId: 'u-8', username: 'x', message: long }, {}, ok);
  const line = lines.find((l) => l.includes('SKIPPED'));
  const cmd = line.match(/cmd=(\S+)/)[1];
  assert.ok(cmd.length <= 24, `command word is ${cmd.length} chars`);
});

test('a platform user id carrying format specifiers is printed as written and does not eat the error', async () => {
  const lines = await run({ platform: 'twitch', userId: '%s%o%d', username: 'casey', message: 'hi' }, {},
    () => new Response('boom', { status: 500 }));
  const line = lines.find((l) => l.includes('POST /chat failed'));
  assert.ok(line, lines.join('\n'));
  assert.match(line, /\(twitch user=%s%o%d\): \S/, `the id was read as a format string: ${line}`);
});
