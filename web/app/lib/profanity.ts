// Behavior › Profanity filter.
// A VIEWER's choice, applied in their own browser: common English swear words
// become asterisks of the same length and the message stays. Off by default.
//
// Not the moderation list. app/lib/blacklist.ts decides what may be SENT
// (slurs are blocked or held there, ordinary swearing deliberately allowed);
// this only hides ordinary swearing from a reader who asked for it.
//
// Whole words only, each with its common endings spelled out — a bare substring
// match would eat "Scunthorpe", "class" and "cocktail".
//
// PURE and import-free: node --test imports it directly.

const FORMS = [
  "(?:mother)?fuck(?:s|ed|er|ers|ing|in|ery|face|head|wit)?",
  "(?:bull|horse|dip|chicken)?shit(?:s|ty|ting|ted|head|heads|show)?",
  "(?:dumb|jack|smart|fat|lazy)?ass(?:es|hole|holes|hat|hats)?",
  "arse(?:hole|holes)?",
  "bitch(?:es|y|ing|ed)?",
  "cunts?",
  // Bare "dick", "cock" and "prick" are names and plain words ("Dick Cheney",
  // "Moby Dick", "the cock crowed") on a political stream — compounds only.
  "dickheads?",
  "cocksuckers?",
  "piss(?:ed|es|ing)?",
  "bastards?",
  "(?:god)?damn(?:ed|it)?",
  "crap(?:py)?",
  "twats?",
  "wank(?:er|ers|ing)?",
  "sluts?",
  "whores?",
  "bollocks",
  "douche(?:bag|bags|s)?",
];

const RE = new RegExp(`\\b(?:${FORMS.join("|")})\\b`, "gi");

/** `text` with every listed swear word replaced by asterisks of its length. */
export function maskProfanity(text: string): string {
  return text.replace(RE, (w) => "*".repeat(w.length));
}
