// What the help desk may promise is read from what the install runs: stream-api's flags
// when it has them, the saved switches before it does; cached, and a failed read keeps the last
// answer.
import test from "node:test";
import assert from "node:assert/strict";
import { createSupportFacts } from "./supportFactsServer.ts";

type Answers = Record<string, { status: number; body?: unknown } | Error>;

function harness(answers: Answers, bools: Record<string, boolean> = {}, opts: { providerOn?: boolean; subs?: boolean } = {}) {
  let now = 0;
  const calls: string[] = [];
  const read = createSupportFacts({
    fetch: async (path) => {
      calls.push(path);
      const a = answers[path];
      if (!a) return { ok: false, status: 404, json: async () => null };
      if (a instanceof Error) throw a;
      return { ok: a.status === 200, status: a.status, json: async () => a.body };
    },
    bool: (k) => bools[k] === true,
    providerOn: () => opts.providerOn ?? true,
    subscriptions: async () => opts.subs ?? false,
    now: () => now,
  });
  return { read, calls, answers, tick: (ms: number) => { now += ms; } };
}

test("stream-api's flags decide: AI free text off, the voice on with key and voice set", async () => {
  const h = harness({
    "/bot/support/status": { status: 200, body: { aiFreeText: false } },
    "/tts/status": { status: 200, body: { enabled: true, keySet: true, voiceSet: true, sink: null } },
  }, { "helpdesk.enabled": true, "currency.purchasable": true }, { subs: true });
  assert.deepEqual(await h.read(), { purchasable: true, subscriptions: true, tts: true, freeText: false });
});

test("the voice switched on without a key or a voice does not count as speaking", async () => {
  const h = harness({ "/tts/status": { status: 200, body: { enabled: true, keySet: false, voiceSet: true } } });
  assert.equal((await h.read()).tts, false);
});

test("before stream-api has the routes (404), the saved switches answer", async () => {
  const off = harness({}, {});
  assert.deepEqual(await off.read(), { purchasable: false, subscriptions: false, tts: false, freeText: false });
  const on = harness({}, { "helpdesk.enabled": true, "tts.enabled": true });
  const f = await on.read();
  assert.equal(f.freeText, true);
  assert.equal(f.tts, true);
});

test("points are buyable only with the switch AND a payment provider", async () => {
  assert.equal((await harness({}, { "currency.purchasable": true }, { providerOn: false }).read()).purchasable, false);
  assert.equal((await harness({}, { "currency.purchasable": true }, { providerOn: true }).read()).purchasable, true);
});

test("cached 30 s; a failed read after that keeps the last answer (retry), then a later answer replaces it", async () => {
  const h = harness({ "/bot/support/status": { status: 200, body: { aiFreeText: true } } });
  assert.equal((await h.read()).freeText, true);
  h.tick(10_000);
  await h.read();
  assert.equal(h.calls.filter((c) => c === "/bot/support/status").length, 1, "inside the window: no second read");
  h.answers["/bot/support/status"] = new Error("stream-api restarting");
  h.tick(30_000);
  assert.equal((await h.read()).freeText, true, "a failed read keeps the last answer");
  h.answers["/bot/support/status"] = { status: 200, body: { aiFreeText: false } };
  h.tick(30_000);
  assert.equal((await h.read()).freeText, false);
});
