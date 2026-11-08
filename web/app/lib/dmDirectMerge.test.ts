// The m.direct heal (client polish Task 20) on the three-rooms fixture: the signed-in account files
// its own missing rooms, never anyone else's, and writes nothing when nothing is missing.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G npx tsx --test app/lib/dmDirectMerge.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { healOwnDirect, mergeOwnDirect } from "./dmDirectMerge.ts";
import { ME, SAM, T, THEM, fakeClient, fakeRoom, text, threeRooms } from "./fixtures/dmThreeRooms.ts";

type C = Parameters<typeof mergeOwnDirect>[0];
const direct = (c: { data: Record<string, unknown> }) => c.data["m.direct"] as Record<string, string[]>;

test("merge adds Z under the partner and keeps X, Y", async () => {
  const { client } = threeRooms();
  const added = await mergeOwnDirect(client as unknown as C, ME);
  assert.equal(added, 1);
  assert.deepEqual(direct(client)[THEM], ["!x", "!y", "!z"]);
  assert.deepEqual(direct(client)[SAM], ["!sam"], "everyone else's entry as it was");
  assert.equal(client.calls.filter((c) => c.startsWith("setAccountData m.direct")).length, 1, "one write");
});

test("never writes when nothing is missing", async () => {
  const { client } = threeRooms();
  await mergeOwnDirect(client as unknown as C, ME);
  client.calls.length = 0;
  // restart: a second client start finds Z already filed.
  assert.equal(await mergeOwnDirect(client as unknown as C, ME), 0);
  assert.deepEqual(client.calls, []);
});

test("a room someone else made and I never accepted as a DM is not filed (Task 2: only rooms we made or accepted)", async () => {
  // Two people, closed — but no DM invite mark anywhere: a plain invite into their room.
  const plain = fakeRoom({ roomId: "!plain", creator: THEM, created: T, members: [{ userId: ME, membership: "join" }, { userId: THEM, membership: "join" }], events: [text(THEM, T + 1, "hi")] });
  const client = fakeClient([plain], { "m.direct": {} });
  assert.equal(await mergeOwnDirect(client as unknown as C, ME), 0);
  assert.deepEqual(client.calls, []);
});

test("a room with a third person is never filed, whatever its marks", async () => {
  const three = fakeRoom({
    roomId: "!three", creator: THEM, created: T,
    members: [{ userId: ME, membership: "join", dmInviter: THEM }, { userId: THEM, membership: "join" }, { userId: SAM, membership: "join" }],
  });
  const client = fakeClient([three], { "m.direct": {} });
  assert.equal(await mergeOwnDirect(client as unknown as C, ME), 0);
});

test("retry: a failed write is tried again on the next change; restart: a room arriving later (first pass ran on no rooms) is filed", async () => {
  const { client, rooms } = threeRooms();
  // The list's first answer comes before the rooms have synced: nothing to file yet.
  const all = rooms.splice(0);
  await healOwnDirect(client as unknown as C, ME);
  assert.deepEqual(client.calls, []);
  rooms.push(...all);
  const set = client.setAccountData;
  let fail = true;
  client.setAccountData = async (type, content) => { if (fail) throw new Error("offline"); return set(type, content); };
  const warn = console.warn;
  console.warn = () => {};
  try { await healOwnDirect(client as unknown as C, ME); } finally { console.warn = warn; }
  assert.deepEqual(direct(client)[THEM], ["!x", "!y"], "the write failed: nothing filed");
  fail = false;
  await healOwnDirect(client as unknown as C, ME);
  assert.deepEqual(direct(client)[THEM], ["!x", "!y", "!z"], "the next change files it");
});

test("one pass at a time per client: calls during a pass run one more pass after it, never two writes at once", async () => {
  const { client } = threeRooms();
  let inFlight = 0;
  let most = 0;
  const set = client.setAccountData;
  client.setAccountData = async (type, content) => {
    inFlight++; most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return set(type, content);
  };
  await Promise.all([healOwnDirect(client as unknown as C, ME), healOwnDirect(client as unknown as C, ME), healOwnDirect(client as unknown as C, ME)]);
  assert.equal(most, 1);
  assert.equal(client.calls.filter((c) => c.startsWith("setAccountData m.direct")).length, 1, "the second pass found nothing missing");
});
