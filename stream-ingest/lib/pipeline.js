// Central message pipeline: strip emotes, count words, POST /chat, then hand the
// message to the registered scorer (lib/scoring.js, if any) and fire the embedding hook.
//
// Each platform connector builds a normalized message and calls processMessage.

import { stripEmotes, cleanWordCount } from './emotes.js';
import { automodOn, platformCheckable, checkPlatformMessage } from './automod.js';
import { ai } from './ai.js';
import { postChat } from './api.js';
import { scorer } from './scoring.js';
import { embedMessage } from './embeddings.js';
import {
  handleKarmaCommand, handlePronounCommand, handleDonoCommand,
} from './commands.js';
import { getStreamId } from './session.js';
import { createWorkQueue } from './workQueue.js';
import { makeRunAlarm } from './ops.js';
import { instanceConfig } from './instanceConfig.js';

// A run of failed chat deliveries means the site is receiving no chat at all.
// The threshold is higher than the impressions one because this path runs per
// MESSAGE — a busy stream would cross a low threshold on a two-second blip.
const chatDeliveryAlarm = makeRunAlarm({
  key: 'ingest.chat-delivery-failing',
  title: 'Chat not reaching stream-api',
  after: Number(process.env.INGEST_CHAT_ALARM_AFTER || 10),
});

// Instance key chat.botUsernames (env BOT_USERNAMES, else the stored list), read per message
// and lower-cased here.
const botUsernames = () => new Set((instanceConfig.get('chat.botUsernames') || []).map((u) => u.toLowerCase()));
const COMMANDS_ENABLED = process.env.ENABLE_COMMANDS !== '0';

// ── Bounded pipelines ───────────────────────────────────────────────────────
// Delivery (POST /chat → broadcast) is the priority and must never be dropped,
// so it gets a healthy worker pool and a high backlog ceiling. Enrichment
// (scoring/automod/embedding — all model calls) is best-effort and shares a
// small, low-concurrency pool so a chat burst can't spawn dozens of concurrent
// model calls; when delivery falls behind, enrichment is shed first.
const DELIVERY_CONCURRENCY = Number(process.env.INGEST_DELIVERY_CONCURRENCY || 6);
const DELIVERY_MAX_QUEUE   = Number(process.env.INGEST_DELIVERY_MAX || 2000);
const ENRICH_CONCURRENCY   = Number(process.env.INGEST_ENRICH_CONCURRENCY || 2);
const ENRICH_MAX_QUEUE     = Number(process.env.INGEST_ENRICH_MAX || 200);
// Above this delivery backlog, skip enrichment entirely to keep chat flowing.
export const SHED_ENRICH_AT = Number(process.env.INGEST_SHED_AT || 100);

let droppedDeliveries = 0;
let droppedEnrichments = 0;
const deliveryQ = createWorkQueue({
  concurrency: DELIVERY_CONCURRENCY,
  maxQueue: DELIVERY_MAX_QUEUE,
  onDrop: () => {
    if (droppedDeliveries++ % 50 === 0)
      console.warn(`[pipeline] delivery queue saturated — dropped ${droppedDeliveries} messages`);
  },
});
const enrichQ = createWorkQueue({
  concurrency: ENRICH_CONCURRENCY,
  maxQueue: ENRICH_MAX_QUEUE,
  // Shedding enrichment is a real degradation — the bot stops seeing messages it would
  // otherwise remember — so it is logged; without the line a saturated enrich queue looks
  // exactly like an idle one.
  onDrop: () => {
    if (droppedEnrichments++ % 50 === 0)
      console.warn(`[pipeline] enrich queue saturated — shed ${droppedEnrichments} messages`);
  },
});

// What a journal line may say about who sent a message and what they typed: the platform's own
// user id (`?` when the platform gave none) and, for a command, only its first word, cut short.
// Never the name and never the rest of the line — a name is personal data the journal keeps for
// months (stream-api/log-names.test.js), and the words after `!karma` are the viewer's.
const COMMAND_WORD_MAX = 24;
const logWho = (msg) => `${msg.platform} user=${msg.userId || '?'}`;
const commandWord = (raw) => raw.split(/\s/, 1)[0].slice(0, COMMAND_WORD_MAX);
// The bot's reply is its own text, but it addresses the viewer by name (`@casey got it, …`),
// so every @mention is masked before the preview is written.
const replyPreview = (reply) => (reply
  ? JSON.stringify(String(reply).replace(/@\S+/g, '@…').slice(0, 50))
  : 'null');

function isBotUser(msg) {
  return Boolean(msg.isBot) || botUsernames().has((msg.username || '').toLowerCase());
}

/**
 * @param {object} msg normalized message:
 *   { platform, userId, username, message, isMod, isVip, isMember, tier,
 *     isBot?, emotes?:{name:url}, replyToUsername?, replyToText? }
 * @param {object} [opts]
 * @param {(text:string)=>Promise<void>} [opts.reply] platform reply fn for commands
 */
export function processMessage(msg, opts = {}) {
  const raw = (msg.message || '').trim();
  if (!raw) return;

  // Cheap, synchronous prep only — then hand off to the bounded delivery pool.
  // Returns immediately so the connector's WS handler never blocks on the
  // stream-api round-trip, which would add latency under a burst.
  const isBot = isBotUser(msg);
  const isCommand = raw.startsWith('!');
  const clean = stripEmotes(raw);
  const words = cleanWordCount(clean);

  deliveryQ.push(() => deliver({ msg, raw, clean, words, isBot, isCommand, opts }));
}

