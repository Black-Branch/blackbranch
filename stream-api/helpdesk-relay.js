// ── Help-desk relay ──────────────────────────────────────────────────────────
// Private request/response plumbing for the site's support panel: the web app
// POSTs a free-text turn (/bot/support/ask, response HELD), the help desk in
// stream-ingest long-polls for work (/bot/support/next) and posts the
// answer back (/bot/support/reply), which resolves the held response.
//
// NEVER route these through the WS hub: broadcast() fans out to every
// public socket (ws-hub.js has no client auth at all), and a support question
// is a private conversation. Long-poll over localhost is why this needs no
// new auth surface — requireInternal's IP trust already covers the brain.

// How long after its last poll (or reply) the brain still counts as answering. Its loop re-polls the
// moment a poll returns, but one turn is a model call of up to a minute (the helpdesk.answer slot's
// timeout), during which it is not polling. Past this, nobody is reading the queue: the help desk
// is switched off, it has no model, or stream-ingest is down — the brain's loop polls only while
// helpdesk.enabled is on and the task resolves (stream-ingest/lib/helpdesk).
const BRAIN_SEEN_MS = 90_000;

// What a poll gets while this process is going away: no job, and the reason (the help desk in
// stream-ingest stays quiet about the closed port that follows).
const RESTARTING = Object.freeze({ restarting: true });

function createSupportRelay({ askTimeoutMs = 30000, pollTimeoutMs = 25000, maxQueue = 20, now = () => Date.now() } = {}) {
  const queue = [];            // jobs waiting for the brain
  const pending = new Map();   // requestId -> { res, timer } — held web responses
  let waiter = null;           // the brain's parked poll: { res, timer }
  let draining = false;        // set by release(); no new socket may be parked after
  let seq = 0;
  let brainSeenAt = null;      // ms of the brain's last poll or reply

  /** Is anything answering free-text questions? Measured from the brain itself (its polls), not
   *  from a setting this process might read differently from stream-ingest. */
  function brainAnswering() {
    return !!waiter || (brainSeenAt !== null && now() - brainSeenAt < BRAIN_SEEN_MS);
  }

  function deliver(job, res) {
    res.json(job);
  }

  function ask(payload, res) {
    // Draining: answer immediately rather than holding the browser's socket for
    // askTimeoutMs against a process that is going away.
    if (draining) {
      res.status(503).json({ error: 'restarting' });
      return;
    }
    if (queue.length >= maxQueue) {
      res.status(503).json({ error: 'busy' });
      return;
    }
    const requestId = `req_${++seq}`;
    const job = { requestId, ...payload };
    const timer = setTimeout(() => {
      // The brain never answered — release the browser; a late reply() finds
      // nothing and returns false. A job still QUEUED leaves the queue with it: nobody is waiting
      // for its answer any more, and left there it counted against maxQueue forever — after 20
      // unanswered questions (a help desk with no brain) every new one was refused as "busy".
      pending.delete(requestId);
      const i = queue.indexOf(job);
      if (i >= 0) queue.splice(i, 1);
      res.status(504).json({ error: 'timeout' });
    }, askTimeoutMs);
    pending.set(requestId, { res, timer });
    if (waiter) {
      const w = waiter;
      waiter = null;
      clearTimeout(w.timer);
      deliver(job, w.res);
    } else {
      queue.push(job);
    }
  }

  function next(res) {
    // Draining: reply at once, saying so, so the brain re-polls against the NEW process instead
    // of parking a 25s request on a socket this one is trying to close, and does not log the
    // closed port in between as an error.
    if (draining) { res.json(RESTARTING); return; }
    brainSeenAt = now();
    const job = queue.shift();
    if (job) { deliver(job, res); return; }
    if (waiter) {
      // The brain loop is serial, but a restart mid-poll can briefly double
      // up — release the displaced waiter empty so its socket isn't hung.
      clearTimeout(waiter.timer);
      waiter.res.json({});
    }
    waiter = {
      res,
      timer: setTimeout(() => {
        if (waiter && waiter.res === res) waiter = null;
        res.json({}); // empty answer = "nothing yet, poll again"
      }, pollTimeoutMs),
    };
    // The ingest-restart race: the old process's parked poll dies with its
    // socket, and a job delivered there vanished (one 504'd turn per deploy).
    // Drop a waiter the moment its socket closes so asks queue for the live
    // poller instead. (res is an http.ServerResponse; optional-chained for
    // the unit tests' bare mocks.)
    res.on?.('close', () => {
      if (waiter && waiter.res === res) {
        clearTimeout(waiter.timer);
        waiter = null;
      }
    });
  }

  function reply(requestId, text) {
    brainSeenAt = now();
    const held = pending.get(requestId);
    if (!held) return false;
    pending.delete(requestId);
    clearTimeout(held.timer);
    held.res.json({ text });
    return true;
  }

  function stats() {
    return { queued: queue.length, pending: pending.size, brainParked: !!waiter };
  }

  /** GET /bot/support/status: may the site offer a free-text box? false while nothing answers. */
  function status() {
    return { aiFreeText: brainAnswering() };
  }

  // Release every socket this relay is holding open. Called from the SIGTERM
  // drain in index.js.
  //
  // This is REQUIRED for a graceful shutdown, not a nicety. The brain's poll is
  // parked for up to pollTimeoutMs (25s) and it is an ACTIVE request, so
  // closeIdleConnections() cannot touch it and server.close() waits on it.
  // Without this, every restart waits out the poll — most of the 30s grace, a
  // dark site meanwhile.
  //
  // The brain gets no job and { restarting: true }, so it polls again against the new
  // process and treats the closed port in between as the restart, not a failure. Held web
  // asks get 503 rather than being left to hang until the browser gives up.
  function release() {
    // Latch: after this, no caller may park a NEW socket. Without the latch the
    // brain answers its released poll by immediately re-polling, which parks a
    // fresh 25s request in the middle of the drain and the close never settles.
    draining = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      clearTimeout(w.timer);
      try { w.res.json(RESTARTING); } catch { void 0; }
    }
    for (const held of pending.values()) {
      clearTimeout(held.timer);
      try { held.res.status(503).json({ error: 'restarting' }); } catch { void 0; }
    }
    pending.clear();
    queue.length = 0;
  }

  return { ask, next, reply, stats, status, release };
}

