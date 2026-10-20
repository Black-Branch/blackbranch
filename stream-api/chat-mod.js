// ── Chat moderation fan-out ─────────────────────────────────────────────────
// Mod actions initiated site-side (Next.js owns the site.* writes) or mirrored
// FROM a platform (stream-ingest connectors): flag stream.chat_log rows, redact
// the WS catch-up buffer, and broadcast the delete/purge/settings frames every
// client keys off — plus the streamer's spotlight pick, a mod's announcement and the DM nudge. No money, no
// identity writes.

const { NATIVE_SQL, isNativePlatform } = require('./native-platform');

/** The longest announcement — web's /api/mod/announce holds the same limit. */
const ANNOUNCE_MAX = 300;

function registerChatMod(app, { pool, msgBuffer, broadcast, redactBuffered, requireInternal, wrap }) {
  // The streamer's highlighted message — see POST /chat/spotlight at the bottom. Declared
  // first because the delete/purge routes below clear it when its row goes:
  // a highlight on a deleted message would otherwise sit on stream with
  // nothing under it, and come back on every reconnect.
  let spotlight = null;
  const setSpotlight = (s) => { spotlight = s; broadcast({ type: 'spotlight', spotlight }); };
  const dropSpotlightIf = (hit) => {
    if (spotlight && hit(spotlight.platform, String(spotlight.messageId))) setSpotlight(null);
  };

  // POST /chat/vote — broadcast a vote-score update (Next.js records the vote
  // in site.message_votes first, then calls this to fan the new score out)
  app.post('/chat/vote', requireInternal, wrap(async (req, res) => {
    const { platform, messageId, score } = req.body;
    if (!platform || messageId == null || score == null)
      return res.status(400).json({ error: 'platform, messageId, score required' });
    // Keep the catch-up buffer in sync so new connections see current scores
    const m = msgBuffer.find(b =>
      b.type === 'message' && b.platform === platform && String(b.id) === String(messageId));
    if (m) m.score = Number(score);
    broadcast({ type: 'vote', platform, messageId, score: Number(score) });
    res.json({ ok: true });
  }));

  // POST /chat/pin — broadcast a pin change (Next.js owns site.pinned_messages;
  // this just fans the new state out). Body: { pin: {...} } to pin, { pin: null }
  // to unpin. Clients fetch the current pin from /api/chat/pin on load, so no
  // catch-up state is kept here.
  app.post('/chat/pin', requireInternal, wrap(async (req, res) => {
    if (!('pin' in (req.body ?? {})))
      return res.status(400).json({ error: 'pin required (object or null)' });
    broadcast({ type: 'pin', pin: req.body.pin });
    res.json({ ok: true });
  }));

  // POST /chat/delete — broadcast a message deletion event (called from Next.js mod actions)
  app.post('/chat/delete', requireInternal, wrap(async (req, res) => {
    const { messageId, platform } = req.body;
    if (!messageId) return res.status(400).json({ error: 'messageId required' });
    // platform is REQUIRED: without it neither DB branch below runs, so the
    // delete would broadcast (clients hide the message) while the row stays
    // un-flagged — served again on history replay and left in the bot's corpus.
    // The web caller always sends it; /chat/platform-delete already requires it.
    if (typeof platform !== 'string' || !platform)
      return res.status(400).json({ error: 'platform required' });
    // Persist for platform messages so the deletion survives a reconnect (native
    // rows live in site.chat_messages and are flagged by the web route).
    // Kept, not removed: mods are shown the struck-out copy; non-mods get nothing.
    if (!isNativePlatform(platform)) {
      await pool.query('UPDATE stream.chat_log SET is_deleted = true WHERE id = $1', [messageId])
        .catch((e) => console.warn('[chat/delete] chat_log flag failed:', e.message));
    } else {
      // Native lines also have a parallel chat_log row (memory corpus) keyed to the
      // site id via platform_msg_id — flag it so deletions stay out of the bot's memory.
      await pool.query(
        `UPDATE stream.chat_log SET is_deleted = true WHERE platform IN ${NATIVE_SQL} AND platform_msg_id = $1`,
        [String(messageId)]
      ).catch((e) => console.warn('[chat/delete] native chat_log flag failed:', e.message));
    }
    // Flag the buffered copy too, so the connect-time history replay reflects the
    // deletion instead of resurrecting the message.
    const b = msgBuffer.find(x => x.type === 'message'
      && String(x.id) === String(messageId)
      && (x.platform || null) === (platform || null));
    redactBuffered(b);
    broadcast({ type: 'delete', messageId, platform: platform || null });
    dropSpotlightIf((p, id) => p === platform && id === String(messageId));
    res.json({ ok: true });
  }));

  // POST /chat/platform-delete — mirror a moderation event that happened ON a
  // platform (a Twitch/Kick/YouTube mod deleted a message or banned/timed-out a
  // user there) into the site: flag the matching stream.chat_log rows and fan out
  // the SAME delete/purge frames the site's own mod actions use, so the message
  // disappears from the site's chat too. Called by stream-ingest's connectors.
  //
  // Body (one of):
  //   { platform, platformMsgId }               — a single message was deleted
  //   { platform, platformUserId?, username? }  — a user was banned/timed-out
  //     (platforms clear ALL their messages client-side; mirrored by flagging
  //     their recent rows on that platform, purge-style: 24h window, cap 250)
  //
  // Loop-safety: rows already flagged are excluded (NOT is_deleted), so the echo
  // of a SITE-initiated delete/purge fan-out (e.g. purge's 1s Twitch timeout
  // bouncing back as CLEARCHAT) re-flags nothing and broadcasts nothing new.
  app.post('/chat/platform-delete', requireInternal, wrap(async (req, res) => {
    const platform = typeof req.body?.platform === 'string' ? req.body.platform.toLowerCase().slice(0, 20) : '';
    const { platformMsgId, platformUserId, username } = req.body || {};
    if (!platform || isNativePlatform(platform))
      return res.status(400).json({ error: 'a platform other than the site required' });

    // Single message delete — resolve by the platform's own message id.
    if (platformMsgId) {
      const r = await pool.query(
        `UPDATE stream.chat_log SET is_deleted = true
         WHERE platform = $1 AND platform_msg_id = $2 AND NOT is_deleted
         RETURNING id`,
        [platform, String(platformMsgId)]
      );
      for (const row of r.rows) {
        const id = parseInt(row.id, 10);
        const b = msgBuffer.find(x => x.type === 'message' && Number(x.id) === id && x.platform === platform);
        redactBuffered(b);
        broadcast({ type: 'delete', messageId: id, platform });
        dropSpotlightIf((p, sid) => p === platform && sid === String(id));
      }
      if (r.rows.length) console.log(`[platform-delete] ${platform} msg ${platformMsgId} → flagged ${r.rows.length}`);
      return res.json({ ok: true, flagged: r.rows.length });
    }

    // User ban/timeout — clear their recent messages on that platform, the same
    // way the platform's own chat view does. Prefer the platform user id (exact,
    // via the identity graph); fall back to the username the event carried.
    if (!platformUserId && !username)
      return res.status(400).json({ error: 'platformMsgId or platformUserId/username required' });
    let canonical = null;
    if (platformUserId) {
      const l = await pool.query(
        'SELECT canonical FROM stream.links WHERE platform = $1 AND platform_id = $2 LIMIT 1',
        [platform, String(platformUserId)]
      ).catch(() => ({ rows: [] }));
      canonical = l.rows[0]?.canonical || null;
    }
    const byUser = canonical
      ? { cond: 'user_id = $2', val: canonical }
      : { cond: 'LOWER(username) = LOWER($2)', val: String(username || '').replace(/^@/, '') };
    if (!byUser.val) return res.json({ ok: true, flagged: 0 });
    const r = await pool.query(
      `UPDATE stream.chat_log SET is_deleted = true
       WHERE id IN (
         SELECT id FROM stream.chat_log
         WHERE platform = $1 AND ${byUser.cond} AND NOT is_deleted
           AND created_at > NOW() - INTERVAL '24 hours'
         ORDER BY created_at DESC LIMIT 250
       )
       RETURNING id`,
      [platform, byUser.val]
    );
    const items = r.rows.map((row) => ({ platform, id: parseInt(row.id, 10) }));
    if (items.length) {
      const keys = new Set(items.map(i => `${i.platform}:${i.id}`));
      for (const b of msgBuffer) {
        if (b.type === 'message' && keys.has(`${b.platform}:${b.id}`)) redactBuffered(b);
      }
      broadcast({ type: 'purge', ids: items, batchId: null });
      dropSpotlightIf((p, id) => keys.has(`${p}:${id}`));
      console.log(`[platform-delete] ${platform} user ${platformUserId || username} banned there → flagged ${items.length}`);
    }
    res.json({ ok: true, flagged: items.length });
  }));

  // POST /chat/purge — bulk-flag a purge's messages and broadcast ONE frame.
  // Called by the web /api/mod/purge route, which already flagged the native
  // site.chat_messages rows and bounded the list (≤500). Items are the same
  // (platform, id) pairs clients key messages by: native items carry the site
  // id (their parallel chat_log row is keyed via platform_msg_id), platform items
  // carry the chat_log id directly.
  app.post('/chat/purge', requireInternal, wrap(async (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 500) : [];
    if (items.length === 0) return res.status(400).json({ error: 'items required' });
    const batchId = req.body?.batchId || null;

    const nativeIds = items.filter(i => isNativePlatform(i.platform)).map(i => String(i.id));
    const platIds = items.filter(i => !isNativePlatform(i.platform)).map(i => Number(i.id)).filter(Number.isFinite);
    if (platIds.length) {
      await pool.query('UPDATE stream.chat_log SET is_deleted = true WHERE id = ANY($1)', [platIds])
        .catch((e) => console.warn('[chat/purge] chat_log flag failed:', e.message));
    }
    if (nativeIds.length) {
      await pool.query(
        `UPDATE stream.chat_log SET is_deleted = true WHERE platform IN ${NATIVE_SQL} AND platform_msg_id = ANY($1)`,
        [nativeIds]
      ).catch((e) => console.warn('[chat/purge] native chat_log flag failed:', e.message));
    }

    // Flag buffered copies so the connect-time history replay reflects the purge.
    const keys = new Set(items.map(i => `${i.platform}:${i.id}`));
    for (const b of msgBuffer) {
      if (b.type === 'message' && keys.has(`${b.platform}:${b.id}`)) redactBuffered(b);
    }

    broadcast({ type: 'purge', ids: items, batchId });
    dropSpotlightIf((p, id) => keys.has(`${p}:${id}`));
    res.json({ ok: true, count: items.length });
  }));

  // POST /chat/settings — broadcast a native chat-settings change (slow mode) so
  // every open client updates live. The setting itself lives in site.chat_settings
  // (written + enforced by the web app); stream-api only fans the change out.
  app.post('/chat/settings', requireInternal, wrap(async (req, res) => {
    const slowModeSeconds = Number(req.body?.slowModeSeconds);
    if (!Number.isFinite(slowModeSeconds) || slowModeSeconds < 0)
      return res.status(400).json({ error: 'slowModeSeconds required' });
    broadcast({ type: 'chat_settings', slowModeSeconds: Math.round(slowModeSeconds) });
    res.json({ ok: true });
  }));


  // POST /chat/announce — a mod's announcement (web /api/mod/announce owns WHO may send it and
  // writes site.mod_log). Fanned out once, never buffered: a late joiner does not get it.
  app.post('/chat/announce', requireInternal, wrap(async (req, res) => {
    const b = req.body ?? {};
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (!text || text.length > ANNOUNCE_MAX) return res.status(400).json({ error: `text required (1–${ANNOUNCE_MAX} characters)` });
    const id = typeof b.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(b.id) ? b.id : null;
    if (!id) return res.status(400).json({ error: 'id required' });
    const by = typeof b.by === 'string' ? b.by.trim().slice(0, 64) : '';
    broadcast({ type: 'announce', id, text, by, at: Date.now() });
    res.json({ ok: true });
  }));

  // POST /chat/badges-changed — transient nudge telling chat clients to refetch the
  // badge map (an admin re-pointed the Supporter badge, or an entitlement changed).
  // Not buffered: a late joiner fetches fresh badges on load anyway.
  app.post('/chat/badges-changed', requireInternal, wrap(async (req, res) => {
    broadcast({ type: 'badges_changed' });
    res.json({ ok: true });
  }));

  // POST /chat/spotlight — the streamer's "highlight": the ONE message being
  // answered on stream, shown to everyone with the highlight-card look. The
  // web route (app/api/chat/spotlight, admin-gated) owns WHO may set it; this
  // just fans the pick out and keeps it for connecting clients. Body:
  // { spotlight: { platform, messageId } } to set, { spotlight: null } to clear.
  // In memory only — a click while talking, nothing to keep across a restart —
  // and replayed on connect through ws-hub's connectFrames (spotlightFrame
  // below, wired in index.js), so a reloaded OBS source paints it at once.
  // (`spotlight` itself is declared at the top of this function.)
  app.post('/chat/spotlight', requireInternal, wrap(async (req, res) => {
    if (!('spotlight' in (req.body ?? {})))
      return res.status(400).json({ error: 'spotlight required (object or null)' });
    const s = req.body.spotlight;
    if (s !== null) {
      if (!s || typeof s !== 'object' || typeof s.platform !== 'string' || !s.platform || s.messageId == null)
        return res.status(400).json({ error: 'spotlight needs platform and messageId' });
      setSpotlight({ platform: s.platform, messageId: s.messageId });
    } else {
      setSpotlight(null);
    }
    res.json({ ok: true });
  }));

  return {
    /** The connect-time replay of the current pick — ALWAYS a frame, `null`
     *  inside when nothing is picked: a client that reconnects after the pick
     *  was cleared (or after a restart, which forgets it) must be told, or it
     *  keeps painting the old highlight — on stream — until the next pick. */
    spotlightFrame: () => ({ type: 'spotlight', spotlight }),
  };
}

module.exports = { registerChatMod };
