// Room lights on a low marathon timer.
//
// Red flashes inside the low window, accelerating as it counts down, and the
// lights OUT at zero.
//
// The properties worth pinning are the ones whose failure is expensive and
// quiet: a room left red for hours, a blackout that never fires or fires every
// tick forever, and a flash cadence fast enough to be unbearable in a room
// someone is actually sitting in.
//
// Run: node --test timerLights.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTimer } = require('./timer');

/** A lights double recording what the timer asks of it. */
function fakeLights({ on = true } = {}) {
  const calls = [];
  return {
    calls,
    enabled: () => on,
    flash: (kind, opts) => { calls.push({ call: 'flash', kind, opts }); return Promise.resolve(true); },
    off: () => { calls.push({ call: 'off' }); return Promise.resolve(true); },
  };
}

/** A timer with its internal state driven directly — no DB, no broadcast. */
function makeTimer(lights, state = {}) {
  const t = createTimer({ broadcast: () => {}, obs: null, pool: null, lights });
  Object.assign(t.__test.st, {
    running: true, lowPulseEnabled: true, lowThresholdSec: 300,
    remainingSec: 3600, updatedAt: Date.now(),
    ...state,
  });
  return t;
}

test('the ramp is keyed to the CLOCK, not to a fraction of the threshold', () => {
  // "Slow at 5 minutes, frantic by the last minute." Interpolating over
  // `lowThresholdSec` would make how the last minute FEELS depend on a
  // mod-configurable number. A statement about the clock has to be measured
  // against the clock.
  const t = makeTimer(fakeLights());
  const { lowCadenceMs, lowIntensity, LOW_SLOW_MS, LOW_FAST_MS, LOW_CALM_SEC, LOW_FRANTIC_SEC } = t.__test;
  assert.equal(LOW_CALM_SEC, 300, 'the slow end is five minutes');
  assert.equal(LOW_FRANTIC_SEC, 60, 'the frantic end is one minute');
  assert.equal(lowCadenceMs(300), LOW_SLOW_MS, 'at five minutes: slowest');
  assert.equal(lowCadenceMs(60), LOW_FAST_MS, 'by one minute: fastest');
  assert.equal(lowCadenceMs(600), LOW_SLOW_MS, 'well above five minutes is still the slow end');
  assert.ok(lowCadenceMs(180) < LOW_SLOW_MS && lowCadenceMs(180) > LOW_FAST_MS, 'three minutes is between');

  // Independent of the threshold, which is the whole point of the change.
  for (const threshold of [120, 300, 1200]) {
    Object.assign(t.__test.st, { lowThresholdSec: threshold });
    assert.equal(lowCadenceMs(60), LOW_FAST_MS,
      `the last minute must feel the same with a ${threshold}s threshold`);
  }
  assert.equal(lowIntensity(30), 1, 'everything below one minute is full intensity');
});

test('the cadence is FLOORED — it never becomes a true strobe', () => {
  // There must BE a cadence floor, and the ramp must not run away toward zero.
  // The floor's value is a product choice; the guard is what matters.
  const t = makeTimer(fakeLights());
  const { lowCadenceMs, LOW_FAST_MS } = t.__test;
  for (const remaining of [59, 30, 10, 5, 1, 0, -50]) {
    assert.ok(lowCadenceMs(remaining) >= LOW_FAST_MS,
      `cadence at ${remaining}s must not drop below the floor`);
  }
  assert.ok(LOW_FAST_MS >= 2_000, 'the floor itself must stay above a true strobe');
});

test('nothing happens above the low threshold', () => {
  const lights = fakeLights();
  const t = makeTimer(lights, { remainingSec: 1800 });
  t.__test.lowLightsTick();
  assert.deepEqual(lights.calls, [], 'a healthy timer must not touch the room');
});

test('inside the window it flashes red, and not more often than the cadence', () => {
  const lights = fakeLights();
  const t = makeTimer(lights, { remainingSec: 120 });
  const t0 = 1_000_000;
  t.__test.lowLightsTick(t0);
  assert.equal(lights.calls.length, 1, 'first tick inside the window flashes');
  assert.equal(lights.calls[0].kind, 'timer_low');
  assert.deepEqual(lights.calls[0].opts.rgb, [255, 30, 30], 'red');

  t.__test.lowLightsTick(t0 + 1000);
  assert.equal(lights.calls.length, 1, 'a tick 1s later must not flash again');

  t.__test.lowLightsTick(t0 + 60_000);
  assert.equal(lights.calls.length, 2, 'a tick past the cadence flashes again');
});

test('a timer ALREADY at zero must not black out — it is a transition, not a state', () => {
  // A restart while the timer sits at 0 from the previous stream must not turn
  // the room lights off on the first tick. "The timer is at zero" is the normal
  // state between marathons, so this is most of the time, not an edge case.
  const lights = fakeLights();
  const t = makeTimer(lights, { remainingSec: 0, running: false });
  t.__test.lowLightsTick();
  t.__test.lowLightsTick();
  assert.deepEqual(lights.calls, [], 'finding it already expired must be silent');
});

