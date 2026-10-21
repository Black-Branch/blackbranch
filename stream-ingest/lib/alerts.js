// Normalize raw Twitch tmi monetization events (from the vendored chatClient's
// MONETIZATION emission) into the stream-api POST /alert payload: builds the
// label + the economics inputs (tier,
// months, count, bits). Take-home itself is computed server-side by /alert via
// economics.js, so this file stays platform-shaping only.

const PLAN_TIER = { '1000': 'tier 1', '2000': 'tier 2', '3000': 'tier 3', prime: 'prime' };

function tierFromPlan(plan) {
  return PLAN_TIER[String(plan || '').toLowerCase()] || 'tier 1';
}
function tierLabel(tier) {
  return tier === 'tier 2' ? 'Tier 2' : tier === 'tier 3' ? 'Tier 3' : tier === 'prime' ? 'Prime' : '';
}
function int(v, d = 0) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }

// Retry-safety id: postAlert retries a failed
// delivery — a paid event is not droppable — and stream-api's /alert dedups on
// this field, which is what makes the retry legal. Minted ONCE per event, here
// in the normalizer, so every retry of the same event carries the same id.
// Prefer the platform's own id when it sends one (that also absorbs a platform
// re-delivering the same event); otherwise mint a process-unique one — for
// retry-dedup, uniqueness per process lifetime is all that is required.
let mintSeq = 0;
function eventIdFor(platform, platformId) {
  const id = platformId ? String(platformId) : `${Date.now().toString(36)}.${++mintSeq}`;
  return `${platform}:${id}`;
}

// A resub that was PREPAID for several months (or gifted that way) carries multi-month tags. The
// owner's decision is to log it, not to change its credit: the raw tag set is written once per
// event at info level so the real shapes can be read before anything is built on them. Tag
// names per Twitch's USERNOTICE docs; values only — never a name (no login/display tags).
const MULTIMONTH_TAGS = ['msg-param-multimonth-duration', 'msg-param-multimonth-tenure', 'msg-param-was-gifted',
  'msg-param-cumulative-months', 'msg-param-streak-months', 'msg-param-sub-plan'];
const multimonthSeen = new Set();
function logMultimonth(u, eventId) {
  const duration = int(u['msg-param-multimonth-duration'], 0);
  const tenure = int(u['msg-param-multimonth-tenure'], 0);
  const gifted = String(u['msg-param-was-gifted'] ?? '').toLowerCase() === 'true';
  if (duration <= 1 && tenure <= 0 && !gifted) return;
  if (multimonthSeen.has(eventId)) return;
  multimonthSeen.add(eventId);
  if (multimonthSeen.size > 1000) multimonthSeen.delete(multimonthSeen.values().next().value);
  const tags = Object.fromEntries(MULTIMONTH_TAGS.filter((k) => u[k] != null).map((k) => [k, String(u[k])]));
  console.info(`[twitch] multi-month resub event=${eventId} tags=${JSON.stringify(tags)} (logged only — credit unchanged)`); // log-names: allow — whitelisted numeric/flag tags, no login or display tag
}

/**
 * @param {{kind:string, userstate?:object, username?:string, message?:string,
 *          numbOfSubs?:number, recipient?:string}} evt
 * @returns {object|null} /alert payload, or null to skip (e.g. a gift that's part
 *   of a mystery-gift bomb already counted, or an unknown event kind).
 */
