// What each participation moment is worth, and whether it is due.
//
// Pure for the same reason storePricing.ts is: it decides what lands in
// someone's wallet, so it is property-tested rather than eyeballed. No imports:
// the client reads DEFAULT_EARN_RULES too (the sponsor clock's "2×"), so this file
// must not pull the settings schema into a browser bundle.
//
// The bounds are not decoration — each one closes a faucet that was measured on
// real chat data before it was chosen.

/** Every number the award functions apply. These are instance settings (`currency.earn.*`):
 *  the product's own numbers are the schema's defaults, an install edits them on
 *  Admin Panel → Site → Points, and coinsServer.ts reads them at call time. */
export type EarnRules = {
  /** Showing up and saying something, once per stream. */
  firstMessage: number;
  /** Any message, at most once per cooldown. */
  message: number;
  messageCooldownMs: number;
  /** Casting a vote, up or down — reading chat is participation too. */
  voteCast: number;
  /** Heavy voters already cast dozens of votes a stream unpaid; without a cap that number would
   *  simply migrate to whatever ceiling is set. */
  votesPerStreamCap: number;
  /** Someone else valuing your message. */
  upvoteReceived: number;
  /** Per VOTER, per stream — NOT per message. The (platform, message_id, voter) primary key
   *  already stops double-voting one message; the open faucet is two accounts upvoting each
   *  other across many messages. */
  paidUpvotesPerVoter: number;
  /** Without it, a long stream pays more for leaving a tab open than for taking part. This cap
   *  is what makes every rule above it matter. */
  watchCap: number;
  watchSecondsPerPoint: number;
  /** The clock perk: while a viewer's sponsor clock is lit, every
   *  PARTICIPATION award pays this many times its base. Watch is excluded on purpose — the
   *  per-stream watch cap is what keeps participation meaningful. */
  clockMultiplier: number;
};

/** The product's own rules, each bound measured before it was chosen. They are the
 *  `currency.earn.*` defaults in
 *  config/instance-schema.mjs; earnRules.test.ts pins the two together so they cannot drift.
 *  What the award functions use when a caller passes none (the tests). */
export const DEFAULT_EARN_RULES: EarnRules = Object.freeze({
  firstMessage: 5, message: 1, messageCooldownMs: 600_000, voteCast: 1, votesPerStreamCap: 25,
  upvoteReceived: 2, paidUpvotesPerVoter: 5, watchCap: 30, watchSecondsPerPoint: 600, clockMultiplier: 2,
});

/** Which setting feeds which rule, and its unit conversion (minutes → ms / s).
 *  @test-only earnRules.test.ts proves every key exists in the schema with a default equal to
 *  DEFAULT_EARN_RULES; earnRulesFrom below is the reader. */
export const EARN_RULE_KEYS: Readonly<Record<keyof EarnRules, readonly [key: string, scale: number]>> = {
  firstMessage: ["currency.earn.firstMessage", 1],
  message: ["currency.earn.message", 1],
  messageCooldownMs: ["currency.earn.messageCooldownMinutes", 60_000],
  voteCast: ["currency.earn.voteCast", 1],
  votesPerStreamCap: ["currency.earn.votesPerStream", 1],
  upvoteReceived: ["currency.earn.upvoteReceived", 1],
  paidUpvotesPerVoter: ["currency.earn.paidUpvotesPerVoter", 1],
  watchCap: ["currency.earn.watchCap", 1],
  watchSecondsPerPoint: ["currency.earn.watchMinutesPerPoint", 60],
  clockMultiplier: ["currency.earn.clockMultiplier", 1],
};

/** The rules from a resolver (key → resolved value). A value that is not a finite number falls
 *  to the product default for THAT rule only — the settings layer has already validated it, so
 *  this is a type guard, not a policy. */
