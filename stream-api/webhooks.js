// Payment-platform receivers for the unified alert system: Ko-fi + Patreon
// webhooks (public HTTP, authenticated by each platform's own token/signature —
// NOT requireInternal, since they arrive from the platform via the CF tunnel) and
// the Streamlabs Socket API (outbound socket.io). All normalize → alert.dispatch,
// which computes take-home via economics.js and fans out the full alert.
//
// ── Acknowledgement and redelivery (who brings a lost event back) ──────────────
// alert.dispatch HOLDS the celebration until the ledger answers, retries a transient ledger
// failure a bounded number of times, and REJECTS (LedgerWriteError, nothing fired, the event kept
// for reconciliation) when the write cannot land (alert.js). What a provider adds on top is
// redelivery across a crash or restart, and that only works if nothing here tells it
// "done" before the ledger has answered:
//   • Ko-fi — expects a 200; with anything else it "will retry a reasonable number of
//     times with the same message_id" (Ko-fi's webhook docs). So the 200 is sent only
//     AFTER dispatch resolves (the ledger has answered); a throw answers 500.
//   • Patreon — stores undelivered events and retries ≈30 s, 5 min, 15 min, 1 h, 3 h,
//     1 day, 1 week after a failure, then pauses the webhook (Patreon API docs, "Robust
//     Retries"). Same rule: the 200 follows the ledger's answer; a throw answers 500.
//   TODO(verify): both retry behaviours above are quoted from memory (review round 5, F7), not
//   re-read from the providers. Check against https://help.ko-fi.com/hc/en-us/articles/360004162298
//   (Ko-fi webhooks) and https://docs.patreon.com/#webhooks (Patreon "Robust Retries") and correct
//   this comment — the code's rule (acknowledge only after the ledger answers) holds either way.
//   • Streamlabs — a socket, no acknowledgement at all; it re-emits recent history on
//     every reconnect, which is the only redelivery there is.
// The in-memory replay guard (createReplayGuard) remembers an id only once its dispatch
// has resolved. While one delivery is in flight a second waits for it (never runs it
// twice, never answers "done" early); a delivery that throws is forgotten, so the
// provider's retry runs again. The guard dies with the process — the ledger's unique
// event_id is the durable answer across a restart.

'use strict';
const crypto = require('crypto');
const { instanceConfig } = require('./instance-config');
const { io } = require('socket.io-client');
const economics = require('./economics');

// Constant-time string comparison. Hashing both sides to a fixed-width digest
// first means the buffers are always equal length (timingSafeEqual throws
// otherwise) and the comparison leaks neither the secret's length nor where the
// first mismatching byte is.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Replay guard: remembers each webhook's unique event id for a TTL so a captured,
// valid payload can't be re-POSTed to re-fire a donation alert — which would move
// the support bar and write a phantom support_event. In-process and bounded, like
// stream-api's other in-memory guards; forgetting on restart is fine for replay
// (ids stay unique and platforms don't re-deliver old events after a 200 ack).
function createSeenStore({ ttlMs = 24 * 60 * 60 * 1000, max = 5000 } = {}) {
  const store = new Map(); // id -> expiry epoch ms
  return {
    // True if this id was already processed within the TTL; else records it and
    // returns false. A falsy id is never deduped (fail-open on a missing id).
    isDuplicate(id) {
      if (!id) return false;
      const now = Date.now();
      if (store.size > max) {
        for (const [k, exp] of store) if (exp <= now) store.delete(k);
        // Expiry alone can't shrink a burst of >max ids inside one TTL — evict
        // oldest-first (Map iteration = insertion order) so `max` is a real
        // bound, not a hope. Slightly weakens dedup for the evicted ids, which
        // is the right trade against unbounded growth.
        if (store.size > max) {
          for (const k of store.keys()) {
            if (store.size <= max) break;
            store.delete(k);
          }
        }
      }
      const exp = store.get(id);
      if (exp && exp > now) return true;
      store.set(id, now + ttlMs);
      return false;
    },
    /** Was this id seen within the TTL? Records nothing. */
    has(id) {
      if (!id) return false;
      const exp = store.get(id);
      return !!(exp && exp > Date.now());
    },
  };
}