export function normalizeTwitchEvent(evt) {
  const u = evt.userstate || {};
  const username = u['display-name'] || evt.username || 'Anonymous';
  const userId = u['user-id'] || '';
  // NO userImage, deliberately: a third-party picture host on the money path is a
  // dependency with no fallback. stream-api resolves the picture from Twitch Helix
  // by `userId` (twitch-app.js), because that is where the Twitch app credentials
  // live; this service has none. So `userId` is the load-bearing field here: drop
  // it and the alert silently loses its avatar.
  // `u.id` is the USERNOTICE/PRIVMSG message id — Twitch's own stable id for
  // this exact event.
  const base = { platform: 'twitch', username, userId, eventId: eventIdFor('twitch', u.id) };

  switch (evt.kind) {
    case 'sub': {
      const tier = tierFromPlan(u['msg-param-sub-plan']);
      const months = int(u['msg-param-multimonth-duration'], 1) || 1;
      const tl = tierLabel(tier);
      const label = months > 1
        ? `subscribed · ${tl ? tl + ' · ' : ''}${months} months`
        : `subscribed${tl ? ' · ' + tl : ''}`;
      return { ...base, eventType: 'sub', tier, months, message: evt.message || '', label };
    }
    case 'resub': {
      logMultimonth(u, base.eventId);
      const tier = tierFromPlan(u['msg-param-sub-plan']);
      const months = int(u['msg-param-cumulative-months'], 1) || 1;
      const streak = int(u['msg-param-streak-months'], 0);
      const parts = [];
      const tl = tierLabel(tier);
      if (tl) parts.push(tl);
      parts.push(`month ${months}`);
      if (streak > 1) parts.push(`${streak} streak`);
      return { ...base, eventType: 'resub', tier, months, message: evt.message || '', label: `resubscribed · ${parts.join(' · ')}` };
    }
    case 'subgift': {
      // Each sub in a mystery-gift bomb also fires `subgift`; skip it (the bomb is
      // counted once by submysterygift) so we don't double-count.
      if (u['msg-param-community-gift-id']) return null;
      const tier = tierFromPlan(u['msg-param-sub-plan']);
      const recipient = u['msg-param-recipient-display-name'] || u['msg-param-recipient-user-name'] || 'someone';
      const months = int(u['msg-param-gift-months'], 1) || 1;
      const tl = tierLabel(tier);
      const label = months > 1
        ? `gifted ${months}mo to ${recipient}${tl ? ' · ' + tl : ''}`
        : `gifted a sub to ${recipient}${tl ? ' · ' + tl : ''}`;
      return { ...base, eventType: 'giftsub', tier, months, recipient, label };
    }
    case 'submysterygift': {
      const tier = tierFromPlan(u['msg-param-sub-plan']);
      const count = int(evt.numbOfSubs, 0) || int(u['msg-param-mass-gift-count'], 1) || 1;
      const tl = tierLabel(tier);
      return { ...base, eventType: 'giftbomb', tier, count, label: `gifted ${count} sub${count === 1 ? '' : 's'}${tl ? ' · ' + tl : ''}` };
    }
    case 'cheer': {
      const bits = int(u.bits, 0);
      return { ...base, eventType: 'bits', bits, message: evt.message || '', label: 'cheered' };
    }
    case 'primepaidupgrade': {
      const tier = tierFromPlan(u['msg-param-sub-plan']);
      const tl = tierLabel(tier) || 'Tier 1';
      return { ...base, eventType: 'prime-upgrade', tier, label: `upgraded Prime → ${tl}` };
    }
    case 'giftpaidupgrade': {
      const tier = tierFromPlan(u['msg-param-sub-plan']);
      const tl = tierLabel(tier);
      return { ...base, eventType: 'gift-paid-upgrade', tier, label: `converted gifted sub${tl ? ' · ' + tl : ''}` };
    }
    case 'payitforward': {
      const tier = tierFromPlan(u['msg-param-sub-plan']);
      const recipient = u['msg-param-recipient-display-name'] || evt.recipient || '';
      return { ...base, eventType: 'pay-it-forward', tier, recipient, label: recipient ? `paid it forward to ${recipient}` : 'paid it forward' };
    }
    default:
      return null;
  }
}

// YouTube superchat amount strings are formatted in the page's en-US locale (we
// set locale:'en-US'), so "." is always the decimal and "," the thousands sep.
// In en-US a currency with no short symbol is written as its ISO code
// ("ARS 5,000.00"), so an ISO code passes straight through; everything else has
// to be in this table. lib/alerts.test.js checks it against every currency
// stream-api can price, formatted by Intl the way the page formats it.
const YT_SYMBOL = {
  '$': 'USD', 'CA$': 'CAD', 'A$': 'AUD', 'MX$': 'MXN', 'HK$': 'HKD', 'NZ$': 'NZD',
  'R$': 'BRL', 'NT$': 'TWD', 'S$': 'SGD', '£': 'GBP', '€': 'EUR', '¥': 'JPY',
  '₩': 'KRW', '₹': 'INR', '₽': 'RUB', '₺': 'TRY', '฿': 'THB', '₱': 'PHP',
  Rp: 'IDR', RM: 'MYR', 'zł': 'PLN', CHF: 'CHF', '₪': 'ILS',
  'CN¥': 'CNY', '₫': 'VND', 'E£': 'EGP', '₴': 'UAH',
};
// A symbol this table does not know is UNKNOWN — never USD. Labelling it USD
// would credit ARS 5,000 (about $5) as $3,500: the label hides it from
// stream-api's toUSD, which credits $0 and logs loudly for a code it cannot
// price. stream-api keeps such an event in stream.unpriced_support for a person
// to reconcile, and the alert shows `amountText`, the raw string.
function parseYtAmount(str) {
  const s = String(str || '').trim();
  const num = s.match(/\d[\d.,]*/);
  const amount = num ? parseFloat(num[0].replace(/,/g, '')) || 0 : 0;
  let symbol = num ? s.slice(0, s.indexOf(num[0])).trim() : '';
  if (!symbol) symbol = s.replace(/[\d.,\s]/g, '');
  const currency = YT_SYMBOL[symbol] || (/^[A-Z]{3}$/.test(symbol) ? symbol : 'UNKNOWN');
  return { amount, currency };
}

