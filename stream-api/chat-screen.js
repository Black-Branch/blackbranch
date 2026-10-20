'use strict';
// POST /chat/screen { text } — would this text pass the checks a PERSON's message passes before it
// is posted? The word filter (blacklist.js) and the link gate (link-gate.js), judged exactly as
// for a site message. The chat bot (stream-ingest lib/bot/) asks before every reply, on every
// platform: its words are posted under the install's name, so they meet the same bar.
//
// A bot's line has no moderator queue to wait in, so anything a person's message would have
// held is simply not sent. Link-gate FLAG mode delivers for people, so it passes here too.
// Nothing is recorded: this is a question, not a hold.

const { classify } = require('./blacklist');
const linkGate = require('./link-gate');

const MAX_TEXT = 2000;

// Characters that hide a word from a filter while it still reads on screen: zero-width and
// direction controls, and C0 controls. The sender (the bot) strips them before it asks; a text
// that still carries one is refused, never judged around.
// eslint-disable-next-line no-control-regex -- detecting control characters is the point of this pattern
const HIDING = /[\u0000-\u0009\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/;

/** { ok: true } or { ok: false, reason } — pure over the current lists and posture. */
function screen(text) {
  const raw = String(text ?? '');
  if (!raw.trim() || raw.length > MAX_TEXT) return { ok: false, reason: 'length' };
  if (HIDING.test(raw)) return { ok: false, reason: 'hidden_characters' };
  // `||hidden||` marks are a site feature for people; a bot line is judged without them, and
  // judged on its compatibility form too (full-width or styled letters fold to plain ones).
  const t = raw.replace(/\|\|/g, '');
  const folded = t.normalize('NFKC');
  for (const candidate of folded === t ? [t] : [t, folded]) {
    const w = classify(candidate);
    if (w.action !== 'allow') return { ok: false, reason: `words:${w.action}` };
  }
  const words = classify(t);
  if (words.action !== 'allow') return { ok: false, reason: `words:${words.action}` };
  const links = linkGate.gate(t);
  if (links.action === 'hold' && linkGate.currentPosture() !== 'flag') return { ok: false, reason: `link:${links.reason}` };
  return { ok: true };
}

function registerChatScreen(app, { requireInternal, wrap }) {
  app.post('/chat/screen', requireInternal, wrap(async (req, res) => {
    res.json(screen(req.body?.text));
  }));
}

module.exports = { registerChatScreen, screen };
