// Tests for coinProvenance.ts. Property-first: the fold's invariants —
// conservation, order-independence of the split — matter more than any one
// fixture, and the dangerous failures here are not wrong-looking examples,
// they are rounding drifts that only appear in aggregate over many
// operations.
//
// THE INVARIANT under test everywhere: the split sums to the balance, and no
// bucket ever goes negative. If either breaks, the module is claiming Qorm
// exists that does not, or losing Qorm that does.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DRAIN_POLICIES, PROVENANCE_BUCKETS,
  attribute, attributionBalance, earnedBalance, drain, isHouseWallet, moneyBacked, splitTotal, PRODUCT_DRAIN,
  type DrainPolicy, type LedgerEntry, type Split,
} from "./coinProvenance.ts";
import { LEDGER_KINDS, type LedgerKind } from "./coins.ts";

// Deterministic PRNG — a seeded generator makes a failure reproducible, and a
// property test whose counterexample cannot be replayed is not much of a test.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const CREDIT_KINDS: LedgerKind[] = ["purchase", "earn_watch", "earn_chat", "admin_adjust"];
const DEBIT_KINDS: LedgerKind[] = ["spend", "market_buy"];
const RESTORE_KINDS: LedgerKind[] = ["refund", "market_sell", "market_payout", "market_void"];

/** A random but WELL-FORMED ledger: an ORDINARY debit never exceeds the
 *  balance, because the real wallet's own guard makes that unreachable and a
 *  test that feeds impossible history proves nothing about real wallets. A
 *  `clawback` is the one exception: the guard that stops
 *  an ordinary spend does not apply to it, so it can drive the balance below
 *  zero and is generated that way some of the time — the whole reason
 *  `attribute()` needs a `debt` field. */
function randomLedger(seed: number, n: number): LedgerEntry[] {
  const r = rng(seed);
  const out: LedgerEntry[] = [];
  let balance = 0;
  for (let i = 0; i < n; i++) {
    const roll = r();
    if (roll < 0.45 || balance <= 0) {
      const kind = CREDIT_KINDS[Math.floor(r() * CREDIT_KINDS.length)]!;
      const amt = 1 + Math.floor(r() * 5000);
      out.push({ kind, delta: amt });
      balance += amt;
    } else if (roll < 0.75) {
      const kind = DEBIT_KINDS[Math.floor(r() * DEBIT_KINDS.length)]!;
      const amt = 1 + Math.floor(r() * balance);
      out.push({ kind, delta: -amt });
      balance -= amt;
    } else if (roll < 0.8) {
      // A clawback can exceed what the wallet holds — it can, and here
      // sometimes does, take the balance below zero into debt.
      const amt = 1 + Math.floor(r() * (balance + 1000));
      out.push({ kind: "clawback", delta: -amt });
      balance -= amt;
    } else {
      const kind = RESTORE_KINDS[Math.floor(r() * RESTORE_KINDS.length)]!;
      const amt = 1 + Math.floor(r() * 3000);
      out.push({ kind, delta: amt });
      balance += amt;
    }
  }
  return out;
}

const balanceOf = (entries: readonly LedgerEntry[]) => entries.reduce((a, e) => a + e.delta, 0);

function assertSane(split: Split, label: string) {
  for (const b of PROVENANCE_BUCKETS) {
    assert.ok(Number.isInteger(split[b]), `${label}: ${b} is not an integer (${split[b]})`);
    assert.ok(split[b] >= 0, `${label}: ${b} went negative (${split[b]})`);
  }
}

// ── the headline invariant ───────────────────────────────────────────────────