// The gift count on a YouTube gift-membership banner. The banner reads
// "Sent 5 <channel> gift memberships" (or the older "Gifted 5 <channel>
// memberships"), and when the author is missing the text may start with the
// donor's name. So the count is the number right after "sent"/"gifted" in a
// phrase that ends in "membership(s)" — never the first number in the text: a
// donor called "Viewer2026" must not become a gift of 2,026.
//
// The donor chooses their own name, and the name comes FIRST, so the name can
// carry the gift wording itself: a viewer called "Sent 500 x" whose banner reads
// "Sent 500 x gifted 1 membership" must be credited 1, not 500. Three guards:
//   • the known author is cut off the front of the text before parsing;
//   • the match is anchored to the END of the banner ("…membership(s)") and the
//     greedy `^(?:.*\s)?` takes the LAST "sent/gifted N" — YouTube's own wording
//     is always last, after anything the donor typed;
//   • the count is capped at GIFT_MAX, YouTube's largest single gift purchase.
//     Anything above it is not a count YouTube can send: credit 1, unverified.
//
// `verified: false` means the wording was not recognised. The caller still
// credits 1 — a gift DID happen — but flags it, and logs the raw text so the
// next stream shows what YouTube actually wrote.
const GIFT_MAX = 50;
export function parseGiftCount(text, author = '') {
  let s = String(text || '').trim();
  const name = String(author || '').trim();
  if (name && s.toLowerCase().startsWith(name.toLowerCase())) s = s.slice(name.length).trim();
  const m = s.match(/^(?:.*\s)?(?:gifted|sent)\s+(\d[\d,]*)\s+.*?\bmemberships?[.!]?$/i);
  const n = m ? parseInt(m[1].replace(/,/g, ''), 10) : NaN;
  return Number.isFinite(n) && n > 0 && n <= GIFT_MAX ? { count: n, verified: true } : { count: 1, verified: false };
}

// The banner text as it may be logged: YouTube's wording, never the gifter's
// name. The known author is masked wherever it appears; with no author, everything before the LAST
// "gifted"/"sent" (YouTube's own verb comes last — parseGiftCount above) is the name. With neither,
// nothing in the text can be told apart from a name, so only its length is logged. Bounded.
const BANNER_LOG_MAX = 200;
export function maskBannerName(text, author = '') {
  let s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const name = String(author || '').trim();
  if (name) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(esc, 'gi'), '<name>');
  } else {
    const verbs = [...s.matchAll(/(?:^|\s)(gifted|sent)\s/gi)];
    if (!verbs.length) return `<unrecognised banner, ${s.length} chars — wording withheld: no author to mask>`;
    const last = verbs[verbs.length - 1];
    const at = last.index + (last[0].startsWith(' ') ? 1 : 0);
    if (at > 0) s = `<name> ${s.slice(at)}`;
  }
  return s.length > BANNER_LOG_MAX ? `${s.slice(0, BANNER_LOG_MAX)}…` : s;
}

// The membership LEVEL name a banner carries (stream-api prices it from the owner's
// YOUTUBE_MEMBERSHIP_TIERS map; unknown or absent → the base price). Tolerant on purpose — the
// wording is YouTube's and changes: anything unrecognised is simply no level.
//   new member:  subtext "Welcome to <level>!"
//   milestone:   primary "Member for N months", subtext = the level
//   gift:        primary "<name> gifted N <level> memberships" / "Sent N <level> gift memberships"
export function membershipLevel(evt) {
  const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (evt.kind === 'membership') {
    const sub = clean(evt.subtext ?? evt.header);
    const welcome = /^welcome to (.+?)[.!]*$/i.exec(sub);
    if (welcome) return clean(welcome[1]);
    if (sub && /\d+\s*month/i.test(clean(evt.primaryHeader)) && !/\d+\s*month/i.test(sub)) return sub;
    return '';
  }
  if (evt.kind === 'membership-gift') {
    let s = clean(evt.primary);
    const name = clean(evt.author);
    if (name && s.toLowerCase().startsWith(name.toLowerCase())) s = s.slice(name.length).trim();
    const m = /(?:^|\s)(?:gifted|sent)\s+\d[\d,]*\s+(.+?)\s+(?:gift\s+)?memberships?[.!]?$/i.exec(s);
    return m ? clean(m[1]) : '';
  }
  return '';
}

/**
 * Normalize a scraped YouTube monetization event → /alert payload.
 * @param {{kind:string, author?:string, avatar?:string, amount?:string,
 *          message?:string, header?:string, count?:number, primary?:string}} evt
 */
