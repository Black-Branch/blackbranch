import { test } from "node:test";
import assert from "node:assert/strict";
import { INSTANCE_KEYS } from "./instanceSchema.generated.mjs";
import {
  DEFAULT_EARN_RULES, EARN_RULE_KEYS, earnRulesFrom,
  messageAward, voteCastAward, upvoteReceivedAward, watchAward, bonusFor,
} from "./earnRules.ts";

// The product's rules under their original names, so every example below still reads as the
// published number it is.
const EARN = DEFAULT_EARN_RULES;
const MESSAGE_COOLDOWN_MS = EARN.messageCooldownMs;
const VOTES_PER_STREAM_CAP = EARN.votesPerStreamCap;
const PAID_UPVOTES_PER_VOTER = EARN.paidUpvotesPerVoter;
const WATCH_POINTS_CAP = EARN.watchCap;
const CLOCK_MULTIPLIER = EARN.clockMultiplier;

const T0 = 1_700_000_000_000;

test("the first message of a stream pays the bonus AND the message point", () => {
  // They are separate awards on purpose: the +5 marks showing up, the +1 marks
  // saying something. Collapsing them would make a lurker's first word worth
  // the same as a regular message.
  assert.deepEqual(messageAward({ firstAwarded: false, lastAwardMs: null }, T0),
    { points: EARN.firstMessage + EARN.message, firstPoints: EARN.firstMessage, messagePoints: EARN.message, first: true, resetsCooldown: true });
});

test("a message inside the cooldown pays nothing and does not restart it", () => {
  // Restarting the cooldown on an UNPAID message would let a chatty user
  // push their own next award further and further away — a penalty for
  // talking, which is the opposite of the intent.
  const state = { firstAwarded: true, lastAwardMs: T0 };
  assert.deepEqual(messageAward(state, T0 + 1_000),
    { points: 0, firstPoints: 0, messagePoints: 0, first: false, resetsCooldown: false });
  assert.deepEqual(messageAward(state, T0 + MESSAGE_COOLDOWN_MS - 1),
    { points: 0, firstPoints: 0, messagePoints: 0, first: false, resetsCooldown: false });
});

test("a message exactly on the cooldown boundary pays", () => {
  assert.deepEqual(messageAward({ firstAwarded: true, lastAwardMs: T0 }, T0 + MESSAGE_COOLDOWN_MS),
    { points: EARN.message, firstPoints: 0, messagePoints: EARN.message, first: false, resetsCooldown: true });
});

test("the first message pays even when a cooldown somehow already exists", () => {
  // Defensive: there is nothing for the cooldown to have started yet, so a
  // stale lastAwardMs must not swallow the once-per-stream bonus.
  assert.deepEqual(messageAward({ firstAwarded: false, lastAwardMs: T0 }, T0 + 1),
    { points: EARN.firstMessage + EARN.message, firstPoints: EARN.firstMessage, messagePoints: EARN.message, first: true, resetsCooldown: true });
});

test("votes cast pay 1 each up to the cap, then nothing", () => {
  assert.equal(voteCastAward({ votesAwarded: 0 }), EARN.voteCast);
  assert.equal(voteCastAward({ votesAwarded: VOTES_PER_STREAM_CAP - 1 }), EARN.voteCast);
  assert.equal(voteCastAward({ votesAwarded: VOTES_PER_STREAM_CAP }), 0);
  assert.equal(voteCastAward({ votesAwarded: VOTES_PER_STREAM_CAP + 99 }), 0);
});

test("an upvote pays the recipient until that ONE voter has paid 5 times", () => {
  // The (platform, message_id, voter) key already stops double-voting one
  // message. This is the other faucet: two accounts upvoting each other across
  // many messages, which modelled out as the top earner's largest single line.
  assert.equal(upvoteReceivedAward(0), EARN.upvoteReceived);
  assert.equal(upvoteReceivedAward(PAID_UPVOTES_PER_VOTER - 1), EARN.upvoteReceived);
  assert.equal(upvoteReceivedAward(PAID_UPVOTES_PER_VOTER), 0);
  assert.equal(upvoteReceivedAward(PAID_UPVOTES_PER_VOTER + 50), 0);
});

