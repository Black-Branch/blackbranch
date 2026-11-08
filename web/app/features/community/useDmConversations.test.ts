// The DM list's live model (client polish Task 20): a line in a DM re-reads the list (its preview,
// its order, the rail chip), a line in a busy channel does not (the list would otherwise be rebuilt
// several times a second during a stream); the account's m.direct is healed, and a re-read alone
// never writes it.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G node --test app/features/community/useDmConversations.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mountHook } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";
import { ME, THEM, fakeRoom, text, threeRooms } from "../../lib/fixtures/dmThreeRooms.ts";

const { useDmConversations } = await import("./useDmConversations.ts");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a DM line re-reads the list; a busy channel's line does not; m.direct is healed, not re-written on every re-read", async () => {
  const s = threeRooms();
  const em = new EventEmitter();
  const channel = fakeRoom({ roomId: "!general", creator: ME, created: 0, members: [
    { userId: ME, membership: "join" }, { userId: THEM, membership: "join" }, { userId: "@x:site.test", membership: "join" },
  ] });
  s.rooms.push(channel);
  Object.assign(s.client, { on: (n: string, f: (...a: unknown[]) => void) => em.on(n, f), off: (n: string, f: (...a: unknown[]) => void) => em.off(n, f) });
  let reads = 0;
  const getRooms = s.client.getRooms;
  s.client.getRooms = () => { reads++; return getRooms(); };
  const h = await mountHook(() => useDmConversations(s.client as never, ME, s.rooms as never));
  await h.act(async () => { await wait(20); });
  assert.equal(h.current.list[0]?.partner, THEM);
  assert.ok(s.client.calls.some((c) => c.startsWith("setAccountData m.direct")), "Z filed in m.direct");
  const before = reads;

  // A line in #general (three people): nothing re-reads.
  await h.act(async () => { const e = text("@x:site.test", Date.now(), "chatter"); em.emit("Room.timeline", e, channel); await wait(200); });
  assert.equal(reads, before, "a channel's line never rebuilds the DM list");

  // Robin writes in Z: the list re-reads and shows the new line.
  await h.act(async () => {
    const e = Object.assign(text(THEM, Date.now(), "new from robin"), { getRoomId: () => "!z" });
    s.z.timeline.push(e);
    em.emit("Room.timeline", e, s.z);
    await wait(200);
  });
  assert.ok(reads > before, "re-read");
  assert.equal(h.current.list[0]?.preview, "new from robin");
  const filings = s.client.calls.filter((c) => c.startsWith("setAccountData m.direct")).length;
  assert.equal(filings, 1, "healed once for this client, not on every re-read");
  await h.unmount();
});
