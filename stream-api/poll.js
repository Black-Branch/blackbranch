// Cross-platform poll engine for stream-api. One active poll at a time,
// server-authoritative, DB-backed (stream.polls / stream.poll_votes) so a
// restart mid-poll recovers state.
//
//   • start: subscribers/mods on the website (web /api/poll/start → POST
//     /poll/start here). Broadcasts an interactive chat card (event_kind
//     'poll' — same persist path as the gift/donation/sub cards) that web
//     viewers tap to vote; the numbered options tell platform chatters what
//     to type.
//   • vote: website taps arrive via POST /poll/vote; platform chatters type a
//     bare option number, parsed in chat.js POST /chat. voter_key = canonical
//     stream id when resolvable, else "matrix:<id>" — an upsert, so changing
//     your vote just moves it.
//   • end: the duration timer, or a mod/creator via POST /poll/end
//     (end | cancel | extend).
//
// Broadcast frames (public WS — website chat AND the OBS overlay at
// GET /overlay/poll consume the same feed):
//   { type:'pollUpdate', poll }   tallies tick, throttled to ≤1/s
//   { type:'pollEnd',    poll }   final state (status ended|cancelled, winner)
// The poll card row's event_json is rewritten on every state change so a
// history replay renders the final result, not the moment of creation.

'use strict';

const { NATIVE_PLATFORM } = require('./native-platform');
const { sendOverlayPage } = require('./overlay-page');

const UPDATE_THROTTLE_MS = 1000;