for (const policy of DRAIN_POLICIES) {
  test(`[${policy}] the split always sums to the balance, over 300 random ledgers`, () => {
    for (let seed = 1; seed <= 300; seed++) {
      const entries = randomLedger(seed, 60);
      const { split, atRiskInMarkets, spentOnSinks, debt } = attribute(entries, policy);
      assert.equal(
        splitTotal(split) - debt, balanceOf(entries),
        `seed ${seed}: split ${splitTotal(split)} - debt ${debt} != balance ${balanceOf(entries)}`
      );
      assert.ok(debt >= 0, `seed ${seed}: debt went negative (${debt})`);
      assert.ok(
        debt === 0 || splitTotal(split) === 0,
        `seed ${seed}: debt ${debt} and a nonzero split ${splitTotal(split)} coexist`
      );
      assertSane(split, `seed ${seed} split`);
      assertSane(atRiskInMarkets, `seed ${seed} atRisk`);
      assertSane(spentOnSinks, `seed ${seed} spent`);
    }
  });

  test(`[${policy}] drain takes exactly what was asked for, and never more than a pool holds`, () => {
    const r = rng(7 + DRAIN_POLICIES.indexOf(policy));
    for (let i = 0; i < 2000; i++) {
      const from: Split = {
        purchased: Math.floor(r() * 1000),
        earned: Math.floor(r() * 1000),
        granted: Math.floor(r() * 1000),
        winnings: Math.floor(r() * 1000),
      };
      const available = splitTotal(from);
      const want = Math.floor(r() * (available + 200));
      const taken = drain(from, want, policy);
      assert.equal(splitTotal(taken), Math.min(want, available), `i=${i}: wrong total taken`);
      for (const b of PROVENANCE_BUCKETS) {
        assert.ok(taken[b] >= 0, `i=${i}: negative take from ${b}`);
        assert.ok(taken[b] <= from[b], `i=${i}: took ${taken[b]} from ${b} which held ${from[b]}`);
      }
    }
  });
}

// ── the property that makes pro-rata worth recommending ──────────────────────

test("[pro-rata] is insensitive to the ORDER of a run of same-sign entries", () => {
  // Reordering credits among themselves, then debits among themselves, must not
  // change the answer — that is exactly the "cannot be gamed by timing"
  // property, and it is the reason pro-rata is the recommended default.
  const credits: LedgerEntry[] = [
    { kind: "purchase", delta: 5000 },
    { kind: "earn_watch", delta: 300 },
    { kind: "admin_adjust", delta: 1000 },
  ];
  const debits: LedgerEntry[] = [
    { kind: "spend", delta: -700 },
    { kind: "spend", delta: -1300 },
  ];
  const a = attribute([...credits, ...debits], "pro-rata").split;
  const b = attribute([...credits].reverse().concat([...debits].reverse()), "pro-rata").split;
  assert.deepEqual(a, b);
});

test("[earned-first] and [purchased-first] disagree, and in the documented direction", () => {
  // If these two ever agreed on a mixed wallet the report would be showing one
  // number three times, which would look like agreement rather than a bug.
  const entries: LedgerEntry[] = [
    { kind: "purchase", delta: 1000 },
    { kind: "earn_watch", delta: 1000 },
    { kind: "spend", delta: -1000 },
  ];
  const conservative = attribute(entries, "earned-first").split;
  const generous = attribute(entries, "purchased-first").split;
  assert.equal(conservative.purchased, 1000, "earned-first must spare the purchased pool");
  assert.equal(conservative.earned, 0);
  assert.equal(generous.purchased, 0, "purchased-first must drain the purchased pool");
  assert.equal(generous.earned, 1000);
  // …and that is the whole gameability argument, stated as a number: the same
  // history yields a wallet reported as 100% money-backed or 0%, purely by
  // choice of policy.
  assert.notEqual(moneyBacked(conservative), moneyBacked(generous));
});

// ── market flows ─────────────────────────────────────────────────────────────

test("a market payout restores the stake's provenance and mints only the excess", () => {
  const entries: LedgerEntry[] = [
    { kind: "purchase", delta: 1000 },
    { kind: "market_buy", delta: -1000 },
    { kind: "market_payout", delta: 2500 },
  ];
  const { split, atRiskInMarkets } = attribute(entries, "pro-rata");
  assert.equal(split.purchased, 1000, "the original purchased stake comes back as purchased");
  assert.equal(split.winnings, 1500, "the house-minted excess is winnings, not purchased");
  assert.equal(splitTotal(atRiskInMarkets), 0, "nothing is still at risk once it paid out");
  assert.equal(splitTotal(split), 2500);
});

test("a losing market position leaves its provenance at risk, not in the balance", () => {
  const entries: LedgerEntry[] = [
    { kind: "earn_watch", delta: 400 },
    { kind: "purchase", delta: 600 },
    { kind: "market_buy", delta: -500 },
  ];
  const { split, atRiskInMarkets } = attribute(entries, "pro-rata");
  assert.equal(splitTotal(split), 500);
  assert.equal(splitTotal(atRiskInMarkets), 500);
  // Pro-rata: the 500 staked was 40% earned / 60% purchased, like the wallet.
  assert.equal(atRiskInMarkets.earned, 200);
  assert.equal(atRiskInMarkets.purchased, 300);
  // This is the number an "only earned Qorm may be at risk" rule constrains,
  // and it is NOT the same as the balance's split — which is the whole reason
  // atRiskInMarkets is tracked separately rather than inferred.
});