test("watch pays whole coins from accrued seconds, capped per stream", () => {
  // 1 coin per 10 minutes, and the remainder carries so a viewer is never
  // charged the rounding.
  assert.deepEqual(watchAward({ watchPoints: 0, watchSeconds: 599 }),
    { points: 0, secondsLeft: 599 });
  assert.deepEqual(watchAward({ watchPoints: 0, watchSeconds: 600 }),
    { points: 1, secondsLeft: 0 });
  assert.deepEqual(watchAward({ watchPoints: 0, watchSeconds: 1_355 }),
    { points: 2, secondsLeft: 155 });
});

test("watch stops paying at the cap, and stops hoarding seconds there", () => {
  // At the cap, banked seconds must NOT keep accumulating toward a burst the
  // moment the next stream starts — that would quietly turn the cap into a
  // delay. This is the existing system's behaviour and it is deliberate.
  assert.deepEqual(watchAward({ watchPoints: WATCH_POINTS_CAP, watchSeconds: 5_000 }),
    { points: 0, secondsLeft: 0 });
  // One short of the cap: pays exactly one, not the three it has seconds for.
  assert.deepEqual(watchAward({ watchPoints: WATCH_POINTS_CAP - 1, watchSeconds: 1_900 }),
    { points: 1, secondsLeft: 0 });
});

test("every award is a non-negative integer", () => {
  // creditCoins throws on a non-positive amount and a fractional Qorm is not a
  // thing. This is what keeps a rules change from reaching the wallet.
  const awards: number[] = [
    messageAward({ firstAwarded: false, lastAwardMs: null }, T0).points,
    messageAward({ firstAwarded: true, lastAwardMs: null }, T0).points,
    ...Array.from({ length: 40 }, (_, i) => voteCastAward({ votesAwarded: i })),
    ...Array.from({ length: 10 }, (_, i) => upvoteReceivedAward(i)),
    ...Array.from({ length: 40 }, (_, i) => watchAward({ watchPoints: i, watchSeconds: 3_000 }).points),
  ];
  for (const q of awards) {
    assert.ok(Number.isInteger(q) && q >= 0, `${q} is not a non-negative integer`);
  }
});

test("no sequence of watch heartbeats can exceed the per-stream cap", () => {
  // The property, not an example. Whatever the beat pattern — one long beat, a
  // thousand short ones — the total for a stream is bounded.
  for (const beat of [1, 7, 90, 600, 4_000]) {
    let watchPoints = 0;
    let watchSeconds = 0;
    // Enough beats that the cap is reachable at this beat size, plus slack —
    // otherwise the test proves only that a short session earns little.
    const beats = Math.ceil((WATCH_POINTS_CAP * 600) / beat) + 10;
    for (let i = 0; i < beats; i++) {
      watchSeconds += beat;
      const r = watchAward({ watchPoints, watchSeconds });
      watchPoints += r.points;
      watchSeconds = r.secondsLeft;
      assert.ok(watchPoints <= WATCH_POINTS_CAP, `beat=${beat} reached ${watchPoints}`);
    }
    assert.equal(watchPoints, WATCH_POINTS_CAP, `beat=${beat} never reached the cap`);
  }
});

test("the clock perk: a lit clock pays the base again; unlit pays nothing extra", () => {
  assert.equal(CLOCK_MULTIPLIER, 2, "the published multiplier");
  assert.equal(bonusFor(EARN.firstMessage, true), 5);
  assert.equal(bonusFor(EARN.message, true), 1);
  assert.equal(bonusFor(EARN.voteCast, true), 1);
  assert.equal(bonusFor(EARN.upvoteReceived, true), 2);
  assert.equal(bonusFor(EARN.firstMessage, false), 0);
  assert.equal(bonusFor(0, true), 0, "no base, no bonus — a capped or replayed award must not mint on its own");
  assert.equal(bonusFor(-1, true), 0);
});

// ── The rules are settings ──────────────────────────────────────────────────────────────────