// Route shells. All requireInternal; /bot/support/* rather than /support/*
// because POST /support is the MONEY endpoint (route-surface snapshot).
function registerHelpdeskRoutes(app, { requireInternal, wrap, relay }) {
  app.post('/bot/support/ask', requireInternal, wrap(async (req, res) => {
    const { matrixId, username, text, history } = req.body || {};
    if (typeof text !== 'string' || !text.trim() || typeof matrixId !== 'string') {
      return res.status(400).json({ error: 'bad request' });
    }
    // Account context is web-derived (the ONE canonical entitlement read) and
    // shape-clamped here — the brain treats it as facts about the asker.
    const acc = req.body && typeof req.body.account === 'object' && req.body.account ? req.body.account : null;
    relay.ask({
      matrixId,
      username: String(username || '').slice(0, 80),
      text: text.slice(0, 2000),
      history: Array.isArray(history) ? history.slice(-8).map((h) => ({
        role: h && h.role === 'user' ? 'user' : 'bot',
        text: String((h && h.text) || '').slice(0, 500),
      })) : [],
      account: acc ? {
        username: String(acc.username || '').slice(0, 80),
        supporter: !!acc.supporter,
        linked: Array.isArray(acc.linked) ? acc.linked.slice(0, 10).map((p) => String(p).slice(0, 20)) : [],
        points: Math.max(0, parseInt(acc.points, 10) || 0),
      } : null,
    }, res);
  }));

  app.get('/bot/support/next', requireInternal, wrap(async (_req, res) => relay.next(res)));

  // { aiFreeText } — the site's help panel shows its free-text box only while this is true. False
  // when the help desk's AI is switched off, has no model, or stream-ingest is down: a question typed
  // then waited 30 s for "I can't reach my brain".
  app.get('/bot/support/status', requireInternal, (_req, res) => res.json(relay.status()));

  app.post('/bot/support/reply', requireInternal, wrap(async (req, res) => {
    const body = req.body || {};
    const ok = relay.reply(String(body.requestId || ''), String(body.text || '').slice(0, 4000));
    res.status(ok ? 200 : 404).json({ ok });
  }));
}

module.exports = { createSupportRelay, registerHelpdeskRoutes };