test("a void returns exactly the stake and mints nothing", () => {
  const entries: LedgerEntry[] = [
    { kind: "purchase", delta: 1000 },
    { kind: "market_buy", delta: -400 },
    { kind: "market_void", delta: 400 },
  ];
  const { split, atRiskInMarkets } = attribute(entries, "pro-rata");
  assert.equal(split.purchased, 1000);
  assert.equal(split.winnings, 0, "a refund of a stake is not a winning");
  assert.equal(splitTotal(atRiskInMarkets), 0);
});

// ── clawbacks ────────────────────────────────────────────────────────────────

test("a negative admin_adjust is remembered NOWHERE, so a later refund cannot resurrect it", () => {
  // The bug this pins: routing every debit into spentOnSinks would let an
  // unrelated refund restore provenance that was confiscated — inventing
  // backing that no longer exists.
  const entries: LedgerEntry[] = [
    { kind: "purchase", delta: 1000 },
    { kind: "admin_adjust", delta: -1000 },
    { kind: "refund", delta: 1000 },
  ];
  const { split } = attribute(entries, "pro-rata");
  assert.equal(splitTotal(split), 1000);
  assert.equal(split.purchased, 0, "the clawed-back purchase must not come back");
  assert.equal(split.winnings, 1000, "an unmatched restoring credit is minted, not restored");
});

// ── exhaustiveness ───────────────────────────────────────────────────────────

test("every LedgerKind is classified — a new kind cannot land in a bucket by accident", () => {
  // attribute() must not throw or silently ignore any kind in the real union.
  // The `CREDIT_BUCKET` record is exhaustive by TYPE, so this guards the fold's
  // own branching rather than the table: the failure mode it catches is a new
  // kind that type-checks as a credit but is handled as a debit, or vice versa.
  for (const kind of LEDGER_KINDS) {
    const { split } = attribute([{ kind, delta: 100 }], "pro-rata");
    assert.equal(splitTotal(split), 100, `credit of kind ${kind} did not reach the split`);
  }
});


test("an empty ledger attributes to nothing rather than throwing", () => {
  for (const policy of DRAIN_POLICIES) {
    const { split } = attribute([], policy as DrainPolicy);
    assert.equal(splitTotal(split), 0);
  }
});

// ── attributionBalance ───────────────────────────────────────────────────────
//
// `splitTotal(a.split)` alone reads 0 for any wallet in debt (attribute()'s
// loop pays debt off a credit before it lands in any split bucket), so a
// report reading it would print 0 instead of the negative balance for a
// wallet a clawback drove below zero. coinProvenanceServer.ts's
// attributeWallet/attributeAllWallets both go through this helper.

test("attributionBalance reads splitTotal(split) when there is no debt", () => {
  const a = attribute([{ kind: "purchase", delta: 500 }], "pro-rata");
  assert.equal(a.debt, 0);
  assert.equal(attributionBalance(a), 500);
});

test("attributionBalance reads the NEGATIVE balance for a wallet in debt — not 0", () => {
  // A clawback larger than the wallet holds: 500 in,
  // 800 clawed back, split is empty and debt is 300 — the wallet owes 300.
  const a = attribute(
    [{ kind: "tip", delta: 500 }, { kind: "clawback", delta: -800 }],
    "pro-rata"
  );
  assert.equal(splitTotal(a.split), 0, "the split alone reads 0 — this is exactly the bug");
  assert.equal(a.debt, 300);
  assert.equal(attributionBalance(a), -300);
});

test("attributionBalance agrees with the raw ledger sum, over 300 random ledgers and every policy", () => {
  for (const policy of DRAIN_POLICIES) {
    for (let seed = 1; seed <= 300; seed++) {
      const entries = randomLedger(seed, 40);
      const a = attribute(entries, policy);
      assert.equal(
        attributionBalance(a), balanceOf(entries),
        `policy ${policy} seed ${seed}: attributionBalance ${attributionBalance(a)} != raw balance ${balanceOf(entries)}`
      );
    }
  }
});