// One delivery per id at a time, remembered only once it SUCCEEDED. `run(key, fn)`:
//   • key seen before (its fn resolved) → { replay: true }, fn not run;
//   • the same key in flight → waits for that delivery, then { replay: true } — or its
//     rejection, so the caller answers an error and the provider retries;
//   • otherwise runs fn; on success the key is remembered, on a throw it is NOT.
// The bookkeeping before fn is synchronous, so two deliveries in the same tick still see
// each other. A falsy key is never deduped (fail-open, like the seen store).
function createReplayGuard(opts) {
  const seen = createSeenStore(opts);
  const inflight = new Map();
  return {
    run(key, fn) {
      const start = () => { try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e); } };
      if (!key) return start().then((result) => ({ replay: false, result }));
      if (seen.has(key)) return Promise.resolve({ replay: true });
      const running = inflight.get(key);
      if (running) return running.then(() => ({ replay: true }));
      const p = start();
      inflight.set(key, p);
      return p.then(
        (result) => { inflight.delete(key); seen.isDuplicate(key); return { replay: false, result }; },
        (e) => { inflight.delete(key); throw e; },
      );
    },
  };
}

// Ko-fi `type`s that are a purchase, not support (see dispatchKofi).
const KOFI_PURCHASE_TYPES = {
  'Shop Order': { eventType: 'shop-order', label: 'bought from the ko-fi shop' },
  Commission: { eventType: 'commission', label: 'commissioned on ko-fi' },
};

