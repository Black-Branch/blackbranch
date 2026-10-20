// The fan-out across a server's channels: sequential, rate-limit aware, and
// honest about which rooms did not land.
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/matrixModerate.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { moderateEverywhere, type ModClient, type ScopeRoom } from "./matrixModerate.ts";

const ROOMS: ScopeRoom[] = [
  { roomId: "!a", name: "general" },
  { roomId: "!b", name: "politics" },
  { roomId: "!c", name: "tech" },
];

/** Records call order so "sequential" can be asserted, not assumed. */
function fakeClient(behaviour: Record<string, () => Promise<unknown>> = {}) {
  const calls: string[] = [];
  const run = (roomId: string) => {
    calls.push(roomId);
    return (behaviour[roomId] ?? (() => Promise.resolve({})))();
  };
  const client: ModClient = {
    kick: (roomId) => run(roomId),
    ban: (roomId) => run(roomId),
    unban: (roomId) => run(roomId),
  };
  return { client, calls };
}

const err = (errcode: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(errcode), { errcode, data: extra });

test("every room is attempted, in order, one at a time", async () => {
  const { client, calls } = fakeClient();
  const out = await moderateEverywhere(client, "ban", ROOMS, "@bad:site.test");
  assert.deepEqual(calls, ["!a", "!b", "!c"]);
  assert.deepEqual(out.map((r) => r.status), ["ok", "ok", "ok"]);
});

test("one room failing does not stop the rest", async () => {
  const { client, calls } = fakeClient({ "!b": () => Promise.reject(err("M_FORBIDDEN")) });
  const out = await moderateEverywhere(client, "ban", ROOMS, "@bad:site.test");
  assert.deepEqual(calls, ["!a", "!b", "!c"]);
  assert.deepEqual(out.map((r) => r.status), ["ok", "failed", "ok"]);
  assert.equal(out[1]?.name, "politics");
});

test("a target who was never in the room counts as done, not failed", async () => {
  // Synapse answers a kick/ban of a non-member with M_FORBIDDEN carrying this
  // message; the desired end state already holds, so it is a no-op.
  const notIn = Object.assign(new Error("not in room"), {
    errcode: "M_FORBIDDEN",
    data: { error: "The target user is not in the room" },
  });
  const { client } = fakeClient({ "!b": () => Promise.reject(notIn) });
  const out = await moderateEverywhere(client, "kick", ROOMS, "@bad:site.test");
  assert.equal(out[1]?.status, "noop");
});

test("an unban of a room the ban never reached counts as done, not failed", async () => {
  // Synapse's real answer to unbanning a non-banned user — a different
  // errcode from the kick/ban "not in the room" case above, which is why the
  // old isAlreadyDone (M_FORBIDDEN-only) missed it: if the original ban only
  // reached some rooms, the unban reported the rest as failures when they
  // were already in the desired (not-banned) state.
  const notBanned = Object.assign(new Error("not banned"), {
    errcode: "M_BAD_STATE",
    data: { error: "Cannot unban a user who was not banned" },
  });
  const { client } = fakeClient({ "!b": () => Promise.reject(notBanned) });
  const out = await moderateEverywhere(client, "unban", ROOMS, "@bad:site.test");
  assert.equal(out[1]?.status, "noop");
});

test("a rate-limited room waits the server's own delay and is retried once", async () => {
  let attempts = 0;
  const waits: number[] = [];
  const { client } = fakeClient({
    "!b": () => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(err("M_LIMIT_EXCEEDED", { retry_after_ms: 2500 }));
      return Promise.resolve({});
    },
  });
  const out = await moderateEverywhere(client, "ban", ROOMS, "@bad:site.test", async (ms) => {
    waits.push(ms);
  });
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [2500]);
  assert.equal(out[1]?.status, "ok");
});

test("a room rate-limited twice is reported as failed, not retried forever", async () => {
  let attempts = 0;
  const { client } = fakeClient({
    "!b": () => {
      attempts += 1;
      return Promise.reject(err("M_LIMIT_EXCEEDED", { retry_after_ms: 10 }));
    },
  });
  const out = await moderateEverywhere(client, "ban", ROOMS, "@bad:site.test", async () => {});
  assert.equal(attempts, 2);
  assert.equal(out[1]?.status, "failed");
});

test("the action chosen is the method called", async () => {
  const seen: string[] = [];
  const client: ModClient = {
    kick: async () => { seen.push("kick"); },
    ban: async () => { seen.push("ban"); },
    unban: async () => { seen.push("unban"); },
  };
  await moderateEverywhere(client, "unban", [ROOMS[0]!], "@bad:site.test");
  assert.deepEqual(seen, ["unban"]);
});
