// Polish handoff A8: a failed DM open showed the SDK's raw `e.message` to the person. Plain
// words on screen; the detail to the console only. The same for a line sent from the bound chat
// box: a send that left a "Not sent" line resolves (the box clears; the line carries the text and
// Retry); only a send that made no line at all throws, in plain words.
// Run: node --test app/features/dm/dmErrorWording.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "../../lib/testTsx.ts"; // resolves dmMatrix.ts's "@/" imports

const { sendDmLine } = await import("./dmMatrix.ts");

test("DmHost never puts an error's own message on screen", () => {
  const src = readFileSync(new URL("./DmHost.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /error: [^\n]*\$\{e\.message\}/, "no `${e.message}` in a shown error");
  assert.match(src, /console\.warn\("\[dm\] could not open the conversation:", e\);/);
  assert.match(src, /error: "Couldn't open the conversation — try again in a moment\." \}/);
  assert.match(src.trimEnd(), /\}$/);
});

/** A client whose send rejects with the SDK's raw words; `echo` = whether the SDK left the line. */
function failingClient(echo: boolean) {
  const sends: unknown[][] = [];
  const room = {
    roomId: "!dm",
    findEventById: (id: string) => (echo && id === "~!dm:txn1" ? { getId: () => id, status: "not_sent" } : null),
  };
  return {
    sends,
    makeTxnId: () => "txn1",
    getRoom: () => room,
    sendEvent: async (...a: unknown[]) => { sends.push(a); throw new Error("fetch failed: Failed to fetch"); },
  };
}

async function quietly<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: Error; logged: unknown[][] }> {
  const logged: unknown[][] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { logged.push(a); };
  try { return { value: await fn(), logged }; } catch (e) { return { error: e as Error, logged }; } finally { console.error = orig; }
}

test("no echo → the plain sentence", async () => {
  const c = failingClient(false);
  const r = await quietly(() => sendDmLine(c as never, "!dm", { msgtype: "m.text", body: "hi" }));
  assert.equal(r.error?.message, "Couldn't send — check your connection and try again.");
  assert.equal(r.logged.length, 1, "the SDK's own error goes to the console");
  assert.match(String(r.logged[0]?.[1]), /fetch failed/);
});

test("failed echo → resolves", async () => {
  const c = failingClient(true);
  const r = await quietly(() => sendDmLine(c as never, "!dm", { msgtype: "m.text", body: "hi" }));
  assert.equal(r.error, undefined, "the box clears: the Not sent line holds the text");
  assert.equal(r.value, false, "not sent — the caller sends no nudge");
});

test("a line starting with $ is the line, not a thread id (the explicit null thread id)", async () => {
  const c = failingClient(true);
  await quietly(() => sendDmLine(c as never, "!dm", { msgtype: "m.text", body: "$5 says hi" }));
  assert.deepEqual(c.sends[0], ["!dm", null, "m.room.message", { msgtype: "m.text", body: "$5 says hi" }, "txn1"]);
});
