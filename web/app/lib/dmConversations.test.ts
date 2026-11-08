// The DM list's model (client polish Task 20; dm-crypto-research B.4 option 1): one conversation per
// PERSON, over the three-rooms fixture (research B.1 with fake ids). Behaviour on a fake client —
// dmConversations.ts imports only the SDK's types.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G npx tsx --test app/lib/dmConversations.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { conversationActions, conversationWith, dmConversations, previewOf, readClosed } from "./dmConversations.ts";
import { BANNED, ME, QUINN, RIVER, SAM, T, THEM, ev, fakeClient, fakeRoom, text, threeRooms } from "./fixtures/dmThreeRooms.ts";

type C = Parameters<typeof dmConversations>[0];
const ids = (rooms: { roomId: string }[]) => rooms.map((r) => r.roomId);

test("three rooms with one partner → one conversation, active = Z, earlier = [Y, X]", () => {
  const { client } = threeRooms();
  const convs = dmConversations(client as unknown as C, ME, {});
  const robin = convs.filter((c) => c.partner === THEM);
  assert.equal(robin.length, 1, "one row for the person, not one per room");
  assert.equal(robin[0]!.active.roomId, "!z", "the newest-active room is the one we talk in");
  assert.deepEqual(ids(robin[0]!.earlier), ["!y", "!x"], "the older rooms, newest first");
  assert.equal(robin[0]!.preview, "You: line 17", "the newest line, mine");
});

test("a room missing from m.direct with exactly {me, them} is found", () => {
  const { client, z } = threeRooms();
  assert.ok(!(client.data["m.direct"] as Record<string, string[]>)[THEM]!.includes(z.roomId), "the fixture's Z is unfiled");
  const robin = dmConversations(client as unknown as C, ME, {}).find((c) => c.partner === THEM)!;
  assert.equal(robin.active.roomId, "!z");
  // The list and the sender agree: the active room IS the one a line would go into.
  assert.equal(conversationWith(client as unknown as C, ME, THEM)?.active.roomId, "!z");
});

test("a banned third member is ignored as partner", () => {
  const { client } = threeRooms();
  const convs = dmConversations(client as unknown as C, ME, {});
  assert.ok(convs.some((c) => c.partner === SAM), "the conversation is with Sam");
  assert.ok(!convs.some((c) => c.partner === BANNED), "never with the banned row");
});

test("an empty room I created is not listed; an invite I received is not a conversation row (it is a request)", () => {
  const { client } = threeRooms();
  const partners = dmConversations(client as unknown as C, ME, {}).map((c) => c.partner);
  assert.ok(!partners.includes(QUINN), "an invite I sent that was never answered, no line: listed nowhere");
  assert.ok(!partners.includes(RIVER), "a request is answered in the Invites section (Accept / Decline)");
  assert.deepEqual(partners, [THEM, SAM], "newest first");
});

test("an empty room is still empty only when its start is loaded: a room whose timeline does not reach the create event is listed", () => {
  const room = fakeRoom({ roomId: "!far", creator: ME, created: T, createLoaded: false, members: [{ userId: ME, membership: "join" }, { userId: QUINN, membership: "join", dmInviter: ME }] });
  const client = fakeClient([room], { "m.direct": { [QUINN]: ["!far"] } });
  assert.deepEqual(dmConversations(client as unknown as C, ME, {}).map((c) => c.partner), [QUINN]);
});

test("pinned first, then newest", () => {
  const { client, sam } = threeRooms();
  sam.tags["m.favourite"] = {};
  assert.deepEqual(dmConversations(client as unknown as C, ME, {}).map((c) => [c.partner, c.pinned]), [[SAM, true], [THEM, false]]);
});

test("pinned on ANY of the person's rooms pins the person; unpin clears every room", async () => {
  const { client, x } = threeRooms();
  x.tags["m.favourite"] = {};
  const robin = dmConversations(client as unknown as C, ME, {}).find((c) => c.partner === THEM)!;
  assert.equal(robin.pinned, true, "an older room's pin still counts");
  await conversationActions(client as unknown as C, robin).onPin(false);
  assert.deepEqual(client.calls, ["deleteRoomTag !x m.favourite"]);
  await conversationActions(client as unknown as C, { ...robin, pinned: false }).onPin(true);
  assert.deepEqual(client.calls.slice(1), ["setRoomTag !z m.favourite"], "a pin goes on the active room");
});

test("closed person hidden until a newer message", () => {
  const { client, z } = threeRooms();
  const lastTs = z.timeline[z.timeline.length - 1]!.getTs();
  assert.ok(!dmConversations(client as unknown as C, ME, { [THEM]: lastTs }).some((c) => c.partner === THEM), "closed after their last line: hidden");
  z.timeline.push(text(THEM, lastTs + 5_000, "you there?"));
  const back = dmConversations(client as unknown as C, ME, { [THEM]: lastTs }).find((c) => c.partner === THEM);
  assert.equal(back?.preview, "you there?", "their next line brings the row back");
});

