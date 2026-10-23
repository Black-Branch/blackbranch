// ── Chat dedup / cache primitives ───────────────────────────────────────────
// Pure, I/O-free helpers shared by the chat ingest path and the identity cache.
// The Map INSTANCES (allSendDedup) and their sweep stay with the chat routes —
// this file is stateless policy + parsing only. stream-ingest sends emotes and
// reply metadata inline with each message.

// FIFO/LRU ceiling helper — evict from the head (oldest insertion) until the map
// is within `max`. Map iteration is insertion order, so deleting keys().next()
// drops the least-recently-inserted; insert sites delete+re-set hot keys to keep
// them at the tail (LRU-by-write).
function capMap(map, max) {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}


// Canonical text for dedup matching: decode entities, lowercase, collapse ws,
// and strip invisible codepoints platforms silently drop — YouTube echoes
// "㊗️" (U+3297 + U+FE0F emoji variation selector) back as bare "㊗", which
// unstripped shows cross-post echoes as duplicate lines. Variation selectors (FE00-FE0F),
// zero-widths (200B-200D), BOM and the TAG block (E0000-E007F) are
// presentation-only, so removing them from the KEY (both arm and echo sides)
// can't over-match visible-different text.
// Unicode NFC, after that strip: one text can arrive as different code points. A
// site line typed as ba · shadda · fatha comes back from Twitch and YouTube as
// ba · fatha · shadda (canonical order), and an unnormalised key let each echo post
// as a new line (ticket #126). NFC and not NFKC: NFKC also folds compatibility
// characters (a "ﬁ" ligature, fullwidth letters, superscripts), which look different
// on screen, and two different lines must never share a key. The strip comes first so
// a zero-width character one platform dropped cannot keep a letter and its mark apart.
// The TAG block is ADDED, not incidental: web escapes a leading `.`/`/` with
// U+E0000 so Twitch stops command-parsing it (web/app/lib/outgoingText.ts).
// We arm on the unescaped text, so without this the escaped echo comes back
// unmatched and renders as a duplicate.
// URLs collapse to scheme+host: platforms rewrite links in their echo (YouTube
// truncates the display text — "…/stat..." — which would show send-to-all link
// messages as duplicates), so the path can't be trusted to round-trip. Host +
// surrounding text + the expected-platform scoping keeps the match safe.
function normText(s) {
  return decodeHtmlEntities(String(s || ''))
    .replace(/[\u{FE00}-\u{FE0F}\u{200B}-\u{200D}\u{FEFF}\u{E0000}-\u{E007F}]/gu, '')
    .normalize('NFC')
    .replace(/\b(?:https?:\/\/)?(?:www\.)?([^\s/]+\.[^\s/]{2,})\S*/gi, (_, host) => `https://${host}`)
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

// normText deliberately discards URL PATHS, because platforms (YouTube notably)
// truncate link text when they echo it, so the path can't be compared directly.
// That is fine when the message has other words to key on — and dangerous when it
// does not.
//
// A send-to-all of a BARE link normalizes to nothing but `https://host`. Any
// viewer posting a different link to the SAME host inside the window then matches
// that key and their message is dropped outright: no chat_log INSERT, no scoring,
// no broadcast. It vanishes for everyone, logged only as `[dedup] suppressed
// echo`. Platform scoping doesn't save it — the streamer fans out to exactly the
// platforms their viewers chat on.
//
// So for those weak keys we compare the PATH-PRESERVING text as well. Prefix
// comparison rather than equality is what keeps truncation working: a truncated
// echo is a prefix of the original, while a different video id diverges early.

/** True when the whole normalized message is a single URL — no other content. */
function isWeakDedupKey(key) {
  return /^https?:\/\/\S+$/.test(key);
}

/** Like normText but KEEPS paths; trailing ellipsis (platform truncation) trimmed. */
function normTextWithPath(s) {
  return decodeHtmlEntities(String(s || ''))
    .replace(/[\u{FE00}-\u{FE0F}\u{200B}-\u{200D}\u{FEFF}\u{E0000}-\u{E007F}]/gu, '')
    .normalize('NFC')
    .replace(/^(?:https?:\/\/)?(?:www\.)?/i, '')
    .replace(/[….]{1,3}$/, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Are these two path-preserving texts plausibly the same link?
 * One being a prefix of the other tolerates the platform truncating its echo,
 * while still separating two different paths on the same host.
 */
function sameLinkText(a, b) {
  if (!a || !b) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  // Require enough shared text that a bare host alone can't satisfy it.
  if (short.length < 8) return short === long;
  return long.startsWith(short);
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// ── Echo-suppression windows ────────────────────────────────────────────────
// Policy, so they live here with the decision that reads them; the Maps they
// bound stay in chat.js.
const ALL_SUPPRESS_TTL = 20_000;    // TEXT-keyed guess: swallow expected platform echoes
                                    // for this long — an automod hold-for-review (or a slow
                                    // relay reconnect) can delay a platform's echo past a
                                    // short window.
                                    // Do NOT widen this further to chase duplicates. This
                                    // window is keyed on message TEXT, so every extra second
                                    // is another second in which an unrelated viewer typing
                                    // "lol" is DELETED with no trace. Duplicates past 20s are
                                    // addressed by the two exact paths below instead.
const ALL_ECHO_GRACE   = 8_000;     // within this window, swallow ANY matching echo from an
                                    // EXPECTED platform (covers double-echoes).
const ECHO_CONFIRMED_TTL = 120_000; // IDENTITY-confirmed: the echo carries the sending user's
                                    // own platform account id (or resolves to their canonical
                                    // id), so it is their message coming back, not a viewer's.
                                    // Nothing a viewer sends can enter this branch, which is
                                    // what makes 120s safe where 20s is not: platform echoes
                                    // can arrive well over a minute late.
const ECHO_ID_TTL = 10 * 60_000;    // EXACT platform-message-id match: the id we were handed
                                    // when we POSTed the message. A collision is impossible,
                                    // so the only job of this bound is to stop the map growing.

/**
 * Should this incoming platform message be suppressed as the echo of a
 * send-to-all we armed? Pure — every piece of state is passed in — so the
 * decision is testable directly rather than through a mirror of itself.
 *
 * `identityConfirmed` is the load-bearing new input. Without it the
 * only evidence that a message is an echo is that its TEXT matches, which is why
 * the window has to stay short: a viewer typing the same words inside it would be
 * deleted outright. With it, we know the message came from the SENDER'S OWN
 * account, so widening the window cannot reach a viewer's message at all.
 *
 * Identity waives the budget and extends the window. It deliberately does NOT
 * waive `expected` or `linkOk`:
 *  - not `expected`: a platform we never fanned out to means the streamer typed
 *    that message there himself. It is not an echo and must render.
 *  - not `linkOk`: a bare-link key matches any link to the same host, so waiving
 *    it would swallow the streamer's own SECOND, different link.
 */
function decideEchoSuppression({
  entry, platform, elapsed, key, incomingRaw, identityConfirmed = false,
}) {
  // `platforms === null` = legacy caller that sent only a count — fall back to the
  // old any-platform behavior so an un-updated caller still dedups.
  const expected = entry.platforms === null || entry.platforms.has(platform);
  const budget = entry.platforms === null
    ? entry.remaining
    : (entry.platforms.get(platform) || 0);

  const window = identityConfirmed ? ECHO_CONFIRMED_TTL : ALL_SUPPRESS_TTL;
  if (elapsed >= window) {
    return { suppress: false, expected, budget, reason: 'expired' };
  }
  // A bare-link key carries no distinguishing content, so confirm against the
  // path-preserving text before suppressing anything. Failing to
  // dedup shows the streamer their own link twice; over-deduping DELETES a viewer's
  // message with no trace. Only one of those is recoverable.
  const linkOk = !isWeakDedupKey(key) ||
    (entry.raws && [...entry.raws].some((r) => sameLinkText(r, incomingRaw)));

  const inBudget = budget > 0 || elapsed < ALL_ECHO_GRACE || identityConfirmed;
  const suppress = expected && linkOk && inBudget;
  return {
    suppress, expected, budget,
    reason: suppress
      ? (identityConfirmed ? 'identity' : 'text')
      : (!expected ? 'unexpected-platform' : !linkOk ? 'different-link' : 'budget-spent'),
  };
}

/** Map key for an exact platform-message-id match. */
function echoIdKey(platform, platformMsgId) {
  return `${String(platform).toLowerCase()}:${platformMsgId}`;
}

// ── Boundary length caps ───────────────────────────────────────
// Applied by /chat and /chat/native before the text reaches identity, the DB,
// the broadcast or the 200-entry msgBuffer (whose `history` replay multiplies
// any oversized message by every connecting client). Deliberately far above
// every legitimate producer — native web sanitizes to 500 chars, Twitch's max
// is 500, YouTube's 200 — so only the abuse shape is cut. Truncate rather than
// reject: on this pipeline a dropped message is worse than a shortened one
// (the YouTube message-loss investigation is the standing example).
const MAX_MESSAGE_LEN = 2000;
const MAX_USERNAME_LEN = 120;
const MAX_REPLY_TEXT_LEN = 500;

/** Truncate a string to `max`; non-strings pass through for the caller's own
 *  validation to judge. */
function clampLen(v, max) {
  return typeof v === 'string' && v.length > max ? v.slice(0, max) : v;
}

// Personal-emote map boundary policy for /chat/native. The map is
// rendered as <img src> by every client, so URLs are HOST-PINNED to Twitch's
// emote CDN and the map is entry/length-capped. Returns a cleaned copy, or
// null when nothing valid remains (callers treat null as "no map").
const MAX_EMOTE_ENTRIES = 50;
const MAX_EMOTE_NAME_LEN = 100;
const MAX_EMOTE_URL_LEN = 300;
const NATIVE_EMOTE_URL_PREFIX = 'https://static-cdn.jtvnw.net/';

function sanitizeNativeEmotes(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  let n = 0;
  for (const [name, url] of Object.entries(raw)) {
    if (!name || name.length > MAX_EMOTE_NAME_LEN) continue;
    if (typeof url !== 'string' || url.length > MAX_EMOTE_URL_LEN) continue;
    if (!url.startsWith(NATIVE_EMOTE_URL_PREFIX)) continue;
    out[name] = url;
    if (++n >= MAX_EMOTE_ENTRIES) break;
  }
  return n ? out : null;
}

module.exports = {
  capMap,
  normText, normTextWithPath, isWeakDedupKey, sameLinkText,
  decodeHtmlEntities,
  decideEchoSuppression, echoIdKey,
  ALL_SUPPRESS_TTL, ALL_ECHO_GRACE, ECHO_CONFIRMED_TTL, ECHO_ID_TTL,
  clampLen, MAX_MESSAGE_LEN, MAX_USERNAME_LEN, MAX_REPLY_TEXT_LEN,
  sanitizeNativeEmotes,
};

