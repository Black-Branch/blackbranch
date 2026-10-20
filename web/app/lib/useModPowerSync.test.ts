// runModPowerPlan: the per-room write loop useModPowerSync drives. One room
// throttled or refused must never end the loop for the rooms after it — the
// first run needs every channel written, and a single try/catch around the
// whole loop would abandon them all at the first M_LIMIT_EXCEEDED.
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/useModPowerSync.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { runModPowerPlan } from "./useModPowerSync.ts";

const err = (errcode: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(errcode), { errcode, data: extra });

function fakeClient(behaviour: Record<string, () => Promise<unknown>> = {}) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      setPowerLevel: (roomId: string) => {
        calls.push(roomId);
        return (behaviour[roomId] ?? (() => Promise.resolve({})))();
      },
    },
  };
}

const PLAN = [
  { roomId: "!a", userIds: ["@mod:site.test"] },
  { roomId: "!b", userIds: ["@mod:site.test"] },
  { roomId: "!c", userIds: ["@mod:site.test"] },
];

test("every room is attempted, in order", async () => {
  const { client, calls } = fakeClient();
  await runModPowerPlan(client, PLAN, async () => {});
  assert.deepEqual(calls, ["!a", "!b", "!c"]);
});

test("one room failing outright leaves the rest attempted", async () => {
  const { client, calls } = fakeClient({ "!b": () => Promise.reject(err("M_FORBIDDEN")) });
  await runModPowerPlan(client, PLAN, async () => {});
  assert.deepEqual(calls, ["!a", "!b", "!c"]);
});

test("a throttled room is retried once, with the server's own delay, and then succeeds", async () => {
  let attempts = 0;
  const waits: number[] = [];
  const { client, calls } = fakeClient({
    "!b": () => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(err("M_LIMIT_EXCEEDED", { retry_after_ms: 1500 }));
      return Promise.resolve({});
    },
  });
  await runModPowerPlan(client, PLAN, async (ms) => { waits.push(ms); });
  assert.deepEqual(calls, ["!a", "!b", "!b", "!c"]);
  assert.deepEqual(waits, [1500]);
  assert.equal(attempts, 2);
});

test("a room throttled twice is given up on, not retried forever, and the rest still run", async () => {
  const { client, calls } = fakeClient({ "!b": () => Promise.reject(err("M_LIMIT_EXCEEDED", { retry_after_ms: 10 })) });
  await runModPowerPlan(client, PLAN, async () => {});
  assert.deepEqual(calls, ["!a", "!b", "!b", "!c"]);
});

// Taking power back: the SDK's setPowerLevel drops a user's entry when the level is undefined
// (they fall back to the room default). The call shape is checked against the REAL client method,
// with only its two network calls replaced.
async function realClient(listed: Record<string, number>) {
  const { createClient } = await import("matrix-js-sdk");
  const client = createClient({ baseUrl: "https://hs.site.test", userId: "@casey:site.test", accessToken: "x" });
  const sent: { roomId: string; users: Record<string, number> | undefined }[] = [];
  Object.assign(client, {
    getStateEvent: async () => ({ users: { ...listed } }),
    sendStateEvent: async (roomId: string, _type: string, content: { users?: Record<string, number> }) => {
      sent.push({ roomId, users: content.users });
      return { event_id: "$1" };
    },
  });
  return { client, sent };
}

test("a demote (level null) reaches the real SDK as `undefined` and drops the user's entry", async () => {
  const { client, sent } = await realClient({ "@casey:site.test": 100, "@rosalind:site.test": 50, "@quinn:site.test": 50 });
  await runModPowerPlan(client, [{ roomId: "!a", userIds: ["@rosalind:site.test"] }], async () => {}, null);
  assert.deepEqual(sent, [{ roomId: "!a", users: { "@casey:site.test": 100, "@quinn:site.test": 50 } }]);
});

test("a grant still writes 50 through the real SDK", async () => {
  const { client, sent } = await realClient({ "@casey:site.test": 100 });
  await runModPowerPlan(client, [{ roomId: "!a", userIds: ["@rosalind:site.test"] }], async () => {});
  assert.deepEqual(sent, [{ roomId: "!a", users: { "@casey:site.test": 100, "@rosalind:site.test": 50 } }]);
});
