// Guards for the Effects section of the chat customizations: the Effects tab,
// the per-device chat-history setting, and the rule that each effect switch is
// listed once. (A sealed message is a still redacted bar — there is no idle
// shimmer and no toggle for one.)
//
// Run: node --test app/lib/perfSection.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

const read = (...p: string[]) => stripComments(readFileSync(join(process.cwd(), ...p), "utf8"));

test("chat history length is per-DEVICE (perf choices never roam)", () => {
  const reg = read("app", "lib", "settingsRegistry.ts");
  // Behavior › Chat history length replaces a Reduced switch.
  assert.match(reg, /histLength: E\(\{ ls: "chatStyle_histLength", prePaint: false, deviceLocal: true, behavior: true,/,
    "histLength lost deviceLocal");
  assert.match(reg, /histLength:\s*"default" as HistoryLength,/, "history default must be Default");
  assert.doesNotMatch(reg, /histReduced/, "the old switch is back as a second control for the same caps");
  // Comments are stripped by read(), so the removal note in the registry does not count.
  assert.doesNotMatch(reg, /encShimmer/,
    "encShimmer is back — the sealed cipher is a still bar, there is no idle animation for it to switch");
  assert.ok(reg.trimEnd().length > 0 && /histLength: E\(/.test(reg), "settingsRegistry.ts read short — the negative above is vacuous");
});

const effectsSection = (menu: string) => menu.match(/\{ title: "Effects", tab: "effects", items: \[[^\]]*\]/)?.[0] ?? "";

test("the Effects tab exists and the Effects section lists its toggles", () => {
  const menu = read("app", "lib", "settingsMenu.ts");
  assert.match(menu, /\{ key: "effects",\s*label: "Effects",/, "the Effects section is gone");
  const section = effectsSection(menu);
  for (const key of ["lowPower", "shadowOn", "piCycle", "unAnim"]) {
    assert.match(section, new RegExp(`s\\("${key}"[,)]`),
      `${key} fell out of the Effects section`);
  }
});

test("every Effects switch lives there ONCE — no key of it is listed in any other section", () => {
  // Each switch is in Effects and nowhere else, so one control is one place —
  // no section re-lists appearance switches.
  const menu = read("app", "lib", "settingsMenu.ts");
  const section = effectsSection(menu);
  const keys = [...section.matchAll(/(?<![A-Za-z])s\("(\w+)"/g)].map((m) => m[1]!);
  assert.ok(keys.length > 10, `parsed only ${keys.length} Effects keys — the negative below is vacuous`);
  for (const key of keys) {
    const count = (menu.match(new RegExp(`(?<![A-Za-z])s\\("${key}"`, "g")) ?? []).length;
    assert.equal(count, 1, `${key} is listed ${count} times — it belongs to Effects only`);
  }
});

test("history depth changes the cap NUMBERS, never the anchored/unanchored split", () => {
  const src = read("app", "lib", "useChatMessages.ts");
  // The numbers live in chatCaps.ts (the server pages read the live cap too).
  const caps = read("app", "lib", "chatCaps.ts");
  assert.match(caps, /export function historyCaps\(/, "the length → caps function is gone");
  // useSetting, not the raw key: the /chat window keeps its own ("ov:") copy.
  assert.match(src, /useSetting\("chatStyle_histLength"\)/, "the buffer reads the unscoped key — the /chat window's pick never lands");
  assert.match(src, /capsRef\.current = historyCaps\(histLengthLs\);/,
    "the setting no longer selects the caps");
  // The load-bearing split (trimming while scrolled back yanks rows out from
  // under the reader) must keep its exact shape, reading the live ref.
  const splits = src.match(/anchoredRef\.current \? capsRef\.current\.live : capsRef\.current\.scrollback/g) ?? [];
  assert.equal(splits.length, 2,
    `expected the anchored-cap ternary at exactly 2 sites reading capsRef, found ${splits.length}`);
  assert.doesNotMatch(src, /anchoredRef\.current \? CHAT_LIVE_CAP/,
    "a cap site still reads the constant — the toggle silently misses it");
});

test("a sealed message is still: no idle timer, no observer, no per-frame work at rest", () => {
  // An idle shimmer would re-render every sealed message on a 140 ms
  // interval, and an IntersectionObserver fence does not hold it: on a desktop
  // it kept a browser at ~35% of a high-end GPU and cost a stream 1.1% of its
  // frames. A sealed message is a still redacted bar; the only motion is the
  // one-shot reveal/re-seal walk, which runs on a tap.
  const raw = readFileSync(join(process.cwd(), "app", "components", "RedactedText.tsx"), "utf8");
  // End-of-file anchor: every assertion below is negative, so a short read would pass them all.
  assert.ok(raw.trimEnd().endsWith("}"), "RedactedText.tsx truncated — the negatives below are vacuous");
  const src = stripComments(raw);
  assert.doesNotMatch(src, /setInterval\s*\(/, "an interval is back in RedactedText — the idle churn returned");
  assert.doesNotMatch(src, /IntersectionObserver/, "an on-screen fence is back — so is something for it to fence");
  assert.doesNotMatch(src, /ENC_IDLE_|shimmer/i, "the idle shimmer is back");
  // The walk is the only rAF, and it is only ever started from reveal().
  const rafStarts = src.match(/requestAnimationFrame\(frame\)/g) ?? [];
  assert.equal(rafStarts.length, 2, `expected the walk's own two rAF calls, found ${rafStarts.length}`);
  assert.match(src, /redactSegments\(/, "the sealed text no longer renders as redacted bars");
});