test("the product defaults are the reference economy, number for number", () => {
  // A changed default here would silently re-price every install that never saved its own
  // value. site.test also holds explicit rows, but the product default must not drift either.
  assert.deepEqual(DEFAULT_EARN_RULES, {
    firstMessage: 5, message: 1, messageCooldownMs: 600_000, voteCast: 1, votesPerStreamCap: 25,
    upvoteReceived: 2, paidUpvotesPerVoter: 5, watchCap: 30, watchSecondsPerPoint: 600, clockMultiplier: 2,
  });
});

test("each rule's setting exists in the schema, and its default IS the product rule (one number, two files)", () => {
  const rules = Object.keys(DEFAULT_EARN_RULES) as (keyof typeof DEFAULT_EARN_RULES)[];
  assert.equal(rules.length, 10);
  for (const rule of rules) {
    const [key, scale] = EARN_RULE_KEYS[rule];
    const e = INSTANCE_KEYS.find((k) => k.key === key);
    assert.ok(e, `${key} is not in the schema`);
    assert.equal(e.kind, "number");
    assert.equal(e.tier, "instance");
    assert.equal(Number(e.default) * scale, DEFAULT_EARN_RULES[rule], `${key}'s default differs from the product rule`);
  }
  assert.equal(INSTANCE_KEYS.filter((k) => k.key.startsWith("currency.earn.")).length, 10, "no earn setting without a rule");
});

test("earnRulesFrom reads each currency.earn.* key, converting minutes; a non-number falls to that rule's default", () => {
  const vals: Record<string, unknown> = {
    "currency.earn.firstMessage": 9, "currency.earn.message": 2, "currency.earn.messageCooldownMinutes": 3,
    "currency.earn.voteCast": 0, "currency.earn.votesPerStream": 4, "currency.earn.upvoteReceived": 7,
    "currency.earn.paidUpvotesPerVoter": 1, "currency.earn.watchCap": 12, "currency.earn.watchMinutesPerPoint": 2,
    "currency.earn.clockMultiplier": 3,
  };
  assert.deepEqual(earnRulesFrom((k) => vals[k]), {
    firstMessage: 9, message: 2, messageCooldownMs: 180_000, voteCast: 0, votesPerStreamCap: 4,
    upvoteReceived: 7, paidUpvotesPerVoter: 1, watchCap: 12, watchSecondsPerPoint: 120, clockMultiplier: 3,
  });
  assert.equal(earnRulesFrom((k) => (k === "currency.earn.watchCap" ? "lots" : null)).watchCap, 30);
});

test("every award function applies the rules it is GIVEN (each rule, mutated, moves its output)", () => {
  const r = { ...DEFAULT_EARN_RULES, firstMessage: 9, message: 2, messageCooldownMs: 60_000, voteCast: 3,
    votesPerStreamCap: 2, upvoteReceived: 4, paidUpvotesPerVoter: 1, watchCap: 3, watchSecondsPerPoint: 60, clockMultiplier: 3 };
  assert.deepEqual(messageAward({ firstAwarded: false, lastAwardMs: null }, T0, r),
    { points: 11, firstPoints: 9, messagePoints: 2, first: true, resetsCooldown: true });
  assert.equal(messageAward({ firstAwarded: true, lastAwardMs: T0 - 60_000 }, T0, r).points, 2, "cooldown 1 min");
  assert.equal(messageAward({ firstAwarded: true, lastAwardMs: T0 - 59_999 }, T0, r).points, 0);
  assert.equal(voteCastAward({ votesAwarded: 1 }, r), 3);
  assert.equal(voteCastAward({ votesAwarded: 2 }, r), 0, "cap 2");
  assert.equal(upvoteReceivedAward(0, r), 4);
  assert.equal(upvoteReceivedAward(1, r), 0, "1 per voter");
  assert.deepEqual(watchAward({ watchPoints: 0, watchSeconds: 150 }, r), { points: 2, secondsLeft: 30 });
  assert.deepEqual(watchAward({ watchPoints: 2, watchSeconds: 600 }, r), { points: 1, secondsLeft: 0 }, "cap 3");
  assert.equal(bonusFor(2, true, r), 4, "x3 pays twice the base on top");
  assert.equal(bonusFor(2, true, { ...r, clockMultiplier: 1 }), 0, "x1 = no bonus row at all");
});
