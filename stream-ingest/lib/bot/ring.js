// Recent chat for the simple chat bot.
//
// An in-memory ring fed by the live feed this process already hears (site messages and every
// relayed platform message), seeded from the `history` frame stream-api replays on connect — no
// route of its own. It keeps the last 30 entries or 3,000 characters, whichever is smaller; each
// entry is { name, platform, text, own }, its text at most 200 characters. A delete or purge frame
// drops the entries it names. Encrypted messages and event cards are never added. The bot's own
// lines stay, marked `own` — decided by the caller from VERIFIED identity, never from a name.
// Entries are data: the prompt renders them as quoted JSON (prompt.js), so a name or a message
// can never pose as the prompt's own structure.

const MAX_LINES = 30;
const MAX_CHARS = 3000;
const TEXT_CHARS = 200;

const keyOf = (platform, id) => `${platform || '?'}:${id}`;

/** Should this frame (a `message` frame, or a row of a `history` frame) be in recent chat? */
export function ringWorthy(f) {
  return !!f && f.id != null && typeof f.message === 'string' && f.message.trim() !== '' &&
    !f.deleted && !f.encrypted && !f.system && typeof f.username === 'string' && f.username !== '';
}

/** One spoken item as data: control characters out, whitespace folded, bounded. */
export function cleanSpoken(s, max) {
  // eslint-disable-next-line no-control-regex -- removing control characters is this function's job
  return String(s ?? '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function createRing({ maxLines = MAX_LINES, maxChars = MAX_CHARS, textChars = TEXT_CHARS } = {}) {
  /** @type {{ key: string, entry: { name: string, platform: string, text: string, own: boolean } }[]} */
  let rows = [];
  const size = (e) => e.name.length + e.platform.length + e.text.length + 4;
  const total = () => rows.reduce((n, r) => n + size(r.entry), 0);
  function trim() {
    while (rows.length > maxLines || (rows.length && total() > maxChars)) rows.shift();
  }
  function add(f, own = false) {
    if (!ringWorthy(f)) return;
    const key = keyOf(f.platform, f.id);
    if (rows.some((r) => r.key === key)) return;
    const entry = { name: cleanSpoken(f.username, 40), platform: cleanSpoken(f.platform || 'chat', 16), text: cleanSpoken(f.message, textChars), own: own === true };
    if (!entry.text) return;
    rows.push({ key, entry });
    trim();
  }
  return {
    add,
    /** Replace the ring with a history replay (oldest first). */
    seed(messages, isOwn = () => false) {
      rows = [];
      for (const m of Array.isArray(messages) ? messages : []) add(m, isOwn(m));
    },
    drop(platform, id) { const k = keyOf(platform, id); rows = rows.filter((r) => r.key !== k); },
    /** Entries oldest → newest, the trigger excluded when given. Copies — never the ring itself. */
    entries(exceptKey = null) { return rows.filter((r) => r.key !== exceptKey).map((r) => ({ ...r.entry })); },
    size: () => rows.length,
    chars: total,
    keyOf,
  };
}
