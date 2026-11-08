// The Kick reader against a fake Centrifugo server: descriptor → token → connect → subscribe,
// newline-joined frames, ping/pong, pushes, error replies, refresh, the reconnect ladder, stop().
// Run: node --test platforms/kickRealtime.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';

process.env.KICK_CHANNEL_SLUG = 'testchannel';
delete process.env.KICK_CHATROOM_ID;
delete process.env.KICK_CHANNEL_ID;
delete process.env.KICK_STALE_MS;

const { startKick } = await import('./kick.js');

const CHANNEL_ID = '4242';
const CHATROOM_ID = '9191';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function waitFor(pred, what, ms = 5000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fake Centrifugo server. Every connection records what the client sent (raw text) and is
// handed to `onConnection` so a test scripts the server side.
async function fakeCentrifugo(onConnection = () => {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const conns = [];
  wss.on('connection', (sock, req) => {
    const conn = { sock, req, raw: [], cmds: [] };
    sock.on('message', (buf) => {
      const s = String(buf);
      conn.raw.push(s);
      try { conn.cmds.push(JSON.parse(s)); } catch { /* recorded raw only */ }
    });
    conns.push(conn);
    onConnection(conn);
  });
  return {
    url: `ws://127.0.0.1:${wss.address().port}/connection/websocket`,
    conns,
    close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(r); }),
  };
}