function registerPaymentWebhooks({ app, wrap, alert }) {
  const replay = createReplayGuard();

  // ── Ko-fi ───────────────────────────────────────────────────────────────
  // Body is application/x-www-form-urlencoded with a single `data` field holding
  // the JSON. Auth = the verification_token inside that JSON.
  app.post('/webhook/kofi', wrap(async (req, res) => {
    let data;
    try { data = JSON.parse(req.body?.data || '{}'); } catch { return res.status(400).json({ error: 'bad data' }); }
    const expected = instanceConfig.get('kofi.verificationToken') || '';
    if (!expected || !safeEqual(String(data.verification_token || ''), expected)) {
      console.warn('[kofi] bad verification token');
      return res.status(401).json({ error: 'unauthorized' });
    }
    // Replay guard on Ko-fi's per-transaction id (present on every real payload).
    const txId = data.kofi_transaction_id || data.message_id || '';
    try {
      const out = await replay.run(txId ? `kofi:${txId}` : '', () => dispatchKofi(data, txId));
      if (out.replay) console.warn(`[kofi] duplicate transaction ${txId} ignored`);
      // ONLY now: the ledger has answered (dispatch held until it did).
      res.json({ ok: true });
    } catch (e) {
      // Not acknowledged: Ko-fi retries a non-200 with the same message_id. Named by
      // transaction id and amount, never by the donor's name.
      console.error(`[kofi] handler FAILED tx=${txId || '?'} amount=${data.amount ?? '?'} ${data.currency || ''} type=${data.type || '?'}: ${e.message} — answered 500 so Ko-fi redelivers`);
      res.status(500).json({ error: 'not processed' });
    }
  }));

  // ── Patreon ───────────────────────────────────────────────────────────────
  // Auth = HMAC-MD5 of the RAW body keyed by the webhook secret, in X-Patreon-
  // Signature. The trigger is in X-Patreon-Event. Body is JSON:API.
  app.post('/webhook/patreon', wrap(async (req, res) => {
    const secret = instanceConfig.get('patreon.webhookSecret') || '';
    const sig = req.get('X-Patreon-Signature') || '';
    const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    const expected = secret ? crypto.createHmac('md5', secret).update(raw).digest('hex') : '';
    if (!secret || !safeEqual(sig, expected)) {
      console.warn('[patreon] bad signature');
      return res.status(401).json({ error: 'unauthorized' });
    }
    const event = req.get('X-Patreon-Event') || '';
    // Only a new pledge fires an alert; anything else is acknowledged as received.
    if (!event.startsWith('members:pledge:create')) return res.json({ ok: true });
    try {
      // The HMAC signature is a per-payload fingerprint → dedupe exact replays.
      const out = await replay.run(`patreon:${sig}`, () => dispatchPatreon(req.body || {}, sig));
      if (out.replay) console.warn('[patreon] duplicate pledge ignored');
      res.json({ ok: true }); // after the ledger answered — see the header
    } catch (e) {
      // Not acknowledged: Patreon stores and retries a failed delivery. Named by member
      // id and amount, never by name (see the Ko-fi log note).
      const a = req.body?.data?.attributes || {};
      console.error(`[patreon] handler FAILED event=${event || '?'} member=${req.body?.data?.id || '?'} cents=${a.will_pay_amount_cents ?? a.currently_entitled_amount_cents ?? a.pledge_amount_cents ?? '?'}: ${e.message} — answered 500 so Patreon redelivers`);
      res.status(500).json({ error: 'not processed' });
    }
  }));

  // Ko-fi's payment → alert.dispatch. Resolves once the ledger has answered.
  async function dispatchKofi(data, txId) {
    // `is_public: false` = the supporter asked Ko-fi to keep them private. Their name and
    // message would otherwise reach every public output — TTS, the overlay, the persisted
    // chat card, the sponsor credit line — and the ledger's username, all of which derive
    // from these two fields, so this is the one place to decide. The money is still
    // credited: privacy changes who is named, not what was paid. 'Anonymous' also gives the
    // ledger row a fresh identity (money.js supportPlatformId).
    const isPrivate = data.is_public === false;
    const username = isPrivate ? 'Anonymous' : (data.from_name || 'Anonymous');
    const amount = parseFloat(data.amount) || 0;
    const currency = (data.currency || 'USD').toUpperCase();
    const message = isPrivate ? '' : (data.message || '');
    const isSub = data.is_subscription_payment === true || data.type === 'Subscription';
    // A shop sale or a commission is a purchase, not support: celebrated, never credited
    // (economics gives these event types a take-home of 0, so no ledger row and no bar/timer).
    const purchase = KOFI_PURCHASE_TYPES[data.type];
    // `eventId` rides into fireStreamEffects' durable ledger dedup.
    if (purchase) {
      await alert.dispatch({ platform: 'kofi', eventType: purchase.eventType, username, amount, currency, message,
        label: purchase.label, eventId: txId || undefined });
    } else if (isSub) {
      const tier = data.tier_name || '';
      const first = data.is_first_subscription_payment === true;
      await alert.dispatch({
        platform: 'kofi', eventType: 'membership', username, amount, currency, message,
        label: (first ? 'subscribed on ko-fi' : 'renewed ko-fi subscription') + (tier ? ' · ' + tier : ''),
        eventId: txId || undefined,
      });
    } else {
      await alert.dispatch({ platform: 'kofi', eventType: 'donation', username, amount, currency, message, label: 'donated on ko-fi', eventId: txId || undefined, grossUSD: economics.toUSD(amount, currency) });
    }
    // No donor name in any log line in this file: the journal is kept, shipped and read far
    // from the people who gave. The transaction id finds the payment in Ko-fi's dashboard.
    console.log(`[kofi] ${purchase ? purchase.eventType : isSub ? 'membership' : 'donation'} tx=${txId || '?'} ${amount} ${currency}`);
  }

  // Patreon's new pledge → alert.dispatch. Resolves once the ledger has answered.
  async function dispatchPatreon(body, sig) {
    const attrs = body?.data?.attributes || {};
    const cents = Number(attrs.will_pay_amount_cents ?? attrs.currently_entitled_amount_cents ?? attrs.pledge_amount_cents ?? 0);
    const currency = (attrs.currency || attrs.pledge_currency || 'USD').toUpperCase();
    // The member's `full_name` is the name on their Patreon account — often a legal name —
    // and is NEVER shown. The only name a patron chose for public display is the included
    // user's `vanity`, when the payload carries it; otherwise they are "A patron".
    const included = Array.isArray(body.included) ? body.included : [];
    const user = included.find((i) => i && i.type === 'user');
    const vanity = typeof user?.attributes?.vanity === 'string' ? user.attributes.vanity.trim() : '';
    const name = vanity || 'A patron';
    const tierObj = included.find((i) => i && (i.type === 'tier' || i.type === 'reward')) || null;
    const tier = tierObj?.attributes?.title || '';
    await alert.dispatch({
      platform: 'patreon', eventType: 'pledge-create', username: name, cents, currency,
      label: 'joined on patreon' + (tier ? ' · ' + tier : ''),
      // The same per-payload fingerprint the in-memory guard keys on, so the durable ledger
      // dedup covers a restart-bridging redelivery too.
      eventId: sig || undefined,
    });
    console.log(`[patreon] pledge member=${body?.data?.id || '?'} ${cents}c ${currency}`);
  }
}