function createPoll({ broadcast, bufferPush, pool, persistCard }) {
  // Authoritative in-memory state (null = no active poll).
  let poll = null; // { id, question, options, createdBy, createdByName, startedAt, endsAt, status, cardId, tallies:Map, voters:Map }
  let endTimer = null;
  let updateTimer = null;
  let updateDirty = false;

  const now = () => Date.now();

  function publicPoll(p = poll) {
    if (!p) return null;
    const tallies = {};
    for (const o of p.options) tallies[o.n] = p.tallies.get(o.n) || 0;
    const total = Object.values(tallies).reduce((a, b) => a + b, 0);
    let winner = null;
    if (p.status === 'ended') {
      let best = 0;
      for (const o of p.options) {
        const t = tallies[o.n];
        if (t > best) { best = t; winner = o.n; }
        else if (t === best && best > 0 && winner !== null) winner = null; // tie → no single winner
      }
    }
    return {
      pollId: p.id,
      question: p.question,
      options: p.options,
      createdByName: p.createdByName || null,
      startedAt: p.startedAt,
      endsAt: p.endsAt,
      status: p.status,
      tallies,
      total,
      winner,
    };
  }

  // Rewrite the persisted card so history replay shows the CURRENT state.
  async function syncCard() {
    if (!poll || poll.cardId == null) return;
    try {
      const card = cardFor(poll);
      await pool.query(
        `UPDATE site.chat_messages SET event_json = $1 WHERE id = $2`,
        [JSON.stringify(card), poll.cardId]
      );
    } catch (e) { console.warn('[poll] card sync failed:', e.message); }
  }

  function cardFor(p) {
    return {
      type: 'message',
      platform: NATIVE_PLATFORM,
      id: p.cardId,
      system: 'poll',
      username: p.createdByName || 'poll',
      message: p.question,
      ts: p.startedAt,
      poll: publicPoll(p),
    };
  }

  function armEndTimer() {
    if (endTimer) clearTimeout(endTimer);
    if (!poll || poll.status !== 'active') return;
    const ms = Math.max(0, poll.endsAt - now());
    endTimer = setTimeout(() => { finish('ended', null).catch((e) => console.warn('[poll] auto-end failed:', e.message)); }, ms);
  }

  function scheduleUpdate() {
    updateDirty = true;
    if (updateTimer) return;
    updateTimer = setTimeout(() => {
      updateTimer = null;
      if (!updateDirty || !poll) return;
      updateDirty = false;
      broadcast({ type: 'pollUpdate', poll: publicPoll() });
      syncCard();
    }, UPDATE_THROTTLE_MS);
  }

  async function init() {
    try {
      const r = await pool.query(
        `SELECT * FROM stream.polls WHERE status = 'active' ORDER BY id DESC LIMIT 1`
      );
      const row = r.rows[0];
      if (!row) return;
      poll = {
        id: Number(row.id),
        question: row.question,
        options: row.options,
        createdBy: row.created_by,
        createdByName: row.created_by_name,
        startedAt: new Date(row.started_at).getTime(),
        endsAt: new Date(row.ends_at).getTime(),
        status: 'active',
        cardId: row.card_id != null ? Number(row.card_id) : null,
        tallies: new Map(),
        voters: new Map(),
      };
      const votes = await pool.query(
        `SELECT voter_key, option_n FROM stream.poll_votes WHERE poll_id = $1`, [poll.id]
      );
      for (const v of votes.rows) {
        poll.voters.set(v.voter_key, v.option_n);
        poll.tallies.set(v.option_n, (poll.tallies.get(v.option_n) || 0) + 1);
      }
      if (poll.endsAt <= now()) {
        await finish('ended', null); // expired while we were down
      } else {
        armEndTimer();
        console.log(`[poll] recovered active poll #${poll.id} (${votes.rows.length} votes)`);
      }
    } catch (e) { console.warn('[poll] init failed:', e.message); }
  }

  async function start({ question, options, durationSec, createdBy, createdByName, streamId }) {
    if (poll && poll.status === 'active') return { error: 'poll_active', poll: publicPoll() };
    const q = String(question || '').trim().slice(0, 200);
    const opts = Array.isArray(options)
      ? options.map((t, i) => ({ n: i + 1, text: String(t ?? '').trim().slice(0, 100) })).filter((o) => o.text)
      : [];
    if (!q || opts.length < 2 || opts.length > 6) return { error: 'bad_poll' };
    const dur = Math.min(3600, Math.max(30, parseInt(durationSec, 10) || 120));

    const startedAt = now();
    const endsAt = startedAt + dur * 1000;
    const ins = await pool.query(
      `INSERT INTO stream.polls (stream_id, question, options, created_by, created_by_name, started_at, ends_at, status)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), to_timestamp($7 / 1000.0), 'active') RETURNING id`,
      [streamId || null, q, JSON.stringify(opts), createdBy || null, createdByName || null, startedAt, endsAt]
    );
    poll = {
      id: Number(ins.rows[0].id),
      question: q,
      options: opts,
      createdBy: createdBy || null,
      createdByName: createdByName || null,
      startedAt, endsAt,
      status: 'active',
      cardId: null,
      tallies: new Map(),
      voters: new Map(),
    };

    // Interactive chat card (persisted like the monetization cards; graceful
    // ephemeral degrade if the insert fails).
    const card = cardFor(poll);
    card.id = `poll${startedAt}`; // ephemeral fallback id
    card.platform = 'system';
    const numericId = await persistCard({ ...card, system: 'poll' });
    if (numericId != null) {
      poll.cardId = numericId;
      card.id = numericId;
      card.platform = NATIVE_PLATFORM;
      await pool.query(`UPDATE stream.polls SET card_id = $1 WHERE id = $2`, [numericId, poll.id]).catch(() => {});
      await syncCard(); // event_json now carries its own card id
    }
    bufferPush(card);
    broadcast(card);
    armEndTimer();
    return { ok: true, poll: publicPoll() };
  }

  // voterKey: canonical stream id (platform + linked site users) or "matrix:<id>".
  async function vote({ voterKey, platform, optionN }) {
    if (!poll || poll.status !== 'active' || poll.endsAt <= now()) return { error: 'no_active_poll' };
    const n = parseInt(optionN, 10);
    if (!voterKey || !poll.options.some((o) => o.n === n)) return { error: 'bad_option' };
    const prev = poll.voters.get(voterKey);
    if (prev === n) return { ok: true, poll: publicPoll(), unchanged: true };
    try {
      await pool.query(
        `INSERT INTO stream.poll_votes (poll_id, voter_key, option_n, platform, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (poll_id, voter_key) DO UPDATE SET option_n = EXCLUDED.option_n, platform = EXCLUDED.platform, updated_at = NOW()`,
        [poll.id, String(voterKey).slice(0, 80), n, platform ? String(platform).slice(0, 20) : null]
      );
    } catch (e) {
      console.warn('[poll] vote persist failed:', e.message);
      return { error: 'store_failed' };
    }
    if (prev != null) poll.tallies.set(prev, Math.max(0, (poll.tallies.get(prev) || 1) - 1));
    poll.tallies.set(n, (poll.tallies.get(n) || 0) + 1);
    poll.voters.set(voterKey, n);
    scheduleUpdate();
    return { ok: true, poll: publicPoll() };
  }

  async function finish(status, endedBy) {
    if (!poll || poll.status !== 'active') return { error: 'no_active_poll' };
    if (endTimer) { clearTimeout(endTimer); endTimer = null; }
    poll.status = status; // 'ended' | 'cancelled'
    try {
      await pool.query(
        `UPDATE stream.polls SET status = $1, ended_at = NOW() WHERE id = $2`,
        [status, poll.id]
      );
    } catch (e) { console.warn('[poll] finish persist failed:', e.message); }
    await syncCard();
    const finalState = publicPoll();
    broadcast({ type: 'pollEnd', poll: finalState, endedBy: endedBy || null });
    console.log(`[poll] #${poll.id} ${status} (${finalState.total} votes)`);
    poll = null;
    return { ok: true, poll: finalState };
  }

  async function extend({ addSec }) {
    if (!poll || poll.status !== 'active') return { error: 'no_active_poll' };
    const add = Math.min(3600, Math.max(10, parseInt(addSec, 10) || 60));
    poll.endsAt += add * 1000;
    try {
      await pool.query(`UPDATE stream.polls SET ends_at = to_timestamp($1 / 1000.0) WHERE id = $2`, [poll.endsAt, poll.id]);
    } catch (e) { console.warn('[poll] extend persist failed:', e.message); }
    armEndTimer();
    await syncCard();
    broadcast({ type: 'pollUpdate', poll: publicPoll() });
    return { ok: true, poll: publicPoll() };
  }

  return {
    init,
    start,
    vote,
    extend,
    end: (endedBy) => finish('ended', endedBy),
    cancel: (endedBy) => finish('cancelled', endedBy),
    current: () => publicPoll(),
    active: () => !!(poll && poll.status === 'active' && poll.endsAt > now()),
    creatorOf: () => (poll ? poll.createdBy : null),
  };
}


