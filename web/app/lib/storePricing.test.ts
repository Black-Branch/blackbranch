import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderPrice, roundPrice, dampen, priceGuard, planRecompute, STORE_PRICE_DAMPING,
} from "./storePricing.ts";

test("roundPrice uses a coarser step as the number grows", () => {
  assert.equal(roundPrice(23), 25); // nearest 25 below 500
  assert.equal(roundPrice(462), 450);
  assert.equal(roundPrice(1_263), 1_250); // nearest 50 from 500..2000
  assert.equal(roundPrice(2_487), 2_500); // nearest 100 above 2000
});

test("roundPrice never returns 0 for a positive price", () => {
  // A free item is a different product, not a cheap one — an item that rounds
  // to nothing would silently stop being a purchase at all.
  assert.equal(roundPrice(1), 25);
});

test("renderPrice is streams x E, rounded", () => {
  assert.equal(renderPrice(0.55, 45), 25);
  assert.equal(renderPrice(28, 45), 1_250);
  assert.equal(renderPrice(55, 45), 2_500);
});

test("dampen clamps movement to 10% of the previous price", () => {
  assert.equal(dampen(1_000, 2_000), 1_100);
  assert.equal(dampen(1_000, 500), 900);
  assert.equal(dampen(1_000, 1_050), 1_050); // inside the band, untouched
});

test("every damped price lands ON the rounding ladder", () => {
  // Damping must not clamp AFTER rounding: a transition would show viewers
  // prices like 149, 2475 and 45 for however many streams it takes to converge — computed artifacts, exactly what roundPrice exists to
  // prevent. A price is only "chosen-looking" if it is chosen-looking the
  // whole way, not just at the destination.
  for (const [prev, target] of [
    [150, 100], [2_500, 11_000], [165, 150], [50, 30], [220, 200], [2_750, 2_500],
  ] as Array<[number, number]>) {
    const got = dampen(prev, target);
    assert.equal(got, roundPrice(got), `dampen(${prev}, ${target}) = ${got} is off the ladder`);
  }
});

test("damping never stalls: a reachable target is always reached", () => {
  // The naive fix — roundPrice(dampen(...)) — DEADLOCKS. From 150 toward 100 it
  // gives 149 -> rounds to 150 -> the same value -> no move, forever. Progress
  // must be guaranteed, so when the band contains no other ladder value the
  // rule takes exactly one ladder step.
  for (const [start, target] of [
    [150, 100], [2_500, 100], [25, 2_500], [1_000, 2_000], [2_000, 500], [275, 250],
  ] as Array<[number, number]>) {
    let p = start;
    for (let i = 0; i < 200; i++) p = dampen(p, target);
    assert.equal(p, target, `${start} never reached ${target} (stalled at ${p})`);
  }
});

test("dampen never overshoots the target", () => {
  // One ladder step can be larger than the remaining distance; stepping past
  // the target and back would oscillate forever.
  assert.equal(dampen(275, 250), 250);
  assert.equal(dampen(50, 25), 25);
  assert.equal(dampen(25, 50), 50);
});

test("a cheap price moves by a whole ladder step or not at all", () => {
  // At 25 points one step IS 100%, and there is nothing finer on the ladder. The
  // honest behaviour is a single step — smaller is not representable.
  assert.equal(dampen(25, 50), 50);
  // ...and it cannot be pushed below the ladder's floor.
  assert.equal(dampen(25, 1), 25);
  assert.equal(dampen(25, 0), 25);
});

test("a large price still moves about 10% per run, not one flat step", () => {
  // At 2,500 a single 100-step would be 4%/run — 85 runs to double. The bound
  // is the LARGER of 10% and one step, so big prices stay responsive.
  const next = dampen(2_500, 11_000);
  assert.ok(next >= 2_700 && next <= 2_800, `expected ~10% of 2500, got ${next}`);
});

test("dampen takes the computed price outright when there is no previous", () => {
  // Outright, but still on the ladder — a first price is a price too.
  assert.equal(dampen(null, 1_263), 1_250);
});

test("repeated damping converges on the target and then stops moving", () => {
  // The property that matters: damping must SLOW a change, never prevent it.
  let p = 1_000;
  for (let i = 0; i < 40; i++) p = dampen(p, 2_000);
  assert.equal(p, 2_000);
});

test("damping is symmetric — a fall converges as a rise does", () => {
  // The rise case above passes even if the lower clamp is missing entirely,
  // so the fall needs its own convergence check.
  let p = 2_000;
  for (let i = 0; i < 40; i++) p = dampen(p, 500);
  assert.equal(p, 500);
});

test("the damping band is 10% and the constant is what sets it", () => {
  // Pins the constant to the behaviour: changing STORE_PRICE_DAMPING without
  // this would move every price ceiling silently.
  assert.equal(STORE_PRICE_DAMPING, 0.1);
  // At 200 the ladder's 25-step is larger than 10% (20), so the step is the
  // bound and the result lands on the ladder either side.
  assert.equal(dampen(200, 10_000), 225);
  assert.equal(dampen(200, 0), 175);
  // Where 10% exceeds a step, the percentage is what bounds the move.
  assert.equal(dampen(1_000, 10_000), 1_100);
});

test("a price already at the target is left exactly where it is", () => {
  // The recompute skips the write when the damped price equals the stored one; if
  // dampen drifted a stable price, every recompute would churn updated_at.
  for (const p of [25, 150, 450, 1_250, 2_500]) assert.equal(dampen(p, p), p);
});

