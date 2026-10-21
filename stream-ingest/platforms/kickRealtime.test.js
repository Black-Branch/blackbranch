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
      isMod: true, isVip: false, isMember: false, tier: '',
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