const closeAt = async (client: ReturnType<typeof threeRooms>["client"], partner: string, at: number) => {
  const conv = conversationWith(client as unknown as C, ME, partner)!;
  const now = Date.now;
  Date.now = () => at;
  try { await conversationActions(client as unknown as C, conv).onHide(); } finally { Date.now = now; }
};

test("restart: Close is kept in account data and read back by a fresh read", async () => {
  const { client } = threeRooms();
  await closeAt(client, THEM, 1000);
  await closeAt(client, SAM, 2000);
  // A fresh read of the account data (a reload) sees both: the second write merged the first.
  assert.deepEqual(readClosed(client as unknown as C), { [THEM]: 1000, [SAM]: 2000 });
  assert.ok(client.calls.every((c) => c.startsWith("setAccountData app.blackbranch.dm_closed")));
});

test("retry: closing the same person again moves the stamp forward and keeps the rest", async () => {
  const { client } = threeRooms();
  await closeAt(client, THEM, 1000);
  await closeAt(client, SAM, 1500);
  await closeAt(client, THEM, 3000);
  assert.deepEqual(readClosed(client as unknown as C), { [THEM]: 3000, [SAM]: 1500 });
});

test("readClosed ignores what is not a person → time map", () => {
  const client = fakeClient([], { "app.blackbranch.dm_closed": { [THEM]: "soon", [SAM]: 5, x: null } });
  assert.deepEqual(readClosed(client as unknown as C), { [SAM]: 5 });
});

test("leave leaves every room with the person — empty ones too — and nothing else", async () => {
  const { client, rooms } = threeRooms();
  // A fourth room with Robin that never got a line (a "Message" press from before lazy creation).
  rooms.push(fakeRoom({ roomId: "!blank", creator: ME, created: T + 2 * 86_400_000, members: [{ userId: ME, membership: "join" }, { userId: THEM, membership: "join", dmInviter: ME }] }));
  (client.data["m.direct"] as Record<string, string[]>)[THEM]!.push("!blank");
  const robin = dmConversations(client as unknown as C, ME, {}).find((c) => c.partner === THEM)!;
  assert.ok(!ids(robin.earlier).includes("!blank"), "an empty room is not an earlier conversation");
  await conversationActions(client as unknown as C, robin).onLeave();
  assert.deepEqual(client.calls, ["leave !z", "leave !blank", "leave !y", "leave !x"], "the room they write into first, then the rest by activity");
});

test("preview: 'You: ' prefix, media label, can't-be-read", () => {
  assert.equal(previewOf(text(ME, 1, "hello there") as never, ME), "You: hello there");
  assert.equal(previewOf(text(THEM, 1, "hi") as never, ME), "hi");
  assert.equal(previewOf(ev("m.room.message", THEM, 1, { msgtype: "m.image", body: "cat.png" }) as never, ME), "📷 Image");
  assert.equal(previewOf(ev("m.sticker", ME, 1, { body: "wave" }) as never, ME), "You: 📷 Image");
  assert.equal(previewOf(ev("m.room.encrypted", THEM, 1, {}, { failed: true }) as never, ME), "Can't be read on this device");
  // A reply shows its own words, not the quoted fallback; one line; cut at 60.
  const reply = ev("m.room.message", THEM, 1, { msgtype: "m.text", body: "> <@me:site.test> earlier\n\nsure thing", "m.relates_to": { "m.in_reply_to": { event_id: "$a" } } });
  assert.equal(previewOf(reply as never, ME), "sure thing");
  assert.equal(previewOf(text(THEM, 1, `two\nlines ${"x".repeat(80)}`) as never, ME), `two lines ${"x".repeat(50)}…`);
});

test("the preview never shows an edit, a reaction or a verification request", () => {
  const room = fakeRoom({
    roomId: "!p", creator: ME, created: T, members: [{ userId: ME, membership: "join" }, { userId: THEM, membership: "join", dmInviter: ME }],
    events: [
      text(THEM, T + 1, "the real line"),
      ev("m.room.message", THEM, T + 2, { msgtype: "m.text", body: "* fixed", "m.new_content": { body: "fixed" }, "m.relates_to": { rel_type: "m.replace", event_id: "$x" } }),
      ev("m.reaction", ME, T + 3, { "m.relates_to": { rel_type: "m.annotation", key: "👍" } }),
      ev("m.room.message", THEM, T + 4, { msgtype: "m.key.verification.request", body: "verify?" }),
    ],
  });
  const client = fakeClient([room], { "m.direct": { [THEM]: ["!p"] } });
  const [c] = dmConversations(client as unknown as C, ME, {});
  assert.equal(c?.preview, "the real line");
  assert.equal(c?.lastTs, T + 1);
});

test("unread sums over the person's rooms", () => {
  const { client, x } = threeRooms();
  (x as unknown as { getUnreadNotificationCount: (t?: string) => number }).getUnreadNotificationCount = (t) => (t === "highlight" ? 1 : 3);
  const robin = dmConversations(client as unknown as C, ME, {}).find((c) => c.partner === THEM)!;
  assert.deepEqual(robin.unread, { total: 5, highlight: 1 });
});
