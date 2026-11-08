// Declining an invite is ONE call shared by the Community invite row and the DM window's request.
// Run: node --test app/lib/matrixInvites.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./testSource.ts";
import { declineInvite } from "./matrixInvites.ts";

test("declineInvite leaves the room (Matrix: a declined invite is a leave)", async () => {
  const calls: string[] = [];
  await declineInvite({ leave: async (id: string) => { calls.push(`leave ${id}`); return {}; } } as never, "!inv");
  assert.deepEqual(calls, ["leave !inv"]);
});

test("the Community invite row and the DM window both decline through it; neither keeps its own leave", () => {
  const view = stripComments(readFileSync("app/features/community/MatrixView.tsx", "utf8"));
  const host = stripComments(readFileSync("app/features/dm/DmHost.tsx", "utf8"));
  assert.match(view, /await declineInvite\(client, room\.roomId\);/);
  assert.match(host, /declineInvite\(/);
  assert.doesNotMatch(view + host, /client\.leave\(/);
  assert.match(host, /\}\s*$/, "vacuity anchor");
});
