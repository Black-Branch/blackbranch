// Public platform-chat commands: !karma / !rank, the pronoun commands, !dono.
//
// !karma / !rank answer for ONE platform account — the handle asked about (or the sender's) on the
// platform the command came from — never the merged person (review round 5, PB1): answering a
// Twitch handle with the person's site name, or with figures their other handles share, told the
// whole chat about a link the person keeps private. stream-api's /user/lookup?platform= decides
// (profiles.js): the identity's own answer, or the merged one when every account on the person
// shows its links (the one consent predicate, noOptOutSql).
//
// Reply formats:
//   identity  @handle — 12 messages · 3 streams · Member
//   merged    @name — <label> (10th) · Smart (4th) · Familiar · Chatter · Supporter
// <label> and its rank are a scoring plugin's (temperamentLabel / labelRank, which stream-api's
// /user/lookup carries only when that plugin is installed); without one the reply starts at the
// next part. intelligence is omitted when intelligenceTier is empty (<20 scored messages);
// support is omitted when supportTier is "None".

import { lookupUser, pronounCommand } from './api.js';
import { instanceConfig } from './instanceConfig.js';

function ordinal(n) {
  if (n == null) return '';
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function formatProfile(p) {
  const parts = [];
  if (p.scope === 'identity') {
    parts.push(plural(p.activity ?? 0, 'message'), plural(p.streams ?? 0, 'stream'));
    if (p.isMember) parts.push('Member');
    return `@${p.name} — ${parts.join(' · ')}`;
  }
  if (p.temperamentLabel) {
    parts.push(p.labelRank ? `${p.temperamentLabel} (${ordinal(p.labelRank)})` : p.temperamentLabel);
  }
  if (p.intelligenceTier) {
    parts.push(p.intelLabelRank ? `${p.intelligenceTier} (${ordinal(p.intelLabelRank)})` : p.intelligenceTier);
  }
  if (p.regularityTier) parts.push(p.regularityTier);
  if (p.wordCountTier) parts.push(p.wordCountTier);
  if (p.supportTier && p.supportTier !== 'None') parts.push(p.supportTier);
  return `@${p.name} — ${parts.join(' · ')}`;
}

/**
 * Detect and handle a !karma / !rank command.
 * @param {object} msg normalized message { message, platform, username, userId, canonicalId }
 * @param {{ lookup?: typeof lookupUser }} [deps]
 * @returns {Promise<string|null>} reply text to send, or null if not a command
 */
export async function handleKarmaCommand(msg, { lookup = lookupUser } = {}) {
  const text = (msg.message || '').trim();
  const m = text.match(/^!(karma|rank)\b\s*(.*)$/i);
  if (!m) return null;
  // Without the platform the lookup would be the merged person — never asked from public chat.
  const platform = typeof msg.platform === 'string' ? msg.platform.toLowerCase() : '';
  if (!platform) return null;

  const target = m[2].trim().replace(/^@/, '');
  try {
    // The answer is for one platform ACCOUNT, keyed by its handle: the sender asking about
    // themselves names the handle they are using now, with their own ids to find them by.
    let profile;
    if (target) {
      profile = await lookup({ platform, username: target });
    } else if (!msg.username) {
      return null;
    } else if (msg.canonicalId) {
      profile = await lookup({ platform, canonicalId: msg.canonicalId, username: msg.username });
    } else if (msg.userId) {
      profile = await lookup({ platform, userId: msg.userId, username: msg.username });
    } else {
      profile = await lookup({ platform, username: msg.username });
    }
    return formatProfile(profile);
  } catch (err) {
    if (/-> 404/.test(err.message)) {
      return target ? `@${target} has no record yet.` : null;
    }
    console.warn('[command] lookup failed:', err.message);
    return null;
  }
}

/**
 * Pronoun commands in platform chat — `!he`, `!she/her`, `!pronouns she`, `!pronouns any` …
 * stream-api's POST /identity/pronoun-command is the ONE parser (web asks it too); this
 * only turns its answer into a reply. The gate below is deliberately broad — it just
 * keeps `!dono` and friends from costing a request; the parser decides everything.
 * @returns {Promise<string|null>} reply text, or null if not a pronoun command
 */
const MAYBE_PRONOUNS = /^!(he|she|they|hehim|sheher|theythem|pronouns?)(\b|\/)/i;
export async function handlePronounCommand(msg, { ask = pronounCommand } = {}) {
  const text = (msg.message || '').trim();
  if (!MAYBE_PRONOUNS.test(text)) return null;
  try {
    const r = await ask({ text, canonicalId: msg.canonicalId, platform: msg.platform, userId: msg.userId });
    if (!r?.matched) return null;
    if (r.usage) return `@${msg.username} set them with !he, !she or !they (or !pronouns she/her).`;
    return r.pronouns ? `@${msg.username} got it, ${r.pronouns} from now on.` : `@${msg.username} cleared your pronouns.`;
  } catch (err) {
    console.warn('[command] pronoun command failed:', err.message);
    return null;
  }
}

/**
 * The !dono reply: the instance key money.supportLine (env DONO_LINKS), read at call time so an
 * edit applies to the next !dono. Unset = a line pointing at this site's own tip page, so an
 * install never advertises links it did not configure.
 */
export function donoLine(get = (k) => instanceConfig.get(k)) {
  const own = String(get('money.supportLine') || '').trim();
  if (own) return own;
  const origin = String(get('site.origin') || '').trim().replace(/\/$/, '');
  return origin ? `support the stream → ${origin}/donate` : 'support the stream on the site — tap Donate under the player';
}
/** !dono — post the support links. */
export function handleDonoCommand(msg, line = donoLine) {
  return /^!dono\b/i.test((msg.message || '').trim()) ? line() : null;
}

// ── No privileged commands in platform chat ─────────────────────────────────
// A command that authorizes on a DISPLAY NAME is not authorized: display names are
// per-platform, changeable, and collide freely across Twitch/YouTube/Kick. Any
// privileged command must gate on `canonicalId` (the identity spine) or the
// platform's own mod flag — never on a display name.
//
// Mod and admin commands (timer, support bar, emotes, the bot toggle) live on the
// SITE's `/` commands (web/app/lib/commands/spec.ts), not here: each platform has its
// own command language, and `opts.reply` is only supplied by platforms/twitch.js, so
// a platform-side mod command could only ever answer on Twitch.
//
// PUBLIC commands stay platform-side: !karma / !rank, !he / !she / !they, !dono.
