// The refusal-rate alarm (matrixSessionWatch.ts), EXECUTED with an injected clock and notifier.
// The 10-21 incident was five accounts signed out every 5 minutes for days, noticed only when a
// viewer reported it; either threshold below would have flagged it on its first evening.
// Run: node --test app/lib/matrixSessionWatch.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRefusalWatch, createSessionAlarms, REFUSAL_WINDOW_MS, REFUSAL_SITE_LIMIT } from "./matrixSessionWatch.ts";

function fixture(start = 1_800_000_000_000) {
  let t = start;
  const sent: { title: string; message: string }[] = [];
  const watch = createRefusalWatch({ now: () => t, notify: (title, message) => sent.push({ title, message }) });
  return { watch, sent, advance: (ms: number) => { t += ms; } };
}

const acct = (n: number) => `@viewer${n}:site.test`;

test("the thresholds are the review's: more than 3 refusals in an hour site-wide, or one account twice in an hour", () => {
  assert.equal(REFUSAL_WINDOW_MS, 60 * 60 * 1000);
  assert.equal(REFUSAL_SITE_LIMIT, 3);
});

test("three refusals from three accounts in an hour stay quiet; the fourth alarms once", () => {
  const { watch, sent, advance } = fixture();
  for (let i = 1; i <= 3; i++) { watch.record(acct(i)); advance(60_000); }
  assert.equal(sent.length, 0);
  watch.record(acct(4));
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.message, /4 sign-in refusals or failed revocations in the last hour/);
});

test("one burst is one alarm: the fifth and sixth refusal in the same hour send nothing more", () => {
  const { watch, sent, advance } = fixture();
  for (let i = 1; i <= 6; i++) { watch.record(acct(i)); advance(1_000); }
  assert.equal(sent.length, 1);
});

test("the same account refused twice within an hour alarms, even when the site total is low", () => {
  const { watch, sent, advance } = fixture();
  watch.record(acct(1));
  advance(5 * 60_000); // the 10-21 cycle: one access-token lifetime later
  watch.record(acct(1));
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.message, /one account was refused 2 times \(a refused refresh or a failed revocation\)/);
  advance(5 * 60_000);
  watch.record(acct(1));
  assert.equal(sent.length, 1, "the third refusal of that account in the hour is the same burst");
});

test("refusals more than an hour apart never alarm", () => {
  const { watch, sent, advance } = fixture();
  for (let i = 0; i < 10; i++) { watch.record(acct(1)); advance(REFUSAL_WINDOW_MS + 1); }
  assert.equal(sent.length, 0);
});

test("retry: once a burst has aged out of the window, the next burst alarms again", () => {
  const { watch, sent, advance } = fixture();
  for (let i = 1; i <= 4; i++) watch.record(acct(i));
  assert.equal(sent.length, 1);
  advance(REFUSAL_WINDOW_MS + 1);
  for (let i = 1; i <= 4; i++) watch.record(acct(i + 10));
  assert.equal(sent.length, 2);
});

test("restart: a new process starts with an empty window (the count is per process; the journal line is the record)", () => {
  const first = fixture();
  for (let i = 1; i <= 3; i++) first.watch.record(acct(i));
  const second = fixture();
  second.watch.record(acct(9));
  assert.equal(first.sent.length + second.sent.length, 0);
  assert.equal(second.watch.size(), 1, "nothing carried over from the first process");
});

test("memory stays bounded: entries older than the window are dropped as new ones arrive", () => {
  const { watch, advance } = fixture();
  for (let i = 0; i < 500; i++) { watch.record(acct(i)); advance(REFUSAL_WINDOW_MS / 10); }
  assert.ok(watch.size() <= 11, `held ${watch.size()} entries`);
});

test("the alarm names no account: the message carries counts only", () => {
  const { watch, sent } = fixture();
  watch.record(acct(1));
  watch.record(acct(1));
  for (let i = 2; i <= 5; i++) watch.record(acct(i));
  assert.ok(sent.length >= 1);
  for (const s of sent) assert.doesNotMatch(`${s.title} ${s.message}`, /viewer|@|site\.test/);
});

// ─── Two sides: an outside server can neither fire nor mask this install's alarm ──────────────

test("re-arm by time: a steady trickle that never empties the window still alarms again an hour after the last alarm", () => {
  const { watch, sent, advance } = fixture();
  for (let i = 0; i < 4; i++) watch.record(acct(i));
  assert.equal(sent.length, 1);
  // One refusal every 10 minutes, for two hours: the window always holds ~6.
  for (let i = 0; i < 12; i++) { advance(10 * 60_000); watch.record(acct(100 + i)); }
  assert.equal(sent.length, 3, "re-armed at 60 and 120 minutes, not latched for good");
});

function alarms(start = 1_800_000_000_000) {
  let t = start;
  const sent: { key: string; title: string; message: string }[] = [];
  const a = createSessionAlarms({
    now: () => t, localKey: "web.local", outsideKey: "web.outside",
    notify: (key, title, message) => sent.push({ key, title, message }),
  });
  return { a, sent, advance: (ms: number) => { t += ms; } };
}

test("a flood of outside-server failures never latches this install's alarm; a local burst after it still alarms", () => {
  const { a, sent, advance } = alarms();
  for (let i = 0; i < 200; i++) { a.record(`@x${i}:outside.example`, "federated"); advance(1_000); }
  assert.ok(sent.length >= 1 && sent.every((s) => s.key === "web.outside"), "the flood alarms only under the outside key");
  assert.equal(a.sizes().local, 0, "nothing counted on the local side");
  for (let i = 1; i <= 4; i++) a.record(acct(i), "local");
  const local = sent.filter((s) => s.key === "web.local");
  assert.equal(local.length, 1, "the real local burst alarmed despite the flood");
  assert.equal(local[0]!.title, "Sign-ins are being refused");
});

test("the outside side alarms at the SAME thresholds as ours, with its own wording and key", () => {
  const site = alarms();
  for (let i = 0; i < 3; i++) site.a.record(`@x${i}:outside.example`, "federated");
  assert.equal(site.sent.length, 0, "three in an hour stay quiet, as on our side");
  site.a.record("@x3:outside.example", "federated");
  assert.deepEqual(site.sent.map((s) => [s.key, s.title]), [["web.outside", "Outside servers refuse sign-ins"]]);
  assert.doesNotMatch(site.sent[0]!.message, /@|outside\.example/, "names no account or server");
  const one = alarms();
  one.a.record("@x:outside.example", "federated");
  one.advance(5 * 60_000);
  one.a.record("@x:outside.example", "federated");
  assert.deepEqual(one.sent.map((s) => [s.key, s.title]), [["web.outside", "An outside sign-in keeps being refused"]], "one account twice in an hour");
});

test("a local burst does not suppress the outside alarm either", () => {
  const { a, sent } = alarms();
  for (let i = 1; i <= 4; i++) a.record(acct(i), "local");
  for (let i = 0; i < 4; i++) a.record(`@x${i}:outside.example`, "federated");
  assert.deepEqual(sent.map((s) => s.key).sort(), ["web.local", "web.outside"]);
});
