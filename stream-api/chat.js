// ── Chat ingest + native chat ──────────────────────────────────────────────
// The hot path: normalized platform chat from stream-ingest (/chat), the
// site's native chat (/chat/native, which shares the send-to-all echo-dedup
// state with /chat — they must stay in one module), scoring patches, and the
// catch-up buffer read. Pure dedup/parsing policy lives in chat-dedup.js; this
// module owns the STATE (dedup entries, hot-path guards) and the routes.

const { classify } = require('./blacklist');
const { instanceConfig } = require('./instance-config');
const { recordPlatformReview, recordAgeReview, recordLinkReview } = require('./blocklist-review');
const linkGate = require('./link-gate');
const { checkAccountAge } = require('./account-age');
const { isIngestPaused } = require('./ingest-pause');
const { twitchProfileImage } = require('./twitch-app.js');
const { parseSelfStatement } = require('./pronouns');
const { NATIVE_SQL, NATIVE_PLATFORM, isNativePlatform } = require('./native-platform');
const { publicIdFor } = require('./pseudonym');
const {
  capMap, normText, normTextWithPath, decodeHtmlEntities,
  decideEchoSuppression, echoIdKey, ECHO_ID_TTL,
  clampLen, MAX_MESSAGE_LEN, MAX_USERNAME_LEN, MAX_REPLY_TEXT_LEN,
  sanitizeNativeEmotes,
} = require('./chat-dedup');

// Tests that are not about pronouns build a chat without them; index.js always
// passes the real module (chat-pronouns.test.js pins the wiring).
const NO_PRONOUNS = { get: async () => null, set: async () => false, maybeAlejo: async () => false };

