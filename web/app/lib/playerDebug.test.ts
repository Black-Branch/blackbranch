import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PlayerDebugLog, readPlayerDebugSwitch } from "./playerDebug.ts";
import { stripComments } from "./testSource.ts";

test("the switch: the URL turns it on or off and is remembered; otherwise the stored value", () => {
  assert.deepEqual(readPlayerDebugSwitch("?playerdebug=1", null), { on: true, store: "1" });
  assert.deepEqual(readPlayerDebugSwitch("?a=b&playerdebug=0", "1"), { on: false, store: null });
  assert.deepEqual(readPlayerDebugSwitch("", "1"), { on: true, store: undefined });
  assert.deepEqual(readPlayerDebugSwitch("?x=1", null), { on: false, store: undefined });
  assert.equal(readPlayerDebugSwitch("?myplayerdebug=1", null).on, false, "a longer param name is not the switch");
});

test("only pauses, mutes, media resets, reloads and remounts send a report; the rest fill the log", () => {
  let now = 1000;
  const l = new PlayerDebugLog(40, () => now);
  for (const k of ["mount", "play", "playing", "waiting", "resize", "unmuted", "volume"]) assert.equal(l.push(k), null, k);
  for (const k of ["pause", "muted", "emptied", "iframe-reload", "remount"]) { now += 31_000; assert.ok(l.push(k), k); }
});

test("a report says how long since the last tap — the line between 'I paused it' and 'it paused itself'", () => {
  let now = 0;
  const l = new PlayerDebugLog(40, () => now);
  now = 5000; l.push("playing");
  now = 9000; assert.match(l.push("pause")!.message, /no tap or key this load/);
  now = 20_000; l.interaction();
  now = 20_250; const r = l.push("pause", "t=12.0 ready=4")!;
  assert.match(r.message, /^player debug: pause \(t=12\.0 ready=4\) at \+20s, last tap or key 250 ms before$/);
  assert.match(r.stack, /\+5\.0s playing\n\+9\.0s pause\n\+20\.3s pause t=12\.0 ready=4$/);
});

test("the log keeps the newest events and fits the sink's 4000-character stack", () => {
  const l = new PlayerDebugLog(5, () => 0);
  for (let i = 0; i < 9; i++) l.push(`e${i}`);
  assert.equal(l.format(), ["e4", "e5", "e6", "e7", "e8"].map((k) => `+0.0s ${k}`).join("\n"));
  const big = new PlayerDebugLog(200, () => 0);
  for (let i = 0; i < 200; i++) big.push("resize", "x".repeat(120));
  const out = big.format();
  assert.ok(out.length <= 3800 && out.length > 3000, `stack is ${out.length} chars`);
});

test("the player area wires the log, and it touches nothing in playback", () => {
  const area = stripComments(readFileSync(join(import.meta.dirname, "../features/player/StreamPlayerArea.tsx"), "utf8"));
  assert.match(area, /usePlayerDebug\(boxRef, src\)/);
  const hook = stripComments(readFileSync(join(import.meta.dirname, "../features/player/usePlayerDebug.ts"), "utf8"));
  assert.doesNotMatch(hook, /\.(play|pause|load)\(\)|\.muted\s*=|\.src\s*=|currentTime\s*=/, "the debug log must only observe");
  assert.match(hook, /reportClientError\("player"/);
  assert.ok(hook.trimEnd().endsWith("}"), "END anchor: the whole hook was read");
});