// ── Streamlabs (Socket API) ─────────────────────────────────────────────────
// Outbound socket.io connection; donations arrive as { type:'donation', message:[…] }.
//
// `ready` (the settings layer's first load) is awaited before the token is read: the socket
// reads it ONCE, at connect, so connecting before the load would miss a stored token. The
// { stop } handle is returned at once, and a stop() before the connect cancels it.
function startStreamlabs({ alert, ready = Promise.resolve() }) {
  let socket = null;
  let stopped = false;
  Promise.resolve(ready).then(() => {
    if (stopped) return;
    socket = connectStreamlabs({ alert });
  }).catch((e) => console.warn('[streamlabs] start:', e.message));
  return {
    stop() {
      stopped = true;
      try { socket?.close(); } catch { /* teardown: an already-closed socket is the state stop() wants */ }
    },
  };
}

function connectStreamlabs({ alert }) {
  const token = instanceConfig.get('streamlabs.socketToken');
  if (!token) { console.warn('[streamlabs] no socket token — skipping'); return null; }
  const socket = io(`https://sockets.streamlabs.com?token=${encodeURIComponent(token)}`, { transports: ['websocket'] });
  socket.on('connect', () => console.log('[streamlabs] socket connected'));
  socket.on('disconnect', (r) => console.warn('[streamlabs] disconnected:', r));
  socket.on('connect_error', (e) => console.warn('[streamlabs] connect error:', e.message));
  socket.on('event', createStreamlabsHandler({ alert }));
  return socket;
}

// The Streamlabs `event` handler. Streamlabs re-emits its donation history on reconnect, so
// each donation's `_id` goes through the replay guard first — the same in-memory guard Ko-fi
// and Patreon have. An id is remembered only once its dispatch has resolved (the ledger
// answered): a dispatch that throws is forgotten, so the next reconnect's replay brings it
// back. alert.js's ledger-first check is the durable answer across a restart. One guard per
// handler, and socket.io keeps one handler across its reconnects.
function createStreamlabsHandler({ alert, replay = createReplayGuard() }) {
  return (ev) => {
    try {
      if (!ev || ev.type !== 'donation' || !Array.isArray(ev.message)) return;
      for (const d of ev.message) {
        const id = d._id != null ? String(d._id) : '';
        const amount = parseFloat(d.amount) || 0;
        const currency = (d.currency || 'USD').toUpperCase();
        replay.run(id ? `streamlabs:${id}` : '', () => alert.dispatch({
          platform: 'streamlabs', eventType: 'donation', username: d.name || d.from || 'Anonymous',
          amount, currency, message: d.message || '', label: 'donated',
          // Streamlabs re-emits history on reconnect; its per-donation _id is the only
          // stable handle. Fail-open when absent.
          eventId: id || undefined,
          grossUSD: economics.toUSD(amount, currency),
        }).then(() => console.log(`[streamlabs] donation id=${id || '?'} ${amount} ${currency}`))) // no donor name in the journal
          .then((out) => { if (out.replay) console.warn(`[streamlabs] duplicate donation ${id} ignored (history replay)`); })
          .catch((e) => console.warn(`[streamlabs] dispatch FAILED id=${id || '?'} — not remembered, the next reconnect replays it: ${e.message}`));
      }
    } catch (e) { console.warn('[streamlabs] event:', e.message); }
  };
}

module.exports = { registerPaymentWebhooks, startStreamlabs, createStreamlabsHandler, safeEqual, createSeenStore, createReplayGuard };