test("rounding lands on the price ladder for every item in the table", () => {
  // The price table at the seeded E=45. If the ladder or the step boundaries
  // move, this is the test that says which prices moved with them.
  const table: Array<[number, number]> = [
    [0.55, 25], // sticker, sticker boost
    [1.1, 50], // cheer floor
    [3.3, 150], // TTS, Gadget roast/hottake
    [4.4, 200], // Gadget poem
    [5.5, 250], // Gadget remember
    [10, 450], // font style, static effect
    [15.5, 700], // custom gradient (duo)
    [28, 1_250], // animated effect
    [33, 1_500], // rainbow
    [44, 2_000], // cosmetic badge
    [55, 2_500], // badge slot
  ];
  for (const [streams, points] of table) assert.equal(renderPrice(streams, 45), points);
});

test("a price on a step boundary rounds the same way every time", () => {
  // 500 and 2000 are where the step changes; an off-by-one in the comparison
  // shows up here and nowhere else.
  assert.equal(roundPrice(500), 500);
  assert.equal(roundPrice(2_000), 2_000);
  assert.equal(roundPrice(499), 500); // still the 25 step: 499/25 -> 20 -> 500
  assert.equal(roundPrice(2_025), 2_000); // past 2000: the 100 step, rounding down
  assert.equal(roundPrice(2_050), 2_100); // the 100 step, rounding up
});

// ── priceGuard — the "never charged a price you did not see" rule ────────────

test("priceGuard passes only when the client's price is exactly the table's", () => {
  assert.deepEqual(priceGuard(25, 25), { ok: true, price: 25 });
});

test("priceGuard refuses a stale price with 409 and returns the real one", () => {
  // The current price rides along so the client can re-render and let the
  // viewer decide, rather than silently retrying at the new number.
  assert.deepEqual(priceGuard(25, 28), {
    ok: false, status: 409, error: "price_changed", price: 28,
  });
  // A price that moved DOWN is refused too: the viewer still did not see it,
  // and a route that silently charged less would be a route that can silently
  // charge differently.
  assert.deepEqual(priceGuard(28, 25), {
    ok: false, status: 409, error: "price_changed", price: 25,
  });
});

test("priceGuard refuses a missing expectedPrice rather than charging the current one", () => {
  // The dark pattern this exists to prevent is "charge whatever it costs
  // now". A client that omitted the field is a bug, and it must be loud.
  for (const bad of [undefined, null, "25", NaN, Infinity, 0, -25]) {
    const r = priceGuard(bad, 25);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 400);
    assert.equal(!r.ok && r.error, "expected_price_required");
  }
});

test("priceGuard refuses an unpriced item with 503 instead of treating it as free", () => {
  assert.deepEqual(priceGuard(25, null), {
    ok: false, status: 503, error: "price_unavailable", price: null,
  });
});

test("priceGuard never returns ok for a null table price, whatever the client sends", () => {
  // The property, not the example: no input can talk the guard into approving
  // a charge when the table does not know the price.
  for (const expected of [1, 25, 1_000, 0.5, -1, "25", null, undefined, NaN]) {
    assert.equal(priceGuard(expected, null).ok, false);
  }
});

// ── planRecompute — one spelling of "what would a new E do" ─────────────────

test("planRecompute returns only the rows that actually move", () => {
  const rows = [
    { itemKey: "sticker", baseStreams: 0.55, price: 25 },
    { itemKey: "tts", baseStreams: 3.3, price: 150 },
  ];
  assert.deepEqual(planRecompute(rows, 45), [], "E unchanged must move nothing");
  assert.deepEqual(planRecompute(rows, 90), [
    { itemKey: "sticker", from: 25, to: 50 },
    { itemKey: "tts", from: 150, to: 175 },
  ]);
});

test("planRecompute damps against the CURRENT price, not the target", () => {
  // The whole point of the plan being a pure function: a preview and the write
  // must agree, and both must show the damped step rather than the destination.
  const [move] = planRecompute([{ itemKey: "badge_slot", baseStreams: 55, price: 2_500 }], 200);
  assert.equal(renderPrice(55, 200), 11_000, "undamped, this is where it is headed");
  assert.equal(move?.to, 2_800, "one recompute moves ~10%, snapped to the ladder");
});

test("planRecompute refuses a non-positive E rather than zeroing the store", () => {
  assert.throws(() => planRecompute([{ itemKey: "sticker", baseStreams: 0.55, price: 25 }], 0), /E/);
});

test("no price pair on the ladder can stall, and none leaves the ladder", () => {
  // The examples above are examples. This is the property, swept over every
  // ladder price from 25 to 20,000 — 21k+ start/target pairs. It is what
  // justifies deleting the anti-stall branch and the no-overshoot clamp an
  // earlier draft carried: this sweep proves the single max() below covers
  // what they were there for. If a future edit reintroduces a stall, this
  // fails and names the pair.
  const prices: number[] = [];
  for (let p = 25; p <= 3_000; p += 25) prices.push(p);
  for (let p = 3_100; p <= 20_000; p += 100) prices.push(p);

  for (const start of prices) {
    for (const tgt of prices) {
      const target = roundPrice(tgt);
      let p = start;
      for (let i = 0; i < 400; i++) {
        const next = dampen(p, target);
        assert.equal(next, roundPrice(next), `dampen(${p}, ${target}) = ${next} left the ladder`);
        assert.ok(
          (p <= target && next <= target) || (p >= target && next >= target),
          `dampen(${p}, ${target}) = ${next} stepped past the target`
        );
        if (next === p) break;
        p = next;
      }
      assert.equal(p, target, `${start} never reached ${target} (stalled at ${p})`);
    }
  }
});