test('but a clock that RUNS OUT while we watch does black out, exactly once', () => {
  // Both halves matter. Never firing loses the ending; firing every tick
  // means a turn_off request to Home Assistant every 5 seconds, forever.
  const lights = fakeLights();
  const t = makeTimer(lights, { remainingSec: 30, running: true });
  t.__test.lowLightsTick();                 // observed above zero
  Object.assign(t.__test.st, { remainingSec: 0, running: false });
  t.__test.lowLightsTick();
  t.__test.lowLightsTick();
  t.__test.lowLightsTick();
  const offs = lights.calls.filter((c) => c.call === 'off');
  assert.equal(offs.length, 1, 'exactly one off()');
});

test('zero blacks out even with the warning effects switched off', () => {
  // `low_pulse_enabled` governs the WARNING treatment. The room going dark at
  // zero is the ending, not a warning about one — a mod who turned the pulse
  // off should not thereby lose the blackout.
  const lights = fakeLights();
  const t = makeTimer(lights, { remainingSec: 30, running: true, lowPulseEnabled: false });
  t.__test.lowLightsTick();                 // observed above zero (no flash: pulse disabled)
  Object.assign(t.__test.st, { remainingSec: 0, running: false });
  t.__test.lowLightsTick();
  assert.deepEqual(lights.calls, [{ call: 'off' }]);
});

test('a revived marathon can go dark again', () => {
  // Re-arming. A donation pushes the clock back above zero; if it runs out a
  // second time the lights must go out a second time.
  const lights = fakeLights();
  const t = makeTimer(lights, { remainingSec: 30, running: true });
  t.__test.lowLightsTick();                       // observed above zero
  Object.assign(t.__test.st, { remainingSec: 0, running: false });
  t.__test.lowLightsTick();
  assert.equal(lights.calls.filter((c) => c.call === 'off').length, 1);

  Object.assign(t.__test.st, { remainingSec: 600, updatedAt: Date.now() });
  t.__test.lowLightsTick();                       // above zero → re-arm (out of window, no flash)
  Object.assign(t.__test.st, { remainingSec: 0 });
  t.__test.lowLightsTick();
  assert.equal(lights.calls.filter((c) => c.call === 'off').length, 2,
    'the second expiry blacks out again');
});

test('a paused timer inside the window does not flash', () => {
  // Paused means it is not counting down, so there is nothing to warn about.
  const lights = fakeLights();
  const t = makeTimer(lights, { remainingSec: 120, running: false });
  t.__test.lowLightsTick();
  assert.deepEqual(lights.calls, []);
});

test('the whole feature is a no-op when Home Assistant is not configured', () => {
  // lights.js ships disabled (no HA_TOKEN / no entities). Nothing here may
  // assume otherwise — this runs on every stream.
  const lights = fakeLights({ on: false });
  const t = makeTimer(lights, { remainingSec: 60 });
  t.__test.lowLightsTick();
  Object.assign(t.__test.st, { remainingSec: 0 });
  t.__test.lowLightsTick();
  assert.deepEqual(lights.calls, [], 'no calls at all when disabled');
});

test('a timer built without lights at all still ticks safely', () => {
  // index.js passes lights, but createTimer is also constructed in tests and
  // could be elsewhere later. A missing dependency must not throw on a 5s timer.
  const t = createTimer({ broadcast: () => {}, obs: null, pool: null });
  Object.assign(t.__test.st, { running: true, remainingSec: 10, lowThresholdSec: 300 });
  assert.doesNotThrow(() => t.__test.lowLightsTick());
});

test('the ending gets both faster AND busier, monotonically', () => {
  // More frequent, faster and busier as it gets low. Asserted as a direction rather than as specific numbers, so the feel
  // can be tuned without rewriting the test.
  const t = makeTimer(fakeLights());
  const { lowShape } = t.__test;
  const at = (r) => lowShape(r);
  assert.ok(at(60).cadenceMs < at(300).cadenceMs, 'the last minute fires more often than five minutes out');
  assert.ok(at(150).cadenceMs < at(300).cadenceMs, 'and it tightens on the way down');
  assert.ok(at(60).pulses >= at(300).pulses, 'bursts do not get smaller');
  assert.ok(at(60).holdMs < at(300).holdMs, 'each pulse gets sharper, not longer');

  // Flashes per minute is what the room actually feels.
  const rate = (r) => 60_000 / at(r).cadenceMs;
  assert.ok(rate(60) > rate(300) * 5,
    `the last minute must be dramatically busier: ${rate(300).toFixed(1)}/min → ${rate(60).toFixed(1)}/min`);
});
