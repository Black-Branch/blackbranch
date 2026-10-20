const express  = require('express');
const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const { Pool } = require('pg');
const { maskBlacklist, startOverrideRefresh } = require('./blacklist');

// ── Local env file ──────────────────────────────────────────────────────────
// Loads KEY=VALUE lines from a sibling `.env` (owned by the service user, 0600)
// into process.env without overriding values already set by systemd. Keeps the
// shared secret out of the root-owned systemd unit and out of git.
(function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const eq = s.indexOf('=');
      if (eq < 0) continue;
      const key = s.slice(0, eq).trim();
      let val = s.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
        val = val.slice(1, -1);
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch (e) { console.warn('[env] could not read .env:', e.message); }
})();

// Alert-system modules. Required AFTER loadDotEnv() because obs.js/tts.js read
// their config (OBS password, ElevenLabs key/voices) at module-load time.
const economics = require('./economics');
const obs = require('./obs');                       // OBS bridge — connects only when the `obs` module starts
const tts = require('./tts');                       // ElevenLabs dual-voice
const { createSupportBar } = require('./supportbar');
const { createSponsors } = require('./sponsors');    // Fund-the-Night credit pool + clock badges (leaf)
const { createMoney, makeRecordSupport, makeRecordUnpriced, makePersistEventCard, COIN_KINDS } = require('./money');
// Qorm spends are spectacle, not support: their
// historical support_events rows are excluded
// from EVERY fold of the table. One list, derived from the policy, handed down
// by this composition root so the leaves never learn the policy themselves.
const SPEND_EVENT_TYPES = [...COIN_KINDS];
const { createMoneyBus, subscribeSponsors } = require('./money-bus');
const { createAlert, cleanForTTS } = require('./alert');
const { createTimer } = require('./timer');
const { createPoll, registerPollRoutes } = require('./poll');
const { registerPaymentWebhooks, startStreamlabs } = require('./webhooks');
const { createModules } = require('./modules');
const { createSounds } = require('./sounds');          // coin-store sound alerts (gated)

// This install's owner plugin (plugins.js — the one seam to owner/): the parts that are the
// owner's own. Absent in the public export; a broken one fails here, at boot.
const owner = require('./plugins').loadOwnerPlugin();
console.log(`[plugins] owner plugin ${owner ? `loaded (${owner.id})` : 'not present'}`);
// Room lights (the owner's `lights` module): alert.js and timer.js flash them when present and
// started; null in the public build, which both already treat as "no lights".
const lights = owner?.lights ?? null;

// Internal-caller auth (auth.js): shared-secret OR internal-IP trust, fail-closed
// enforcement, and the enforce-without-secret startup fatal. createAuth
// exits the process itself when the config is the known-bad trap state.
const { createAuth } = require('./auth');
const { requireInternal, requireSecret, isInternalUpgrade, STREAM_API_SECRET } = createAuth();

// ── Database ──────────────────────────────────────────────────────────────
if (!process.env.DB_PASSWORD) { console.error('[FATAL] DB_PASSWORD not set'); process.exit(1); }

// Bounded connection + statement timeouts (db-pool.js says why each): a hung database must
// answer 503, never hold a request — or a money hold — open forever.
const { poolOptions, apiErrorHandler } = require('./db-pool');
const pool = new Pool(poolOptions(process.env));

pool.on('error', (err) => console.error('[DB] Unexpected pool error:', err.message));

// ── App ───────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
// Capture the raw body (for the Patreon webhook's HMAC). Harmless for the
// internal JSON routes.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
// Ko-fi is the ONLY form-encoded caller (a single `data` field), so the
// urlencoded parser is scoped to its webhook. A global parser would be a CSRF
// surface: a browser running ON an internal host is 127.0.0.1 to
// requireInternal, and a hostile page can fire form-encoded POSTs without a
// CORS preflight — with no global parser those bodies never parse. (app.use is invisible to routeSurface.js, so the frozen route table
// is unchanged; inline middleware on the route itself WOULD change it.)
app.use('/webhook/kofi', express.urlencoded({ extended: false }));

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── Aggregate refresh (aggregates.js) — single-flight + coalesced.
//    The interval drives the wrapper, never the raw rebuild.
const { createAggregates } = require('./aggregates');
// The owner plugin's step after each rebuild (its scoring labels); none without a plugin.
const { requestAggregateRefresh, start: startAggregates } = createAggregates({
  pool, excludeEventTypes: SPEND_EVENT_TYPES, afterAggregates: owner?.afterAggregates ?? null,
});
startAggregates();