function createChat({ pool, resolveOrCreate, resolveCanonical, pronouns = NO_PRONOUNS, pollEngine,
                      msgBuffer, broadcast, bufferPush,
                      // The live session's id, for /chat/native's corpus row.
                      // Platform messages arrive stamped by ingest; a native
                      // send comes from web, which does not know the id, so
                      // without it native rows carry stream_id NULL and the
                      // profile card's `streams` (COUNT(DISTINCT stream_id))
                      // stops counting native chat. Same lookup the support bar uses.
                      getStreamId = async () => null }) {
  // ── "Send to all" echo dedup ────────────────────────────────────────────────
  // When a user posts with destination "all", the Next.js server writes ONE
  // canonical native row (/chat/native, allSend:true) and registers the message
  // text here, THEN fans out to every platform. Each platform's bot echoes the
  // message back into /chat within a few seconds; up to `remaining` of those
  // echoes are suppressed so the message shows once (the native line).
  //
  // Key = normalized message text (NOT canonicalId): a sender's cross-platform
  // identities are separate canonical users unless explicitly linked, so the
  // echoes resolve to DIFFERENT canonical ids and a canonicalId key misses them.
  // Text alone is too loose, though: an unrelated viewer typing the same short
  // line ("lol", "gm") inside the window would be swallowed as the echo. So each
  // entry also carries the PLATFORMS the caller actually fanned out to
  // (`platforms`: name → echoes still expected there, normally 1). Only a
  // matching text FROM an expected platform is suppressed.
  const allSendDedup = new Map(); // normText → { platforms:Map|null, remaining, ts, nativeMsgId,
                                  //              aliases:Set, raws:Set, senderCanonical, senderPlatformIds:Map }
  // ── The two EXACT echo paths ────────────────────────────────────────────────
  // The text window above is a guess that must stay narrow (see chat-dedup.js).
  // These two carry proof instead, so they can run far longer:
  //
  //  1. `echoIds` — the platform's own id for the message this service posted,
  //     returned by its send API and registered by the web route (POST
  //     /chat/echo-copies). An id match means the incoming message IS the copy.
  //     Works for Twitch, Kick and stream.place. It cannot work for YouTube: the
  //     send goes through the Data API (`liveChat/messages`, an "LCC."-prefixed
  //     id) and the read through innertube `get_live_chat` (a renderer id) — two
  //     id spaces for the same message that never match. YouTube is covered by (2).
  //
  //  2. `senderPlatformIds` / `senderCanonical` on the entry — the sending user's
  //     own account on each platform. An echo comes back FROM THAT ACCOUNT, so
  //     matching it proves the message is theirs without needing an id at all.
  const echoIds = new Map();        // `${platform}:${platformMsgId}` → { ts, entry|null, nativeMsgId }
  const ECHO_IDS_MAX = 5000;
  const ALL_REPLY_TTL    = 60_000;  // keep entry around so reply lookback resolves
  const MAX_DEDUP_ALIASES = 100;    // cap learned reply aliases per entry (anti-flood)
  // The bot's native identity — instance key bot.matrixId (env BOT_MATRIX_ID, else the
  // stored value). Read per message, so an edit applies without a
  // restart. Unset = no message is the bot's, which is what an install without a bot means.
  const botMatrixId = () => instanceConfig.get('bot.matrixId');

  // First-time chatters: a person's first message EVER carries isFirst. The database answers "no earlier
  // chat_log row"; this set stops a quick second message from being "first" again
  // while the first one's row is still being written (the site path logs AFTER the
  // response). Only canonicals that were ever first land here, so it stays small;
  // the cap is a backstop, and clearing it can only re-mark someone the DB already
  // knows about — which the DB check then refuses.
  const firstClaimed = new Set();
  function claimFirst(canonicalId, dbSaysFirst) {
    if (!canonicalId || !dbSaysFirst || firstClaimed.has(canonicalId)) return false;
    if (firstClaimed.size > 20000) firstClaimed.clear();
    firstClaimed.add(canonicalId);
    return true;
  }

  // ── Hot-path query guards ───────────────────────────────────────────────────
  // Most per-message writes (sessions INSERT, last_seen UPDATE) are idempotent
  // no-ops after a stream's or a user's first message. These in-memory guards
  // skip them, so the common case is a single round-trip: the chat_log INSERT
  // and the stats SELECT, combined in one CTE.

  const lastSeenAt = new Map();      // canonical → epoch ms of last last_seen write
  const LAST_SEEN_THROTTLE = 30_000; // only refresh last_seen this often per user
  const LAST_SEEN_MAX = 20000;
  const sessionsSeen = new Set();    // streamIds already INSERTed this process life

  // Should we write last_seen for this canonical now? Throttled so a chatty user
  // doesn't trigger an UPDATE on every single message.
  function shouldTouchLastSeen(canonicalId) {
    const now = Date.now();
    const prev = lastSeenAt.get(canonicalId);
    if (prev && now - prev < LAST_SEEN_THROTTLE) return false;
    lastSeenAt.set(canonicalId, now);
    capMap(lastSeenAt, LAST_SEEN_MAX);
    return true;
  }

  setInterval(() => {
    const allCutoff = Date.now() - ALL_REPLY_TTL;
    for (const [k, e] of allSendDedup) {
      if (e.ts < allCutoff) allSendDedup.delete(k);
    }
    const idCutoff = Date.now() - ECHO_ID_TTL;
    for (const [k, e] of echoIds) {
      if (e.ts < idCutoff) echoIds.delete(k);
    }
  }, 30_000)
  // The HTTP server keeps the process alive; this sweep must not, or it pins
  // `node --test` open forever.
  .unref();


  // The last profile picture a platform chatter was seen with, kept on
  // stream.users.avatar_url for the Home Leaderboard. One UPDATE per CHANGE, not
  // per message: this map remembers what was last written for each canonical, so
  // a busy stream costs one write per chatter. Best-effort: a failed write never
  // touches the message path.
  const lastAvatarWritten = new Map();
  function rememberAvatar(canonicalId, avatarUrl) {
    if (!canonicalId || typeof avatarUrl !== 'string' || !avatarUrl) return;
    if (lastAvatarWritten.get(canonicalId) === avatarUrl) return;
    lastAvatarWritten.set(canonicalId, avatarUrl);
    if (lastAvatarWritten.size > 5000) lastAvatarWritten.delete(lastAvatarWritten.keys().next().value);
    pool.query('UPDATE stream.users SET avatar_url = $1 WHERE id = $2 AND avatar_url IS DISTINCT FROM $1', [avatarUrl, canonicalId])
      .catch((e) => console.warn('[chat] avatar write failed:', e.message));
  }

  // A message that is ONLY a valid option number of the running poll (1–N, N = that poll's
  // option count) is counted as a vote and NOT shown — not in site chat, not in history, not on an
  // overlay (owner decision). Shown, a bare number moving the live tallies a second later ties a
  // voter's accounts on different platforms together. Outside a poll, or a number that is not an
  // option ("12" with three options), the line displays normally. Returns the option or null.
  function pollVoteOf(message) {
    if (!pollEngine.active()) return null;
    const m = /^\s*(\d{1,2})\s*$/.exec(String(message ?? ''));
    if (!m) return null;
    const n = parseInt(m[1], 10);
    const options = (pollEngine.current && pollEngine.current()?.options) || [];
    return options.some((o) => o.n === n) ? n : null;
  }

  function registerChatRoutes(app, { requireInternal, wrap }) {

  // POST /chat — log a chat message, resolve canonical ID
  app.post('/chat', requireInternal, wrap(async (req, res) => {
    let { platform, userId, username, message, streamId,
          isBot, isMod, isBroadcaster, isVip, isMember, tier, cleanWordCount, avatarUrl,
          emotes: bodyEmotes, replyToUsername: bodyReplyUser, replyToText: bodyReplyText,
          platformMsgId, usernameColor, releaseHold, login } = req.body;
    if (typeof avatarUrl === 'string' && avatarUrl.length > 500) avatarUrl = null;
    // Boundary caps (chat-dedup.js) — before the text reaches identity, the DB,
    // the broadcast or the msgBuffer replay. Legit producers never hit these.
    message = clampLen(message, MAX_MESSAGE_LEN);
    username = clampLen(username, MAX_USERNAME_LEN);
    bodyReplyUser = clampLen(bodyReplyUser, MAX_USERNAME_LEN);
    bodyReplyText = clampLen(bodyReplyText, MAX_REPLY_TEXT_LEN);
    if (!platform || !username || !message)
      return res.status(400).json({ error: 'platform, username, message required' });
    // ── Lockdown: ingest paused for this platform ────────────────────────────
    // FIRST, before any lookup or write: a paused platform's chat is not taken in at all — not
    // stored, not scored, not broadcast. 200 like the word filter, so stream-ingest does not retry
    // a message dropped on purpose. The site's own chat is never paused by it, and a mod releasing
    // a held message (releaseHold) is not ingest. Fails open (ingest-pause.js).
    if (releaseHold !== true && !isNativePlatform(String(platform).toLowerCase())
        && await isIngestPaused(pool, String(platform).toLowerCase())) {
      return res.json({ ok: true, filtered: true, reason: 'ingest_paused' });
    }
    // Twitch profile picture, resolved on THIS side: this process holds the
    // Twitch app credentials; stream-ingest does not. Cached per user id
    // (twitch-app.js), so a stream costs one lookup per chatter, not per message,
    // and it never throws: '' just means the web renders its coloured initial.
    if (platform === 'twitch' && !avatarUrl && userId) {
      avatarUrl = (await twitchProfileImage(userId)) || null;
    }
    message = decodeHtmlEntities(message);
    username = username.replace(/^@/, '').trim();

    const canonicalId = await resolveOrCreate(platform, userId || '', username);
    rememberAvatar(canonicalId, avatarUrl);

    // Suppress "send to all" platform echoes (see allSendDedup). The Next.js
    // server already wrote one canonical native row + broadcast for this message;
    // the platform bots are now echoing it back. Drop the echo entirely — no
    // chat_log INSERT, no scoring, no second broadcast — but record the platform
    // username on the entry so a later cross-platform reply can resolve back to
    // the native line (see lookback's alias fallback).
    const _plat = platform.toLowerCase();
    // Reply lookback needs the platform username on the entry whichever path
    // suppressed the echo, so both share this.
    const learnAlias = (entry) => {
      if (entry && entry.aliases && entry.aliases.size < MAX_DEDUP_ALIASES)
        entry.aliases.add(String(username).toLowerCase());
    };
    const suppressedResponse = (nativeMsgId) =>
      res.json({ id: nativeMsgId, canonicalId, suppressed: true,
                 karma: 0.5, activity: 0, streams: 0, support: 0.0 });

    // ── Path 1: exact platform-message-id ───────────────────────────────────
    // Checked FIRST and unconditionally. This id is the one the platform handed
    // us when we posted the message, so a match is not evidence that this is our
    // copy — it IS our copy. No text comparison, no window, no budget.
    if (!isNativePlatform(_plat) && platformMsgId) {
      const hit = echoIds.get(echoIdKey(_plat, platformMsgId));
      if (hit) {
        learnAlias(hit.entry);
        console.log(`[dedup] suppressed echo BY ID plat=${_plat} elapsed=${Date.now() - hit.ts}ms`);
        return suppressedResponse(hit.nativeMsgId);
      }
    }

    // ── Path 2: armed text, optionally confirmed by sender identity ─────────
    const _dedupKey = normText(message);
    const _dedup = allSendDedup.get(_dedupKey);
    if (_dedup && !isNativePlatform(_plat)) {
      const elapsed = Date.now() - _dedup.ts;
      // Is this message coming back from the SENDER'S OWN account? Either signal
      // is proof on its own: the platform account id we recorded when they linked
      // it, or the echo resolving to the same canonical user as the sender.
      // Both are needed. The canonical check misses the common case the comment
      // above describes (cross-platform identities are only unified when
      // explicitly linked); the account-id check misses platforms whose ingest
      // sends no user id.
      const identityConfirmed =
        (!!_dedup.senderCanonical && canonicalId === _dedup.senderCanonical) ||
        (!!userId && !!_dedup.senderPlatformIds &&
         _dedup.senderPlatformIds.get(_plat) === String(userId));

      const verdict = decideEchoSuppression({
        entry: _dedup, platform: _plat, elapsed, key: _dedupKey,
        incomingRaw: normTextWithPath(message), identityConfirmed,
      });
      if (verdict.suppress) {
        learnAlias(_dedup);
        // Identity-confirmed suppression does not spend budget: the budget exists
        // to bound how much a TEXT guess may swallow, and there is no guess here.
        if (!identityConfirmed) {
          if (_dedup.platforms === null) {
            if (_dedup.remaining > 0) _dedup.remaining--;
          } else if (verdict.budget > 0) {
            _dedup.platforms.set(_plat, verdict.budget - 1);
          }
        }
        console.log(`[dedup] suppressed echo plat=${_plat} elapsed=${elapsed}ms budget=${verdict.budget} by=${verdict.reason}`);
        return suppressedResponse(_dedup.nativeMsgId);
      }
      console.log(`[dedup] NOT suppressed (${verdict.reason} expected=${verdict.expected} budget=${verdict.budget} elapsed=${elapsed}ms confirmed=${identityConfirmed}) plat=${_plat} — rendering as a new message`);
    }

    // Poll vote: while a poll is running, a line that is only an option number counts as this
    // chatter's vote (upsert — typing a different number moves it) and is NOT stored or shown
    // (pollVoteOf). Runs after echo suppression so an all-send echo can't double-vote on behalf
    // of the sender. `suppressed: true` tells stream-ingest there is no row to score.
    const pollN = pollVoteOf(message);
    if (pollN != null) {
      pollEngine.vote({ voterKey: canonicalId, platform: platform.toLowerCase(), optionN: pollN })
        .catch((e) => console.warn('[poll] chat vote failed:', e.message));
      return res.json({ ok: true, canonicalId, suppressed: true, pollVote: { optionN: pollN } });
    }

    // Cross-platform reply banners, from stream-ingest's inline reply metadata.
    // Most recent buffered message from `target`; prefer the one matching the
    // banner snippet so replies to older messages resolve correctly.
    const lookback = (target, snippet) => {
      const t = String(target).toLowerCase();
      const snip = snippet ? snippet.replace(/…+$/, '').trim().toLowerCase() : null;
      let newest = null;
      for (let i = msgBuffer.length - 1; i >= 0; i--) {
        const b = msgBuffer[i];
        if (b.type !== 'message' || !b.username ||
            String(b.username).toLowerCase() !== t) continue;
        if (!newest) newest = b;
        if (!snip) break;
        if (String(b.message).toLowerCase().startsWith(snip)) return b;
      }
      if (newest) return newest;
      // Alias fallback: a cross-platform reply targets the streamer's PLATFORM
      // username, but a "send to all" message is buffered only as the native copy
      // under the streamer's display name (the platform echoes were suppressed).
      // Resolve via the dedup entry's recorded platform aliases.
      for (const e of allSendDedup.values()) {
        if (!e.aliases.has(t)) continue;
        const nb = msgBuffer.find(b => b.type === 'message' && b.id === e.nativeMsgId);
        if (nb && (!snip || String(nb.message).toLowerCase().startsWith(snip))) return nb;
      }
      return null;
    };

    let replyToId = null, replyToUsername = null, replyToText = null;
    if (bodyReplyUser) {
      // Inline reply metadata from stream-ingest. Single-process ingestion has the
      // platform's native reply fields (e.g. tmi.js reply-parent tags). Resolve
      // reply_to_id via lookback.
      const quoted = lookback(bodyReplyUser, bodyReplyText);
      replyToId       = quoted ? Number(quoted.id) || null : null;
      replyToUsername = quoted ? quoted.username : String(bodyReplyUser).replace(/^@/, '');
      replyToText     = quoted ? decodeHtmlEntities(String(quoted.message)).slice(0, 100)
                               : (bodyReplyText ? decodeHtmlEntities(String(bodyReplyText)).slice(0, 100) : null);
    }
    // No blind "@name ..." text-prefix fallback here on purpose: a plain typed
    // @mention (no genuine reply metadata from the platform) must never be
    // reinterpreted as a reply — that's what made mentions and real replies
    // indistinguishable downstream.

    // The session row only needs creating once per stream — skip the round-trip
    // after the first message of that stream this process life.
    if (streamId && !sessionsSeen.has(streamId)) {
      await pool.query(
        'INSERT INTO stream.sessions (stream_id) VALUES ($1) ON CONFLICT DO NOTHING',
        [streamId]
      );
      sessionsSeen.add(streamId);
    }

    // last_seen is throttled per user (no UPDATE on every message from a chatter).
    if (shouldTouchLastSeen(canonicalId)) {
      await pool.query('UPDATE stream.users SET last_seen = NOW() WHERE id = $1', [canonicalId]);
    }

    // Inline emote map from stream-ingest, persisted with the row — Kick/YouTube
    // channel emotes aren't in the global manifest, so history needs the
    // per-message map.
    const emoteMap = (bodyEmotes && typeof bodyEmotes === 'object' && Object.keys(bodyEmotes).length)
      ? bodyEmotes
      : null;

    // Strip Twitch Cheermote prefix tokens (e.g. "Cheer100", "Cheer 100100") so the
    // stored/broadcast message contains only the viewer's actual text. Preserves
    // cheer-only messages that have no body (stripped === "").
    if (platform.toLowerCase() === 'twitch') {
      const stripped = message.replace(/^Cheer\s*\d+\s*/i, '').trim();
      if (stripped) message = stripped;
    }

    // ── Word filter: withhold, don't asterisk ──────────────────
    //
    // A starred-out slur is the worst of both — everyone still reads what was
    // said, and no mod is told about it.
    //
    // A hit is NOT stored in stream.chat_log and NOT broadcast. Not storing is
    // deliberate: chat_log feeds history replay AND the bot's corpus, so a row
    // there would leak the message to every viewer who reconnects and teach the
    // bot the language we are filtering. The review row carries the full text,
    // sender and matched term — that is the evidence a mod needs.
    //
    // It stays visible on the source platform, and that is accepted: that is
    // the platform's own moderation to handle. What is owed here is the REVIEW,
    // so a mod can ban the sender on the other platform — which the row
    // provides, and which the cross-platform ban tooling acts on.
    const verdict = classify(message);
    if (verdict.action !== 'allow') {
      recordPlatformReview({ pool, verdict, text: message, platform, username, canonicalId });
      // 200, not an error: the sender is a platform bot relaying someone else's
      // message. Failing the POST would make stream-ingest retry a message we
      // are deliberately dropping.
      return res.json({ ok: true, filtered: true });
    }

    // ── Link gate ──────────────────────────────────────────────────────────
    //
    // Ordered AFTER the word blocklist and BEFORE the account-age check, for the
    // same reason the age check sits where it does: this one is synchronous and
    // free (at posture `off` it does not even scan for URLs), the age check can
    // make an HTTP call.
    //
    // `releaseHold` SKIPS THIS GATE, and unlike the blocklist that is not a
    // policy choice — it is what makes "held" true. A mod pressing Allow
    // re-posts the message through this same route; re-running the gate would
    // refuse it again and Allow would be a silent no-op.
    // The word blocklist above still ran, so releasing a link cannot smuggle a
    // slur through.
    const linkVerdict = releaseHold === true
      ? { action: 'allow' }
      : linkGate.gate(message);
    if (linkVerdict.action === 'hold') {
      const flagOnly = linkGate.currentPosture() === 'flag';
      recordLinkReview({
        pool, host: linkVerdict.host, reason: linkVerdict.reason,
        text: message, platform, username, canonicalId, flagOnly,
      });
      if (!flagOnly) {
        // 200 like the blocklist path: the caller is a relay bot, and failing
        // the POST would make stream-ingest retry a message we are withholding
        // on purpose.
        return res.json({ ok: true, filtered: true, reason: `link:${linkVerdict.reason}` });
      }
      // flag mode: measured, not withheld — fall through and deliver.
    }

    // ── Minimum account age: the third raid-lockdown lever ──────────────────
    //
    // Ordered AFTER the blocklist on purpose. The blocklist is synchronous and
    // free; this one may make an HTTP call. Running the cheap, always-on check
    // first means a slur from a fresh account is refused without anyone waiting
    // on Twitch's API, and the expensive check is reached only by messages that
    // are otherwise fine.
    //
    // Disarmed (minAgeDays = 0, the default and the state of every ordinary
    // stream) this costs one small cached query per 5 seconds for the whole
    // service — no fetch, no per-message DB read. See account-age.js.
    // `releaseHold` is a mod RELEASING a message this gate previously withheld,
    // so re-running the gate would refuse it again and make Allow a no-op,
    // breaking the "held, not dropped" promise.
    // Internal-only (the route is behind requireInternal), and deliberately
    // narrow: it skips THIS gate and nothing else. The blocklist above still
    // ran, so a mod cannot release a slur by way of the age queue.
    const ageCheck = releaseHold === true
      ? { action: 'allow' }
      : await checkAccountAge({ pool, platform, platformId: userId });
    if (ageCheck.action === 'withhold') {
      recordAgeReview({
        pool,
        reason: ageCheck.reason,
        minAgeDays: ageCheck.minAgeDays,
        accountCreatedAt: ageCheck.accountCreatedAt,
        text: message,
        platform,
        username,
        canonicalId,
      });
      return res.json({ ok: true, filtered: true, reason: ageCheck.reason });
    }

    // Pronouns (pronouns.js): a plain statement of the sender's own
    // is saved silently and BEFORE the broadcast, so the bot's lookup for its reply
    // already has it; the frame carries the value for the chat symbol; a Twitch
    // chatter is offered to alejo.io (never awaited — it cannot slow chat).
    let senderPronouns = null;
    if (!isBot && canonicalId) {
      const stated = parseSelfStatement(message);
      if (stated) await pronouns.set(canonicalId, stated, 'self').catch((e) => console.warn('[chat] pronoun save failed:', e.message));
      if (_plat === 'twitch') pronouns.maybeAlejo(canonicalId, String(login || username).toLowerCase());
      senderPronouns = await pronouns.get(canonicalId).catch(() => null);
    }

    // Combine the chat_log INSERT with the caller's stats lookup into ONE
    // round-trip: a CTE inserts the row, then we LEFT JOIN the sender's cached
    // aggregate stats off the returned id, rather than two serial queries per message.
    const result = await pool.query(
      `WITH ins AS (
         INSERT INTO stream.chat_log
           (user_id, platform, username, message, stream_id,
            is_bot, is_mod, is_vip, is_member, tier, clean_word_count,
            reply_to_id, reply_to_username, reply_to_text, emotes,
            platform_msg_id, username_color)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING id, user_id
       )
       SELECT ins.id, s.karma, s.activity, s.streams, s.support,
              NOT EXISTS (SELECT 1 FROM stream.chat_log p WHERE p.user_id = $1) AS first_msg
       FROM ins LEFT JOIN stream.user_stats s ON s.user_id = ins.user_id`,
      [canonicalId, platform, username, message, streamId || null,
       !!isBot, !!isMod, !!isVip, !!isMember, tier || null,
       cleanWordCount != null ? parseInt(cleanWordCount) : null,
       replyToId, replyToUsername, replyToText,
       emoteMap ? JSON.stringify(emoteMap) : null,
       platformMsgId || null, usernameColor || null]
    );

    const stats = result.rows[0];
    const chatLogId = parseInt(result.rows[0].id, 10);
    // The INSERT's own row is invisible to the NOT EXISTS in the same statement,
    // so first_msg means "no EARLIER row for this person". Bots never count.
    const isFirst = !isBot && claimFirst(canonicalId, stats.first_msg === true);

    // Broadcast to all connected site clients
    const msg = {
      type:       'message',
      id:         chatLogId,
      platform,
      // The public socket carries only the per-platform public id; the canonical rides for the
      // internal sockets and ws-hub strips it from every public one (INTERNAL_ONLY_KEYS).
      publicId:   publicIdFor(canonicalId, platform),
      canonicalId,
      username,
      message,
      isMod:      !!isMod,
      isBroadcaster: !!isBroadcaster,
      // Behavior flags: the server's own bot list decides (stream-ingest BOT_USERNAMES);
      // the site hides bots on request without knowing any bot's name.
      isBot:      !!isBot,
      ...(isFirst && { isFirst: true }),
      isVip:      !!isVip,
      isMember:   !!isMember,
      tier:       tier || null,
      ts:         Date.now(),
      ...(usernameColor && { usernameColor }),
      ...(platformMsgId && { platformMsgId }),
      ...(avatarUrl && { avatarUrl }),
      ...(senderPronouns && { pronouns: senderPronouns }),
      ...(emoteMap && { emotes: emoteMap }),
      ...(replyToUsername && {
        reply_to_id:       replyToId,
        reply_to_username: replyToUsername,
        reply_to_text:     replyToText,
      }),
    };
    bufferPush(msg);
    broadcast(msg);

    res.json({
      id:          chatLogId,
      canonicalId,
      karma:       stats.karma    != null ? parseFloat(stats.karma)   : 0.5,
      activity:    stats.activity != null ? parseInt(stats.activity)  : 0,
      streams:     stats.streams  != null ? parseInt(stats.streams)   : 0,
      support:     stats.support  != null ? parseFloat(stats.support) : 0.0,
    });
  }));

  // POST /chat/echo-copies — the platform message ids a send-to-all produced.
  // Called by the web route as each platform send RESOLVES (not batched after
  // the slowest one: Twitch answers in ~200ms and its echo follows within a
  // second, so waiting on a slow YouTube send would register the Twitch id after
  // its echo had already been rendered).
  //
  // Body: { nativeMsgId, copies: [{ platform, platformMsgId }] }.
  app.post('/chat/echo-copies', requireInternal, wrap(async (req, res) => {
    const { nativeMsgId, copies } = req.body || {};
    if (!Array.isArray(copies) || copies.length === 0)
      return res.status(400).json({ error: 'copies required' });
    const nativeId = Number.isInteger(nativeMsgId) ? nativeMsgId : null;
    // Reply lookback resolves a cross-platform reply through the entry's learned
    // aliases, so an id-suppressed echo must still be able to teach it. The map
    // holds at most a handful of live entries (60s TTL), so the scan is cheap.
    let entry = null;
    if (nativeId != null) {
      for (const e of allSendDedup.values()) {
        if (e.nativeMsgId === nativeId) { entry = e; break; }
      }
    }
    let registered = 0;
    for (const c of copies) {
      if (!c || typeof c.platform !== 'string' || !c.platform) continue;
      const id = c.platformMsgId;
      if (typeof id !== 'string' && typeof id !== 'number') continue;
      const idStr = String(id).slice(0, 200);
      if (!idStr) continue;
      echoIds.set(echoIdKey(c.platform, idStr), { ts: Date.now(), entry, nativeMsgId: nativeId });
      registered += 1;
    }
    capMap(echoIds, ECHO_IDS_MAX);
    res.status(202).json({ ok: true, registered });
  }));

  // The row id is a bigint. ingest once scored a dedup-suppressed echo whose
  // /chat response carried no id and PATCHed `/chat/undefined/karma`; the
  // string reached Postgres and came back as an unhandled 500 (09-17 stream,
  // 14×). A bad id is the caller's mistake and gets a 400, not a pg error —
  // and that includes digits past the bigint range, which pg refuses the
  // same way.
  const BIGINT_MAX = 9223372036854775807n;
  const rowId = (raw) => {
    const s = String(raw);
    return /^\d{1,19}$/.test(s) && BigInt(s) <= BIGINT_MAX ? s : null;
  };

  // PATCH /chat/:id/karma
  app.patch('/chat/:id/karma', requireInternal, wrap(async (req, res) => {
    const { score } = req.body;
    if (score == null) return res.status(400).json({ error: 'score required' });
    const id = rowId(req.params.id);
    if (!id) return res.status(400).json({ error: 'numeric id required' });
    await pool.query('UPDATE stream.chat_log SET karma = $1 WHERE id = $2', [score, id]);
    res.json({ ok: true });
  }));

  // PATCH /chat/:id/intelligence
  app.patch('/chat/:id/intelligence', requireInternal, wrap(async (req, res) => {
    const { score } = req.body;
    if (score == null) return res.status(400).json({ error: 'score required' });
    const id = rowId(req.params.id);
    if (!id) return res.status(400).json({ error: 'numeric id required' });
    await pool.query('UPDATE stream.chat_log SET intelligence = $1 WHERE id = $2', [score, id]);
    res.json({ ok: true });
  }));

  // PATCH /chat/native/:siteId/scores — a SITE message's karma/intelligence,
  // so the Leaderboard's rate faces include site chatters. stream-ingest scores the live WS frame,
  // which carries the site.chat_messages id; the score belongs on the parallel
  // stream.chat_log row /chat/native writes AFTER its response (the site's own
  // platform id, platform_msg_id = the site id), because that row is what the
  // boards and every karma aggregate read. No row yet → 404, and the caller
  // tries once more.
  const unitScore = (v) => (v == null ? null : typeof v === 'number' && v >= 0 && v <= 1 ? v : undefined);
  app.patch('/chat/native/:siteId/scores', requireInternal, wrap(async (req, res) => {
    const siteId = rowId(req.params.siteId);
    if (!siteId) return res.status(400).json({ error: 'numeric id required' });
    const karma = unitScore(req.body?.karma);
    const intelligence = unitScore(req.body?.intelligence);
    if (karma === undefined || intelligence === undefined) return res.status(400).json({ error: 'scores are 0..1' });
    if (karma == null && intelligence == null) return res.status(400).json({ error: 'a score required' });
    const r = await pool.query(
      `UPDATE stream.chat_log
          SET karma = COALESCE($1::double precision, karma), intelligence = COALESCE($2::double precision, intelligence)
        WHERE platform IN ${NATIVE_SQL} AND platform_msg_id = $3`,
      [karma, intelligence, siteId]
    );
    if (!r.rowCount) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true });
  }));

  // POST /chat/native — the site's native chat (called from the Next.js server).
  // The web server authenticates with the shared secret (the tunnel's egress is
  // never IP-trusted) — see requireInternal.
  // Response: { ok: true, id } for a shown line; { ok: true, id: null, pollVote: { optionN } }
  // when the line was only a valid option number of the running poll — counted as the
  // sender's vote (voter = their canonical id, the same key a card tap uses) and NOT stored or
  // shown anywhere; { ok: false, error: 'vote_failed' } (503) when that vote could not be stored.
  app.post('/chat/native', requireInternal, wrap(async (req, res) => {
    let { matrixId, username, message, streamId, usernameColor, reply_to_id, reply_to_username, reply_to_text,
          allSend, canonicalId: bodyCanonicalId, expectedEchoes, destPlatform, echoText, echoTextAlt } = req.body;
    // Boundary caps, same as /chat. The web sanitizer already caps at 500, but
    // direct internal callers (the owner plugin's bot, automod release) bypass it.
    message = clampLen(message, MAX_MESSAGE_LEN);
    username = clampLen(username, MAX_USERNAME_LEN);
    reply_to_username = clampLen(reply_to_username, MAX_USERNAME_LEN);
    reply_to_text = clampLen(reply_to_text, MAX_REPLY_TEXT_LEN);
    if (!matrixId || !message) return res.status(400).json({ error: 'matrixId and message required' });
    // Optional coin-store username style: the equipped id-set
    // { font?, effect?, entrance?, gradient?, gradientColor? } rides the frame only — the
    // web client derives the actual CSS from these ids + the name color;
    // history re-reads site.users. gradientColor = the user-picked second stop
    // for the "duo" gradient (hex only; render clamps contrast web-side).
    const rawStyle = req.body.usernameStyle;
    const pickStyleId = (v) => (typeof v === 'string' && v ? v.slice(0, 30) : undefined);
    const pickHex = (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : undefined);
    let usernameStyle = null;
    if (rawStyle && typeof rawStyle === 'object') {
      const s = {
        font: pickStyleId(rawStyle.font),
        effect: pickStyleId(rawStyle.effect),
        entrance: pickStyleId(rawStyle.entrance),
        gradient: pickStyleId(rawStyle.gradient),
        gradientColor: pickHex(rawStyle.gradientColor),
      };
      if (s.font || s.effect || s.entrance || s.gradient) usernameStyle = s;
    }
    // Optional routing cue: a site message sent to ONE platform keeps its site
    // identity but is tinted with that platform in chat (the color bar/icon).
    const dest = typeof destPlatform === 'string' && destPlatform ? destPlatform.toLowerCase().slice(0, 20) : null;
    // "Send to: all" destination SET (2+ platforms) — persisted + broadcast so
    // every viewer's indicator can cycle through the destination colors.
    const destList = Array.isArray(req.body.destPlatforms)
      ? req.body.destPlatforms
          .filter((p) => typeof p === 'string' && p)
          .map((p) => p.toLowerCase().slice(0, 20))
          .slice(0, 6)
      : null;
    const destListStr = destList && destList.length >= 2 ? destList.join(',') : null;

    // Resolve the sender's saved name color when the caller didn't supply one.
    // The web route passes usernameColor explicitly; direct callers (e.g. the owner
    // plugin's bot) omit it, so fall back to site.users.username_color here.
    let resolvedColor = usernameColor || null;
    if (!resolvedColor) {
      try {
        const c = await pool.query('SELECT username_color FROM site.users WHERE matrix_id = $1', [matrixId]);
        resolvedColor = c.rows[0]?.username_color || null;
      } catch { /* site schema not ready — leave null */ }
    }

    // Store in site schema. Fail CLOSED on a DB error: broadcasting with id:null
    // is worse than not broadcasting — live clients drop null-id frames (the
    // message silently vanishes for everyone including the sender) while the
    // history replay renders it, so reconnecting clients see a ghost line. An
    // {ok:false} here lets the web client show its normal "Failed to send" +
    // draft-restore path instead.
    //
    // Supporter encrypted message. `message` is ALREADY the
    // scramble when this is set — the web route swapped it before calling — so
    // everything downstream of here (the broadcast, the msgBuffer replay, the
    // stream.chat_log mirror the bot reads) handles the placeholder and only the
    // placeholder. The plaintext is written in the SAME INSERT below and is
    // served exclusively by /api/chat/decrypt.
    //
    // `encText` must never be added to the `msg` frame built at the bottom of
    // this handler. ws-hub broadcasts that frame to every connected client AND
    // keeps the last 200 as `history`, replayed to everyone who connects later —
    // one plaintext in that buffer reaches every future viewer with no auth
    // check anywhere in the path.
    const encText = typeof req.body.encryptedText === 'string' && req.body.encryptedText
      ? req.body.encryptedText.slice(0, 2000)
      : null;

    // Personal Twitch emotes resolved by web chat/send (sender-only names; the
    // site catalog wins collisions THERE — nothing here re-decides precedence).
    // Host-pinned + capped at this boundary: see sanitizeNativeEmotes.
    // Encrypted gate: web never sends both today, but this is the boundary
    // that owns the public history buffer — an emote map's KEYS are plaintext
    // words, so attaching one to an encrypted row leaks message content into
    // msgBuffer/broadcast/history the same way the note above forbids for
    // `message` itself. Computed null outright rather than filtered later.
    const nativeEmotes = encText ? null : sanitizeNativeEmotes(req.body.emotes);

    // "Send to all": register this message's text so the per-platform echoes that
    // follow are suppressed in /chat (one row, one broadcast). Registered here,
    // before the caller fans out, so the window is armed before any echo returns.
    const armAllSend = (nativeMsgId) => {
    let armedEntry = null;
    if (allSend) {
      // Key on the text the platform will ACTUALLY echo back. For a reply that's
      // "@user message" (the web route sends echoText), not the bare message —
      // otherwise the reply's platform copy never matches and double-posts.
      // The web route names the platforms it fans out to (expectedPlatforms) so
      // suppression can be scoped per platform; a caller sending only a count
      // gets the legacy any-platform window (platforms: null).
      //
      // `platforms: null` is currently unreachable, and not because of anything
      // in this file. `/chat/native` is requireInternal with exactly one caller —
      // web `app/api/chat/send/route.ts` — which sends `expectedPlatforms` at both
      // call sites, and which returns 403 `not_linked` when it has no targets
      // before it ever POSTs here.
      //
      // The fall-back is kept deliberately: deleting it would make removing that
      // 403 silently turn per-platform echo scoping into an any-platform window,
      // which swallows unrelated viewers typing the same text. If you touch the
      // web route's 403, re-read this.
      const expectedPlatforms = Array.isArray(req.body.expectedPlatforms)
        ? req.body.expectedPlatforms
            .filter((p) => typeof p === 'string' && p)
            .map((p) => p.toLowerCase().slice(0, 20))
            .slice(0, 10)
        : null;
      // The sender's own identity on each platform, so an echo can be recognised
      // by WHO sent it rather than only by what it says — see the header comment
      // on echoIds. Known here, before the fan-out, so there is no race with the
      // echo: unlike the platform message ids, this needs no second round trip.
      const rawSenderIds = req.body.senderPlatformIds;
      const senderPlatformIds = new Map();
      if (rawSenderIds && typeof rawSenderIds === 'object') {
        for (const [p, id] of Object.entries(rawSenderIds)) {
          if (typeof p === 'string' && p && (typeof id === 'string' || typeof id === 'number'))
            senderPlatformIds.set(p.toLowerCase().slice(0, 20), String(id).slice(0, 100));
        }
      }
      const dedupEntry = {
        platforms: expectedPlatforms && expectedPlatforms.length
          ? new Map(expectedPlatforms.map((p) => [p, 1]))
          : null,
        remaining: Math.max(1, parseInt(expectedEchoes, 10) || 4),
        ts: Date.now(),
        nativeMsgId,
        aliases: new Set(),
        senderCanonical: bodyCanonicalId || null,
        senderPlatformIds,
        // Path-preserving forms of the same message, for the weak-key check in
        // /chat. Only consulted when the dedup key is a bare URL.
        raws: new Set([normTextWithPath(echoText || message)]),
      };
      const primaryKey = normText(echoText || message);
      allSendDedup.set(primaryKey, dedupEntry);
      armedEntry = dedupEntry;
      // A native-threaded reply's ACTUAL echoed text is platform-dependent and not
      // fully known in advance (e.g. Twitch's Send Chat Message API auto-prepends
      // "@user " to the delivered message when reply_parent_message_id is set,
      // even though we sent the bare text, so the bare-text dedup key alone misses
      // and the echo renders as a duplicate row). The web route supplies the OTHER
      // plausible shape here so both are armed against the SAME entry — whichever
      // one the platform actually echoes still gets suppressed.
      if (echoTextAlt) {
        const altKey = normText(echoTextAlt);
        dedupEntry.raws.add(normTextWithPath(echoTextAlt));
        if (altKey !== primaryKey) allSendDedup.set(altKey, dedupEntry);
      }
    }
    return armedEntry;
    };

    // A poll vote (pollVoteOf): counted, NOT stored, NOT broadcast. The echoes a send-to-all
    // brings back are still armed for suppression, so they cannot vote a second time.
    // Response contract: { ok: true, id: null, pollVote: { optionN } } — the composer shows
    // "counted as a vote". A vote that could not be stored answers 503 { ok: false, error:
    // 'vote_failed' } and the line is not shown either. An encrypted line is never a vote.
    const pollN = encText == null && matrixId !== botMatrixId() ? pollVoteOf(message) : null;
    if (pollN != null) {
      armAllSend(null);
      let voter = bodyCanonicalId || null;
      try {
        voter = voter || (await resolveCanonical(null, matrixId))
          || (await resolveOrCreate(NATIVE_PLATFORM, matrixId, (username || matrixId).replace(/^@/, '')));
      } catch (err) { console.warn('[chat/native] canonical resolve failed:', err.message); }
      const voted = voter
        ? await pollEngine.vote({ voterKey: voter, platform: NATIVE_PLATFORM, optionN: pollN })
          .catch((e) => ({ error: e.message }))
        : { error: 'no_identity' };
      if (voted && voted.error) {
        console.warn('[poll] native chat vote failed:', voted.error);
        return res.status(503).json({ ok: false, error: 'vote_failed' });
      }
      return res.json({ ok: true, id: null, pollVote: { optionN: pollN } });
    }

    let chatId = null;
    try {
      // The install's bot account posts here without ever signing in to the site, so it may have
      // no account row yet — and chat_messages references one. Created on its first line only.
      if (matrixId && matrixId === botMatrixId()) {
        await pool.query(
          `INSERT INTO site.users (matrix_id, display_name, is_bot) VALUES ($1, $2, true) ON CONFLICT (matrix_id) DO NOTHING`,
          [matrixId, String(username || '').slice(0, 64) || null]);
      }
      const r = await pool.query(
        `INSERT INTO site.chat_messages (matrix_id, message, reply_to_id, reply_to_username, reply_to_text, dest_platform, dest_platforms, encrypted_text, emotes, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW()) RETURNING id`,
        [matrixId, message, reply_to_id ?? null, reply_to_username ?? null, reply_to_text ?? null, dest, destListStr, encText, nativeEmotes]
      );
      chatId = parseInt(r.rows[0].id, 10);
    } catch (err) {
      console.warn('[chat/native] store failed, refusing to broadcast:', err.message);
      return res.status(503).json({ ok: false, error: 'store_failed' });
    }

    let armedEntry = armAllSend(chatId);

    // Unify native chat into the memory corpus: resolve the sender's canonical and
    // append a parallel stream.chat_log row (the site's own platform id). The combined-chat
    // history reads native from site.chat_messages and EXCLUDES chat_log's native
    // rows, so this never double-displays — it only feeds scoring/stats/recall and
    // the bot's memory under one identity. The bot's own lines are skipped (it
    // handles its self-memory separately). platform_msg_id = the site id, so a
    // later /chat/delete can flag this row too.
    // Only the resolve happens HERE (the broadcast frame and the poll vote
    // carry nativeCanon); the corpus INSERT + last_seen write are non-display
    // bookkeeping and run after the response — see below.
    let nativeCanon = bodyCanonicalId || null;
    if (matrixId !== botMatrixId()) {
      try {
        nativeCanon = nativeCanon
          || (await resolveCanonical(null, matrixId))
          || (await resolveOrCreate(NATIVE_PLATFORM, matrixId, (username || matrixId).replace(/^@/, '')));
        // Backfill the armed entry's sender identity for callers that omit
        // canonicalId — without this the identity path is dark for them, and
        // silently (it would just never confirm).
        if (armedEntry && !armedEntry.senderCanonical) armedEntry.senderCanonical = nativeCanon;
      } catch (err) {
        console.warn('[chat/native] canonical resolve failed:', err.message);
      }
    }

    // Pronouns — the same silent save + frame field as /chat above. An encrypted
    // line's text is a placeholder, and the bot's own lines never save.
    let senderPronouns = null;
    if (nativeCanon && matrixId !== botMatrixId()) {
      const stated = encText ? null : parseSelfStatement(message);
      if (stated) await pronouns.set(nativeCanon, stated, 'self').catch((e) => console.warn('[chat/native] pronoun save failed:', e.message));
      senderPronouns = await pronouns.get(nativeCanon).catch(() => null);
    }

    // Behavior flags: the site's own bot is the configured bot account; a person's
    // first message ever is one with no earlier chat_log row (their corpus rows
    // are written after the response, so claimFirst also remembers this process's).
    const nativeIsBot = matrixId === botMatrixId();
    let nativeFirst = false;
    if (nativeCanon && !nativeIsBot) {
      const fr = await pool.query(
        'SELECT NOT EXISTS (SELECT 1 FROM stream.chat_log WHERE user_id = $1) AS first_msg', [nativeCanon],
      ).catch(() => null);
      nativeFirst = claimFirst(nativeCanon, fr?.rows?.[0]?.first_msg === true);
    }

    const msg = {
      type:             'message',
      id:               chatId,
      platform:         NATIVE_PLATFORM,
      // As on the platform frame: public id for everyone, canonical for internal sockets only.
      // The Matrix id stays — it is this site account's own handle, the one the community and
      // DMs show; it ties to no other platform.
      publicId:         publicIdFor(nativeCanon, NATIVE_PLATFORM),
      canonicalId:      nativeCanon,
      matrixId:         matrixId,
      username:         username || matrixId,
      message,
      isMod:            false,
      isBroadcaster:    false, // native website chat carries no broadcaster signal (secure default)
      isBot:            nativeIsBot,
      ...(nativeFirst && { isFirst: true }),
      isVip:            false,
      isMember:         false,
      tier:             null,
      usernameColor:    resolvedColor,
      usernameStyle,
      destPlatform:     dest,
      destPlatforms:    destList && destList.length >= 2 ? destList : null,
      // The FLAG only — see the note above the INSERT. Clients need to know
      // to render a lock and offer to decrypt; the plaintext itself is fetched
      // separately, authenticated, per message.
      encrypted:        encText != null,
      ts:               Date.now(),
      reply_to_id:      reply_to_id ?? null,
      reply_to_username: reply_to_username ?? null,
      reply_to_text:    reply_to_text ?? null,
      ...(senderPronouns && { pronouns: senderPronouns }),
      ...(nativeEmotes && { emotes: nativeEmotes }),
    };
    bufferPush(msg);
    broadcast(msg);

    res.json({ ok: true, id: chatId });

    // Unify native chat into the memory corpus: a parallel stream.chat_log row
    // (the site's own platform id) under the canonical identity. The combined-chat
    // history reads native from site.chat_messages and EXCLUDES chat_log's
    // native rows, so this never double-displays — it only feeds
    // scoring/stats/recall and the bot's memory. The bot's own lines are skipped
    // (it handles its self-memory separately). platform_msg_id = the
    // site id, so a later /chat/delete can flag this row too.
    //
    // Deliberately AFTER broadcast + response, so no native send waits on a
    // last_seen UPDATE plus the corpus INSERT before anyone sees the message.
    // A failure warns.
    if (nativeCanon && matrixId !== botMatrixId()) {
      (async () => {
        if (shouldTouchLastSeen(nativeCanon)) {
          await pool.query('UPDATE stream.users SET last_seen = NOW() WHERE id = $1', [nativeCanon]);
        }
        const cwc = message.trim() ? message.trim().split(/\s+/).length : 0;
        // Attribute the row to the live stream when the caller did not (web
        // never does). Behind the response on purpose: liveState is two
        // queries, and nothing displayed depends on it.
        const sid = streamId || await getStreamId().catch(() => null);
        await pool.query(
          `INSERT INTO stream.chat_log
             (user_id, platform, username, message, stream_id, is_bot,
              clean_word_count, reply_to_username, reply_to_text, platform_msg_id)
           VALUES ($1,$9,$2,$3,$4,false,$5,$6,$7,$8)`,
          [nativeCanon, username || matrixId, message, sid || null, cwc,
           reply_to_username ?? null, reply_to_text ?? null, chatId != null ? String(chatId) : null, NATIVE_PLATFORM]
        );
      })().catch((err) => console.warn('[chat/native] corpus log failed:', err.message));
    }
  }));

  }

  return { registerChatRoutes };
}

module.exports = { createChat };