// ── owner wallets ────────────────────────────────────────────────────────────

test("grantsReceived is LIFETIME, so spending the grant does not un-owner a wallet", () => {
  // The bug this pins: reading the current `granted` bucket instead would
  // reclassify an owner as a participant the moment they spent the grant down
  // — which is the exact wallet whose spending the grant was meant to make
  // free, so it would be wrong precisely where it matters most.
  const spentItAll: LedgerEntry[] = [
    { kind: "admin_adjust", delta: 100_000 },
    { kind: "spend", delta: -100_000 },
  ];
  const a = attribute(spentItAll, "pro-rata");
  assert.equal(a.split.granted, 0, "the grant really is spent");
  assert.equal(a.grantsReceived, 100_000);
  assert.ok(isHouseWallet(a), "still an owner wallet");
});

test("a clawback does not erase the fact that a grant was received", () => {
  const clawedBack: LedgerEntry[] = [
    { kind: "admin_adjust", delta: 100_000 },
    { kind: "admin_adjust", delta: -100_000 },
  ];
  const a = attribute(clawedBack, "pro-rata");
  assert.equal(a.grantsReceived, 100_000, "only POSITIVE adjusts count toward the classification");
  assert.ok(isHouseWallet(a));
});

test("an ordinary participant is never classified as an owner", () => {
  const ordinary: LedgerEntry[] = [
    { kind: "purchase", delta: 5_000 },
    { kind: "earn_watch", delta: 400 },
    { kind: "market_payout", delta: 900 },
    { kind: "spend", delta: -2_000 },
  ];
  const a = attribute(ordinary, "pro-rata");
  assert.equal(a.grantsReceived, 0);
  assert.ok(!isHouseWallet(a), "buying, earning and winning must never make someone an owner");
});

// ── The SHIPPED rule ────────────────────────────────────────────────────────
//
// Everything above tests the uniform policies, which exist so the report can
// compare hypotheticals. PRODUCT_DRAIN is the rule that actually governs a
// wallet, and it is not uniform: a store spend and a market buy take from
// different pools on purpose.

test("PRODUCT_DRAIN holds the invariant over 300 random ledgers", () => {
  // The non-uniform policy is where the invariant is most at risk: a debit and
  // the credit that reverses it now resolve their policy separately, so a
  // mismatch would silently lose or invent Qorm rather than throwing.
  for (let seed = 1; seed <= 300; seed++) {
    const entries = randomLedger(seed, 60);
    const { split, atRiskInMarkets, spentOnSinks, debt } = attribute(entries, PRODUCT_DRAIN);
    assert.equal(
      splitTotal(split) - debt, balanceOf(entries),
      `seed ${seed}: split ${splitTotal(split)} - debt ${debt} != balance ${balanceOf(entries)}`
    );
    assert.ok(debt >= 0, `seed ${seed}: debt went negative (${debt})`);
    assert.ok(
      debt === 0 || splitTotal(split) === 0,
      `seed ${seed}: debt ${debt} and a nonzero split ${splitTotal(split)} coexist`
    );
    assertSane(split, `seed ${seed} split`);
    assertSane(atRiskInMarkets, `seed ${seed} atRisk`);
    assertSane(spentOnSinks, `seed ${seed} spent`);
  }
});

test("a store spend drains PURCHASED first, leaving the earned pool intact", () => {
  // The half of the rule that makes the other half generous rather than
  // punitive: bought Qorm leaves through the store, so earned Qorm stays earned.
  const { split } = attribute([
    { kind: "purchase", delta: 500 },
    { kind: "earn_chat", delta: 300 },
    { kind: "spend", delta: -400 },
  ], PRODUCT_DRAIN);
  assert.equal(split.purchased, 100, "the spend took purchased Qorm");
  assert.equal(split.earned, 300, "and left every earned Qorm alone");
  assert.equal(earnedBalance(split), 300);
});

test("(legacy) a market buy took only earned Qorm, never the purchased pool", () => {
  // THE POINT OF THE PHASE. A wallet holding both could stake only what it
  // had earned; the purchased Qorm stayed untouched and spendable in the store.
  const { split, atRiskInMarkets } = attribute([
    { kind: "purchase", delta: 500 },
    { kind: "earn_chat", delta: 300 },
    { kind: "market_buy", delta: -300 },
  ], PRODUCT_DRAIN);
  assert.equal(split.purchased, 500, "purchased Qorm never reached a market");
  assert.equal(split.earned, 0);
  assert.equal(atRiskInMarkets.earned, 300, "the stake is earned Qorm, all of it");
  assert.equal(atRiskInMarkets.purchased, 0);
});