// Mod-curated blocklist re-grades, refreshed in the BACKGROUND so
// classify() stays synchronous on the ingest hot path. Until the first load
// succeeds the shipped list is in force — the strict end, which is the correct
// way for a slur filter to fail. A /whitelist lands here within 60s; the web
// runtime applies its own copy immediately on write.
startOverrideRefresh({ pool });

// ── Identity (identity.js): canonical resolution, merge cascade, pronouns/tz.
//    resolveOrCreate sits upstream of the money ledger AND chat ingest — see
//    identity.js's module header before touching anything it wires.
const { createIdentity } = require('./identity');
const identity = createIdentity({ pool, requestAggregateRefresh });
const { resolveOrCreate, resolveCanonical, pronounsFor, personLocalTime } = identity;
// Pronouns (pronouns.js): the one parser + writer for every way they are set, and
// the per-person cache chat.js reads for each frame's ♂ ♀ ⚲.
const { createPronouns } = require('./pronouns');
const pronouns = createPronouns({ pool, resolveCanonical, resolveOrCreate });

// ── WebSocket hub (ws-hub.js): capped broadcast-only socket, msgBuffer +
//    history replay, redaction, heartbeat reaping.
const { createWsHub } = require('./ws-hub');
// `wss` is taken so shutdown() can terminate the long-lived clients — without
// that, server.close() never settles (see the shutdown block at the bottom).
const { wss, msgBuffer, broadcast, sendInternal, bufferPush, bufferReplace, redactBuffered, routeUpgrade } = createWsHub({
  server,
  isInternalUpgrade,
  // State frames pushed to every client on connect, after `history` — so an
  // overlay that (re)loads paints now, not on the next heartbeat (15s for the
  // timer, up to 60s for the credit line). Late-bound
  // on purpose: `timer` and `sponsors` are constructed below; a connection
  // before then hits the TDZ and ws-hub skips that frame (try/catch).
  connectFrames: [
    () => timer.snapshot(),
    () => sponsors.currentFrame(),
    // The streamer's highlighted message (chat-mod.js /chat/spotlight) — in memory, so a
    // reloaded OBS source or a late-opening tab must be told on connect.
    () => chatMod.spotlightFrame(),
  ],
});
// The rig page's socket (rig.js, part of the obs module): its own path on the same port. Its key is
// derived from this process's secret; it answers 404 until the obs module starts.
const { rig } = require('./rig');
const rigSink = require('./rig-sink');
rig.init({ secret: STREAM_API_SECRET });
routeUpgrade(rig.PATH, rig.handleUpgrade);

// ── Stream lifecycle (lifecycle.js): sessions, viewer snapshots, heartbeat
//    liveness (liveState), /stream/current, and the support-reminder bubble.
// The instance settings layer: owner of site.instance_* and the /config
// routes. Modules read it through its process singleton at call time, so wiring it here —
// after the pool and the socket exist — is early enough; until its first load lands they
// answer from env and defaults, exactly as process.env did.
const { instanceConfig } = require('./instance-config');
// The AI wrapper (ai.js): the slot registry, routing and usage. The owner plugin's radio
// DJ registered its slot when the plugin loaded (above), so it is listed from boot.
const { ai } = require('./ai');
instanceConfig.init({
  pool, sendInternal,
  notify: (...a) => require('./notify.js').notify(...a),
  onAiReport: (pkg, body) => ai.acceptReport(pkg, body),
  writeGuard: (key, value) => ai.writeGuard(key, value),
  localChecks: {
    obs: () => (obs.isConnected() ? { ok: true, code: 'connected' } : { ok: false, code: 'not_connected' }),
    ...(owner?.localChecks || {}),
  },
});
instanceConfig.registerConfigRoutes(app, { requireSecret, wrap });
ai.registerAiRoutes(app, { requireSecret, wrap });
// Instance content (content.js): prompt overrides, the bot's behavior file, the help desk's
// reference text. stream-api is its one writer; the other processes read it over /content.
const { createContent } = require('./content');
const { parseBotBehavior } = require('./instanceSchema.generated.js');
const content = createContent({
  pool, sendInternal,
  slotKnown: async (id) => (await ai.slotInfo(id))?.kind === 'chat' || ai.promptKnown(id),
  validators: { 'bot.behavior': (body) => { const r = parseBotBehavior(body); return r.ok ? null : r.error; } },
});
content.registerContentRoutes(app, { requireSecret, wrap });
content.load().catch((e) => console.warn(`[content] first load failed: ${e.message} — read again on the first request`));
// `memory` is built further down; the stats hook is late-bound and runs only on a /ai/routes read.
instanceConfig.ready.then(() => ai.start({ pool, memoryStats: () => memory.stats() })).catch((e) => console.warn(`[ai] start failed: ${e.message}`));

