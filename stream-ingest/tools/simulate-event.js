// Monetization-event simulator — replay a platform's monetization event (or a
// native Stripe celebration) through the REAL pipeline so the alert/TTS/card path
// is testable without a live stream.
//
//   node tools/simulate-event.js <platform> <eventType> [flags]
//
// Platforms / events:
//   youtube  superchat | supersticker | membership | membership-gift
//   twitch   sub | resub | subgift | submysterygift | cheer | primepaidupgrade | payitforward
//   native   sub | gift | donation        (posts to stream-api /chat/event)
//
// Flags: --amount <usd>  --currency <CODE>  --user <name>  --months <n>
//        --count <n>  --message <text>  --tier <name>  --server <matrix server>  --send
//
// DRY-RUN by default: builds the raw event, normalizes it, and PRINTS — no POST.
// Pass --send to actually POST to STREAM_API_URL. That broadcasts into the live
// site + OBS overlays (and TTS when ALERT_TTS_ENABLED=1) but NEVER publishes to an
// external platform. Don't --send during a live stream unless you mean to.
//
// It drives normalize -> POST -> dispatch -> broadcast. It does NOT replay the
// browser DOM scrape (parseEvent/selectors) — that layer is only reproducible
// against live YouTube and is covered by the youtube.js instrumentation logs.

import 'dotenv/config';
import { normalizeTwitchEvent, normalizeYouTubeEvent, normalizeKickEvent } from '../lib/alerts.js';
import { postAlert } from '../lib/api.js';
import { streamApiBase } from '../lib/streamApiUrl.js';

// ── arg parsing ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const platform = (argv[0] || '').toLowerCase();
const eventType = (argv[1] || '').toLowerCase();
const flags = {};
for (let i = 2; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--send') { flags.send = true; continue; }
  if (a.startsWith('--')) { flags[a.slice(2)] = argv[i + 1]; i++; }
}
const num = (v, d) => (v == null ? d : Number(v));
const amountUsd = num(flags.amount, 5);
const currency = (flags.currency || 'USD').toUpperCase();
const user = flags.user || 'TestUser';
const months = num(flags.months, 1);
const count = num(flags.count, 5);
const message = flags.message || '';
const tier = flags.tier || 'Supporter';
// The Matrix server the simulated native ids are minted on (they name nobody real).
const server = flags.server || 'example.tv';

const USAGE = `usage: node tools/simulate-event.js <youtube|twitch|kick|native|alert> <eventType> [--amount 5 --currency USD --user Name --months 3 --count 5 --message "hi" --tier Supporter --server example.tv --send]
  kick events: sub | giftsub | kicks`;

// Currency code → the symbol YouTube renders, so parseYtAmount recovers it.
const CODE_SYMBOL = { USD: '$', EUR: '€', GBP: '£', CAD: 'CA$', AUD: 'A$', INR: '₹', JPY: '¥', BRL: 'R$', KRW: '₩' };
const ytAmountStr = () => `${CODE_SYMBOL[currency] || '$'}${amountUsd.toFixed(2)}`;

// Twitch sub-plan code from a tier name/number (1000/2000/3000).
const subPlan = () => {
  const t = String(flags.tier || '1').toLowerCase();
  if (t.includes('3') || t.includes('iii')) return '3000';
  if (t.includes('2') || t.includes('ii')) return '2000';
  return '1000';
};

// ── raw-event builders (mirror what the live connectors emit) ───────────────
function buildYouTube() {
  switch (eventType) {
    case 'superchat':       return { kind: 'superchat', author: user, avatar: '', amount: ytAmountStr(), message };
    case 'supersticker':    return { kind: 'supersticker', author: user, avatar: '', amount: ytAmountStr() };
    case 'membership':      return { kind: 'membership', author: user, avatar: '', header: months > 1 ? `Member for ${months} months` : 'Welcome!' };
    case 'membership-gift': return { kind: 'membership-gift', author: user, avatar: '', count };
    default: return null;
  }
}
function buildKick() {
  switch (eventType) {
    case 'sub':     return { kind: 'sub', username: user, months };
    case 'giftsub': return { kind: 'giftsub', gifter: user, count };
    case 'kicks':   return { kind: 'kicks', username: user, kicks: Math.round(amountUsd / 0.01) };
    default: return null;
  }
}
function buildTwitch() {
  const us = { 'display-name': user, 'user-id': '1', login: user.toLowerCase(), 'msg-param-sub-plan': subPlan() };
  switch (eventType) {
    case 'sub':             return { kind: 'sub', userstate: us, message };
    case 'resub':           return { kind: 'resub', userstate: { ...us, 'msg-param-cumulative-months': String(months) }, message };
    case 'subgift':         return { kind: 'subgift', userstate: { ...us, 'msg-param-recipient-display-name': flags.message || 'Recip', 'msg-param-gift-months': String(months) } };
    case 'submysterygift':  return { kind: 'submysterygift', numbOfSubs: count, userstate: us };
    case 'cheer':           return { kind: 'cheer', userstate: { 'display-name': user, bits: String(Math.round(amountUsd * 100)) }, message: `cheer${Math.round(amountUsd * 100)} ${message}` };
    case 'primepaidupgrade':return { kind: 'primepaidupgrade', userstate: us };
    case 'payitforward':    return { kind: 'payitforward', userstate: { 'display-name': user, 'msg-param-recipient-display-name': flags.message || 'Lucky' } };
    default: return null;
  }
}

