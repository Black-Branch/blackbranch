// Emote stripping + clean word count. The clean_word_count stored with each row
// feeds the scoring and memory gates, so changing these rules changes which
// messages those gates admit.

// Global emotes: Twitch's own and the third-party globals every channel shows. A channel's own
// emotes are NOT here — they are that install's, and come from its plugin (registerChannelEmotes):
// a product file naming one channel's emotes would ship that channel to every install.
export const GLOBAL_EMOTES = Object.freeze([
  'KEKL', 'KEKW', 'LUL', 'LULW', 'Pog', 'PogChamp', 'OMEGALUL', 'PowerUpL', 'PowerUpR', 'o7',
  'FeelsBeanMan', 'YEP', 'PepeHands', 'TheIlluminati', 'peepoHappy', 'NotLikeThis',
]);

const WORD = /^[A-Za-z0-9]+$/;
const wordsRe = (words) => (words.length ? new RegExp(`\\b(?:${words.join('|')})\\b`, 'g') : null);
let namesRe = wordsRe(GLOBAL_EMOTES);
let prefixRe = null;

/**
 * This channel's own emotes, from the install's plugin: its emote PREFIX (Twitch sub emotes are
 * prefix + name; a name in lowercase or digits slips past the camel-case rule below) and the
 * third-party emotes it added. Each is a plain word — anything else would be a regex. Replaces
 * what an earlier call set; {} clears it.
 * @param {{ prefixes?: string[], names?: string[] }} channel
 */
export function registerChannelEmotes({ prefixes = [], names = [] } = {}) {
  for (const w of [...prefixes, ...names]) {
    if (typeof w !== 'string' || !WORD.test(w)) throw new Error(`channel emotes: "${w}" — plain letters and digits only`);
  }
  prefixRe = prefixes.length ? new RegExp(`\\b(?:${prefixes.join('|')})[A-Za-z0-9]+\\b`, 'g') : null;
  namesRe = wordsRe([...GLOBAL_EMOTES, ...names]);
}

/**
 * Strip emotes/emoticons from a message, leaving only real words.
 * @param {string} message raw message text (NOT html)
 * @returns {string} cleaned text
 */
export function stripEmotes(message) {
  if (!message) return '';
  let s = message;
  if (prefixRe) s = s.replace(prefixRe, '');                // this channel's prefix emotes
  return s
    .replace(/\b[a-z]{2,}[0-9]*[A-Z][a-zA-Z0-9]+\b/g, '')   // user-prefix emotes (e.g. rhyzRIOT)
    .replace(namesRe, '')                                   // globals + this channel's own
    .replace(/(?:^|\s)[:;xX8]-?[)(DP/\\|oO](?:\s|$)/g, ' ') // ASCII emoticons
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Count whitespace-delimited words in cleaned text.
 * @param {string} clean output of stripEmotes()
 * @returns {number}
 */
export function cleanWordCount(clean) {
  return clean ? clean.split(/\s+/).filter(Boolean).length : 0;
}