const { createLifecycle } = require('./lifecycle');
const lifecycle = createLifecycle({
  pool, broadcast,
  // A stream starting re-keys the credit pool's weight split (last stream's
  // cohort → 0.25×); without this a night opened BEFORE going live keeps last
  // stream's funders at full weight all evening.
  // Same guard as money.js's rebuildSponsorPool; `sponsors` is built below.
  onStreamStart: () => Promise.resolve(sponsors.reset())
    .catch((e) => console.warn('[sponsors] reset on stream start:', e.message)),
  // The owner plugin's stream-end hook (e.g. a bot forced 'on' goes back to following the
  // stream); no plugin = nothing to do.
  onStreamEnd: () => owner?.onStreamEnd?.(),
});
const { liveState } = lifecycle;
lifecycle.registerLifecycleRoutes(app, { requireInternal, wrap });

// ── Money plumbing (money.js): the ledger writer + card persistence, created
//    ahead of the alert stack that takes them as deps (logSupport/persistCard).
// `onReversed`: a late credit that took back a refund held for it (money.js, v156) rebuilds the
// sponsor pool from the ledger — same guard as money.js's rebuildSponsorPool; `sponsors` is built below.
const recordSupport = makeRecordSupport({ pool, resolveOrCreate, liveState, onReversed: () => sponsors.reset() });
const recordUnpriced = makeRecordUnpriced({ pool, liveState }); // R2-1: payments the ledger cannot price
const persistEventCard = makePersistEventCard(pool);

// TTS auto-fire on alerts stays OFF until the qpwgraph routing + an audible test
// are confirmed (avoids blasting audio). Flip ALERT_TTS_ENABLED=1 in .env then.
const ALERT_TTS_ENABLED = process.env.ALERT_TTS_ENABLED === '1';

// Stream timer — server-authoritative + persistent (stream.timer_state). Created
// before the support bar so take-home $ can credit time via earnTime→addMoney.
// `getBarTotal` closes over `supportBar`, which is declared BELOW. That is
// deliberate and safe: the arrow only runs when a timerState frame is built,
// long after both exist. Do NOT "fix" it into a direct reference — supportBar
// already depends on timer through earnTime, so that would be a real cycle.
const timer = createTimer({
  broadcast, obs, pool, lights,
  getBarTotal: () => supportBar.getTotal(),
});
// Held, not just fired: sponsors.init() below chains off it (see there).
const timerReady = timer.init().catch((e) => console.warn('[timer] init:', e.message));
timer.wireScenePause(); // auto pause on the pause scene (timer.pauseScene), play otherwise
timer.startHeartbeat();  // periodic resync of (re)connecting overlays + DB freshness
timer.startLowLights();  // red room flashes inside the low window, lights OUT at zero (no-op while lights are off)

