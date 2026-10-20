'use strict';
// Pronouns — the one parser and the one writer.
//
// Held on the canonical identity (stream.users.pronouns), so one value covers the
// site, Twitch, YouTube and Kick. Everything that sets them goes through here:
//   · the site's Edit profile / `/pronouns` and a mod's card (POST /identity/pronouns)
//   · `!he` `!she/her` `!pronouns she` … in any chat — web and stream-ingest ask
//     POST /identity/pronoun-command instead of carrying regexes of their own
//     (two parsers disagree on inputs like `!pronouns she/her`)
//   · a plain statement of one's OWN pronouns in chat, saved silently by chat.js
//     (no "saved" line — the bot just answers as normal, knowing them)
//   · alejo.io for Twitch chatters who set theirs there
//
// Precedence lives in the UPDATE's WHERE, not in JS: a 'self' or 'mod' write
// always lands; an 'alejo' write only onto a row that is EMPTY and unowned, or
// whose value came from alejo. A value with no source is a person's (older rows
// carry none). A clear keeps its source, so someone who chose "not set" is not
// refilled from alejo.io.

const { instanceConfig } = require('./instance-config');
const { NATIVE_PLATFORM } = require('./native-platform');

const PRONOUN_VALUES = ['he/him', 'she/her', 'they/them'];
const PRONOUN_SET = new Set(PRONOUN_VALUES);
const SOURCES = new Set(['self', 'mod', 'alejo']);
const SUBJECT = { he: 'he/him', she: 'she/her', they: 'they/them' };
const OBJECT = { him: 'he/him', her: 'she/her', them: 'they/them' };
const JOINED = { hehim: 'he/him', sheher: 'she/her', theythem: 'they/them' };
const CLEAR = new Set(['any', 'all', 'none', 'clear', 'any/all', 'all/any']);
const ALEJO = 'https://api.pronouns.alejo.io/v1';
const ALEJO_IDS = { hehim: 'he/him', sheher: 'she/her', theythem: 'they/them' };

// "she/her", "she/they" (a pair takes the first), "sheher", "she". null otherwise.
function readValue(word, { bare = true, object = false } = {}) {
  const w = String(word || '').trim().toLowerCase();
  if (JOINED[w]) return JOINED[w];
  const pair = /^(he|she|they)\/(he|she|they|him|her|them)$/.exec(w);
  if (pair) return SUBJECT[pair[1]];
  if (bare && SUBJECT[w]) return SUBJECT[w];
  if (object && OBJECT[w]) return OBJECT[w];
  return null;
}

/** `!she`, `!she/her`, `!pronouns she` … → { set } | { clear } | { usage }; null = not a pronoun command. */
function parsePronounCommand(text) {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t.startsWith('!')) return null;
  const bare = /^!(\S+)$/.exec(t);
  if (bare) {
    const v = readValue(bare[1]);
    if (v) return { set: v };
  }
  const cmd = /^!pronouns?(?:\s+(.*))?$/.exec(t);
  if (!cmd) return null;
  const arg = (cmd[1] || '').trim().replace(/\s+pronouns?$/, '');
  if (CLEAR.has(arg)) return { clear: true };
  const v = readValue(arg, { object: true });
  return v ? { set: v } : { usage: true };
}

/** The WHOLE message is a plain statement of the sender's own pronouns → the value; else null.
 *  A question, a quote, a negation, someone else's, or a longer sentence is never saved.
 *  A leading address to the bot ("hey <bot>, i use she/her") is dropped first; the bot's name is
 *  the instance key bot.name, read per call (unset = no address is recognised). */
