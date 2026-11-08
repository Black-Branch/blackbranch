// ── Stream lifecycle ────────────────────────────────────────────────────────
// Session open/close, viewer snapshots, and the heartbeat-based liveness read
// the rest of the stack keys off (support bar stream tagging, recordSupport,
// the bot's stream-state, the offline gate). stream-ingest owns the platform
// tokens and calls these endpoints; stream-api never polls platforms itself.

const { PLATFORM_LIVENESS: { RESUME_GRACE_MS } } = require('./platformLiveness.generated');

// A YouTube video id is exactly 11 URL-safe base64 characters.
function youtubeVideoId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{11}$/.test(v) ? v : null;
}

function createLifecycle({ pool, broadcast, onStreamStart = null, onStreamEnd = null, now = Date.now, getLiveness = null }) {
  // Each platform's public state (platform-states.js), on both answers: the site reads it from
  // /stream/current. With no relay wired it is the empty snapshot — never an invented state.
  const liveness = () => (getLiveness ? getLiveness() : { at: now(), platforms: {} });
  // A stream ends two ways — /stream/end, and the heartbeat self-heal in
  // liveState() when it never fires — and both are "the stream ended" to anything
  // that keys on it (e.g. a forced-on bot goes back to auto). Best-effort,
  // after the row is closed; never fails its caller. It can fire more than
  // once for one session (two liveState() calls racing the self-heal, or a
  // resumed session ending again), so a hook must be idempotent.
  async function streamEnded(streamId) {
    if (!onStreamEnd) return;
    try { await onStreamEnd(streamId); }
    catch (e) { console.warn('[lifecycle] onStreamEnd:', e.message); }
  }
  // A mod's "force offline" (web /api/mod/stream/end → /stream/end with
  // `forced`). Remembered so /stream/current can tell the poller, which would
  // otherwise re-open a session on its next tick while any platform still
  // reports live (a phantom second session that also re-keys the credit pool
  // early). Expires on its own — what it covers is a re-open within seconds,
  // and a press by mistake must not black the site out for long — and clears
  // the moment a session starts. In-process memory: a stream-api restart releases it, which is
  // the right failure direction (live, not dark).
  const FORCED_END_TTL_MS = 15 * 60 * 1000;
  let forcedEnd = null; // { at, by, streamId }
  // The last resume (liveState's grace for it). In memory: a restart drops it, by which time the
  // poller has long posted the reopened session's first heartbeat.
  let resumed = null; // { streamId, at }
  const activeForcedEnd = () =>
    forcedEnd && now() - forcedEnd.at <= FORCED_END_TTL_MS ? forcedEnd : null;
  // Heartbeat liveness, shared by /stream/current and /bot/stream-state. A
  // session row alone isn't trusted — if /stream/end never fires the row sits open
  // forever. The poller posts a viewer snapshot every 60s while live, so a
  // snapshot within 10 min proves the stream is up; a start-grace covers cold start.
  // A stale open session self-heals (ended_at = NOW()).
  // Offline, plus the forced-end hold while one is active. NOT who forced it:
  // /stream/current is public, and a moderator's Matrix id is nobody's business
  // there. Nothing read it but a poller log line; the mod is named in the
  // journal by /stream/end below.
  function offlineState() {
    const f = activeForcedEnd();
    return f ? { live: false, forcedEndAt: f.at, liveness: liveness() } : { live: false, liveness: liveness() };
  }

  async function liveState() {
    const r = await pool.query(
      `SELECT stream_id, started_at, yt_video_id FROM stream.sessions
       WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1`
    );
    if (!r.rows.length) return offlineState();
    const HEARTBEAT_MIN = 10, START_GRACE_MIN = 10;
    const v = await pool.query(
      `SELECT twitch, youtube, kick, streamplace, total,
              (recorded_at > NOW() - INTERVAL '${HEARTBEAT_MIN} minutes') AS fresh
       FROM stream.viewer_snapshots WHERE stream_id = $1
       ORDER BY recorded_at DESC LIMIT 1`,
      [r.rows[0].stream_id]
    );
    const hasHeartbeat = !!v.rows[0]?.fresh;
    // A resume is proof of life too, with a start's grace: the reopened row's started_at and last
    // heartbeat are from before the drop, and the poller's first new snapshot comes after its
    // publish and YouTube lookup — a read in between must not close the night again.
    const resumedLately = resumed && resumed.streamId === String(r.rows[0].stream_id)
      && now() - resumed.at < START_GRACE_MIN * 60_000;
    const inStartGrace = resumedLately
      || Date.now() - new Date(r.rows[0].started_at).getTime() < START_GRACE_MIN * 60_000;
    if (!hasHeartbeat && !inStartGrace) {
      await pool.query(
        `UPDATE stream.sessions SET ended_at = NOW() WHERE stream_id = $1 AND ended_at IS NULL`,
        [r.rows[0].stream_id]
      );
      await streamEnded(r.rows[0].stream_id);
      return offlineState();
    }
    return {
      live: true,
      streamId: r.rows[0].stream_id,
      startedAt: r.rows[0].started_at,
      // The LIVE YouTube broadcast id — null until ingest has confirmed
      // one; the site embeds by id when present, by channel otherwise.
      ytVideoId: r.rows[0].yt_video_id ?? null,
      viewers: v.rows[0] ? { twitch: v.rows[0].twitch, youtube: v.rows[0].youtube,
                             kick: v.rows[0].kick, streamplace: v.rows[0].streamplace,
                             total: v.rows[0].total } : null,
      liveness: liveness(),
    };
  }

  // Periodic "support the stream" bubble (Node replacement for support-reminder.cs),
  // only while live. Chat-link posting moves to stream-ingest's send-back later.
  const SUPPORT_REMINDER_MS = Number(process.env.SUPPORT_REMINDER_MIN || 25) * 60_000;
  const reminder = setInterval(async () => {
    try { if ((await liveState()).live) broadcast({ type: 'showSupportBubble' }); }
    catch (e) { console.warn('[support-reminder]', e.message); }
  }, SUPPORT_REMINDER_MS);
  // The HTTP server keeps the process alive; this timer must not — it pinned
  // `node --test lifecycle.test.js` open for 25 minutes.
  if (reminder.unref) reminder.unref();
  // NOTE: the viewer poller + stream lifecycle live in stream-ingest (it owns the
  // Twitch token + YouTube key) and call the /viewer-snapshot, /stream/start,
  // /stream/end endpoints below. stream-api does not poll.

  function registerLifecycleRoutes(app, { requireInternal, wrap }) {
    // POST /stream/start
    app.post('/stream/start', requireInternal, wrap(async (req, res) => {
      const { streamId, resume } = req.body;
      if (!streamId) return res.status(400).json({ error: 'streamId required' });
      // A resume (ADR 0134 E8): the poller saw the SAME broadcast come back within
      // RESUME_GRACE_MS of its own end, so the night goes on under the same id. Only a row it
      // closed inside the window reopens; anything else is a 409 and the poller mints a new id.
      // A forced end never resumes. No onStreamStart: nothing touched the credit pool between the
      // end and now, so it still holds tonight's cohort under this same id (a rebuild would make the
      // same pool). onStreamEnd needs no undo: its one consumer (a bot forced on → auto) follows
      // the reopened session.
      if (resume === true) {
        const f = activeForcedEnd();
        if (f && String(f.streamId) === String(streamId)) {
          return res.status(409).json({ error: 'a forced end does not resume' });
        }
        // An open row (ended_at NULL) fails the comparison too: only a closed row reopens.
        const r = await pool.query(
          `UPDATE stream.sessions SET ended_at = NULL
           WHERE stream_id = $1 AND ended_at > NOW() - ($2::int * INTERVAL '1 millisecond')`,
          [streamId, RESUME_GRACE_MS]
        );
        if (r.rowCount === 0) return res.status(409).json({ error: 'not resumable' });
        forcedEnd = null;
        resumed = { streamId: String(streamId), at: now() };
        console.log(`[API] Stream resumed: ${streamId}`);
        return res.json({ ok: true, resumed: true });
      }
      await pool.query(
        'INSERT INTO stream.sessions (stream_id) VALUES ($1) ON CONFLICT DO NOTHING',
        [streamId]
      );
      forcedEnd = null;
      console.log(`[API] Stream started: ${streamId}`);
      // The credit pool keys its weight split on the SESSION (last stream's
      // cohort at 0.25×, tonight's at 1×), so it is rebuilt when a session opens
      // as well as on `/timer/night start` and `/support-bar/reset`; otherwise a
      // night opened BEFORE going live keeps last stream's funders at full
      // weight all evening. Best-effort, after the row exists; never fails the route.
      if (onStreamStart) {
        try { await onStreamStart(streamId); }
        catch (e) { console.warn('[lifecycle] onStreamStart:', e.message); }
      }
      res.json({ ok: true });
    }));

    // POST /stream/end
    app.post('/stream/end', requireInternal, wrap(async (req, res) => {
      const { streamId, forced, by } = req.body;
      if (!streamId) return res.status(400).json({ error: 'streamId required' });
      // A forced end is remembered even when the row is already closed: the poller may have
      // ended it a moment before the mod's press, and the press still means "keep it off"
      // (no resume, and the hold above).
      if (forced) forcedEnd = { at: now(), by: typeof by === 'string' ? by : null, streamId };
      // Only an open row closes: a second end (a retry, the poller racing a mod) changes nothing —
      // not the end time, not the avg, and fires no hook.
      const closed = await pool.query(
        `UPDATE stream.sessions SET ended_at = NOW() WHERE stream_id = $1 AND ended_at IS NULL`,
        [streamId]
      );
      if (closed.rowCount === 0) return res.json({ ok: true, already: true });
      // Snapshot avg message word count for this stream
      await pool.query(`
        UPDATE stream.sessions SET avg_message_words = (
          SELECT AVG(clean_word_count)
          FROM stream.chat_log
          WHERE stream_id = $1 AND clean_word_count IS NOT NULL AND is_bot = false
        ) WHERE stream_id = $1
      `, [streamId]);
      console.log(`[API] Stream ended: ${streamId}${forced ? ` (forced offline by ${by || 'a mod'})` : ''}`);
      await streamEnded(streamId);
      res.json({ ok: true });
    }));

    // POST /viewer-snapshot
    app.post('/viewer-snapshot', requireInternal, wrap(async (req, res) => {
      const { streamId, twitch, youtube, kick, streamplace, ytVideoId } = req.body;
      if (!streamId) return res.status(400).json({ error: 'streamId required' });
      await pool.query(
        `INSERT INTO stream.viewer_snapshots (stream_id, twitch, youtube, kick, streamplace)
         VALUES ($1,$2,$3,$4,$5)`,
        [streamId, twitch ?? null, youtube ?? null, kick ?? null, streamplace ?? null]
      );
      // The live broadcast id rides on every snapshot. Validated HERE,
      // the trust boundary: only an 11-char YouTube id reaches the embed URL;
      // anything else (absent, '', junk) writes NULL and the site falls back
      // to the channel form. Every snapshot rewrites the column; stream-ingest
      // decides when the id is gone (it sends the chat watcher's verified-live
      // id, '' once YouTube is confirmed off).
      await pool.query(
        `UPDATE stream.sessions SET yt_video_id = $2 WHERE stream_id = $1`,
        [streamId, youtubeVideoId(ytVideoId)]
      );
      res.json({ ok: true });
    }));

    // Public: active session info for the homepage live indicator. Viewer counts
    // come from stream-ingest's 60s viewer poller (→ POST /viewer-snapshot).
    app.get('/stream/current', wrap(async (req, res) => {
      res.json(await liveState());
    }));
  }

  return { liveState, registerLifecycleRoutes };
}

module.exports = { createLifecycle };