// ── Night liveness (night-liveness.js): a sustained outage during an active
// night must FREEZE it — timer.pauseRetroactive() — rather than let the
// running clock keep spending funded time nobody actually streamed.
// `getLive` rides the SAME heartbeat liveness `/stream/current` already
// computes (lifecycle.liveState()); when it says not-live, the fallback query
// below finds the most honest retroactive anchor: the last provable proof of
// life for the most recent session — the latest viewer-snapshot heartbeat, or
// (only when NO snapshot exists at all) the session's ended_at, or null for a
// cold start with no session at all.
const { createNightLiveness } = require('./night-liveness');
const nightLiveness = createNightLiveness({
  timer,
  getLive: async () => {
    const state = await liveState();
    if (state.live) return { live: true, lastLiveMs: null };
    // PLAIN COALESCE, not GREATEST. `ended_at` is written by
    // lifecycle.liveState()'s own self-heal at DETECTION time — up to 10
    // minutes after the true drop (a 10-min heartbeat-staleness window past a
    // 10-min start grace) — while the latest viewer_snapshots row is a
    // precise, minute-granularity proof of life. GREATEST(snapshot, ended_at)
    // would prefer the LATER but LESS accurate ended_at whenever it has
    // already been stamped, under-refunding the outage by exactly the
    // detection delay — the harm this whole task exists to prevent.
    // COALESCE only reaches for ended_at when no snapshot exists at all (a
    // session with no viewer poll yet). This module's own poll/debounce
    // cadence (30s / 120s, well under the 10-min self-heal) means the fallback
    // query normally runs before ended_at is even set — but if intervalMs or
    // debounceMs are ever tuned close to or past 10 minutes, ended_at could be
    // stamped before this query runs; COALESCE still prefers the snapshot in
    // that case (it only falls through when the snapshot is genuinely absent).
    const r = await pool.query(
      `SELECT COALESCE(
                (SELECT MAX(recorded_at) FROM stream.viewer_snapshots
                  WHERE stream_id = s.stream_id),
                s.ended_at
              ) AS last_live
         FROM stream.sessions s ORDER BY s.started_at DESC LIMIT 1`
    );
    const lastLive = r.rows[0]?.last_live;
    return { live: false, lastLiveMs: lastLive ? new Date(lastLive).getTime() : null };
  },
});
nightLiveness.start();

// Fund-the-Night: sponsor credit pool + clock badges (sponsors.js). Depends
// only on `timer` (already constructed above) + its own DB reads; it hears
// about money through the money bus below.
const sponsors = createSponsors({
  pool, broadcast, timer, excludeEventTypes: SPEND_EVENT_TYPES,
  getStreamId: async () => (await liveState()).streamId || null,
});
// CHAINED off timer.init(), not fired alongside it. The replay reads the
// night through `timer.snapshot()` (the no-night branch quotes the legacy
// usdPerHour) and through `stream.timer_state` — and until timer.init()
// resolves, the timer is still holding its coded DEFAULTS, so a race here
// prices an active night's whole cohort against a night that isn't loaded yet.
timerReady
  .then(() => sponsors.init())
  .catch((e) => console.warn('[sponsors] init:', e.message));
sponsors.startHeartbeat();

// The money bus (money-bus.js): the bar banks, broadcasts and credits time, THEN publishes to
// whoever listens — the sponsor pool here, the meter when its module starts. Each listener is
// guarded on its own, so one consumer's failure cannot cost another's.
const moneyBus = createMoneyBus();
const supportBar = createSupportBar({
  pool, broadcast, excludeEventTypes: SPEND_EVENT_TYPES,
  getStreamId: async () => (await liveState()).streamId || null,
  earnTime: (takeHome) => timer.addMoney(takeHome), // $ → countdown seconds (capped)
  notionalFor: (usd) => timer.convertNotional(usd),  // $ → NOTIONAL seconds (uncapped curve value)
  onAdd: moneyBus.publish,
});
supportBar.init().catch((e) => console.warn('[supportbar] init:', e.message));
subscribeSponsors(moneyBus, sponsors);

const alert = createAlert({
  broadcast, bufferPush, supportBar, obs, lights,
  tts: ALERT_TTS_ENABLED ? tts : null,
  logSupport: recordSupport,
  logUnpriced: recordUnpriced,
  persistCard: persistEventCard,
  maskBlacklist, // external-platform alerts were reaching TTS/OBS/chat unmasked
  // "+0" on a locked marathon needs explaining — but a GOLD night is also
  // `locked` (timer.js atCeiling()) and is not an ending, so
  // marathonEnded must read false while a night is active, whatever the
  // legacy `locked` bit says.
  timerLocked: () => { const s = timer.snapshot(); return s.locked && !s.night.active; },
});

// Coin-store sound alerts (SOUNDS_ENABLED-gated; empty manifest = disabled).
const sounds = createSounds();

// Cross-platform polls (poll.js): web card taps + platform
// number-votes tally into one poll; card + updates ride the public WS.
const pollEngine = createPoll({ broadcast, bufferPush, pool, persistCard: persistEventCard });
pollEngine.init().catch((e) => console.warn('[poll] init:', e.message));

