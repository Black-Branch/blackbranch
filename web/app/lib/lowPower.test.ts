// Low power: the switch's pure logic — flip every listed effect off,
// remember which were on, restore them, and report tri-state for the row
// label. Run: node --test app/lib/lowPower.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { lowPowerOn, lowPowerOff, lowPowerState, LOW_POWER_KEYS } from "./lowPower.ts";

const all = (v: boolean) => Object.fromEntries(LOW_POWER_KEYS.map((k) => [k, v]));

test("on: every effect off, the ones that were on are remembered", () => {
  const before = { ...all(false), shadowOn: true, piCycle: true, lowPower: false, lowPowerPrev: "" };
  const ch = lowPowerOn(before);
  for (const k of LOW_POWER_KEYS) assert.equal(ch[k], false);
  assert.equal(ch.lowPower, true);
  assert.equal(ch.lowPowerPrev, "piCycle,shadowOn");
});

test("off: restores exactly what was on", () => {
  const on = { ...all(false), lowPower: true, lowPowerPrev: "piCycle,shadowOn" };
  const ch = lowPowerOff(on);
  assert.deepEqual({ piCycle: ch.piCycle, shadowOn: ch.shadowOn, glassOn: ch.glassOn }, { piCycle: true, shadowOn: true, glassOn: undefined });
  assert.equal(ch.lowPower, false);
  assert.equal(ch.lowPowerPrev, "");
});

test("state: some-on when a switch was turned back on under low power", () => {
  assert.equal(lowPowerState({ ...all(false), lowPower: false }), "off");
  assert.equal(lowPowerState({ ...all(false), lowPower: true }), "on");
  assert.equal(lowPowerState({ ...all(false), shadowOn: true, lowPower: true }), "some");
});

test("the remembered list fits the 256-char blob cap", () => {
  assert.ok(lowPowerOn(all(true)).lowPowerPrev!.toString().length < 256);
});