// Kick's HTTP side: the channel lookup, the descriptor and the guest token. Every call is
// recorded; `descriptor` may be overridden per call number to script failures.
function stubKickHttp(socketUrl, { descriptor } = {}) {
  const calls = { lookup: [], descriptor: [], token: [] };
  const realFetch = global.fetch;
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  global.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.includes('/api/v2/channels/')) {
      calls.lookup.push(url);
      return json({ id: Number(CHANNEL_ID), chatroom: { id: Number(CHATROOM_ID) } });
    }
    const body = init.body ? JSON.parse(init.body) : null;
    if (url.includes('/realtime/channels/')) {
      calls.descriptor.push({ url, body, headers: init.headers });
      const scripted = descriptor?.(calls.descriptor.length);
      if (scripted) return scripted;
      return json({ data: { connections: [{ credentials: { url: socketUrl }, provider: 'centrifugo' }], mode: 'websocket' }, message: 'success' });
    }
    if (url.endsWith('/realtime/auth/connection')) {
      calls.token.push(body);
      return json({ data: { token: `tok-${calls.token.length}` } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { calls, json, restore: () => { global.fetch = realFetch; } };
}

function captureConsole() {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const level of ['log', 'warn', 'error']) {
    console[level] = (...a) => lines.push({ level, text: a.map(String).join(' ') });
  }
  return {
    lines,
    has: (re, level) => lines.some((l) => re.test(l.text) && (!level || l.level === level)),
    restore: () => Object.assign(console, orig),
  };
}

const connectReply = (id, extra = {}) =>
  JSON.stringify({ id, connect: { client: 'c-1', version: '6.9.7 PRO', expires: true, ttl: 3600, ping: 25, pong: true, ...extra } });

// Answers connect (once its token checks out) and every subscribe.
function scriptHandshake(conn, connectExtra) {
  conn.sock.on('message', (buf) => {
    let cmd;
    try { cmd = JSON.parse(String(buf)); } catch { return; }
    if (cmd.connect) conn.sock.send(connectReply(cmd.id, connectExtra));
    else if (cmd.subscribe) conn.sock.send(JSON.stringify({ id: cmd.id, subscribe: {} }));
  });
}

const chatPush = (msg) => JSON.stringify({
  push: {
    channel: `chatrooms.${CHATROOM_ID}.v2`,
    pub: {
      data: { event: 'App\\Events\\ChatMessageEvent', data: JSON.stringify(msg) },
      tags: { event: 'App\\Events\\ChatMessageEvent' },
    },
  },
});

test('relay: descriptor + token, connect carries the token, ping/pong, a chat push reaches the sink, errors are logged, a close reconnects', async () => {
  const server = await fakeCentrifugo((conn) => {
    conn.sock.once('message', (buf) => {
      const cmd = JSON.parse(String(buf));
      // The first command must be connect with the freshly fetched token.
      if (!cmd.connect) { conn.sock.close(3501, 'bad request'); return; }
      conn.sock.send(connectReply(cmd.id));
      conn.sock.on('message', (b2) => {
        const sub = JSON.parse(String(b2) === '{}' ? 'null' : String(b2));
        if (!sub?.subscribe) return;
        // Several commands in ONE websocket message, newline-separated: the subscribe reply,
        // a server ping and a chat push.
        conn.sock.send([
          JSON.stringify({ id: sub.id, subscribe: {} }),
          '{}',
          chatPush({ id: 'msg-1', content: 'hello [emote:123:Gadget]', sender: { id: 77, username: 'casey', identity: { color: '#00ff00', badges: [{ type: 'moderator' }] } } }),
        ].join('\n'));
      });
    });
  });
  const http = stubKickHttp(server.url);
  const out = captureConsole();
  const got = [];
  let h;
  try {
    h = await startKick({ slug: 'someone', onMessage: (m) => got.push(m) });
    const first = await waitFor(() => server.conns[0], 'first connection');

    // Step 1 + 2: the descriptor names the channel id and carries a uuid client; the token call
    // uses that same client id.
    const d = http.calls.descriptor[0];
    assert.match(d.url, new RegExp(`/realtime/channels/${CHANNEL_ID}/chat/connection$`));
    assert.match(d.body.client.id, UUID_RE);
    assert.equal(d.body.client.type, 'web');
    assert.deepEqual(d.body.capabilities.accepted_providers.map((p) => p.provider).sort(), ['centrifugo', 'pusher']);
    assert.equal(http.calls.token[0].client_id, d.body.client.id);
    assert.equal(first.req.headers.origin, 'https://kick.com');

    // Step 3: connect is the first command and carries the token.
    await waitFor(() => first.cmds[0], 'connect command');
    assert.deepEqual(first.cmds[0], { connect: { token: 'tok-1', name: 'js' }, id: 1 });

    // Subscribe: relays read chat only.
    await waitFor(() => first.cmds.some((c) => c.subscribe), 'subscribe');
    assert.deepEqual(first.cmds.filter((c) => c.subscribe).map((c) => c.subscribe), [{ channel: `chatrooms.${CHATROOM_ID}.v2`, flag: 1 }]);

    // The ping inside the multi-command message is answered with a bare {}.
    await waitFor(() => first.raw.includes('{}'), 'pong');

    // The push reaches the sink in the shape the handlers have always produced.
    await waitFor(() => got.length, 'chat message at the sink');
    assert.equal(got.length, 1);
    assert.deepEqual(got[0], {
      platform: 'kick', userId: '77', username: 'casey', message: 'hello Gadget',
      isMod: true, isBroadcaster: false, isVip: false, isMember: false, tier: '',
      emotes: { Gadget: 'https://files.kick.com/emotes/123/fullsize' },
      replyToUsername: undefined, replyToText: undefined, platformMsgId: 'msg-1', usernameColor: '#00ff00',
    });
    assert.ok(out.has(/\[kick:relay\] connected to 127\.0\.0\.1:\d+ \(centrifugo 6\.9\.7 PRO, ping 25s, token ttl 3600s\)/), 'connect logged');
    assert.ok(out.has(new RegExp(`\\[kick:relay\\] subscribed chatrooms\\.${CHATROOM_ID}\\.v2$`)), 'subscribe logged');

    // An error reply is logged with its code and message — never swallowed.
    first.sock.send(JSON.stringify({ error: { code: 103, message: 'permission denied' }, id: 99 }));
    await waitFor(() => out.has(/error reply to unknown command \(id 99\): code 103 permission denied/, 'error'), 'error reply logged');
    // So is a server disconnect push.
    first.sock.send(JSON.stringify({ disconnect: { code: 3005, reason: 'token expired' } }));
    await waitFor(() => out.has(/server disconnect: code 3005 token expired/, 'warn'), 'disconnect logged');

    // A close runs the ladder: logged with its code, then a whole new descriptor → token → socket.
    first.sock.close(3005, 'token expired');
    await waitFor(() => out.has(/\[kick:relay\] disconnected \(close 3005 token expired\); reconnecting in 1000ms/, 'warn'), 'reconnect logged');
    const second = await waitFor(() => server.conns[1], 'second connection', 4000);
    await waitFor(() => second.cmds[0], 'second connect');
    assert.deepEqual(second.cmds[0], { connect: { token: 'tok-2', name: 'js' }, id: 1 });
    assert.notEqual(http.calls.descriptor[1].body.client.id, d.body.client.id, 'a reconnect is a fresh client');
    assert.equal(server.conns.length, 2, 'one socket per start at a time');
  } finally {
    h?.stop();
    out.restore();
    http.restore();
    await server.close();
  }
});

test('home: env ids skip the lookup, monetization channel is subscribed too', async () => {
  const server = await fakeCentrifugo((conn) => scriptHandshake(conn));
  const http = stubKickHttp(server.url);
  const out = captureConsole();
  process.env.KICK_CHATROOM_ID = CHATROOM_ID;
  process.env.KICK_CHANNEL_ID = CHANNEL_ID;
  let h;
  try {
    h = await startKick();
    assert.equal(h.health().state, 'starting', '/health: not reading chat yet');
    const conn = await waitFor(() => server.conns[0], 'connection');
    await waitFor(() => conn.cmds.filter((c) => c.subscribe).length === 2, 'two subscribes');
    await waitFor(() => h.health().state === 'running', '/health running once chat is subscribed');
    assert.deepEqual(conn.cmds.filter((c) => c.subscribe).map((c) => c.subscribe.channel), [`chatrooms.${CHATROOM_ID}.v2`, `channel.${CHANNEL_ID}`]);
    assert.equal(http.calls.lookup.length, 0, 'both env ids set: no lookup');
    await waitFor(() => out.has(new RegExp(`\\[kick\\] subscribed channel\\.${CHANNEL_ID} for monetization`)), 'monetization subscribe logged');
  } finally {
    h?.stop();
    delete process.env.KICK_CHATROOM_ID;
    delete process.env.KICK_CHANNEL_ID;
    out.restore();
    http.restore();
    await server.close();
  }
});

test('home: a chatroom id without a channel id still looks both up — the descriptor needs the channel id', async () => {
  const server = await fakeCentrifugo((conn) => scriptHandshake(conn));
  const http = stubKickHttp(server.url);
  const out = captureConsole();
  process.env.KICK_CHATROOM_ID = '1';
  let h;
  try {
    h = await startKick();
    await waitFor(() => server.conns[0], 'connection');
    assert.equal(http.calls.lookup.length, 1);
    assert.match(http.calls.descriptor[0].url, new RegExp(`/channels/${CHANNEL_ID}/`));
    assert.ok(out.has(/only one of "Kick chatroom id" \/ "Kick channel id" is set/, 'warn'));
  } finally {
    h?.stop();
    delete process.env.KICK_CHATROOM_ID;
    out.restore();
    http.restore();
    await server.close();
  }
});

test('refresh: before the ttl runs out the client sends refresh with a newly fetched token for the same client', async () => {
  let refreshCmd = null;
  const server = await fakeCentrifugo((conn) => {
    conn.sock.on('message', (buf) => {
      const cmd = JSON.parse(String(buf) === '{}' ? 'null' : String(buf));
      if (cmd?.connect) conn.sock.send(connectReply(cmd.id, { ttl: 1 }));
      else if (cmd?.subscribe) conn.sock.send(JSON.stringify({ id: cmd.id, subscribe: {} }));
      else if (cmd?.refresh) {
        refreshCmd = cmd;
        conn.sock.send(JSON.stringify({ id: cmd.id, refresh: { client: 'c-1', version: '6.9.7 PRO', expires: true, ttl: 3600 } }));
      }
    });
  });
  const http = stubKickHttp(server.url);
  const out = captureConsole();
  let h;
  try {
    h = await startKick({ slug: 'someone', onMessage: () => {} });
    await waitFor(() => refreshCmd, 'refresh command', 3000);
    assert.deepEqual(refreshCmd.refresh, { token: 'tok-2' });
    assert.equal(http.calls.token.length, 2);
    assert.equal(http.calls.token[1].client_id, http.calls.token[0].client_id, 'a refresh keeps the client id');
    await waitFor(() => out.has(/token refreshed \(ttl 3600s\)/), 'refresh reply logged');
    assert.equal(server.conns.length, 1, 'a refresh is not a reconnect');
  } finally {
    h?.stop();
    out.restore();
    http.restore();
    await server.close();
  }
});

test('a failing descriptor says so with its status and is retried on the ladder', async () => {
  const server = await fakeCentrifugo((conn) => scriptHandshake(conn));

  const http = stubKickHttp(server.url, { descriptor: (n) => (n === 1 ? new Response('{"message":"Forbidden"}', { status: 403 }) : null) });
  const out = captureConsole();
  let h;
  try {
    h = await startKick({ slug: 'someone', onMessage: () => {} });
    await waitFor(() => out.has(/\[kick:relay\] descriptor 403 \{"message":"Forbidden"\}; reconnecting in 1000ms/, 'warn'), 'descriptor failure logged');
    await waitFor(() => server.conns[0], 'connection after retry', 4000);
    assert.equal(http.calls.descriptor.length, 2);
  } finally {
    h?.stop();
    out.restore();
    http.restore();
    await server.close();
  }
});

test('a descriptor that offers only pusher is an error, not a silent fallback, and is retried', async () => {
  const server = await fakeCentrifugo((conn) => scriptHandshake(conn));
  const pusherOnly = { data: { connections: [{ credentials: { key: 'k', cluster: 'x' }, provider: 'pusher' }] }, message: 'success' };
  const http = stubKickHttp(server.url, { descriptor: (n) => (n === 1 ? new Response(JSON.stringify(pusherOnly), { status: 200 }) : null) });
  const out = captureConsole();
  let h;
  try {
    h = await startKick({ slug: 'someone', onMessage: () => {} });
    await waitFor(() => out.has(/descriptor offers pusher, and this reader speaks only centrifugo/, 'error'), 'unsupported provider logged as error');
    assert.equal(http.calls.token.length, 0, 'no token is fetched for a transport we cannot speak');
    await waitFor(() => server.conns[0], 'connection after retry', 4000);
  } finally {
    h?.stop();
    out.restore();
    http.restore();
    await server.close();
  }
});

test('a socket that goes silent is torn down by the watchdog and reconnected', async () => {
  const server = await fakeCentrifugo((conn) => scriptHandshake(conn));
  const http = stubKickHttp(server.url);
  const out = captureConsole();
  process.env.KICK_STALE_MS = '600';
  let h;
  try {
    h = await startKick({ slug: 'someone', onMessage: () => {} });
    await waitFor(() => server.conns[0], 'connection');
    await waitFor(() => out.has(/no frames for \d+s — socket is half-open, forcing reconnect/, 'warn'), 'watchdog fired', 4000);
    await waitFor(() => server.conns[1], 'reconnection', 4000);
  } finally {
    h?.stop();
    delete process.env.KICK_STALE_MS;
    out.restore();
    http.restore();
    await server.close();
  }
});

test('stop() closes the socket and nothing reconnects afterwards', async () => {
  const server = await fakeCentrifugo((conn) => scriptHandshake(conn));
  const http = stubKickHttp(server.url);
  const out = captureConsole();
  try {
    const h = await startKick({ slug: 'someone', onMessage: () => {} });
    const conn = await waitFor(() => server.conns[0], 'connection');
    await waitFor(() => conn.cmds.some((c) => c.subscribe), 'subscribed');
    const closed = new Promise((r) => conn.sock.once('close', r));
    h.stop();
    await closed;
    await sleep(1500);
    assert.equal(server.conns.length, 1, 'no reconnect after stop');
    assert.equal(http.calls.descriptor.length, 1);
    assert.ok(!out.has(/reconnecting in/), 'stop is not a disconnect');
  } finally {
    out.restore();
    http.restore();
    await server.close();
  }
});

test('stop() during the backoff after a failed descriptor ends the retries', async () => {
  const server = await fakeCentrifugo();
  const http = stubKickHttp(server.url, { descriptor: () => new Response('down', { status: 503 }) });
  const out = captureConsole();
  try {
    const h = await startKick({ slug: 'someone', onMessage: () => {} });
    await waitFor(() => http.calls.descriptor.length === 1 && out.has(/descriptor 503 down; reconnecting in 1000ms/), 'first failure');
    h.stop();
    await sleep(1500);
    assert.equal(http.calls.descriptor.length, 1, 'the pending retry was cancelled');
    assert.equal(server.conns.length, 0);
  } finally {
    out.restore();
    http.restore();
    await server.close();
  }
});

// Kick's own on-air / off-air events on the channel subscription (ADR 0134 E7/E11): each notes a
// push hint that wakes the poller for an immediate read (lib/liveHints.js). Home only, like
// moderation; they are not part of the monetization discovery net, so they no longer log as unbound.
const channelPush = (event, data, channel = `channel.${CHANNEL_ID}`) => JSON.stringify({
  push: { channel, pub: { data: { event, data: JSON.stringify(data) }, tags: { event } } },
});

test('home: StopStreamBroadcast and StreamerIsLive on the channel note push hints, with a line each', async () => {
  const { lastHint } = await import('../lib/liveHints.js');
  const server = await fakeCentrifugo((conn) => scriptHandshake(conn));
  const http = stubKickHttp(server.url);
  const out = captureConsole();
  process.env.KICK_CHATROOM_ID = CHATROOM_ID;
  process.env.KICK_CHANNEL_ID = CHANNEL_ID;
  let h;
  try {
    h = await startKick();
    const conn = await waitFor(() => server.conns[0], 'connection');
    await waitFor(() => conn.cmds.filter((c) => c.subscribe).length === 2, 'the channel subscribe');

    const before = Date.now();
    // The raw frame Kick sends (its payload holds the livestream; only the event name is read).
    conn.sock.send(channelPush('App\\Events\\StopStreamBroadcast', { livestream: { id: 1, channel: { id: Number(CHANNEL_ID), is_banned: false } } }));
    await waitFor(() => lastHint('kick')?.kind === 'stop' && lastHint('kick').at >= before, 'the stop hint');
    assert.ok(out.has(/^\[kick\] StopStreamBroadcast — checking now$/, 'log'));

    conn.sock.send(channelPush('App\\Events\\StreamerIsLive', { livestream: { id: 2, session_title: 'a title' } }));
    await waitFor(() => lastHint('kick')?.kind === 'live', 'the live hint');
    assert.ok(out.has(/^\[kick\] StreamerIsLive — checking now$/, 'log'));
    assert.ok(!out.has(/unbound event App\\Events\\(StopStreamBroadcast|StreamerIsLive)/), 'no longer in the discovery net');
  } finally {
    h?.stop();
    delete process.env.KICK_CHATROOM_ID;
    delete process.env.KICK_CHANNEL_ID;
    out.restore();
    http.restore();
    await server.close();
  }
});

test('relay: a stream event on a relay\'s socket notes no hint (another channel\'s stream is not ours)', async () => {
  const { lastHint, noteHint } = await import('../lib/liveHints.js');
  noteHint('kick', 'live', 1_000);
  const server = await fakeCentrifugo((conn) => scriptHandshake(conn));
  const http = stubKickHttp(server.url);
  const out = captureConsole();
  const got = [];
  let h;
  try {
    h = await startKick({ slug: 'someone', onMessage: (m) => got.push(m) });
    const conn = await waitFor(() => server.conns[0], 'connection');
    await waitFor(() => conn.cmds.some((c) => c.subscribe), 'subscribed');
    // The stop event, then a chat line in the same message: once the chat line reaches the sink,
    // the event before it has been handled.
    conn.sock.send([
      channelPush('App\\Events\\StopStreamBroadcast', { livestream: { id: 3 } }, `chatrooms.${CHATROOM_ID}.v2`),
      chatPush({ id: 'msg-9', content: 'bye', sender: { id: 78, username: 'robin', identity: { badges: [] } } }),
    ].join('\n'));
    await waitFor(() => got.length === 1, 'the chat line after the event');
    assert.deepEqual(lastHint('kick'), { kind: 'live', at: 1_000 }, 'unchanged');
    assert.ok(!out.has(/StopStreamBroadcast — checking now/));
  } finally {
    h?.stop();
    out.restore();
    http.restore();
    await server.close();
  }
});

// ── Kick moderation events over the real socket (the #185 lag read) ─────────────────────────
// A ban/delete on chatrooms.{id}.v2 writes ONE receipt line (ids and times only) and asks the
// mirror. stream-api's own `[platform-delete]` line stays silent for a site ban's echo (the rows
// are already flagged), so before this line the journal held no record that Kick sent the event.

// Answers the mirror's POST /chat/platform-delete on top of the Kick stub; records each body.
function stubMirror() {
  process.env.STREAM_API_URL = 'http://stream-api.site.test';
  const posted = [];
  const inner = global.fetch;
  global.fetch = async (url, init = {}) => {
    if (String(url) === 'http://stream-api.site.test/chat/platform-delete') {
      posted.push(JSON.parse(init.body));
      return new Response('{"ok":true,"flagged":0}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return inner(url, init);
  };
  return posted;
}

const BAN = { id: 'evt-1', user: { id: 131902950, username: 'robin', slug: 'robin' }, banned_by: { id: 2, username: 'casey', slug: 'casey' }, permanent: true };
const RECEIPT = /^\[kick\] moderation UserBannedEvent user=131902950 kickAt=none receivedAt=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z id=evt-1 keys=\[id,user,banned_by,permanent\]$/;

async function homeBanRun(server, out, posted, idx = 0) {
  const h = await startKick();
  try {
    const conn = await waitFor(() => server.conns[idx]?.cmds.filter((c) => c.subscribe).length === 2 && server.conns[idx], `home socket ${idx} subscribed`);
    const before = Date.now();
    conn.sock.send(channelPush('App\\Events\\UserBannedEvent', BAN, `chatrooms.${CHATROOM_ID}.v2`));
    const n = posted.length;
    await waitFor(() => posted.length === n + 1, 'the mirror POST');
    const line = out.lines.filter((l) => RECEIPT.test(l.text)).at(-1);
    assert.ok(line, `no receipt line in ${JSON.stringify(out.lines.map((l) => l.text))}`);
    assert.equal(line.level, 'log');
    const at = Date.parse(line.text.match(/receivedAt=(\S+)/)[1]);
    assert.ok(at >= before - 5 && at <= Date.now(), 'receivedAt is the arrival time');
    return h;
  } catch (e) {
    h.stop(); // a failed run must not leave a reader reconnecting into the next test
    throw e;
  }
}

test('home: a Kick ban push writes one receipt line with ids only and asks the mirror', async () => {
  const server = await fakeCentrifugo((conn) => scriptHandshake(conn));
  const http = stubKickHttp(server.url);
  const posted = stubMirror();
  const out = captureConsole();
  process.env.KICK_CHATROOM_ID = CHATROOM_ID;
  process.env.KICK_CHANNEL_ID = CHANNEL_ID;
  let h;
  try {
    h = await homeBanRun(server, out, posted);
    assert.deepEqual(posted, [{ platform: 'kick', platformUserId: '131902950', username: 'robin' }]);
    assert.equal(out.lines.filter((l) => /^\[kick\] moderation /.test(l.text)).length, 1, 'one line per event');
    assert.ok(!out.lines.some((l) => /robin|casey/.test(l.text)), 'no name in any line');
  } finally {
    h?.stop();
    delete process.env.KICK_CHATROOM_ID;
    delete process.env.KICK_CHANNEL_ID;
    out.restore();
    http.restore();
    await server.close();
  }
});

test('kick moderation retry: after the socket drops and the ladder reconnects, the next ban is still logged', async () => {
  const server = await fakeCentrifugo((conn) => scriptHandshake(conn));
  const http = stubKickHttp(server.url);
  const posted = stubMirror();
  const out = captureConsole();
  process.env.KICK_CHATROOM_ID = CHATROOM_ID;
  process.env.KICK_CHANNEL_ID = CHANNEL_ID;
  let h;
  try {
    h = await homeBanRun(server, out, posted);
    server.conns[0].sock.terminate();
    const conn2 = await waitFor(() => server.conns[1]?.cmds.filter((c) => c.subscribe).length === 2 && server.conns[1], 'the reconnect', 8000);
    conn2.sock.send(channelPush('App\\Events\\UserBannedEvent', BAN, `chatrooms.${CHATROOM_ID}.v2`));
    await waitFor(() => posted.length === 2, 'the second mirror POST');
    assert.equal(out.lines.filter((l) => RECEIPT.test(l.text)).length, 2);
  } finally {
    h?.stop();
    delete process.env.KICK_CHATROOM_ID;
    delete process.env.KICK_CHANNEL_ID;
    out.restore();
    http.restore();
    await server.close();
  }
});

test('kick moderation restart: a stopped reader and a fresh start log the ban on the new socket, once', async () => {
  const server = await fakeCentrifugo((conn) => scriptHandshake(conn));
  const http = stubKickHttp(server.url);
  const posted = stubMirror();
  const out = captureConsole();
  process.env.KICK_CHATROOM_ID = CHATROOM_ID;
  process.env.KICK_CHANNEL_ID = CHANNEL_ID;
  let h;
  try {
    const first = await homeBanRun(server, out, posted);
    first.stop();
    h = await homeBanRun(server, out, posted, 1);
    assert.equal(posted.length, 2);
    assert.equal(out.lines.filter((l) => RECEIPT.test(l.text)).length, 2, 'one line per event across the restart — the stopped reader logs nothing more');
  } finally {
    h?.stop();
    delete process.env.KICK_CHATROOM_ID;
    delete process.env.KICK_CHANNEL_ID;
    out.restore();
    http.restore();
    await server.close();
  }
});

test('relay: a Kick ban on a relay\'s socket is not ours — no line, no mirror', async () => {
  const server = await fakeCentrifugo((conn) => scriptHandshake(conn));
  const http = stubKickHttp(server.url);
  const posted = stubMirror();
  const out = captureConsole();
  const got = [];
  let h;
  try {
    h = await startKick({ slug: 'someone', onMessage: (m) => got.push(m) });
    const conn = await waitFor(() => server.conns[0], 'connection');
    await waitFor(() => conn.cmds.some((c) => c.subscribe), 'subscribed');
    conn.sock.send([
      channelPush('App\\Events\\UserBannedEvent', BAN, `chatrooms.${CHATROOM_ID}.v2`),
      chatPush({ id: 'msg-10', content: 'hi', sender: { id: 78, username: 'robin', identity: { badges: [] } } }),
    ].join('\n'));
    await waitFor(() => got.length === 1, 'the chat line after the event');
    assert.deepEqual(posted, []);
    assert.ok(!out.has(/^\[kick\] moderation /));
  } finally {
    h?.stop();
    out.restore();
    http.restore();
    await server.close();
  }
});

// ── The channel owner on Kick ────────────────────────────────────────────────────────────────
// Kick gives the streamer no `moderator` badge on his own channel, so before 2026-10-31 his lines
// arrived as an ordinary viewer's (prod: every one of the owner's Kick lines has is_mod = false):
// the platform automod would check them and the bot refused his `remember_lore`. Twitch has always
// carried isBroadcaster from its badge; Kick now carries it from the broadcaster badge OR from the
// sender being the account whose channel this connection reads (its slug — platform-assigned and
// unique, not a display name a viewer chooses).

async function readOneLine(sender, { slug = 'someone' } = {}) {
  const server = await fakeCentrifugo((conn) => scriptHandshake(conn));
  const http = stubKickHttp(server.url);
  const out = captureConsole();
  const got = [];
  let h;
  try {
    h = await startKick({ slug, onMessage: (m) => got.push(m) });
    const conn = await waitFor(() => server.conns[0], 'connection');
    await waitFor(() => conn.cmds.some((c) => c.subscribe), 'subscribed');
    conn.sock.send(chatPush({ id: 'msg-b', content: 'hi', sender }));
    await waitFor(() => got.length === 1, 'the line at the sink');
    return got[0];
  } finally {
    h?.stop();
    out.restore();
    http.restore();
    await server.close();
  }
}

test('kick owner: the account whose channel is read is the broadcaster (by slug, any case); a viewer is not', async () => {
  const owner = await readOneLine({ id: 5, username: 'SomeOne', slug: 'SomeOne', identity: { badges: [] } });
  assert.equal(owner.isBroadcaster, true);
  assert.equal(owner.isMod, false, 'broadcaster is its own flag, not a mod badge');
  const viewer = await readOneLine({ id: 6, username: 'casey', slug: 'casey', identity: { badges: [] } });
  assert.equal(viewer.isBroadcaster, false);
  // A viewer whose DISPLAY name matches the owner's but whose slug is their own is not the owner.
  const lookalike = await readOneLine({ id: 7, username: 'someone', slug: 'someone-2', identity: { badges: [] } });
  assert.equal(lookalike.isBroadcaster, false);
});

test('kick owner: a frame without a slug falls back to the username, which Kick also keeps unique', async () => {
  const owner = await readOneLine({ id: 5, username: 'someone', identity: { badges: [] } });
  assert.equal(owner.isBroadcaster, true);
});

test('kick owner: a broadcaster badge marks the broadcaster even on another channel\'s reader', async () => {
  const line = await readOneLine({ id: 9, username: 'robin', slug: 'robin', identity: { badges: [{ type: 'broadcaster', text: 'Broadcaster' }] } }, { slug: 'elsewhere' });
  assert.equal(line.isBroadcaster, true);
});

test('kick owner: the parsed owner line is exempt from the platform automod, a viewer line is not', async () => {
  const { platformCheckable } = await import('../lib/automod.js');
  const owner = await readOneLine({ id: 5, username: 'someone', slug: 'someone', identity: { badges: [] } });
  const viewer = await readOneLine({ id: 6, username: 'casey', slug: 'casey', identity: { badges: [] } });
  assert.equal(platformCheckable(owner, false), false);
  assert.equal(platformCheckable(viewer, false), true);
});

test('kick owner retry: after the socket drops and the ladder reconnects, the owner is still the broadcaster', async () => {
  const server = await fakeCentrifugo((conn) => scriptHandshake(conn));
  const http = stubKickHttp(server.url);
  const out = captureConsole();
  const got = [];
  let h;
  try {
    h = await startKick({ slug: 'someone', onMessage: (m) => got.push(m) });
    const first = await waitFor(() => server.conns[0], 'first connection');
    await waitFor(() => first.cmds.some((c) => c.subscribe), 'first subscribe');
    first.sock.close(3005, 'token expired');
    const second = await waitFor(() => server.conns[1], 'second connection', 4000);
    await waitFor(() => second.cmds.some((c) => c.subscribe), 'second subscribe');
    second.sock.send(chatPush({ id: 'msg-r', content: 'back', sender: { id: 5, username: 'someone', slug: 'someone', identity: { badges: [] } } }));
    await waitFor(() => got.length === 1, 'the line after the reconnect');
    assert.equal(got[0].isBroadcaster, true);
  } finally {
    h?.stop();
    out.restore();
    http.restore();
    await server.close();
  }
});

test('kick owner restart: a stopped reader and a fresh start for another channel judge by the NEW channel', async () => {
  const before = await readOneLine({ id: 5, username: 'someone', slug: 'someone', identity: { badges: [] } }, { slug: 'someone' });
  assert.equal(before.isBroadcaster, true);
  const after = await readOneLine({ id: 5, username: 'someone', slug: 'someone', identity: { badges: [] } }, { slug: 'other' });
  assert.equal(after.isBroadcaster, false, 'a restart does not carry the previous channel over');
});