// ── Money routes (money.js): /support, /alert, /speak, /support-bar/reset,
//    /timer/*, /chat/event (KIND_POLICY accounting), /tts/status,
//    /sounds/manifest, /overlay/sticker. See money.js's header — the
//    accounting model is the most consequential invariant in the repo.
const money = createMoney({
  pool, economics, alert, supportBar, timer, tts, sounds, cleanForTTS,
  // /timer/night's price floor: the owner's meter when it is on, else null — the route reads null as 0.
  meter: { requiredCentsPerDay: () => owner?.requiredCentsPerDay?.() ?? null },
  persistEventCard, maskBlacklist,
  broadcast, bufferPush, bufferReplace, ALERT_TTS_ENABLED,
  // /timer/night's `start` and /support-bar/reset rebuild the credit pool —
  // it is night-scoped state, not stream-lifetime state (sponsors.reset).
  sponsors,
  // POST /support/reconcile credits an unpriced payment through the same ledger writer, and moves
  // the live bar when the payment's stream is the one live now.
  recordSupport,
  getStreamId: async () => (await liveState()).streamId || null,
});
money.registerMoneyRoutes(app, { requireInternal, requireSecret, wrap });

// ── Chat ingest + native chat (chat.js): /chat, /chat/native (shared
//    send-to-all dedup state), scoring patches. The hot path.
const { createChat } = require('./chat');
createChat({ pool, resolveOrCreate, resolveCanonical, pronouns, pollEngine,
             msgBuffer, broadcast, bufferPush,
             getStreamId: async () => (await liveState()).streamId || null })
  .registerChatRoutes(app, { requireInternal, wrap });

// Automod (automod.js, product): hold + flag + suspicious marks; off until switched on.
const { createAutomod } = require('./automod');
const automod = createAutomod({ pool, ai, notify: (...a) => require('./notify.js').notify(...a) });
automod.registerAutomodRoutes(app, { requireInternal, wrap });
automod.start({ content });

// The chat bot's output check (chat-screen.js): the word filter + link gate a person's message
// meets, asked before every bot reply.
require('./chat-screen').registerChatScreen(app, { requireInternal, wrap });

// Payment-platform receivers → /alert: Ko-fi + Patreon public webhooks, Streamlabs
// outbound socket. (Public routes auth via each platform's own token/signature.)
registerPaymentWebhooks({ app, wrap, alert });
// startStreamlabs returns a { stop } handle. Closing it on SIGTERM stops a donation arriving mid-drain, after the pool is gone.
const streamlabs = startStreamlabs({ alert, ready: instanceConfig.ready }); // connects after the settings layer's first load

// ── Profile reads (profiles.js): /user/:id/stats, /user/lookup, /user/:id/context.
const { registerProfileRoutes } = require('./profiles');
registerProfileRoutes(app, { pool, requireInternal, wrap, profileExtras: owner?.profileExtras ?? null });

// ── Chat moderation fan-out (chat-mod.js): vote/pin/delete/platform-delete/
//    purge/settings/badges-changed/spotlight. The return carries the spotlight
//    connect frame ws-hub replays (see connectFrames above).
const { registerChatMod } = require('./chat-mod');
const chatMod = registerChatMod(app, { pool, msgBuffer, broadcast, redactBuffered, requireInternal, wrap });

// Poll HTTP surface (poll.js): /poll/current|start|vote|end|creator + /overlay/poll.
registerPollRoutes(app, { pollEngine, pool, resolveCanonical, requireInternal, wrap });

// ── Operator-notification relay (notify.js): POST /ops/notify.
//    This process holds the notifier, so it is the one that can reach a human.
//    stream-ingest escalates through here rather than carrying a second
//    credential and a second, unbatchable rate limiter.
require('./notify.js').registerNotifyRoutes(app, { requireInternal, wrap });

// ── The owner plugin's bot config surface (botRoutes.config): output mode + scene
//    auto-switch, runtime active gate, tool toggles, exemplars, Dials tuning, emote legend,
//    prompt overrides, and the size-capped behavior-file editor (M33/M68). Mounted HERE, where
//    it always sat — route order is part of the surface contract. No plugin = not mounted.
owner?.botRoutes?.config?.(app, { obs, broadcast, requireInternal, wrap });

// ── Help-desk relay (helpdesk-relay.js): the site support panel's
//    free-text turns — web ask (held) → brain long-poll → brain reply.
//    Private by construction; never touches the WS broadcast.
// The relay is captured because the drain MUST
// release its parked long-poll — see the shutdown block.
const { createSupportRelay, registerHelpdeskRoutes } = require('./helpdesk-relay');
const supportRelay = createSupportRelay();
registerHelpdeskRoutes(app, { requireInternal, wrap, relay: supportRelay });

