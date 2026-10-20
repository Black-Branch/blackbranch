// House looks.
//
// Run: node --test app/lib/houseLooks.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { houseBlob, resolveSlot, slotTone } from "./houseLooks.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const LP = "chatStyle_lowPower", LPP = "chatStyle_lowPowerPrev", FONT = "chatStyle_fontFamily";

test("a house look never carries the publisher's name colour or Low power", () => {
  // Applying a house look writes every key it holds. The publisher's name colour
  // would recolour the viewer's own name, and Low power would flip a phone's power
  // saving — neither is part of a "look".
  const out = houseBlob({
    chatUsernameColor: "#ff0000",
    [LP]: "1",
    [LPP]: "{}",
    [FONT]: "var(--font-dm-sans)",
  });
  assert.deepEqual(out, { [FONT]: "var(--font-dm-sans)" });
});

test("the stripped Low power keys are the registry's own storage names", () => {
  // houseLooks.ts spells them out; a rename in the registry must fail here, not
  // quietly let Low power ride along in every house look again.
  const reg = readFileSync(join(import.meta.dirname, "settingsRegistry.ts"), "utf8");
  assert.match(reg, /lowPower: E\(\{ ls: "chatStyle_lowPower",/);
  assert.match(reg, /lowPowerPrev: E\(\{ ls: "chatStyle_lowPowerPrev",/);
});

test("houseBlob does not mutate its input", () => {
  const src = { chatUsernameColor: "#fff", a: "1" };
  houseBlob(src);
  assert.equal(src.chatUsernameColor, "#fff");
});

test("your own look wins; the house look fills only an EMPTY slot", () => {
  const own = { name: "Mine", settings: { a: "1" } };
  const house = { name: "House", settings: { a: "2" } };
  assert.deepEqual(resolveSlot(own, house),
    { kind: "own", name: "Mine", settings: { a: "1" }, houseBehind: true });
  assert.deepEqual(resolveSlot(null, house),
    { kind: "house", name: "House", settings: { a: "2" }, houseBehind: true });
  assert.deepEqual(resolveSlot(own, null),
    { kind: "own", name: "Mine", settings: { a: "1" }, houseBehind: false });
  assert.deepEqual(resolveSlot(null, null),
    { kind: "empty", name: null, settings: null, houseBehind: false });
});

test("selected, your own and a house look are three different colours", () => {
  // One colour for your OWN look, another for the SELECTED one.
  // Selected is a light fill — never the accent, which the viewer picks and
  // which "own" already uses.
  const own = slotTone("own", false, false);
  const house = slotTone("house", false, false);
  const sel = slotTone("own", true, false);
  assert.match(own, /bg-accent\//);
  assert.doesNotMatch(house, /(bg|border|ring)-accent/);
  assert.match(sel, /bg-strong/);
  assert.doesNotMatch(sel, /(bg|border|ring)-accent/, "selected must not use the accent hue");
  assert.equal(slotTone("house", true, false), sel, "selected looks the same whichever kind was picked");
  assert.match(slotTone("empty", false, false), /cursor-default/);
});

test("an edited pick keeps its own colour plus an outline — not the selected fill", () => {
  const edited = slotTone("own", false, true);
  assert.match(edited, /bg-accent\//);
  assert.match(edited, /ring-1 ring-strong/);
  assert.doesNotMatch(edited, /bg-strong/);
  assert.match(slotTone("house", false, true), /ring-1 ring-strong/);
});

test("a look published while Low power was on carries the effects Low power had switched off", () => {
  // Low power flips real switches and remembers which were on (lowPower.ts).
  // Stripping only the flag would publish those effects OFF — every viewer would
  // get a look with glass and shadow silently disabled.
  const out = houseBlob({
    [LP]: "1",
    [LPP]: "glassOn,shadowOn",
    theme_glassOn: "0",
    chatStyle_shadow: "0",
    chatStyle_seam: "0",
    [FONT]: "x",
  });
  assert.deepEqual(out, { theme_glassOn: "1", chatStyle_shadow: "1", chatStyle_seam: "0", [FONT]: "x" });
  // Low power OFF: effects pass through untouched.
  assert.deepEqual(houseBlob({ [LP]: "0", [LPP]: "", theme_glassOn: "0" }), { theme_glassOn: "0" });
});

test("the Low power effect storage names match the registry", () => {
  const reg = readFileSync(join(import.meta.dirname, "settingsRegistry.ts"), "utf8");
  for (const [key, ls] of [
    ["animEmotesOn", "chatStyle_animEmotes"], ["piCycle", "chatStyle_piCycle"], ["unAnim", "chatStyle_unAnim"],
    ["shadowOn", "chatStyle_shadow"], ["seamOn", "chatStyle_seam"], ["chatFade", "chatStyle_chatFade"],
    ["transparencyOn", "theme_transparencyOn"], ["glassOn", "theme_glassOn"],
  ]) assert.match(reg, new RegExp(`\\n  ${key}: E\\(\\{ ls: "${ls}",`), `${key} is no longer stored as ${ls}`);
  const lp = readFileSync(join(import.meta.dirname, "lowPower.ts"), "utf8");
  assert.match(lp, /"animEmotesOn", "piCycle", "unAnim", "shadowOn", "seamOn", "chatFade", "transparencyOn", "glassOn",/,
    "Low power's switch list changed — houseLooks.ts LOW_POWER_LS must follow");
});
