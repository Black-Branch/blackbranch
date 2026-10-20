// The simple chat bot.
//
// HEARING: the live feed this process already holds (the settings layer's internal socket —
// site messages and every relayed platform message). Recent chat is kept from boot, whatever
// the bot's switch says, so a bot switched on mid-stream already knows the room. It answers a
// message that mentions its name (`bot.name`, "Bot" unset), and never itself: lines from
// `bot.matrixId`, from `chat.botUsernames`, or from the Twitch account it speaks as.
//
// SPEAKING follows the linked bot accounts: a site message is answered on the site
// when `bot.matrixId` is set; a Twitch message on Twitch when the home Twitch connection is
// signed in as the bot account. Anything else is skipped silently and counted. Every reply first
// passes the word filter and link gate a person's message meets (stream-api /chat/screen).
//
// THINKING: the behavior file + recent chat (+ remembered lines when memory is on), on the
// `bot.reply` task. One reply in flight, 20 s per person, 6 a minute overall.
//
// Started and stopped by the supervisor (bot.enabled + the task resolves + no plugin brings its
// own bot); this module names no plugin.

import { instanceConfig } from '../instanceConfig.js';
import { ai } from '../ai.js';
import { postChatNative, screenText, searchMemory } from '../api.js';
import { embedText } from '../embeddings.js';
import { getAccessToken } from '../twitchToken.js';
import { parseBotBehavior } from '../instanceSchema.generated.js';
import { createRing, ringWorthy } from './ring.js';
import { NATIVE_PLATFORM, isNativePlatform } from '../native-platform.js';
import { buildSystem, buildUserTurn, fitReply } from './prompt.js';

