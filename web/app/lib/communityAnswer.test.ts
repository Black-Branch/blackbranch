// The community client's read of GET /api/community/mods: tolerant of an older server, one fetch
// per page once it has an answer, and a failure never kept.
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/communityAnswer.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommunityAnswer, fetchCommunityAnswer, watchCommunityAnswer } from "./communityAnswer.ts";

const ROLE = { key: "mod", label: "Mod", level: 50, colour: "#123456", hoist: true, orderKey: "a2", builtin: true };

test("an older server's answer (modIds and keepIds only) reads as no hub, nobody hidden and the default ladder", () => {
  const a = parseCommunityAnswer({ modIds: ["@m:x"], keepIds: ["@k:x"] });
  assert.deepEqual(a, { modIds: ["@m:x"], keepIds: ["@k:x"], hubRoomId: null, hiddenIds: [], roles: [], staffIds: [], botIds: [] });
});

test("a member's answer has no mod list: modIds is null, never an empty list (empty would read as 'nobody is a mod')", () => {
  const a = parseCommunityAnswer({ hubRoomId: "!h:x", hiddenIds: ["@s:x"], roles: [ROLE], staffIds: ["@st:x"], botIds: ["@b:x"] });
  assert.equal(a.modIds, null);
  assert.deepEqual(a.roles, [ROLE]);
  assert.equal(a.hubRoomId, "!h:x");
});

test("malformed fields are dropped one by one, not trusted", () => {
  const a = parseCommunityAnswer({
    hiddenIds: ["@ok:x", 7, null], staffIds: "nope", hubRoomId: 5,
    roles: [ROLE, { key: "x" }, { ...ROLE, level: "50" }, { ...ROLE, key: "c", colour: 3 }],
  });
  assert.deepEqual(a.hiddenIds, ["@ok:x"]);
  assert.deepEqual(a.staffIds, []);
  assert.equal(a.hubRoomId, null);
  assert.deepEqual(a.roles, [ROLE, { ...ROLE, key: "c", colour: null }], "a bad colour is no colour; a row without a numeric level is not a role");
  assert.deepEqual(parseCommunityAnswer(null).hiddenIds, []);
});

test("retry: a failed answer is not kept — the next read fetches again; a good one is kept for the page", async () => {
  let calls = 0;
  let ok = false;
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: string) => {
    calls++;
    assert.equal(url, "/api/community/mods");
    return ok ? Response.json({ hiddenIds: ["@s:x"] }) : new Response("no", { status: 503 });
  };
  assert.equal(await fetchCommunityAnswer(), null);
  ok = true;
  const second = await fetchCommunityAnswer();
  assert.deepEqual(second?.hiddenIds, ["@s:x"]);
  await fetchCommunityAnswer();
  assert.equal(calls, 2, "one fetch for the failure, one for the answer, none after");
});

const answer = (hiddenIds: string[]) => parseCommunityAnswer({ hiddenIds });

// A watch that stops asking never resolves these promises: the timeout makes that a failure, not a hang.
test("retry: a list whose first answer failed keeps asking, with a bounded wait, until one arrives", { timeout: 5_000 }, async () => {
  const results = [null, null, answer(["@s:x"])];
  const waits: number[] = [];
  const got: string[][] = [];
  let loads = 0;
  await new Promise<void>((done) => {
    watchCommunityAnswer((a) => { got.push(a.hiddenIds); done(); }, {
      load: async () => results[loads++] ?? null,
      wait: async (ms) => { waits.push(ms); },
    });
  });
  assert.equal(loads, 3, "failed, failed, answered");
  assert.deepEqual(got, [["@s:x"]], "the answer is handed over once");
  assert.equal(waits.length, 2);
  assert.ok(waits[0]! > 0 && waits[1]! >= waits[0]!, "it backs off");
});

test("the wait never grows past its cap, and a stopped watch asks no more", { timeout: 5_000 }, async () => {
  const waits: number[] = [];
  let loads = 0;
  let stop: () => void = () => {};
  await new Promise<void>((done) => {
    stop = watchCommunityAnswer(() => {}, {
      load: async () => { loads++; return null; },
      wait: async (ms) => { waits.push(ms); if (waits.length === 12) { stop(); done(); } },
    });
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(loads, 12, "no load after stop");
  assert.ok(Math.max(...waits) <= 60_000, "bounded at a minute");
  assert.equal(waits.at(-1), 60_000);
});