export function normalizeYouTubeEvent(evt) {
  const username = evt.author || 'Anonymous';
  const base = { platform: 'youtube', username, userImage: evt.avatar || '',
    eventId: eventIdFor('youtube', evt.id) };
  switch (evt.kind) {
    case 'superchat': {
      const { amount, currency } = parseYtAmount(evt.amount);
      if (amount === 0 && String(evt.amount || '').trim())
        console.warn(`[youtube] superchat amount parsed to 0 from "${evt.amount}" — #purchase-amount selector drift? (alert still fires, $ uncredited)`);
      if (currency === 'UNKNOWN' && amount > 0)
        console.warn(`[youtube] superchat currency not recognised in "${evt.amount}" — sent as UNKNOWN (stream-api holds it unpriced)`);
      return { ...base, eventType: 'superchat', amount, currency, amountText: String(evt.amount || '').trim(),
        message: evt.message || '', label: 'super chat' };
    }
    case 'supersticker': {
      const { amount, currency } = parseYtAmount(evt.amount);
      if (amount === 0 && String(evt.amount || '').trim())
        console.warn(`[youtube] supersticker amount parsed to 0 from "${evt.amount}" — #purchase-amount selector drift? (alert still fires, $ uncredited)`);
      if (currency === 'UNKNOWN' && amount > 0)
        console.warn(`[youtube] supersticker currency not recognised in "${evt.amount}" — sent as UNKNOWN (stream-api holds it unpriced)`);
      return { ...base, eventType: 'supersticker', amount, currency, amountText: String(evt.amount || '').trim(),
        label: 'super sticker' };
    }
    case 'membership': {
      const header = evt.header || '';
      const m = header.match(/(\d+)\s*month/i); // "Member for 3 months" → milestone
      const level = membershipLevel(evt);
      return m
        ? { ...base, eventType: 'membership-milestone', label: `member · month ${m[1]}`, ...(level ? { level } : {}) }
        : { ...base, eventType: 'membership-new', label: 'became a member', ...(level ? { level } : {}) };
    }
    case 'membership-gift': {
      // Both scrape paths (innertube + DOM) send the banner's raw `primary`
      // text and the count is read here, once. A caller that already knows the
      // count (tests, a future structured field) may pass `count` instead.
      let count;
      let unverified = false;
      const given = parseInt(evt.count, 10);
      if (Number.isFinite(given) && given > 0) {
        count = given;
      } else {
        const parsed = parseGiftCount(evt.primary, evt.author);
        count = parsed.count;
        if (!parsed.verified) {
          unverified = true;
          console.warn(`[youtube] gift-membership count NOT recognised — crediting 1, flagged unverified. banner wording: "${maskBannerName(evt.primary, evt.author)}"`);
        }
      }
      const level = membershipLevel(evt);
      return { ...base, eventType: 'membership-gift', count,
        ...(unverified ? { countUnverified: true } : {}),
        ...(level ? { level } : {}),
        label: `gifted ${count} membership${count === 1 ? '' : 's'}` };
    }
    default:
      return null;
  }
}

/**
 * Normalize a Kick monetization event → /alert payload. The connector classifies
 * the raw Kick event into one of these `kind`s and extracts the fields; take-home
 * ($4.99 × 95% per sub, count for gifts, per-Kick rate) is computed server-side by
 * economics.js `kick`. `count`/`kicks` are carried through so that math has them.
 * @param {{kind:string, username?:string, gifter?:string, recipient?:string,
 *          months?:number, count?:number, kicks?:number, avatar?:string}} evt
 */
export function normalizeKickEvent(evt) {
  if (!evt) return null;
  const base = { platform: 'kick', userImage: evt.avatar || '',
    eventId: eventIdFor('kick', evt.id) };
  switch (evt.kind) {
    case 'sub': {
      const months = Math.max(1, parseInt(evt.months, 10) || 1);
      return { ...base, username: evt.username || 'Anonymous', eventType: 'sub', months,
        label: months > 1 ? `resubscribed · ${months} months` : 'subscribed' };
    }
    case 'giftsub': {
      const count = Math.max(1, parseInt(evt.count, 10) || 1);
      return { ...base, username: evt.gifter || 'Anonymous', eventType: 'giftsub', count,
        recipient: count === 1 && evt.recipient ? evt.recipient : '',
        label: `gifted ${count} sub${count === 1 ? '' : 's'}` };
    }
    case 'kicks': {
      const kicks = Math.max(0, parseInt(evt.kicks, 10) || 0);
      return { ...base, username: evt.username || 'Anonymous', eventType: 'kicks', kicks,
        label: `sent ${kicks} Kick${kicks === 1 ? '' : 's'}` };
    }
    default:
      return null;
  }
}