const SLOT = 'bot.reply';
const FALLBACK_NAME = 'Bot';
const PER_USER_MS = 20_000;
const PER_MINUTE = 6;
const REPLY_LIMIT = { site: 480, twitch: 450 };

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does `text` mention `name` as a word (optionally @-tagged)? Pure. */
export function mentions(text, name) {
  if (!name || typeof text !== 'string') return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}_])@?${escapeRe(name)}($|[^\\p{L}\\p{N}_])`, 'iu').test(text);
}

function hostOf(origin) { try { return new URL(origin).host; } catch { return ''; } }

/**
 * @test-only the factory exists so tests drive a bot with their own settings, model, senders and
 * clock; production uses `startBotFeed` below.
 */
export function createBot({
  cfg = instanceConfig, wrapper = ai, twitch = () => null,
  api = { postChatNative, screenText, searchMemory }, embed = embedText,
  twitchLogin = () => (process.env.TWITCH_BOT_USERNAME || '').toLowerCase(),
  twitchSignedIn = () => !!getAccessToken(),
  now = () => Date.now(), log = console,
} = {}) {
  const ring = createRing();
  const lastByPerson = new Map();
  const recentReplies = [];
  const counts = { replies: 0, skippedUnlinked: 0, screened: 0, failed: 0, cooldown: 0 };
  let replying = false;
  let inFlight = false;

  const name = () => cfg.get('bot.name') || FALLBACK_NAME;
  // Names that are VERIFIED to be a bot: the operator's own list, and the Twitch login this
  // process is signed in as. Never bot.name — a display name anyone can take.
  const ownNames = () => new Set([...(cfg.get('chat.botUsernames') || []), twitchLogin()].filter(Boolean).map((n) => String(n).toLowerCase()));

  /** Is this line the bot's own (or another listed bot's)? By server-side identity only: the
   *  site account the message was stored under, or a platform login listed as a bot. */
  function isOwn(f) {
    const id = cfg.get('bot.matrixId');
    if (isNativePlatform(f.platform)) return !!id && f.matrixId === id;
    return ownNames().has(String(f.username || '').toLowerCase());
  }

  /** Where the bot can speak right now: the site, and Twitch as which login. */
  function speakOn() {
    const login = twitchLogin();
    const h = twitch();
    return { site: !!cfg.get('bot.matrixId'), twitch: h && typeof h.sendMessage === 'function' && login && twitchSignedIn() ? login : null };
  }

  function wanted() {
    return cfg.get('bot.enabled') === true && wrapper.route(SLOT).enabled && !wrapper.providesBot();
  }

  async function memories(text) {
    const s = cfg.get('memory.state');
    if (!s || s.status !== 'on' || cfg.get('memory.enabled') !== true) return [];
    try {
      const vector = await embed(text);
      if (!vector) return [];
      const r = await api.searchMemory({ vector, excludeNames: [...ownNames()], excludeMatrixIds: [cfg.get('bot.matrixId')].filter(Boolean) });
      return Array.isArray(r?.rows) ? r.rows : [];
    } catch (e) {
      log.warn(`[bot] memory unavailable for this reply: ${e.code || e.status || e.message}`);
      return [];
    }
  }

  async function reply(f) {
    const parsed = parseBotBehavior(cfg.content('bot.behavior'));
    if (!parsed.ok) log.warn(`[bot] the stored behavior file does not parse (${parsed.error}) — using the default`);
    const behavior = parsed.ok ? parsed.value : parseBotBehavior(null).value;
    const site = cfg.get('site.name') || hostOf(cfg.get('site.origin')) || 'this site';
    const { system } = buildSystem({ name: name(), site, behavior });
    const user = buildUserTurn({
      memories: await memories(f.message),
      recent: ring.entries(ring.keyOf(f.platform, f.id)),
      trigger: { username: f.username, platform: f.platform, message: f.message },
    });
    const out = await wrapper.chat(SLOT, { system, messages: [{ role: 'user', content: user }] });
    const platform = f.platform === 'twitch' ? 'twitch' : 'site';
    let text = fitReply(out.text, REPLY_LIMIT[platform]);
    if (!text) return 'empty';
    if (platform === 'twitch') text = fitReply(`@${f.username} ${text}`, REPLY_LIMIT.twitch + 30);
    const verdict = await api.screenText(text);
    if (!verdict || verdict.ok !== true) {
      counts.screened++;
      log.warn(`[bot] reply not sent: it would not pass the chat filter (${verdict?.reason || 'unknown'})`);
      return 'screened';
    }
    if (platform === 'twitch') {
      await twitch().sendMessage(text);
    } else {
      const payload = { matrixId: cfg.get('bot.matrixId'), username: name(), message: text };
      if (typeof f.id === 'number' || /^\d+$/.test(String(f.id))) {
        payload.reply_to_id = Number(f.id);
        payload.reply_to_username = f.username;
        payload.reply_to_text = String(f.message).slice(0, 100);
      }
      await api.postChatNative(payload);
    }
    counts.replies++;
    return 'sent';
  }

  /** A message frame that may be for the bot. Resolves what happened (tests read it). */
  async function consider(f) {
    if (!replying || isOwn(f) || !ringWorthy(f) || !mentions(f.message, name())) return 'ignored';
    const where = isNativePlatform(f.platform) ? (speakOn().site ? 'site' : null) : f.platform === 'twitch' ? speakOn().twitch : null;
    if (!where) { counts.skippedUnlinked++; return 'skipped_unlinked'; }
    const t = now();
    const person = `${f.platform}:${String(f.username).toLowerCase()}`;
    while (recentReplies.length && t - recentReplies[0] > 60_000) recentReplies.shift();
    if (inFlight || t - (lastByPerson.get(person) || 0) < PER_USER_MS || recentReplies.length >= PER_MINUTE) { counts.cooldown++; return 'cooldown'; }
    inFlight = true;
    lastByPerson.set(person, t);
    recentReplies.push(t);
    try {
      return await reply(f);
    } catch (e) {
      counts.failed++;
      log.warn(`[bot] reply failed: ${e.code || e.message}`);
      return 'failed';
    } finally {
      inFlight = false;
    }
  }

  /** Every frame on the internal feed. Recent chat is kept always; replies only while switched on. */
  function onFrame(text) {
    if (!text.includes('"type"')) return null;
    let f;
    try { f = JSON.parse(text); } catch { return null; }
    if (!f || typeof f !== 'object') return null;
    if (f.type === 'history') { ring.seed(f.messages, isOwn); return null; }
    if (f.type === 'delete') { ring.drop(f.platform || NATIVE_PLATFORM, f.messageId); return null; }
    if (f.type === 'purge') { for (const x of Array.isArray(f.ids) ? f.ids : []) ring.drop(x.platform, x.id); return null; }
    if (f.type !== 'message') return null;
    ring.add(f, isOwn(f));
    return consider(f);
  }

  return {
    onFrame, consider, wanted, speakOn, ring,
    /** The supervisor's start: replies on until the returned stop. */
    startReplies() { replying = true; log.log(`[bot] answering mentions of "${name()}"`); return () => { replying = false; log.log('[bot] stopped answering'); }; },
    report: () => ({ speakOn: speakOn(), ...counts }),
  };
}

/** Boot: hear the feed from the start (recent chat), and hand the supervisor the switch. */
export function startBotFeed({ cfg = instanceConfig, twitch = () => null } = {}) {
  const bot = createBot({ cfg, twitch });
  const off = cfg.onMessage((text) => { const p = bot.onFrame(text); if (p && p.catch) p.catch(() => {}); });
  return { bot, stop: off };
}