// ── Memory (memory.js, product): the opt-out, the embedding writer's check, forget.
//    Created before the owner plugin's bot data surface, which registers its forget handler on it.
const { createMemory } = require('./memory');
const memory = createMemory({ pool, ai, notify: (...a) => require('./notify.js').notify(...a) });
instanceConfig.onWrite((keys) => memory.onSettingsWritten(keys));
memory.registerMemoryRoutes(app, { requireInternal, requireSecret, wrap });
// The dimension check runs on a LOADED settings layer (memory.state lives there); until the
// layer loads, it retries with it.
instanceConfig.ready.then(function memoryBoot() {
  if (!instanceConfig.snapshot().state.loaded) { setTimeout(memoryBoot, 30_000).unref?.(); return; }
  memory.boot().catch((e) => console.error(`[memory] boot check failed: ${e.message}`));
});
memory.startRetention();

// The stream-side half of self-serve "Delete my account" (account-erase.js): AI memory, linked
// platform lines, support-event names, the site link. web runs the site half.
require('./account-erase').createAccountErase({ pool, memory, identity, sponsors, msgBuffer, broadcast, redactBuffered }).registerAccountEraseRoutes(app, { requireSecret, wrap });

// ── The owner plugin's bot data surface (botRoutes.data): stream-state, retrieval
//    + search/lookup/top tools, impressions, narrative memory, response log, brain trace
//    (+ its 14-day retention sweep), social credit, and the bot's forget handler on memory.
owner?.botRoutes?.data?.(app, { pool, liveState, resolveCanonical, pronounsFor, personLocalTime, memory, requireInternal, wrap });

// Identity routes (identity.js): /identity/pronouns|timezone|merge|check|backfill
identity.registerIdentityRoutes(app, { requireInternal, wrap });
pronouns.registerPronounRoutes(app, { requireInternal, wrap });

// Sponsor clock (sponsors.js): GET /sponsors/clock — is this viewer's clock lit?
// Web's earn path reads it for the 2x participation bonus.
sponsors.registerSponsorRoutes(app, { requireInternal, wrap });

// ── Modules (modules.js, config/modules.mjs): each starts on the settings layer's first load,
//    only if its switch is on. Their routes go on this router, mounted HERE so they sit before
//    the error handler below. Off = not started, routes not mounted (404).
const modules = createModules({
  instanceConfig,
  starters: {
    // The rig page (rig.js) is part of the obs module: its socket and routes exist only while it is on.
    obs: ({ router }) => {
      obs.start();
      rig.registerRigRoutes(router, {
        requireSecret, wrap,
        speakTest: (clip) => tts.speakTest(clip),
        soundTest: (clip) => rigSink.playClip(clip, { kind: 'sound' }),
        which: rigSink.which,
      });
    },
  },
  // The owner plugin's modules (lights, meter, radio); absent in the public build = not installed.
  ownerStarters: owner?.moduleStarters?.({ pool, broadcast, supportBar, timer, liveState, moneyBus, requireInternal, wrap }) ?? {},
});
app.use(modules.router);

// ── Error handler ─────────────────────────────────────────────────────────
app.use(apiErrorHandler); // db-pool.js: a timed-out database answers 503, anything else a generic 500