/**
 * A best-effort enrichment job from outside the platform pipeline: the same small pool, shed on
 * the same backlog rule, so site chat can never outrun platform delivery.
 * @parked plugin API: a plugin's native (site) message scorer queues its jobs here; no
 * product code does.
 */
export function queueEnrichment(job) {
  if (deliveryQ.size > SHED_ENRICH_AT) return false;
  enrichQ.push(job);
  return true;
}

// Delivery job: log the message (single POST), handle commands, then schedule
// best-effort enrichment. Drained by the bounded delivery worker pool.
// Enrichment (scoring + embedding) is best-effort: skip for bots, shed it
// entirely while delivery is backed up so chat keeps flowing under a burst —
// and only ever for a row that EXISTS. A dedup-suppressed echo answers
// `{ suppressed: true }` and may carry no id at all (the text-window path
// knows no native row); scoring it would PATCH `/chat/undefined/karma`, which
// stream-api rejects. The id check is the same shape stream-api's route
// enforces: digits or nothing.
export function shouldEnrich({ logged, isBot, backlog }) {
  if (isBot || backlog > SHED_ENRICH_AT) return false;
  if (!logged || logged.suppressed) return false;
  return /^\d+$/.test(String(logged.id ?? ''));
}

async function deliver({ msg, raw, clean, words, isBot, isCommand, opts }) {
  let logged;
  try {
    logged = await postChat({
      platform: msg.platform,
      userId: msg.userId || '',
      username: msg.username,
      message: raw,
      streamId: getStreamId(),
      isBot,
      isMod: Boolean(msg.isMod),
      isBroadcaster: Boolean(msg.isBroadcaster),
      isVip: Boolean(msg.isVip),
      isMember: Boolean(msg.isMember),
      tier: msg.tier || '',
      cleanWordCount: words,
      emotes: msg.emotes && Object.keys(msg.emotes).length ? msg.emotes : undefined,
      replyToUsername: msg.replyToUsername || undefined,
      replyToText: msg.replyToText || undefined,
      platformMsgId: msg.platformMsgId || undefined,
      usernameColor: msg.usernameColor || undefined,
      avatarUrl: msg.avatarUrl || undefined,
      login: msg.login || undefined,
    });
  } catch (err) {
    // The platform and user id come from the platform: they ride as an argument, never in the
    // format string, so a `%` in them cannot consume err.message.
    console.warn('[pipeline] POST /chat failed (%s):', logWho(msg), err.message);
    // This return drops a chat message. `deliver` is called un-awaited from every
    // platform adapter, so nothing upstream can tell — the viewer's line never
    // reaches the site, the overlay, the log or the bot. The run alarm makes a
    // sustained failure visible beyond this warn line.
    // The log line carries the platform user id, never the name; the alarm carries
    // only the platform (a notification renders on a lock screen).
    chatDeliveryAlarm.fail(`platform ${msg.platform}`);
    return;
  }
  chatDeliveryAlarm.ok();

  // Commands: reply, never score. NEVER dispatch a command from a bot/self message —
  // The bot's own LLM output can begin with '!' and must never execute a command against
  // the privileged handlers (LLM→command injection). This mirrors the !isBot
  // gate on the enrichment path below. Bot '!'-messages fall through to the isBot
  // return below (delivered, not dispatched, not scored).
  if (isCommand && !isBot) {
    if (COMMANDS_ENABLED && opts.reply) {
      try {
        const cmdMsg = { ...msg, canonicalId: logged.canonicalId };
        // Mod commands are not handled in platform chat — see the note at the
        // foot of lib/commands.js. Only the PUBLIC ones are.
        const reply = await handleKarmaCommand(cmdMsg)
          || await handlePronounCommand(cmdMsg)
          || handleDonoCommand(cmdMsg);
        console.log(`[cmd-debug] ${logWho(msg)} cmd=${commandWord(raw)} mod=${!!msg.isMod} bc=${!!msg.isBroadcaster} -> ${replyPreview(reply)}`);
        if (reply) await opts.reply(reply);
      } catch (err) {
        console.warn('[pipeline] command reply failed:', err.message);
      }
    } else {
      console.log(`[cmd-debug] SKIPPED ${logWho(msg)} cmd=${commandWord(raw)} enabled=${COMMANDS_ENABLED} reply=${!!opts.reply}`);
    }
    return;
  }

  // Automod: judged after relay (never on the delivery path). A message the pool sheds under a
  // backlog goes unchecked, and is counted as such.
  const automodWanted = automodOn() && platformCheckable(msg, isBot) && logged && !logged.suppressed;
  if (!shouldEnrich({ logged, isBot, backlog: deliveryQ.size })) {
    if (automodWanted) ai.noteUnchecked('automod.classify');
    return;
  }
  if (automodWanted) {
    enrichQ.push(() =>
      checkPlatformMessage({ msg, canonicalId: logged.canonicalId, text: raw })
        .catch((err) => console.warn(`[pipeline] automod check failed id=${logged.id}: ${err.message}`))
    );
  }

  // Scoring is a plugin's (lib/scoring.js): with none registered, nothing is scored.
  const active = scorer();
  if (active) for (const job of active.platformJobs({ id: logged.id, clean, words })) enrichQ.push(job);
  if (words >= instanceConfig.get('memory.minWords')) {
    enrichQ.push(() =>
      embedMessage({ source: 'platform', sourceId: logged.id, username: msg.username, message: clean })
        .catch((err) => console.warn(`[pipeline] embed failed id=${logged.id}: ${err.message}`))
    );
  }
}