test("(legacy) winnings were staked BEFORE earned, and count as earned again after a win", () => {
  // Winnings had to be re-stakeable or winning would have locked that Qorm out
  // of the market forever. And they went first because they were the most
  // restricted pool.
  const { split } = attribute([
    { kind: "earn_chat", delta: 100 },
    { kind: "market_buy", delta: -100 },
    { kind: "market_payout", delta: 250 },   // 100 stake back + 150 minted
  ], PRODUCT_DRAIN);
  assert.equal(split.winnings, 150, "the excess over the stake is minted");
  assert.equal(split.earned, 100, "the stake itself comes back as what it was");
  assert.equal(earnedBalance(split), 250, "and all of it counted as earned again");

  const after = attribute([
    { kind: "earn_chat", delta: 100 },
    { kind: "market_buy", delta: -100 },
    { kind: "market_payout", delta: 250 },
    { kind: "market_buy", delta: -150 },
  ], PRODUCT_DRAIN);
  assert.equal(after.split.winnings, 0, "winnings are spent first");
  assert.equal(after.split.earned, 100, "so the earned pool survives");
});

test("STAKE_TAIL_IS_NOT_DEAD — a pre-Phase-3 commingled trade still folds", () => {
  // Historical market_buy rows predate the rule and were funded from whatever
  // the wallet held. If `stake` could not drain past winnings+earned, the split
  // would stop summing to the balance the moment the fold replayed one — which
  // is the invariant everything else depends on. Deleting the tail as "dead
  // code" breaks exactly the wallets that traded earliest.
  const entries: LedgerEntry[] = [
    { kind: "purchase", delta: 500 },
    { kind: "market_buy", delta: -400 },  // no earned Qorm at all
  ];
  const { split, atRiskInMarkets } = attribute(entries, PRODUCT_DRAIN);
  assert.equal(splitTotal(split), balanceOf(entries), "the invariant must survive history");
  assert.equal(atRiskInMarkets.purchased, 400, "and describe what actually happened");
});

test("a break-even sell returns the stake as exactly what it was", () => {
  const { split } = attribute([
    { kind: "earn_chat", delta: 300 },
    { kind: "market_buy", delta: -300 },
    { kind: "market_sell", delta: 300 },
  ], PRODUCT_DRAIN);
  assert.equal(split.earned, 300, "the stake returns as earned Qorm");
  assert.equal(split.purchased, 0, "and no purchased Qorm is conjured");
  assert.equal(split.winnings, 0, "a break-even sell mints nothing");
});

test("(legacy) a PARTIAL exit from a commingled position cannot inflate the earned balance", () => {
  // The one case where the restore order is observable, and the reason
  // RESTORE_POLICY is a named constant rather than a lookup on either kind.
  //
  // A mutation swapping the restore to the stake order passes every other
  // test in this file: every position under the earned-only rule held
  // atRiskInMarkets in only winnings and earned, and both orders drain
  // winnings before earned, so they agree everywhere except on a position
  // funded before that rule — which needs BOTH pools at risk and a PARTIAL
  // return to expose. No new market_buy rows exist; the fold just replays the
  // old ones unchanged.
  const entries: LedgerEntry[] = [
    { kind: "purchase", delta: 500 },
    { kind: "market_buy", delta: -400 },  // before the earned-only rule: staked purchased Qorm
    { kind: "earn_chat", delta: 300 },
    { kind: "market_buy", delta: -300 },  // and later, earned Qorm
    { kind: "market_sell", delta: 300 },  // a PARTIAL exit
  ];
  const { split, atRiskInMarkets } = attribute(entries, PRODUCT_DRAIN);
  assert.equal(splitTotal(split), balanceOf(entries), "the invariant first");
  assert.equal(split.purchased, 400,
    "the purchased provenance comes back to the SPENDABLE balance — 100 never staked, 300 returned");
  assert.equal(earnedBalance(split), 0,
    "and not one Qorm of the exit lands in the earned pool");
  assert.equal(atRiskInMarkets.earned, 300, "the earned stake is what stays at risk");
});

