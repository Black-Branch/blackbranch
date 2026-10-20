// Behavior › mention sound: WHEN it may play.
// "New" means a LIVE frame not seen before — never a clock comparison: the
// message's time is the server's, the viewer's clock may be off by minutes.
// Run: node --test app/lib/mentionGate.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { createMentionGate } from "./mentionGate.ts";

const row = (key: string, live: boolean, alert = true) => ({ key, live, alert });

function gateAt(start = 1_000_000) {
  let now = start;
  const g = createMentionGate(() => now);
  return { g, tick: (ms: number) => { now += ms; } };
}

test("history rows (initial load, scroll-back, reconnect replay) never play", () => {
  const { g } = gateAt();
  assert.equal(g.check([row("t:1", false), row("t:2", false)]), false);
  assert.equal(g.check([row("t:0", false), row("t:1", false), row("t:2", false)]), false);
});

test("a new live mention plays; a new live plain message does not", () => {
  const { g, tick } = gateAt();
  g.check([row("t:1", false)]);
  tick(3000);
  assert.equal(g.check([row("t:1", false), row("t:2", true, false)]), false);
  tick(3000);
  assert.equal(g.check([row("t:1", false), row("t:2", true, false), row("t:3", true)]), true);
});

test("a live mention in the very first look plays (a page that started empty)", () => {
  const { g } = gateAt();
  assert.equal(g.check([row("t:9", true)]), true);
});

test("the same mention never plays twice", () => {
  const { g, tick } = gateAt();
  const rows = [row("t:5", true)];
  assert.equal(g.check(rows), true);
  tick(5000);
  assert.equal(g.check(rows), false);
});

test("at most once every 2 seconds", () => {
  const { g, tick } = gateAt();
  assert.equal(g.check([row("t:1", true)]), true);
  tick(500);
  assert.equal(g.check([row("t:1", true), row("t:2", true)]), false);
  tick(2000);
  assert.equal(g.check([row("t:1", true), row("t:2", true), row("t:3", true)]), true);
});

test("keys include the platform: the same id on two platforms are two messages", () => {
  const { g, tick } = gateAt();
  g.check([row("twitch:7", true, false)]);
  tick(3000);
  assert.equal(g.check([row("twitch:7", true, false), row("native:7", true)]), true);
});
