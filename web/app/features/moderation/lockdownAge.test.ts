// The account-age lever names what it holds: only the platforms whose account age can be checked
// (stream-api /lockdown/checkable), and "Age unknown on <platform> — not held" for each other one.
// It never says it holds Kick, and never "under 7d" for a platform it does not hold.
// Run: node --test app/features/moderation/lockdownAge.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ageLeverText } from "./lockdownAge.ts";

const checkable = { twitch: true, kick: false, youtube: true, streamplace: false, native: true };

test("on, with checkable platforms: holds those under N days; each uncheckable one is 'age unknown — not held'", () => {
  const t = ageLeverText(7, checkable);
  assert.equal(t.detail, "Holding Twitch and YouTube accounts under 7d. Held messages wait in review, not deleted.");
  assert.deepEqual(t.unknown, ["Age unknown on Kick — not held.", "Age unknown on Streamplace — not held."]);
  assert.equal(t.armed(7), "Holding Twitch and YouTube accounts under 7 days.");
});

test("off: says what it would hold, and the same unknown lines", () => {
  const t = ageLeverText(0, checkable);
  assert.equal(t.detail, "Holds new Twitch and YouTube accounts for review.");
  assert.equal(t.unknown.length, 2);
});

test("Twitch without app keys, YouTube without an API key: only what is checkable is named", () => {
  const t = ageLeverText(7, { twitch: false, kick: false, youtube: true, streamplace: false, native: true });
  assert.equal(t.detail, "Holding YouTube accounts under 7d. Held messages wait in review, not deleted.");
  assert.deepEqual(t.unknown, ["Age unknown on Twitch — not held.", "Age unknown on Kick — not held.", "Age unknown on Streamplace — not held."]);
});

test("nothing checkable: the lever says it holds nothing from platform chat — never a whole audience", () => {
  const t = ageLeverText(7, { twitch: false, kick: false, youtube: false, streamplace: false, native: true });
  assert.match(t.detail, /holds nothing from platform chat/);
  assert.equal(t.unknown.length, 4);
  assert.match(t.armed(7), /nothing is held/);
});

test("the answer could not be read: no platform is named either way, and Kick is never said to be held", () => {
  for (const c of [null, undefined]) {
    const on = ageLeverText(7, c);
    assert.match(on.detail, /^Holding platform accounts under 7d where the platform says how old an account is/);
    assert.deepEqual(on.unknown, []);
    for (const s of [on.detail, ageLeverText(0, c).detail, on.armed(7)]) assert.doesNotMatch(s, /Kick|Twitch|YouTube/);
  }
});