test("earnedBalance excludes purchased and granted, and says so in one place", () => {
  const split: Split = { purchased: 1000, earned: 40, granted: 100_000, winnings: 7 };
  assert.equal(earnedBalance(split), 47, "earned + winnings only");
  assert.equal(moneyBacked(split), 1000, "and moneyBacked stays a different question");
});

test("PRODUCT_DRAIN is exhaustive over LedgerKind and only market_buy stakes", () => {
  // A new ledger kind must not quietly acquire the market's drain order.
  for (const kind of LEDGER_KINDS) {
    const p = PRODUCT_DRAIN(kind);
    assert.equal(p, kind === "market_buy" ? "stake" : "purchased-first", `${kind} drains ${p}`);
  }
});

test("earnedBalance is the parenthetical's number: earned + winnings, nothing purchased or granted", () => {
  const split = { purchased: 500, earned: 40, granted: 1_000_000, winnings: 7 };
  assert.equal(earnedBalance(split), 47);
});

// ── Money-bought Qorm: tip / clawback / clawback_reversed ──

test("a tip is money-backed Qorm", () => {
  const a = attribute([{ kind: "tip", delta: 500 }], PRODUCT_DRAIN);
  assert.equal(a.split.purchased, 500);
  assert.equal(a.debt, 0);
});

test("a clawback past zero becomes DEBT, never a negative bucket", () => {
  const a = attribute([
    { kind: "tip", delta: 500 },
    { kind: "spend", delta: -400 },
    { kind: "clawback", delta: -500 },
  ], PRODUCT_DRAIN);
  for (const v of Object.values(a.split)) assert.ok(v >= 0, "no bucket may go negative");
  assert.equal(splitTotal(a.split), 0);
  assert.equal(a.debt, 400);
  assert.equal(splitTotal(a.split) - a.debt, 500 - 400 - 500);
});

test("credits pay debt off FIRST, and only the excess lands in a bucket", () => {
  const a = attribute([
    { kind: "clawback", delta: -300 },
    { kind: "earn_watch", delta: 100 },
    { kind: "earn_watch", delta: 250 },
  ], PRODUCT_DRAIN);
  assert.equal(a.debt, 0);
  assert.equal(a.split.earned, 50);
});

test("a clawback is remembered NOWHERE — a later sink refund cannot resurrect it", () => {
  const a = attribute([
    { kind: "purchase", delta: 500 },
    { kind: "clawback", delta: -500 },
    { kind: "refund", delta: 100 },
  ], PRODUCT_DRAIN);
  assert.equal(a.split.purchased, 0);
});

test("a won dispute restores money-backed Qorm (and pays debt first)", () => {
  const a = attribute([
    { kind: "tip", delta: 500 },
    { kind: "spend", delta: -500 },
    { kind: "clawback", delta: -500 },
    { kind: "clawback_reversed", delta: 500 },
  ], PRODUCT_DRAIN);
  assert.equal(a.debt, 0);
  assert.equal(a.split.purchased, 0); // 500 restored, all of it paid the 500 debt
});

// ── fix round 1: grantsReceived must count a grant even when debt eats it ──

test("grantsReceived counts an admin_adjust FULLY absorbed by debt repayment", () => {
  // Reviewer-reproduced regression: the debt-payoff `continue` used to exit
  // before grantsReceived was incremented, so a grant that arrived while the
  // wallet owed money vanished from the lifetime count entirely.
  const a = attribute([
    { kind: "clawback", delta: -100 },
    { kind: "admin_adjust", delta: 50 },
  ], PRODUCT_DRAIN);
  assert.equal(a.debt, 50, "the clawback minus the grant that paid part of it off");
  assert.equal(a.grantsReceived, 50, "the grant was still RECEIVED even though debt absorbed all of it");
  assert.equal(a.split.granted, 0, "and none of it reached the spendable balance");
});

test("a PARTIALLY debt-absorbed admin_adjust still counts its full delta toward grantsReceived", () => {
  const a = attribute([
    { kind: "clawback", delta: -100 },
    { kind: "admin_adjust", delta: 150 },
  ], PRODUCT_DRAIN);
  assert.equal(a.debt, 0, "the grant more than covered the debt");
  assert.equal(a.grantsReceived, 150, "lifetime received is the FULL delta, not just what was left after debt");
  assert.equal(a.split.granted, 50, "and the excess, after paying off the 100 debt, reaches the bucket");
});