// ── Poll HTTP surface ────────────────────────────────────────────────────────
// The engine above is created by index.js (it owns broadcast/bufferPush/
// persistCard); these are the routes over it.
// Same convention as radio.js's registerRadio / webhooks.js.
function registerPollRoutes(app, { pollEngine, pool, resolveCanonical, requireInternal, wrap }) {
  // Public read: current poll state (or {poll:null}). Late-joining web clients
  // and the OBS overlay fetch this on load, then apply WS pollUpdate deltas.
  app.get('/poll/current', wrap(async (req, res) => {
    res.json({ poll: pollEngine.current() });
  }));

  // Serve the OBS browser-source overlay (transparent page; add as
  // http://<stream-api host>:3001/overlay/poll in OBS).
  // With its CSP / nosniff / no-framing headers (overlay-page.js).
  app.get('/overlay/poll', (req, res) => sendOverlayPage(res, require('path').join(__dirname, 'overlay-poll.html')));

  // POST /poll/start — from web /api/poll/start (subscriber/mod gate lives there).
  app.post('/poll/start', requireInternal, wrap(async (req, res) => {
    const { question, options, durationSec, createdBy, createdByName } = req.body || {};
    // Tag the poll with the open stream session when there is one (history joins).
    let streamId = null;
    try {
      const s = await pool.query(
        `SELECT stream_id FROM stream.sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1`
      );
      streamId = s.rows[0]?.stream_id ?? null;
    } catch { /* untagged poll is fine */ }
    const r = await pollEngine.start({ question, options, durationSec, createdBy, createdByName, streamId });
    res.status(r.error ? 409 : 200).json(r);
  }));

  // POST /poll/vote — from web (card tap). voter_key unifies with platform votes
  // through the canonical identity when the site user is linked.
  app.post('/poll/vote', requireInternal, wrap(async (req, res) => {
    const { matrixId, optionN } = req.body || {};
    if (!matrixId) return res.status(400).json({ error: 'matrixId required' });
    const canon = await resolveCanonical(null, matrixId);
    const r = await pollEngine.vote({
      voterKey: canon || `matrix:${matrixId}`,
      platform: NATIVE_PLATFORM,
      optionN,
    });
    res.status(r.error ? 409 : 200).json(r);
  }));

  // POST /poll/end — end early / cancel / extend. Permission (mod/admin or the
  // poll's creator) is enforced by the web route; it passes endedBy for the log.
  app.post('/poll/end', requireInternal, wrap(async (req, res) => {
    const { action, endedBy, addSec } = req.body || {};
    const r =
      action === 'cancel' ? await pollEngine.cancel(endedBy)
      : action === 'extend' ? await pollEngine.extend({ addSec })
      : await pollEngine.end(endedBy);
    res.status(r.error ? 409 : 200).json(r);
  }));

  // GET /poll/creator — lets the web route check "is this the creator" without
  // duplicating poll state.
  app.get('/poll/creator', wrap(async (req, res) => {
    res.json({ createdBy: pollEngine.creatorOf() });
  }));
}

module.exports = { createPoll, registerPollRoutes };