// ── native Stripe /chat/event body (sub/gift/donation) ──────────────────────
function buildNativeBody() {
  const cents = Math.round(amountUsd * 100);
  if (eventType === 'sub') {
    return { kind: 'sub', subscriber: user, subscriberMatrixId: `@${user.toLowerCase()}:${server}`, usernameColor: null, tier, months, amount: cents, currency: currency.toLowerCase() };
  }
  if (eventType === 'gift') {
    return { kind: 'gift', gifter: user, anonymous: false, giftKind: count > 1 ? 'community' : 'direct', months, amount: cents,
      recipients: Array.from({ length: Math.max(1, count) }, (_, i) => ({ name: `Recip${i + 1}`, matrixId: `@recip${i + 1}:${server}` })) };
  }
  if (eventType === 'donation') {
    return { kind: 'donation', donor: user, donorMatrixId: `@${user.toLowerCase()}:${server}`, anonymous: false, amount: cents, currency: currency.toLowerCase(), message, usernameColor: null };
  }
  return null;
}

// Minimal authed POST to stream-api (mirrors lib/api.js's req for /chat/event).
async function postChatEvent(body) {
  const base = streamApiBase(); // no default — see lib/streamApiUrl.js
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.STREAM_API_SECRET) headers.Authorization = `Bearer ${process.env.STREAM_API_SECRET}`;
  const res = await fetch(`${base}/chat/event`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`stream-api POST /chat/event -> ${res.status} ${text}`);
  return text;
}

// ── run ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!platform || !eventType) { console.log(USAGE); process.exit(1); }

  if (platform === 'alert') {
    // Generic external-platform alert card (kofi/patreon/streamlabs/twitch/youtube
    // /kick): the 2nd positional is the SOURCE platform; --event sets the type.
    // Goes /alert → dispatch → system:'alert' card (colored by source platform).
    const src = eventType; // e.g. kofi / patreon / streamlabs
    // Provide the NUMERIC fields economics.takeHome needs per platform, so --send
    // credits the support bar + timer exactly like the real webhook would (a string
    // amount would parse to 0 and silently skip the bar).
    const a = { platform: src, username: user, message };
    if (src === 'patreon') {
      a.eventType = flags.event || 'pledge-create';
      a.cents = Math.round(amountUsd * 100); a.currency = currency;
      a.label = flags.label || 'pledged';
    } else {
      a.eventType = flags.event || 'donation';
      a.amount = amountUsd; a.currency = currency;
      a.label = flags.label || (a.eventType === 'donation' ? 'donated' : a.eventType);
    }
    console.log('ALERT → /alert:\n', JSON.stringify(a, null, 2));
    if (!flags.send) { console.log('\n(dry-run — pass --send to POST to stream-api /alert)'); return; }
    console.log('\nPOST /alert OK:', JSON.stringify(await postAlert(a)));
    return;
  }

  if (platform === 'native') {
    const body = buildNativeBody();
    if (!body) { console.error(`unknown native event "${eventType}" (sub|gift|donation)`); process.exit(1); }
    console.log('NATIVE /chat/event body:\n', JSON.stringify(body, null, 2));
    if (!flags.send) { console.log('\n(dry-run — pass --send to POST to stream-api /chat/event)'); return; }
    const out = await postChatEvent(body);
    console.log('\nPOST /chat/event OK:', out);
    return;
  }

  const raw = platform === 'youtube' ? buildYouTube() : platform === 'twitch' ? buildTwitch() : platform === 'kick' ? buildKick() : null;
  if (raw == null) { console.error(`unknown platform/event "${platform} ${eventType}"\n${USAGE}`); process.exit(1); }
  const alert = platform === 'youtube' ? normalizeYouTubeEvent(raw)
    : platform === 'kick' ? normalizeKickEvent(raw)
    : normalizeTwitchEvent(raw);

  console.log('RAW EVENT:\n', JSON.stringify(raw, null, 2));
  console.log('\nNORMALIZED ALERT:\n', alert == null ? '(null — normalizer suppressed this event)' : JSON.stringify(alert, null, 2));
  if (alert == null) return;
  if (!flags.send) { console.log('\n(dry-run — pass --send to POST to stream-api /alert)'); return; }
  const out = await postAlert(alert);
  console.log('\nPOST /alert OK:', JSON.stringify(out));
}

main().catch((e) => { console.error('\nSIMULATOR ERROR:', e.message); process.exit(1); });
