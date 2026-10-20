// Unified alert dispatch for stream-api. One normalized alert fans out to:
//   • showAlert WS        → OBS alert overlay
//   • system chat card    → website chat (external platforms; native Stripe makes its own)
//   • obs.playSound()     → alert sound
//   • tts.speak(message)  → reads the message aloud + raises the bot's avatar
//   • supportBar.add()    → support bar + DB support_events log
//
// Pure builders (cleanForTTS / buildShowAlert / buildSystemCard) are exported for
// tests; createAlert wires the side-effects via injected deps so index.js owns the
// transport (broadcast/buffer), DB (logSupport) and the obs/tts/supportBar modules.

'use strict';

const { twitchProfileImage } = require('./twitch-app.js');
const economics = require('./economics');
const { notify } = require('./notify.js');
const ttsTiers = require('./tts-tiers');
const { NATIVE_PLATFORM } = require('./native-platform');

// cleanForTTS lives with the engine it protects (tts.js), so every caller of tts.speak is
// covered — not only the alert paths. Re-exported here for the callers that build spoken text.
const { cleanForTTS } = require('./tts');

// The celebration is HELD until the ledger answers "this event is new". A rejected write is
// retried on this schedule (the last delay repeats until the write lands); a ledger that has not
// answered after LEDGER_SLOW_MS is logged loudly, and the celebration still waits.
const LEDGER_RETRY_MS = [1000, 2000, 5000, 10000, 30000];
const LEDGER_SLOW_MS = 5000;
// A transient failure is retried at most this many times in all (≈ 2 min on the schedule
// above); a permanent one is not retried at all. Either way the event is then recorded for
// reconciliation and the caller is answered with an error — see LedgerWriteError.
const LEDGER_MAX_ATTEMPTS = 8;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// SQLSTATE classes worth retrying: connection (08), insufficient resources (53), operator
// intervention / shutdown (57P, 57014 statement timeout), system (58), serialization failure and
// deadlock (40001, 40P01), lock not available (55P03). Anything else carrying a SQLSTATE — data
// exceptions (22: bad byte sequence, value too long), constraint violations (23), a bad statement
// (42) — fails the same way every time, so retrying it would only hold the handler forever.
// An error with no SQLSTATE (a refused connection, a pool timeout) is treated as transient.
const TRANSIENT_SQLSTATE = /^(08|53|57P|57014|58|40001|40P01|55P03)/;
function isTransientDbError(e) {
  const code = e && e.code;
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return TRANSIENT_SQLSTATE.test(code);
  return true;
}

/** Thrown by fireStreamEffects (and so dispatch) when the ledger could not record an event: no
 *  effect fired, the event is kept for reconciliation when that was possible, and every caller's
 *  error path answers non-2xx / forgets its replay key so a provider that retries brings it back. */
class LedgerWriteError extends Error {
  constructor(message, { permanent, recorded }) {
    super(message);
    this.code = 'LEDGER_WRITE_FAILED';
    this.permanent = permanent;
    this.recorded = recorded;
  }
}