function parseSelfStatement(text, botName = instanceConfig.get('bot.name')) {
  let t = String(text ?? '').trim().toLowerCase().replace(/[‘’]/g, "'");
  if (!t || t.length > 80 || /[?"“”]/.test(t)) return null;
  if (/\bnot\b|n't\b/.test(t)) return null;
  const name = String(botName || '').trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (name) t = t.replace(new RegExp(`^(?:(?:hey|yo)\\s+)?@?${name}[,:!]?\\s+`), '');
  t = t
    .replace(/[.!]+$/, '')
    .replace(/\s+(?:please|pls|thanks|thx|ty)$/, '')
    .replace(/^(?:please|pls)\s+/, '')
    .trim();
  const X = '([a-z]+(?:/[a-z]+)?)';
  let m = new RegExp(`^my pronouns are ${X}$`).exec(t);
  if (m) return readValue(m[1]);
  for (const re of [`^i go by ${X}$`, `^i use ${X}(?: pronouns)?$`, `^use ${X} for me$`, `^(?:i'm|im|i am) ${X}$`]) {
    m = new RegExp(re).exec(t);
    if (m) return readValue(m[1], { bare: false });
  }
  return null;
}

/** alejo.io's { pronoun_id, alt_pronoun_id } → one of the three, else null (the first id only). */
function fromAlejo(row) {
  return ALEJO_IDS[row?.pronoun_id] || null;
}

function createPronouns({ pool, resolveCanonical = async (c) => c, resolveOrCreate = null, fetchImpl = globalThis.fetch,
  now = Date.now, ttlMs = 60_000, alejoTimeoutMs = 3000 } = {}) {
  const cache = new Map();          // canonical → { v, at }
  const CACHE_MAX = 20000;
  const alejoAsked = new Set();     // canonicals asked this process — one claim query each, not one per message
  const ALEJO_ASKED_MAX = 50000;

  async function get(cid) {
    if (!cid) return null;
    const hit = cache.get(cid);
    if (hit && now() - hit.at < ttlMs) return hit.v;
    const { rows } = await pool.query('SELECT pronouns FROM stream.users WHERE id = $1', [cid]);
    const v = rows[0]?.pronouns || null;
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(cid, { v, at: now() });
    return v;
  }

  async function set(cid, value, source = 'self') {
    if (value != null && !PRONOUN_SET.has(value)) throw new Error('bad pronouns');
    if (!SOURCES.has(source)) throw new Error('bad source');
    const r = await pool.query(
      `UPDATE stream.users SET pronouns = $1::text, pronouns_source = $3::text
        WHERE id = $2 AND ($3::text <> 'alejo' OR pronouns_source = 'alejo' OR (pronouns IS NULL AND pronouns_source IS NULL))`,
      [value, cid, source]
    );
    cache.delete(cid);
    return r.rowCount > 0;
  }

  /** Fill a Twitch chatter from alejo.io. Once per person per process, once per week in the DB
   *  (the claim stamps alejo_checked_at first), a 3 s ceiling, and it never throws — chat.js
   *  does not await it. */
  async function maybeAlejo(cid, login) {
    const name = String(login || '').toLowerCase();
    if (!cid || !/^[a-z0-9_]{3,25}$/.test(name) || alejoAsked.has(cid)) return false;
    if (alejoAsked.size >= ALEJO_ASKED_MAX) alejoAsked.clear();
    alejoAsked.add(cid);
    try {
      const claim = await pool.query(
        `UPDATE stream.users SET alejo_checked_at = now()
          WHERE id = $1 AND (pronouns_source = 'alejo' OR (pronouns IS NULL AND pronouns_source IS NULL))
            AND (alejo_checked_at IS NULL OR alejo_checked_at < now() - interval '7 days')
          RETURNING id`,
        [cid]
      );
      if (!claim.rowCount) return false;
      const res = await fetchImpl(`${ALEJO}/users/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(alejoTimeoutMs) });
      if (!res.ok) return false;
      const v = fromAlejo(await res.json());
      return v ? await set(cid, v, 'alejo') : false;
    } catch (err) {
      console.warn('[pronouns] alejo.io lookup failed:', err.message);
      return false;
    }
  }

  // canonicalId | matrixId | platform+userId → canonical. A site account with no
  // identity yet gets one here, exactly as its first chat message would
  // (/chat/native's resolveOrCreate): otherwise a new member's first `!she` is
  // posted to chat and saved nowhere.
  async function resolveTarget({ canonicalId, matrixId, platform, userId, username }) {
    let cid = canonicalId || null;
    if (!cid && matrixId) cid = await resolveCanonical(null, matrixId);
    if (!cid && typeof matrixId === 'string' && matrixId.startsWith('@') && resolveOrCreate) {
      const name = (typeof username === 'string' && username.trim()) || matrixId.slice(1).split(':')[0];
      cid = await resolveOrCreate(NATIVE_PLATFORM, matrixId, name.slice(0, 64));
    }
    if (!cid && platform && userId) {
      const r = await pool.query('SELECT canonical FROM stream.links WHERE platform = $1 AND platform_id = $2', [platform, userId]);
      cid = r.rows[0]?.canonical || null;
    }
    return cid;
  }

  // A mod's `/pronouns @name`: the people who CHATTED under that name in the last
  // 30 days. Not stream.nameidx — it keeps one row per name, the first holder's,
  // so it could neither see a shared name nor find a
  // newer holder. → { cid } | { ambiguous } | { notFound }.
  async function resolveName(name) {
    const n = String(name || '').trim().replace(/^@/, '').toLowerCase().slice(0, 64);
    if (!n) return { notFound: true };
    const { rows } = await pool.query(
      `SELECT DISTINCT user_id FROM stream.chat_log
        WHERE created_at > now() - interval '30 days' AND lower(username) = $1 AND NOT is_bot
        LIMIT 2`,
      [n]
    );
    if (rows.length > 1) return { ambiguous: true };
    return rows[0] ? { cid: rows[0].user_id } : { notFound: true };
  }

  function registerPronounRoutes(app, { requireInternal, wrap }) {
    // POST /identity/pronouns — set/clear. Body: { pronouns, source?: 'self'|'mod',
    // canonicalId?|matrixId?|platform+userId? }. pronouns null clears.
    app.post('/identity/pronouns', requireInternal, wrap(async (req, res) => {
      const body = req.body || {};
      const pronouns = body.pronouns == null ? null : body.pronouns;
      const source = body.source == null ? 'self' : body.source;
      if (pronouns != null && !PRONOUN_SET.has(pronouns)) return res.status(400).json({ error: 'bad pronouns' });
      if (source !== 'self' && source !== 'mod') return res.status(400).json({ error: 'bad source' });
      const cid = await resolveTarget(body);
      if (!cid) return res.status(404).json({ error: 'no canonical identity' });
      await set(cid, pronouns, source);
      res.json({ ok: true, canonicalId: cid, pronouns });
    }));

    // POST /identity/pronoun-command — { text, source?: 'self'|'mod', <identity> | name, resolveOnly? } →
    // { matched:false } | { matched:true, usage:true } | { matched:true, pronouns, canonicalId }
    // (pronouns null = cleared) | a `name` answer { matched:true, ambiguous|notFound }.
    // `source: 'mod'` (and only it may pass `name`) is web's /api/mod/pronouns, which
    // checks the role first; this route only trusts its internal callers, like every other.
    app.post('/identity/pronoun-command', requireInternal, wrap(async (req, res) => {
      const body = req.body || {};
      const source = body.source == null ? 'self' : body.source;
      if (source !== 'self' && source !== 'mod') return res.status(400).json({ error: 'bad source' });
      if (body.name != null && source !== 'mod') return res.status(400).json({ error: 'only a mod names someone' });
      // resolveOnly: answer WHO a mod's name lookup lands on and write nothing — web checks the
      // moderation ceiling on that person before it asks again with the canonicalId.
      if (body.resolveOnly === true && body.name == null) return res.status(400).json({ error: 'resolveOnly needs a name' });
      const parsed = parsePronounCommand(body.text);
      if (!parsed) return res.json({ matched: false });
      if (parsed.usage) return res.json({ matched: true, usage: true });
      let cid;
      if (body.name != null) {
        const found = await resolveName(body.name);
        if (!found.cid) return res.json({ matched: true, ...found });
        if (body.resolveOnly === true) return res.json({ matched: true, canonicalId: found.cid, resolveOnly: true });
        cid = found.cid;
      } else {
        cid = await resolveTarget(body);
      }
      if (!cid) return res.status(404).json({ error: 'no canonical identity' });
      const pronouns = parsed.clear ? null : parsed.set;
      await set(cid, pronouns, source);
      res.json({ matched: true, pronouns, canonicalId: cid });
    }));
  }

  return { get, set, maybeAlejo, registerPronounRoutes };
}

module.exports = { parsePronounCommand, parseSelfStatement, fromAlejo, createPronouns, PRONOUN_VALUES };