export function earnRulesFrom(get: (key: string) => unknown): EarnRules {
  const out = { ...DEFAULT_EARN_RULES };
  for (const rule of Object.keys(EARN_RULE_KEYS) as (keyof EarnRules)[]) {
    const [key, scale] = EARN_RULE_KEYS[rule];
    const v = get(key);
    if (typeof v === "number" && Number.isFinite(v)) out[rule] = v * scale;
  }
  return out;
}

/** The BONUS row's amount for a base award — 0 when the clock is not lit. The
 *  base award is written unchanged; the bonus is a second ledger row, so a
 *  multiplier of 2 means "one more of the same". Never negative, never for a
 *  zero base (a capped or replayed award has nothing to double). Wired into
 *  the ledger by coinsServer.ts's createEarn. */
export function bonusFor(basePoints: number, clockActive: boolean, rules: EarnRules = DEFAULT_EARN_RULES): number {
  if (!clockActive || !(basePoints > 0)) return 0;
  return basePoints * (rules.clockMultiplier - 1);
}

export type MessageState = { firstAwarded: boolean; lastAwardMs: number | null };
/** `points` is the whole award; `firstPoints` + `messagePoints` are its two ledger
 *  rows (`earn_first`, `earn_chat`). The writer credits THESE, never literal
 *  numbers, so changing a rate moves the ledger and the chip together. */
export type MessageAward = {
  points: number; firstPoints: number; messagePoints: number; first: boolean; resetsCooldown: boolean;
};

export function messageAward(state: MessageState, nowMs: number, rules: EarnRules = DEFAULT_EARN_RULES): MessageAward {
  const first = !state.firstAwarded;
  const cooled = state.lastAwardMs === null || nowMs - state.lastAwardMs >= rules.messageCooldownMs;

  // An unpaid message returns resetsCooldown:false deliberately. Restarting
  // the cooldown on a message that paid nothing would let a chatty user push
  // their own next award further and further away — a penalty for talking.
  if (!first && !cooled) {
    return { points: 0, firstPoints: 0, messagePoints: 0, first: false, resetsCooldown: false };
  }

  // The first message always pays, cooldown or not: it is the first, so there
  // is nothing for a cooldown to have started yet.
  const firstPoints = first ? rules.firstMessage : 0;
  const messagePoints = rules.message;
  return { points: firstPoints + messagePoints, firstPoints, messagePoints, first, resetsCooldown: true };
}

export function voteCastAward(state: { votesAwarded: number }, rules: EarnRules = DEFAULT_EARN_RULES): number {
  return state.votesAwarded < rules.votesPerStreamCap ? rules.voteCast : 0;
}

export function upvoteReceivedAward(paidFromThisVoter: number, rules: EarnRules = DEFAULT_EARN_RULES): number {
  return paidFromThisVoter < rules.paidUpvotesPerVoter ? rules.upvoteReceived : 0;
}

export type WatchState = { watchPoints: number; watchSeconds: number };
export type WatchAward = { points: number; secondsLeft: number };

/** Whole coins out of accrued seconds, bounded by what the stream has left.
 *  The remainder carries, so a viewer is never charged the rounding.
 *
 *  At the cap the remainder is DISCARDED, not banked. Hoarding seconds there
 *  would quietly turn the cap into a delay — the next stream would open with a
 *  burst of coins earned against the previous one. */
export function watchAward(state: WatchState, rules: EarnRules = DEFAULT_EARN_RULES): WatchAward {
  const room = Math.max(0, rules.watchCap - state.watchPoints);
  const earnable = Math.floor(state.watchSeconds / rules.watchSecondsPerPoint);
  const points = Math.min(earnable, room);
  // Discard the remainder the moment the cap is REACHED, not only once already
  // sitting at it; keeping it would pay seconds earned past the cap at the
  // start of the next stream.
  if (points >= room) return { points, secondsLeft: 0 };
  return { points, secondsLeft: state.watchSeconds - points * rules.watchSecondsPerPoint };
}