// Donor-supplied text, before it reaches any INSERT: control characters (NUL above all, which
// Postgres refuses in text) become spaces, and the length is clamped. A bad name is then a
// cosmetic problem, never a ledger write that fails the same way on every retry.
function cleanText(v, max) {
  let out = '';
  for (const ch of String(v ?? '')) {
    const c = ch.codePointAt(0);
    out += (c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127 ? ' ' : ch;
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

/** The ledger's event_id for a producer's raw id: platform-prefixed, because the same raw id on
 *  two platforms must stay two events. The reversal route finds an original row by this key. */
function ledgerEventId(platform, rawId) {
  return `alert:${String(platform).toLowerCase()}:${String(rawId).trim()}`;
}

// The showAlert payload shape alert-overlay.html consumes.
function buildShowAlert(p) {
  return {
    type: 'showAlert',
    platform: p.platform || 'unknown',
    eventType: p.eventType || '',
    username: p.username || 'Anonymous',
    userImage: p.userImage || '',
    amount: p.amount || '',
    message: p.message || '',
    recipient: p.recipient || '',
    label: p.label || '',
    tier: p.tier || '',
    months: p.months != null && p.months !== '' ? String(p.months) : '',
  };
}

// Ephemeral system chat card for external-platform alerts (never persisted).
let sysSeq = 0;
function buildSystemCard(p) {
  return {
    type: 'message', platform: 'system', id: `a${Date.now()}-${sysSeq++}`,
    system: 'alert', ts: Date.now(),
    username: p.username || 'Anonymous',
    usernameColor: p.usernameColor || null,
    alertPlatform: p.platform || 'unknown',
    eventType: p.eventType || '',
    label: p.label || '',
    message: p.message || '',
    recipient: p.recipient || '',
    addedSeconds: p.addedSeconds || 0,   // time this contribution added to the timer
    marathonEnded: !!p.marathonEnded,    // true = 0 seconds BECAUSE the timer is locked
    // Display amount (same string the OBS alert overlay shows), DONATIONS ONLY:
    // for sub-family events `amount` is the internal per-sub revenue estimate,
    // which must not ride a public chat card. Named amountText,
    // not amount — on ChatMsg `amount` is the native donation card's CENTS
    // number, and one field with two units is how money bugs start.
    amountText: p.eventType === 'donation' ? (p.amount || '') : '',
  };
}

// Ephemeral celebratory card for NATIVE Stripe events posted via /chat/event
// (gift / donation / sub). Distinct from buildSystemCard, which is the
// external-platform alert card. Pure: the route supplies `base` (id/ts/system)
// and a blacklist-mask fn; returns null for a gift with no recipients (the route
// then skips). Exported for unit tests.
function buildEventCard(kind, body, base, maskFn = (s) => s) {
  if (kind === 'gift') {
    const { gifter, gifterColor, gifterMatrixId, anonymous, giftKind, months, recipients, usernameStyle } = body;
    const list = (Array.isArray(recipients) ? recipients : []).slice(0, 50).map((r) => ({
      name: String(r?.name ?? '').slice(0, 80),
      matrixId: r?.matrixId ? String(r.matrixId) : null,
    }));
    if (list.length === 0) return null;
    const name = anonymous ? 'Anonymous' : (gifter || 'Someone');
    return {
      ...base,
      username:       name,            // so renderers that assume a sender don't choke
      gifter:         name,
      gifterColor:    anonymous ? null : (gifterColor || null),
      gifterMatrixId: anonymous ? null : (gifterMatrixId || null),
      // Generic identity fields — renders this card through the SAME chat row
      // as any other message (badges/username style), mirroring the `sticker`
      // card below.
      matrixId:       anonymous ? null : (gifterMatrixId || null),
      usernameColor:  anonymous ? null : (gifterColor || null),
      usernameStyle:  anonymous ? null : (usernameStyle || null),
      anonymous:      !!anonymous,
      giftKind:       giftKind === 'community' ? 'community' : 'direct',
      count:          list.length,
      months:         Math.max(1, parseInt(months, 10) || 1),
      recipients:     list,
      message:        '',
    };
  }
  if (kind === 'cheer' || kind === 'highlight') {
    // Coin-spend highlighted message. `coins` is the spend amount (1 coin = 1¢);
    // the card carries no dollar take-home field. The accounting (enforced by
    // money.js KIND_POLICY): Qorm is channel points — a purchase is a private
    // wallet top-up and a spend is spectacle only, moving nothing (no bar, no
    // timer, no support_events row). A lit sponsor clock pays a 2x
    // participation-earning bonus, which is why a spend must never light one.
    //
    // Two kinds, one shape: `highlight` is the live product (money.js's
    // `highlight` sink); `cheer` is its retired predecessor, kept because
    // historical cards and any spend still in flight replay through here.
    const { username, cheererMatrixId, usernameColor, usernameStyle, coins, message } = body;
    const n = Math.max(0, parseInt(coins, 10) || 0);
    if (n <= 0) return null;
    return {
      ...base,
      username:         String(username || 'Someone').slice(0, 80),
      cheererMatrixId:  cheererMatrixId || null,
      matrixId:         cheererMatrixId || null,
      usernameColor:    usernameColor || null,
      usernameStyle:    usernameStyle || null,
      coins:            n,
      message:          message ? maskFn(String(message)).slice(0, 500) : '',
    };
  }
  if (kind === 'sticker') {
    // Coin-spend large emote: shown big in chat + on the /overlay/
    // sticker OBS source. emoteUrl is resolved SERVER-side by the web route from
    // the emote manifest — never trusted from the client.
    const { username, senderMatrixId, usernameColor, usernameStyle, emoteName, emoteUrl, coins } = body;
    if (!emoteUrl || !/^https:\/\//i.test(String(emoteUrl))) return null;
    return {
      ...base,
      username:       String(username || 'Someone').slice(0, 80),
      senderMatrixId: senderMatrixId || null,
      // Stickers render as a NORMAL chat line — matrixId makes the row carry
      // the sender's badges/avatar/user-card exactly like any other message.
      matrixId:       senderMatrixId || null,
      usernameColor:  usernameColor || null,
      usernameStyle:  usernameStyle || null,
      emoteName:      String(emoteName || '').slice(0, 100),
      emoteUrl:       String(emoteUrl).slice(0, 300),
      coins:          Math.max(0, parseInt(coins, 10) || 0),
      message:        '',
    };
  }
  if (kind === 'sticker_boost') {
    // Coin-spend escalation of an EXISTING sticker: the SAME
    // chat_messages row is updated in place (boostCoins bumped, created_at
    // bumped so it re-sorts to the bottom) and moved for connected clients via
    // a `stickerMove` broadcast — never a second row (no duplicate sticker).
    // See money.js's `sticker_boost` branch for the UPDATE + move broadcast;
    // this only builds the card shape used for the overlay retrigger + bar
    // credit effects (the caller reads emoteUrl/emoteName/coins/boostCoins off
    // what's returned here).
    const { username, senderMatrixId, usernameColor, usernameStyle, emoteName, emoteUrl, coins, boostCoins } = body;
    if (!emoteUrl || !/^https:\/\//i.test(String(emoteUrl))) return null;
    return {
      ...base,
      system:         'sticker',
      username:       String(username || 'Someone').slice(0, 80),
      senderMatrixId: senderMatrixId || null,
      matrixId:       senderMatrixId || null,
      usernameColor:  usernameColor || null,
      usernameStyle:  usernameStyle || null,
      emoteName:      String(emoteName || '').slice(0, 100),
      emoteUrl:       String(emoteUrl).slice(0, 300),
      coins:          Math.max(0, parseInt(coins, 10) || 0),
      boostCoins:     Math.max(0, parseInt(boostCoins, 10) || 0),
      message:        '',
    };
  }
  if (kind === 'tts_msg') {
    // Coin-paid TTS message. The card's masked text is ALSO what gets spoken
    // (route-side) — a blacklisted word is never voiced.
    const { username, senderMatrixId, usernameColor, usernameStyle, coins, message } = body;
    const text = message ? maskFn(String(message)).slice(0, 200) : '';
    if (!text) return null;
    return {
      ...base,
      username:       String(username || 'Someone').slice(0, 80),
      senderMatrixId: senderMatrixId || null,
      matrixId:       senderMatrixId || null,
      usernameColor:  usernameColor || null,
      usernameStyle:  usernameStyle || null,
      coins:          Math.max(0, parseInt(coins, 10) || 0),
      message:        text,
    };
  }
  if (kind === 'sound') {
    const { username, senderMatrixId, usernameColor, usernameStyle, coins, soundId, label } = body;
    return {
      ...base,
      username:       String(username || 'Someone').slice(0, 80),
      senderMatrixId: senderMatrixId || null,
      matrixId:       senderMatrixId || null,
      usernameColor:  usernameColor || null,
      usernameStyle:  usernameStyle || null,
      coins:          Math.max(0, parseInt(coins, 10) || 0),
      soundId:        String(soundId || '').slice(0, 60),
      label:          String(label || '').slice(0, 80),
      message:        '',
    };
  }
  if (kind === 'sub') {
    const { subscriber, subscriberMatrixId, usernameColor, usernameStyle, tier, months, amount, currency, message } = body;
    const name = subscriber || 'Someone';
    return {
      ...base,
      username:           name,
      subscriberMatrixId: subscriberMatrixId || null,
      matrixId:            subscriberMatrixId || null,
      usernameColor:      usernameColor || null,
      usernameStyle:      usernameStyle || null,
      tier:               tier ? String(tier).slice(0, 40) : 'Supporter',
      months:             Math.max(1, parseInt(months, 10) || 1),
      amount:             Math.max(0, parseInt(amount, 10) || 0), // cents
      currency:           String(currency || 'usd').toLowerCase().slice(0, 8),
      message:            message ? maskFn(String(message)).slice(0, 500) : '',
    };
  }
  // donation
  const { donor, donorMatrixId, anonymous, amount, currency, message, usernameColor, usernameStyle } = body;
  const name = anonymous ? 'Anonymous' : (donor || 'Anonymous');
  return {
    ...base,
    username:      name,
    donorMatrixId: anonymous ? null : (donorMatrixId || null),
    matrixId:      anonymous ? null : (donorMatrixId || null),
    anonymous:     !!anonymous,
    amount:        Math.max(0, parseInt(amount, 10) || 0), // cents
    currency:      String(currency || 'usd').toLowerCase().slice(0, 8),
    usernameColor: anonymous ? null : (usernameColor || null),
    usernameStyle: anonymous ? null : (usernameStyle || null),
    message:       message ? maskFn(String(message)).slice(0, 500) : '',
  };
}

function createAlert({ broadcast, bufferPush, supportBar, obs, tts, lights, logSupport, logUnpriced, persistCard, maskBlacklist, timerLocked,
  ledgerRetryMs = LEDGER_RETRY_MS, ledgerSlowMs = LEDGER_SLOW_MS, ledgerMaxAttempts = LEDGER_MAX_ATTEMPTS, sleep = sleepMs }) {
  // Anything arriving through an external payment platform — Ko-fi, Patreon,
  // Streamlabs, YouTube superchats — reaches the TTS voice, the OBS alert and
  // the persisted chat card, so a slur in a donation message or display name
  // must be masked here or it is spoken on stream.
  //
  // Masking centrally in fireStreamEffects covers every dispatch() caller at
  // once, so a new external integration cannot forget it. Idempotent: native
  // Stripe events are already masked by buildEventCard, and masking twice is a
  // no-op.
  const mask = typeof maskBlacklist === 'function' ? maskBlacklist : (s) => s;
  // Stream-side effects shared by external alerts AND native Stripe (everything
  // EXCEPT the chat card — native Stripe builds its own gift/donation card).
  async function fireStreamEffects(input) {
    // Mask BEFORE anything reads the text: the TTS voice, the OBS alert frame,
    // the WS broadcast and the persisted card all derive from these. Donor-supplied
    // display names are masked too — a slur in the name is as public as one in the
    // message, and it is the field most likely to be overlooked.
    input = { ...input, message: mask(cleanText(input.message, 2000)), username: mask(cleanText(input.username, 100)) };
    if (input.eventId != null) input.eventId = cleanText(input.eventId, 200);
    const platform = cleanText(input.platform || 'unknown', 40).toLowerCase();
    const eventType = String(input.eventType || '');
    const username = input.username || 'Anonymous';
    // ── the money guard ───────────────────────────────────────────────────────
    // Every producer funnels through here — the four stream-ingest normalizers via
    // POST /alert, and Ko-fi/Patreon/Streamlabs by calling dispatch() in-process —
    // so this is the ONE place a take-home guard covers all of them.
    //
    // Two things are being defended against, neither of them hypothetical:
    //
    //   • A NEGATIVE take-home. Only streamlabsTakeHome() has a Math.max(0, …)
    //     floor; bits, YouTube super, Ko-fi, Patreon and Kick kicks all propagate a
    //     negative input straight through (bits=-100000 measured at -1000). The
    //     ledger write and bar credit are already gated on `takeHome > 0`, so money
    //     was never corrupted — but the value still rode the `alert` WS frame as
    //     takeHomeUSD, and a negative there is nonsense to every consumer.
    //   • A caller-supplied `takeHomeUSD` that is not a finite number. The old
    //     `Number(x) || 0` turned NaN/Infinity into 0 SILENTLY, so a real donation
    //     could credit nothing with no trace of why.
    //
    // Clamped rather than thrown: an alert is a live, one-shot event and refusing it
    // outright would lose the viewer's moment. There is deliberately NO upper cap —
    // a ceiling would silently truncate a genuinely large donation, which is the
    // failure mode this whole path exists to avoid.
    const suppliedTakeHome = input.takeHomeUSD != null;
    const rawTakeHome = suppliedTakeHome
      ? Number(input.takeHomeUSD)
      : economics.takeHome(platform, eventType, input);
    const takeHome = Number.isFinite(rawTakeHome) && rawTakeHome > 0 ? rawTakeHome : 0;
    if (rawTakeHome !== takeHome && rawTakeHome !== 0) {
      // Loud: reaching here means a producer sent something impossible. It is not
      // recoverable at this layer, and silence is how it stayed invisible.
      // Ids and amounts only — never the donor's name (the journal travels further than
      // the people who gave). A caller-supplied value is logged only when it is a number.
      const raw = suppliedTakeHome ? input.takeHomeUSD : rawTakeHome;
      console.error(
        '[alert] take-home %s clamped to 0 — %s. platform=%s eventType=%s event=%s raw=%s',
        Number.isFinite(rawTakeHome) ? 'was NEGATIVE' : 'was NOT FINITE',
        suppliedTakeHome ? 'caller supplied takeHomeUSD directly' : 'computed by economics from the event fields',
        platform, eventType, input.eventId ?? '?', typeof raw === 'number' ? String(raw) : `(${typeof raw})`
      );
      // A push renders on a lock screen — platform and event type are enough to find the
      // journal entry.
      notify(
        'alert.takehome-clamped',
        'Take-home clamped to 0',
        `${platform}/${eventType} — a producer sent a ${Number.isFinite(rawTakeHome) ? 'negative' : 'non-finite'} take-home`,
        { critical: true },   // money path: this must not wait until morning
      );
    }
    // R2-2's server half: stream-ingest could not read a gift's count from the
    // banner and sent 1. Credit it (a gift happened; economics floors the count
    // at 1, never 0) and say so where a person will see it.
    if (input.countUnverified) {
      console.warn('[alert] %s/%s event=%s: gift count UNVERIFIED — credited as %s. The producer logged the raw banner text.',
        platform, eventType, input.eventId ?? '?', input.count ?? 1);
    }

    // A payment that arrived in a currency the rate table cannot price: its
    // take-home is 0, but unlike a milestone or a tip under the fee it IS money.
    // It goes to stream.unpriced_support (via logUnpriced), never the ledger the
    // bar/timer/sponsors/meter sum — see economics.unpricedNative.
    const unpriced = takeHome > 0 ? null : economics.unpricedNative(platform, eventType, input);
    const rawAmount = typeof input.amountText === 'string' && input.amountText.trim()
      ? input.amountText.trim()
      : (unpriced ? `${unpriced.amount} ${unpriced.currency}` : '');

    // `amount` doubles as the economics input (a NUMBER: gross for kofi/streamlabs/
    // youtube) and a display string. Only use it for display when it's a string
    // (e.g. native Stripe passes a pre-formatted "$6.00"); otherwise show take-home
    // — or, for an unpriced payment, the amount as it arrived (never "$0").
    const amount = (typeof input.amount === 'string' && input.amount)
      ? input.amount
      : (takeHome > 0 ? economics.formatUSD(takeHome) : (unpriced ? rawAmount : ''));

    // Durable dedup key: the in-memory guards upstream (/alert's alertSeen, the
    // webhook replay stores) die with the process, and the producer retries they
    // legalize exist to bridge exactly that restart. Platform-prefixed — never
    // trust a producer to namespace its own ids; the same raw id on two platforms
    // must stay two events.
    const eventId = input.eventId != null && String(input.eventId).trim()
      ? ledgerEventId(platform, input.eventId)
      : undefined;

    // ── The hold ─────────────────────────────────────────────────────────────
    // ORDER IS LOAD-BEARING: the ledger answers FIRST, then the stream effects, then the
    // visible bar/timer. Nothing on stream fires until the ledger has said "this event is
    // new" — however long that takes. There is no ceiling on the wait and no "fire anyway":
    // Streamlabs re-emits its history on every reconnect and producers retry across
    // restarts, so a duplicate is the COMMON case, and celebrating before the ledger answers
    // is how a replay during a slow database rang, spoke and posted a card a second time.
    // A slow write is logged loudly and still waited for — late-but-once is the rule. A
    // REJECTED write is retried while the error is transient (bounded: LEDGER_MAX_ATTEMPTS); a
    // permanent error, or a transient one past the cap, fires nothing, is recorded for
    // reconciliation and throws LedgerWriteError, so the caller answers non-2xx and a provider
    // that redelivers brings the event back.
    //
    // Ledger before BAR: stream.support_events is the ledger and the bar is derived from it,
    // so crediting the bar without a row would show money no row backs (the bar walks
    // backwards on the next rebuild, the timer keeps seconds it was never owed).
    //
    // Known limit (beta): a crash AFTER the row is written and BEFORE the effects fire loses
    // that one celebration — the replay that follows is then, correctly, a duplicate. The
    // money is still credited (the row is the truth; the bar recomputes from it on start).
    // Same for a write that committed but whose reply was lost: its retry answers "already
    // recorded" and is treated as a duplicate (logged as such).
    //
    // An unpriced payment's row in stream.unpriced_support answers the same "already
    // recorded?" question through its own unique event_id.
    const what = { platform, eventType, eventId: eventId || '?', takeHome };
    const ledger = takeHome > 0 && logSupport ? writeLedger({ platform, eventType, username, takeHome, input, eventId }, what)
      : unpriced ? writeUnpriced({ platform, eventType, username, unpriced, rawAmount, input, eventId }, what)
      : null;
    let rec = null;
    if (ledger) {
      rec = await held(ledger, what);
      if (rec.failed) {
        // No effect fires for an event the ledger does not hold. Recorded for reconciliation
        // (POST /support/reconcile) when the database would take even that.
        const recorded = await recordFailure({ platform, eventType, username, takeHome, unpriced, input, eventId, error: rec.error });
        throw new LedgerWriteError(
          `ledger write failed (${rec.permanent ? 'permanent' : 'retries exhausted'}) for ${platform}/${eventType} event=${eventId || '?'}`,
          { permanent: rec.permanent, recorded });
      }
      if (rec.duplicate) return { takeHome, amount, addedSeconds: 0, marathonEnded: false, duplicate: true };
    }
    // Held refunds took the WHOLE credit back as it landed (money.js, v156): the row and its
    // reversal are written, but money already refunded is not celebrated — no alert, sound,
    // lights, TTS or card (callers skip the card on `refunded`).
    // The bar and the timer admit the credit's NET of those held refunds (review round 6 D-D, k
    // 2026-10-18): fully refunded → nothing, partly → the kept part. money.js stores that amount
    // on the row (admitted_usd, v159), so the bar's restart rebuild agrees. A refund that arrives
    // AFTER the credit never takes anything back (unchanged).
    const refunded = !!(rec && rec.refunded);
    const barUsd = rec && rec.admittedUsd != null ? Math.max(0, Number(rec.admittedUsd) || 0) : takeHome;
    if (refunded) {
      console.log('[alert] %s/%s event=%s: credited and already fully refunded — no celebration', platform, eventType, eventId || '?');
    } else {
      broadcast(buildShowAlert({ ...input, platform, eventType, username, amount }));
      // There is no money-bearing `alert` frame; the bar moves via updateSupportBar.

      if (obs) obs.playSound().catch((e) => console.warn('[alert] sound:', e.message));

      // Room lights. Same contract as the sound above: fired, never awaited, and a no-op when
      // unconfigured or unreachable. `barUsd` (the net of any held refunds) — the SAME number that moves the bar below, so
      // the bulb and the bar cannot disagree about the event's size.
      if (lights) lights.flash(eventType, { usd: barUsd }).catch((e) => console.warn('[alert] lights:', e.message));

      // input.speak === false opts OUT of narration for this call only (e.g. the cheer
      // composer's TTS toggle). Donations are read up to the tier for the GROSS amount paid
      // (tts-tiers.js); everything else keeps the card's 500-character cap. The producer that
      // knows the gross amount supplies `grossUSD` — a donation without it reads the smallest tier.
      const spoken = input.speak === false
        ? ''
        : cleanForTTS(input.message || '').slice(0, ttsTiers.spokenCharsFor(eventType, input.grossUSD));
      if (spoken && tts) tts.speak(spoken); // serialized + non-blocking inside tts
    }

    let addedSeconds = 0;
    if (barUsd > 0 && supportBar) {
      // Post-ledger, a bar failure must not unwind the caller: the row is the truth and the
      // bar recomputes from it. With no ledger wired (tests, tools) there is no row to wait for.
      try {
        const r = rec
          ? supportBar.add(barUsd, username, rec.canonicalId, rec.ledgerId || null)
          : supportBar.add(barUsd, username, null);
        addedSeconds = (r && r.deltaSeconds) || 0; // seconds this contribution added to the timer
      } catch (e) {
        console.error('[alert] supportBar.add failed AFTER the ledger write — timer not moved; ' +
          'bar catches up from support_events. platform=%s event=%s amountUsd=%s err=%s',
          platform, eventId || '?', barUsd, e.message);
      }
    }
    // A locked marathon banks the money but buys no time — distinguish that from "too small
    // to move the clock", which is also addedSeconds 0. Only the lock gets the message, and
    // only for a CONTRIBUTION: a Qorm spend rides this path with takeHome 0.
    const marathonEnded = barUsd > 0 && addedSeconds === 0 && typeof timerLocked === 'function' && timerLocked();
    return { takeHome, amount, addedSeconds, marathonEnded, ...(refunded ? { refunded: true } : {}) };
  }

  // Wait for the ledger's answer with no ceiling, saying so loudly once it is slow.
  async function held(ledger, what) {
    const started = Date.now();
    const slow = setTimeout(() => {
      console.warn('[alert] ledger has not answered after %dms — %s/%s event=%s: celebration HELD until it does',
        ledgerSlowMs, what.platform, what.eventType, what.eventId);
    }, ledgerSlowMs);
    if (slow.unref) slow.unref();
    try {
      const rec = await ledger;
      const waited = Date.now() - started;
      if (waited >= ledgerSlowMs) {
        console.warn('[alert] ledger answered after %dms — %s/%s event=%s: %s',
          waited, what.platform, what.eventType, what.eventId,
          rec.duplicate ? 'already recorded, nothing fires' : 'firing the celebration now (late, once)');
      }
      return rec;
    } finally {
      clearTimeout(slow);
    }
  }

  // Run one ledger write until it ANSWERS. A transient failure (isTransientDbError) is logged
  // and retried on `ledgerRetryMs` (the last delay repeats), at most `ledgerMaxAttempts` times;
  // a permanent one is not retried. One critical push on the first failure. Never rejects:
  // gives up with { failed: true, permanent, error } and the caller records the event.
  async function untilAnswered(kind, what, write) {
    let failures = 0;
    for (;;) {
      try {
        const rec = await write();
        if (failures > 0) {
          console.warn('[alert] %s write landed after %d failed attempt(s) — %s/%s event=%s%s',
            kind, failures, what.platform, what.eventType, what.eventId,
            rec.duplicate ? ' — answered "already recorded"; treated as a duplicate (a failed attempt may have committed)' : '');
        }
        return rec;
      } catch (e) {
        failures++;
        const permanent = !isTransientDbError(e);
        const giveUp = permanent || failures >= ledgerMaxAttempts;
        const wait = ledgerRetryMs[Math.min(failures - 1, ledgerRetryMs.length - 1)];
        console.error('[alert] %s write FAILED (attempt %d, %s) — %s/%s event=%s amountUsd=%s: celebration HELD, ' +
          'bar/timer not moved; %s. code=%s err=%s',
          kind, failures, permanent ? 'permanent' : 'transient', what.platform, what.eventType, what.eventId, what.takeHome,
          giveUp ? 'GIVING UP — recording it for reconciliation' : `retrying in ${wait}ms`, e && e.code, e && e.message);
        if (failures === 1) {
          // Real money has not reached the ledger yet — page, don't just log. No name or
          // amount in the push (lock screen); the journal line has the event id.
          notify(
            'money.ledger-write-failed',
            'Support ledger write FAILED',
            `${what.platform}/${what.eventType} — a credit could not reach the ledger; ${giveUp ? 'not retried, kept for reconciliation' : 'retrying, celebration held'}`,
            { critical: true },
          );
        }
        if (giveUp) return { failed: true, permanent, error: e };
        await sleep(wait);
      }
    }
  }

  // An event the ledger could not record goes to stream.unpriced_support as reason
  // 'ledger_failed' (amount = the take-home in USD), where POST /support/reconcile settles it — and
  // where a later successful delivery of the same event closes it on its own (money.js). When even
  // that write fails, this journal line is the only record, so it carries everything but the name.
  async function recordFailure({ platform, eventType, username, takeHome, unpriced, input, eventId, error }) {
    const amountNative = unpriced ? unpriced.amount : takeHome;
    const currency = unpriced ? unpriced.currency : 'USD';
    // No event id, no record: a record with no key could be reconciled AND later delivered again
    // as two credits. The journal line below is then the handle (manual handling).
    if (logUnpriced && eventId) {
      try {
        await logUnpriced({
          platform, eventType, userId: input.userId, username, amountNative, currency,
          raw: `ledger write failed${error && error.code ? ` (${error.code})` : ''}`, message: input.message || '',
          eventId, reason: 'ledger_failed',
        });
        return true;
      } catch (e) {
        console.error('[alert] could not even record the failed event — %s/%s event=%s amount=%s %s: %s',
          platform, eventType, eventId || '?', amountNative, currency, e.message);
      }
    }
    console.error('[alert] UNRECORDED payment — %s/%s event=%s amount=%s %s userId=%s: reconcile BY HAND from this line',
      platform, eventType, eventId || '?', amountNative, currency, input.userId || '?');
    return false;
  }

  // The ledger write: { duplicate, canonicalId, ledgerId, refunded, admittedUsd }. Never rejects (untilAnswered).
  function writeLedger({ platform, eventType, username, takeHome, input, eventId }, what) {
    return untilAnswered('ledger', what, async () => {
      const rec = await logSupport({
        platform, userId: input.userId, username, amountUsd: takeHome,
        eventType, tier: input.tier, months: input.months, eventId,
      });
      return { duplicate: !!(rec && rec.duplicate), canonicalId: (rec && rec.canonicalId) || null, ledgerId: (rec && rec.ledgerId) || null,
        refunded: !!(rec && rec.refunded), admittedUsd: rec && rec.admittedUsd != null ? rec.admittedUsd : null };
    });
  }

  // An unpriced payment's row in stream.unpriced_support, retried like the ledger. The loud
  // line and the critical push go out once per event: only when the row is NEW — a replay of
  // the same event_id re-sends neither. Reconciled later through POST /support/reconcile,
  // which credits the ledger under the same event_id.
  function writeUnpriced({ platform, eventType, username, unpriced, rawAmount, input, eventId }, what) {
    const announce = () => {
      console.error(
        '[alert] UNPRICED payment — %s/%s event=%s: "%s" (%s %s). Bar/timer NOT credited; kept in stream.unpriced_support for reconciliation.',
        platform, eventType, eventId || '?', rawAmount, unpriced.amount, unpriced.currency
      );
      notify(
        'money.unpriced',
        'Payment in an unpriced currency',
        `${platform}/${eventType} in ${unpriced.currency} — not on the bar; reconcile from stream.unpriced_support`,
        { critical: true },
      );
    };
    if (!logUnpriced) { announce(); return null; }
    return untilAnswered('unpriced', what, async () => {
      const rec = await logUnpriced({
        platform, eventType, userId: input.userId, username,
        amountNative: unpriced.amount, currency: unpriced.currency, raw: rawAmount,
        message: input.message || '', eventId,
      });
      const duplicate = !!(rec && rec.duplicate);
      if (!duplicate) announce();
      return { duplicate, canonicalId: null };
    });
  }

  // External-platform dispatch: stream effects + a chat card.
  async function dispatch(input) {
    // Mask here too, not just inside fireStreamEffects. That function masks its own
    // local copy, but buildSystemCard below reads THIS `input` — so the chat card
    // (and the persisted row behind it) kept the unmasked donor text even while the
    // TTS and overlay were clean. Masking is idempotent, so both layers is fine and
    // neither can be the single point of failure.
    input = { ...input, message: mask(cleanText(input.message, 2000)), username: mask(cleanText(input.username, 100)) };
    // Twitch profile picture, resolved HERE rather than by the sender.
    // stream-ingest has the event's numeric user id but no Twitch app
    // credentials; this process has both, so the lookup belongs on this side. Cached per user (twitch-app.js) and it never
    // throws — '' is the value buildShowAlert/buildSystemCard already expect, and
    // the web falls back to a coloured initial.
    if (input.platform === 'twitch' && !input.userImage && input.userId) {
      input = { ...input, userImage: await twitchProfileImage(input.userId) };
    }
    const { amount, addedSeconds, marathonEnded, duplicate, refunded } = await fireStreamEffects(input);
    // Already recorded: the first delivery posted this card. A second would be
    // a second persisted row and a second line in everyone's chat.
    if (duplicate) return { ok: true, deduped: true };
    // Credited and already fully refunded (held refunds): no card either.
    if (refunded) return { ok: true, refunded: true };
    const card = buildSystemCard({ ...input, amount, addedSeconds, marathonEnded });
    // Persist so the external-platform alert card supports the same actions as any
    // chat line (reply/vote/delete/pin) — on success it gets a real numeric id +
    // the site's own platform id. No author (external donor has no matrix id).
    if (persistCard) {
      const id = await persistCard(card);
      if (id != null) { card.id = id; card.platform = NATIVE_PLATFORM; }
    }
    if (bufferPush) bufferPush(card);
    broadcast(card);
    return { ok: true };
  }

  return { dispatch, fireStreamEffects, buildEventCard };
}

module.exports = { createAlert, cleanForTTS, buildShowAlert, buildSystemCard, buildEventCard, ledgerEventId, isTransientDbError, LedgerWriteError };