// ── Start ─────────────────────────────────────────────────────────────────
const listenAt = require('./listen-address').listenAddress();
if (listenAt.error) { console.error(`[FATAL] ${listenAt.error}`); process.exit(1); }
server.listen(listenAt.port, listenAt.host, () => {
  console.log(`[API] Stream API listening on ${listenAt.host}:${listenAt.port} (HTTP + WS)`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────
//
// systemd sends SIGTERM on `systemctl restart stream-api`. With no handler Node
// dies on the spot and drops every in-flight request — including identity.js's
// merge cascade, the ONLY pool.connect() transaction in the service, and the
// /support ledger writes. Postgres rolls the transaction back, so the damage is
// not corruption: it is that the caller cannot distinguish "not applied" from
// "applied, reply lost", and a merge that silently didn't happen looks like a
// bug in identity resolution days later.
//
// Sequence: stop accepting → let in-flight HTTP finish → drain the pool → exit.
// Bounded at every step, because a restart that HANGS is worse than one that
// truncates: systemd would sit in `deactivating` until its own timeout while
// the site has no API.
//
// This deliberately does NOT chase every timer and socket to a clean close.
// The process ends on an explicit process.exit(), which makes that unnecessary,
// and obs.js would actively fight it — its 'ConnectionClosed' handler calls
// scheduleReconnect(), so disconnecting OBS during a drain ARMS a fresh timer.
// Of the intervals still running here, every one that touches the pool has its
// own catch handler, so one firing against a closing pool costs a warning line
// rather than an unhandled rejection: lifecycle, radio ×2, aggregates (hold the loop open) + the owner bot data surface, timer ×2,
// blacklist (already unref'd) + ws-hub (cleared by its own 'close' handler).

const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS || 10_000);
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return; // a second SIGTERM must not re-enter and race the exit
  shuttingDown = true;
  console.log(`[API] ${signal} received — draining`);

  // Backstop. unref'd so the timer itself can never be the thing holding us open.
  const forced = setTimeout(() => {
    // Report WHAT is still holding us, or the next person sees only "timed out" and
    // has to rediscover that a parked long-poll was the cause. getConnections is
    // async, so exit from its callback with a hard fallback if even that stalls.
    setTimeout(() => process.exit(1), 500).unref?.();
    server.getConnections((err, count) => {
      console.error(`[API] drain exceeded ${SHUTDOWN_GRACE_MS}ms — forcing exit ` +
        `(${err ? 'connection count unavailable' : `${count} connection(s) still open`}, ` +
        `ws=${wss.clients.size}, relay=${JSON.stringify(supportRelay.stats())})`);
      process.exit(1);
    });
  }, SHUTDOWN_GRACE_MS);
  if (forced.unref) forced.unref();

  try {
    // Stop accepting new connections, so nothing new enters while we drain.
    const closed = new Promise((resolve) => server.close(resolve));

    // Two classes of connection would otherwise keep server.close() pending
    // forever, since it waits for every open socket:
    //   • WS clients (site viewers, OBS overlays) are long-lived BY DESIGN and
    //     would never leave on their own. They all auto-reconnect, so
    //     terminating is correct. wss.close() also clears ws-hub's heartbeat
    //     interval through its own 'close' handler.
    //   • idle HTTP keep-alive sockets — the web app holds these open
    //     between internal calls. closeIdleConnections() drops exactly those and
    //     leaves sockets with a request in flight alone, which is the whole point.
    //   • the help desk's parked long-poll on /bot/support/next, held up to
    //     25s — LONGER than this grace, and an ACTIVE request, so
    //     closeIdleConnections() will not touch it; without supportRelay.release()
    //     every restart runs the full grace and exits 1 (status=1/FAILURE).
    // A client that already vanished throws; that is the outcome we wanted anyway.
    //
    // Deliberately no inline block comment here, and none anywhere below. The
    // money-route list above documents a path as `/timer/` + a star, which a
    // block-comment stripper reads as an OPENER — so the first block-comment
    // TERMINATOR appearing later in this file makes every source-scan guard that
    // reads index.js silently drop the ~60 lines in between. shutdown.test.js
    // explains the full trap; keep block comments out of index.js entirely.
    //
    // ORDER: release held sockets BEFORE sweeping idle ones. Releasing a parked
    // poll COMPLETES its response, which makes that socket newly IDLE — and if the
    // sweep has already run, nothing closes it and server.close() waits on it.
    // Sweeping first, the drain still runs the full grace and exits 1.
    // release() also latches the relay so the brain cannot re-park a
    // fresh 25s poll in the middle of the drain.
    supportRelay.release();
    streamlabs.stop();       // no donation may land after the pool is gone
    for (const ws of wss.clients) { try { ws.terminate(); } catch { void 0; } }
    wss.close();
    rig.stop();              // the rig pages' sockets are long-lived too; they reconnect by themselves
    server.closeIdleConnections();

    await closed;

    // No new queries can arrive now. end() waits for checked-out clients, which
    // is what lets an in-flight merge transaction reach its COMMIT.
    await pool.end();
    console.log('[API] drained cleanly');
    process.exit(0);
  } catch (e) {
    console.error('[API] shutdown error:', e.message);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A rejected promise nobody awaited must never take the money service down: log
// it loudly and keep serving. Matches stream-ingest/index.js. Deliberately no
// 'uncaughtException' companion — that one means state is already unknown, and
// continuing to write to the ledger from there is worse than dying.
process.on('unhandledRejection', (err) => {
  console.error('[API] unhandledRejection:', (err && (err.stack || err.message)) || err);
});
