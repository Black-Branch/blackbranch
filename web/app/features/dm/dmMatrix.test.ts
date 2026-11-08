// The DM window's Matrix side against a FAKE client — the SDK is not loadable under node --test,
// and dmMatrix.ts imports only its types. Plus the crypto rule as a source scan: the window READS
// encryption state and never runs a crypto flow (crypto setup, stores and devices belong to the
// Matrix client layer).
//
// Run: node --test app/features/dm/dmMatrix.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { stripComments } from "../../lib/testSource.ts";
import "../../lib/testTsx.ts"; // resolves dmMatrix.ts's "@/" imports
import type { Arrival } from "./dmMatrix.ts";

const { setMatrixHandle } = await import("../../lib/matrixHandle.ts");
const { acceptInvite, encryptionCaution, ensureMatrix, openConversation, recentArrivals, watchArrivals } = await import("./dmMatrix.ts");

const ME = "@me:site.test";
const CASEY = "@casey:site.test";

function ev(type: string, sender: string, ts: number, body = "hi") {
  return {
    getId: () => `$${ts}`, status: null,
    getType: () => type, getSender: () => sender, getTs: () => ts, isRedacted: () => false,
    isDecryptionFailure: () => false, getContent: () => ({ msgtype: "m.text", body }), getRoomId: () => "!dm",
  };
}

function fakeRoom(roomId: string, membership: string, opts: { inviter?: string; events?: unknown[]; unread?: number; members?: { userId: string; membership: string }[]; history?: string } = {}) {
  // With no member list given: me joined, Casey invited — a fresh, private DM marked is_direct.
  const members = () => opts.members ?? [{ userId: ME, membership: "join" }, { userId: CASEY, membership: "invite" }];
  const count = (m: string) => members().filter((x) => x.membership === m).length;
  return {
    roomId,
    getMyMembership: () => membership,
    getDMInviter: () => opts.inviter,
    getMember: (id: string) => {
      const m = members().find((x) => x.userId === id);
      return m ? { ...m, events: { member: { getTs: () => 0, getContent: () => ({ membership: m.membership, ...(id === ME ? { is_direct: true } : {}) }) } } } : null;
    },
    getMembers: members,
    getJoinedMemberCount: () => count("join"),
    getInvitedMemberCount: () => count("invite"),
    getJoinRule: () => "invite",
    getHistoryVisibility: () => opts.history ?? "shared",
    currentState: { getStateEvents: () => ({ getTs: () => 0 }) },
    isSpaceRoom: () => false,
    getLastActiveTimestamp: () => 0,
    loadMembersIfNeeded: async () => true,
    getLiveTimeline: () => ({ getEvents: () => opts.events ?? [] }),
    getUnreadNotificationCount: () => opts.unread ?? 0,
  };
}

function fakeClient(rooms: ReturnType<typeof fakeRoom>[], direct: Record<string, string[]> = {}, crypto: unknown = null) {
  const em = new EventEmitter();
  const calls: string[] = [];
  let account = { ...direct };
  const client = {
    calls,
    emit: (name: string, ...a: unknown[]) => em.emit(name, ...a),
    on: (n: string, f: (...a: unknown[]) => void) => em.on(n, f),
    off: (n: string, f: (...a: unknown[]) => void) => em.off(n, f),
    getUserId: () => ME,
    getRooms: () => rooms,
    getRoom: (id: string) => rooms.find((r) => r.roomId === id) ?? null,
    getAccountData: () => ({ getContent: () => account }),
    setAccountData: async (_t: string, c: Record<string, string[]>) => { calls.push(`setAccountData ${JSON.stringify(c)}`); account = c; },
    joinRoom: async (id: string) => { calls.push(`joinRoom ${id}`); const r = rooms.find((x) => x.roomId === id); if (r) r.getMyMembership = () => "join"; },
    createRoom: async (o: unknown) => { calls.push(`createRoom ${JSON.stringify(o)}`); rooms.push(fakeRoom("!new", "join")); return { room_id: "!new" }; },
    decryptEventIfNeeded: async () => {},
    getCrypto: () => crypto,
  };
  return client;
}
type C = Parameters<typeof watchArrivals>[0];

test("encryptionCaution: one plain line for each way encryption is not in force, and null when it is", async () => {
  const crypto = (enabled: boolean, devices: number) => ({
    isEncryptionEnabledInRoom: async () => enabled,
    getUserDeviceInfo: async (ids: string[]) => new Map(ids.map((id) => [id, new Map(Array.from({ length: devices }, (_, i) => [`D${i}`, {}]))])),
  });
  const at = (c: unknown) => encryptionCaution(fakeClient([], {}, c) as unknown as C, "!dm", CASEY, "casey");
  assert.equal(await at(null), "Encryption isn't running in this browser — messages here are not protected.");
  assert.equal(await at(crypto(false, 2)), "This conversation isn't encrypted.");
  assert.equal(await at(crypto(true, 0)), "casey hasn't set up encrypted messages yet — they may not be able to read this.");
  assert.equal(await at(crypto(true, 1)), null);
});

test("openConversation: a pending invite FROM that person is joined and filed in m.direct — no second room is made", async () => {
  const c = fakeClient([fakeRoom("!inv", "invite", { inviter: CASEY })]);
  const room = await openConversation(c as unknown as C, CASEY);
  assert.equal(room?.roomId, "!inv");
  assert.deepEqual(c.calls, ["joinRoom !inv", `setAccountData {"${CASEY}":["!inv"]}`]);
});

test("openConversation: no room yet → nothing is made and no one is invited (Message / opening the window)", async () => {
  const c = fakeClient([]);
  assert.equal(await openConversation(c as unknown as C, CASEY), null);
  assert.deepEqual(c.calls, [], "no createRoom, no invite — the room comes with the first line");
});

test("openConversation: an existing room is reused as it is", async () => {
  const c = fakeClient([fakeRoom("!dm", "join")], { [CASEY]: ["!dm"] });
  assert.equal((await openConversation(c as unknown as C, CASEY))?.roomId, "!dm");
  assert.deepEqual(c.calls, []);
});

test("roomForSending: the first send makes the room, once, through the ONE DM-room path (encrypted)", async () => {
  const { roomForSending } = await import("../../lib/matrixDm.ts");
  const c = fakeClient([]);
  // The ban courtesy check asks /api/me/ban; answer "not banned".
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ banned: false }), { status: 200 })) as typeof fetch;
  try {
    const [a, b] = await Promise.all([roomForSending(c as unknown as C, CASEY), roomForSending(c as unknown as C, CASEY)]);
    assert.equal(a.roomId, "!new");
    assert.equal(b.roomId, "!new");
  } finally { globalThis.fetch = origFetch; }
  const creates = c.calls.filter((x) => x.startsWith("createRoom"));
  assert.equal(creates.length, 1, "two sends at once make one room");
  assert.match(creates[0]!, /"is_direct":true.*"m\.megolm\.v1\.aes-sha2"/);
});

test("roomForSending: the pre-send gate refuses when a third person joins between finding the room and sending", async () => {
  const { roomForSending } = await import("../../lib/matrixDm.ts");
  const members = [{ userId: ME, membership: "join" }, { userId: CASEY, membership: "join" }];
  const room = fakeRoom("!dm", "join", { members });
  let loads = 0;
  // The first load (the lookup) sees the two of you; by the second (the gate) Sam has joined.
  room.loadMembersIfNeeded = async () => { loads += 1; if (loads === 2) members.push({ userId: "@sam:site.test", membership: "join" }); return true; };
  const c = fakeClient([room], { [CASEY]: ["!dm"] });
  await assert.rejects(roomForSending(c as unknown as C, CASEY), { message: "Not sent — this conversation isn't private any more." });
  assert.ok(!c.calls.some((x) => x.startsWith("createRoom")));
});

test("roomForSending: a room that already stopped being private is never the conversation — a private one is made", async () => {
  const { roomForSending } = await import("../../lib/matrixDm.ts");
  const group = fakeRoom("!dm", "join", { members: [{ userId: ME, membership: "join" }, { userId: CASEY, membership: "join" }, { userId: "@sam:site.test", membership: "join" }] });
  const c = fakeClient([group], { [CASEY]: ["!dm"] });
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ banned: false }), { status: 200 })) as typeof fetch;
  try {
    assert.equal((await roomForSending(c as unknown as C, CASEY)).roomId, "!new");
  } finally { globalThis.fetch = origFetch; }
  assert.equal(c.calls.filter((x) => x.startsWith("createRoom")).length, 1);
});

test("roomForSending: no room to send into → the plain sentence, the SDK's error to the console", async () => {
  const { roomForSending } = await import("../../lib/matrixDm.ts");
  const c = { ...fakeClient([]), createRoom: async () => { throw new Error("M_LIMIT_EXCEEDED"); } };
  const origFetch = globalThis.fetch;
  const origErr = console.error;
  const logged: unknown[] = [];
  globalThis.fetch = (async () => new Response(JSON.stringify({ banned: false }), { status: 200 })) as typeof fetch;
  console.error = (...a: unknown[]) => { logged.push(a); };
  try {
    await assert.rejects(roomForSending(c as unknown as C, CASEY), { message: "Couldn't send — check your connection and try again." });
  } finally { globalThis.fetch = origFetch; console.error = origErr; }
  assert.equal(logged.length, 1);
});

test("acceptInvite = join + m.direct (the Community tab's Accept)", async () => {
  const c = fakeClient([fakeRoom("!inv", "invite", { inviter: CASEY })]);
  await acceptInvite(c as unknown as C, "!inv");
  assert.deepEqual(c.calls, ["joinRoom !inv", `setAccountData {"${CASEY}":["!inv"]}`]);
});

test("the accepting side of a two-person DM is private the moment it is accepted", async () => {
  // The room as the server has it once we join: our member event is now the JOIN (no is_direct —
  // that mark lived on the invite), the creator's never carried one, and nothing is in our m.direct
  // yet. Judged after the join, the room looked "not private": it was never filed, and the window
  // showed "This isn't a private conversation" over a plain two-person DM (Task 22's look).
  const members = [{ userId: ME, membership: "invite", direct: true }, { userId: CASEY, membership: "join", direct: false }];
  const room = Object.assign(fakeRoom("!dm", "invite", { inviter: CASEY }), {
    getMember: (id: string) => {
      const m = members.find((x) => x.userId === id);
      return m ? { ...m, events: { member: { getTs: () => 0, getContent: () => ({ membership: m.membership, ...(m.direct ? { is_direct: true } : {}) }) } } } : null;
    },
    getMembers: () => members,
    // As the SDK: the sender of OUR invite event when it is marked direct; nothing once we joined.
    getDMInviter: () => (members[0]!.membership === "invite" && members[0]!.direct ? CASEY : undefined),
    getJoinedMemberCount: () => members.filter((m) => m.membership === "join").length,
    getInvitedMemberCount: () => members.filter((m) => m.membership === "invite").length,
  });
  const c = fakeClient([room]);
  c.joinRoom = async (id: string) => {
    c.calls.push(`joinRoom ${id}`);
    room.getMyMembership = () => "join";
    members[0] = { userId: ME, membership: "join", direct: false };   // the join event replaces the invite
  };
  await acceptInvite(c as unknown as C, "!dm");
  assert.deepEqual(c.calls, ["joinRoom !dm", `setAccountData {"${CASEY}":["!dm"]}`], "filed in our m.direct as we accept it");
  const { strictlyOurs } = await import("../../lib/matrixDm.ts");
  assert.equal(await strictlyOurs(c as unknown as C, room as never, CASEY), true, "private on the accepting side");
  // An invite NOT marked direct is not filed by accepting it (the mark is what makes it a DM request).
  members[0] = { userId: ME, membership: "invite", direct: false };
  room.getMyMembership = () => "invite";
  const c2 = Object.assign(fakeClient([room]), {});
  c2.joinRoom = c.joinRoom;
  await acceptInvite(c2 as unknown as C, "!dm");
  assert.ok(!c2.calls.some((x) => x.startsWith("setAccountData")), "a plain invite is never filed as a DM");
});

test("watchArrivals: a new DM invite and a message from the other person arrive; my own line and a repeat invite do not", async () => {
  const dm = fakeRoom("!dm", "join");
  const c = fakeClient([dm], { [CASEY]: ["!dm"] });
  const got: Arrival[] = [];
  const off = watchArrivals(c as unknown as C, (a) => got.push(a));
  c.emit("Room.myMembership", fakeRoom("!inv", "invite", { inviter: CASEY }), "invite", "leave");
  c.emit("Room.myMembership", fakeRoom("!inv", "invite", { inviter: CASEY }), "invite", "invite");
  c.emit("Room.timeline", ev("m.room.message", ME, 1), dm, false, false, { liveEvent: true });
  c.emit("Room.timeline", ev("m.room.message", CASEY, 2), dm, false, false, { liveEvent: true });
  await new Promise((r) => setTimeout(r, 10)); // onDmMessage decrypts first (a promise)
  off();
  c.emit("Room.timeline", ev("m.room.message", CASEY, 3), dm, false, false, { liveEvent: true });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(got, [
    { partner: CASEY, roomId: "!inv", invite: true },
    { partner: CASEY, roomId: "!dm", invite: false },
  ]);
});

test("watchArrivals: a message still encrypted when the timeline fires arrives once it is decrypted (the window comes back after leaving the Matrix tab)", async () => {
  // The SDK emits the timeline event before the decryption it has already started finishes, so the
  // event first reads as m.room.encrypted. Looked at before decrypting, every such line was dropped:
  // nothing opened a window for a DM line that arrived while no window and no Community pane held it.
  const dm = fakeRoom("!dm", "join");
  const c = fakeClient([dm], { [CASEY]: ["!dm"] });
  const sealed = (type: string, sender: string, ts: number) => {
    const e = ev(type, sender, ts);
    let decrypted = false;
    return { ...e, getType: () => (decrypted ? type : "m.room.encrypted"), open: () => { decrypted = true; } };
  };
  const line = sealed("m.room.message", CASEY, 2);
  const reaction = sealed("m.reaction", CASEY, 3);
  c.decryptEventIfNeeded = async (e?: unknown) => { (e as { open: () => void }).open(); };
  const got: Arrival[] = [];
  const off = watchArrivals(c as unknown as C, (a) => got.push(a));
  c.emit("Room.timeline", line, dm, false, false, { liveEvent: true });
  c.emit("Room.timeline", reaction, dm, false, false, { liveEvent: true });
  c.emit("Room.timeline", ev("m.room.member", CASEY, 4), dm, false, false, { liveEvent: true });
  await new Promise((r) => setTimeout(r, 10));
  off();
  assert.deepEqual(got, [{ partner: CASEY, roomId: "!dm", invite: false }]);
});

test("recentArrivals: after a nudge — pending DM invites and unread recent DMs from others; not my own last line, not old ones", () => {
  const now = 10_000_000;
  const rooms = [
    fakeRoom("!inv", "invite", { inviter: CASEY }),
    fakeRoom("!fresh", "join", { events: [ev("m.room.message", "@sam:site.test", now - 5_000)], unread: 1 }),
    fakeRoom("!mine", "join", { events: [ev("m.room.message", ME, now - 5_000)], unread: 1 }),
    fakeRoom("!old", "join", { events: [ev("m.room.message", "@old:site.test", now - 3_600_000)], unread: 1 }),
  ];
  const c = fakeClient(rooms, { "@sam:site.test": ["!fresh"], "@me2:site.test": ["!mine"], "@old:site.test": ["!old"] });
  assert.deepEqual(recentArrivals(c as unknown as C, now), [
    { partner: "@sam:site.test", roomId: "!fresh", invite: false },
    { partner: CASEY, roomId: "!inv", invite: true },
  ]);
});

test("ensureMatrix: starts a client that is not running and answers when it is ready, or why not", async () => {
  let started = 0;
  const client = {};
  setMatrixHandle({ client: null, status: "idle", startClient: async () => { started += 1; } });
  const p = ensureMatrix();
  assert.equal(started, 1, "opening a DM is real intent: the client is started");
  setMatrixHandle({ client: null, status: "loading", startClient: async () => {} });
  setMatrixHandle({ client: client as never, status: "ready", startClient: async () => {} });
  const r = await p;
  assert.ok(r.ok && r.client === client);
  setMatrixHandle({ client: null, status: "notoken", startClient: async () => {} });
  assert.deepEqual(await ensureMatrix(), { ok: false, reason: "signin" });
});

test("partnerLeftCaution: '<username> isn't in this conversation' once they left or were banned; nothing otherwise", async () => {
  const { partnerLeftCaution } = await import("./dmMatrix.ts");
  const casey = { matrixId: CASEY, username: "casey", displayName: null };
  const room = (membership: string | null) => ({ getMember: (id: string) => (id === CASEY && membership ? { membership } : null) });
  assert.equal(partnerLeftCaution(room("leave") as never, casey), "casey isn't in this conversation");
  assert.equal(partnerLeftCaution(room("ban") as never, casey), "casey isn't in this conversation");
  assert.equal(partnerLeftCaution(room("join") as never, casey), null);
  assert.equal(partnerLeftCaution(room("invite") as never, casey), null, "invited: the request is still theirs to answer");
  assert.equal(partnerLeftCaution(room(null) as never, casey), null, "members not loaded yet: no claim either way");
});

test("onPartnerChange: the caution follows a membership change in that room only", async () => {
  const { onPartnerChange } = await import("./dmMatrix.ts");
  const em = new EventEmitter();
  const client = { on: (n: string, f: (...a: unknown[]) => void) => em.on(n, f), off: (n: string, f: (...a: unknown[]) => void) => em.off(n, f) };
  let fired = 0;
  const off = onPartnerChange(client as never, "!dm", () => { fired += 1; });
  em.emit("RoomMember.membership", {}, { roomId: "!other" });
  em.emit("RoomMember.membership", {}, { roomId: "!dm" });
  off();
  em.emit("RoomMember.membership", {}, { roomId: "!dm" });
  assert.equal(fired, 1);
});

/** A room Casey LEFT, and a client whose re-invite reaches our local state only `lag` ms after the
 *  PUT returns (as sync brings it back). The send records Casey's membership at that moment: the
 *  SDK encrypts for the members the local state lists (joined + invited). */
function reinviteWorld(lag: number | null) {
  const members = [{ userId: ME, membership: "join" }, { userId: CASEY, membership: "leave" }];
  const room = fakeRoom("!dm", "join", { members });
  const c = fakeClient([room], { [CASEY]: ["!dm"] });
  const sentWhile: string[] = [];
  Object.assign(c, {
    sendStateEvent: async () => {
      c.calls.push("reinvite");
      if (lag !== null) setTimeout(() => { members[1]!.membership = "invite"; c.emit("RoomMember.membership", {}, { roomId: "!dm", userId: CASEY }); }, lag);
      return { event_id: "$m" };
    },
    makeTxnId: () => "t1",
    sendEvent: async () => { sentWhile.push(members[1]!.membership); return { event_id: "$sent" }; },
  });
  return { c, sentWhile };
}

test("the line sent after a re-invite is encrypted for the partner's devices: it waits until our state lists them invited", async () => {
  const { roomForSending, openOrCreateDm } = await import("../../lib/matrixDm.ts");
  const { sendDmLine } = await import("./dmMatrix.ts");
  // The shown room (the window) and the found room (/dm name text) — both paths wait.
  for (const path of ["shown", "found"] as const) {
    const { c, sentWhile } = reinviteWorld(30);
    const room = path === "shown"
      ? await roomForSending(c as unknown as C, CASEY, "!dm")
      : await openOrCreateDm(c as unknown as C, CASEY, async () => false);
    assert.ok(room, path);
    await sendDmLine(c as unknown as C, room!.roomId, { msgtype: "m.text", body: "hello again" });
    assert.deepEqual(sentWhile, ["invite"], `${path}: sent only once Casey is invited in our own state`);
    assert.ok(c.calls.includes("reinvite"));
  }
});

test("a re-invite never seen in our state sends nothing (the plain sentence; the box keeps the line)", async (t) => {
  const { roomForSending } = await import("../../lib/matrixDm.ts");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { c, sentWhile } = reinviteWorld(null);
  const p = roomForSending(c as unknown as C, CASEY, "!dm");
  const orig = console.error;
  console.error = () => {};
  try {
    for (let i = 0; i < 20 && !c.calls.includes("reinvite"); i++) await Promise.resolve();
    t.mock.timers.tick(8_000);
    await assert.rejects(p, { message: "Couldn't send — check your connection and try again." });
  } finally { console.error = orig; }
  assert.deepEqual(sentWhile, []);
});

test("/dm name text, a re-invite never seen: the window opens on the room, says the real sentence, and keeps the line", async (t) => {
  const { openThenSend } = await import("./dmMatrix.ts");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { c, sentWhile } = reinviteWorld(null);
  const shown: Record<string, unknown>[] = [];
  const p = openThenSend(c as unknown as C, CASEY, "hello again", (x) => shown.push(x));
  const orig = console.error;
  console.error = () => {};
  try {
    for (let i = 0; i < 50 && !c.calls.includes("reinvite"); i++) await Promise.resolve();
    t.mock.timers.tick(8_000);
    assert.equal(await p, "kept");
  } finally { console.error = orig; }
  assert.deepEqual(shown[0], { phase: "open", roomId: "!dm", invite: false, notPrivate: false }, "the window opens on the room FIRST");
  assert.deepEqual(shown.at(-1), { kept: "hello again", error: "Couldn't send — check your connection and try again." },
    "the plain sentence, and the line is kept (never 'Couldn't open the conversation', never lost)");
  assert.deepEqual(sentWhile, [], "nothing was sent");
});

test("/dm name text, their pending invite is a group: the window shows the not-private note and keeps the line", async () => {
  const { openThenSend } = await import("./dmMatrix.ts");
  const group = fakeRoom("!group", "invite", { inviter: CASEY, members: [{ userId: ME, membership: "join" }, { userId: CASEY, membership: "join" }, { userId: "@yan:site.test", membership: "join" }] });
  const c = Object.assign(fakeClient([group]), { makeTxnId: () => "t1", sendEvent: async () => { c.calls.push("send"); return { event_id: "$x" }; } });
  const shown: Record<string, unknown>[] = [];
  assert.equal(await openThenSend(c as unknown as C, CASEY, "sure", (x) => shown.push(x)), "kept");
  assert.deepEqual(shown[0], { phase: "open", roomId: "!group", invite: false, notPrivate: true }, "the note and its button show");
  assert.deepEqual(shown.at(-1), { kept: "sure", error: "Not sent — this conversation isn't private any more.", notPrivate: true });
  assert.ok(!c.calls.includes("send"), "nothing sent into the group");
  assert.ok(!c.calls.some((x) => x.startsWith("createRoom")), "and no room the person never saw");
});

test("/dm name text, the ordinary case: the window opens, the line is sent, nothing is kept", async () => {
  const { openThenSend } = await import("./dmMatrix.ts");
  const dm = fakeRoom("!dm", "join");
  const c = Object.assign(fakeClient([dm], { [CASEY]: ["!dm"] }), { makeTxnId: () => "t1", sendEvent: async (r: string) => { c.calls.push(`send ${r}`); return { event_id: "$x" }; } });
  const shown: Record<string, unknown>[] = [];
  assert.equal(await openThenSend(c as unknown as C, CASEY, "hi", (x) => shown.push(x)), "sent");
  assert.deepEqual(shown, [{ phase: "open", roomId: "!dm", invite: false, notPrivate: false }]);
  assert.ok(c.calls.includes("send !dm"));
  // No room yet: a draft first, then the first line makes it.
  const c2 = Object.assign(fakeClient([]), { makeTxnId: () => "t1", sendEvent: async (r: string) => { c2.calls.push(`send ${r}`); return { event_id: "$x" }; } });
  const shown2: Record<string, unknown>[] = [];
  assert.equal(await openThenSend(c2 as unknown as C, CASEY, "hi", (x) => shown2.push(x)), "sent");
  assert.deepEqual(shown2, [{ phase: "open", draft: true }, { roomId: "!new", draft: false, notPrivate: false }]);
  assert.ok(c2.calls.includes("send !new"));
});

test("a reply typed into the room on screen goes into THAT room, never another — even when another is more active", async () => {
  const { roomForSending } = await import("../../lib/matrixDm.ts");
  const shown = fakeRoom("!shown", "join");
  const busier = Object.assign(fakeRoom("!busier", "join"), { getLastActiveTimestamp: () => 999 });
  const c = fakeClient([shown, busier], { [CASEY]: ["!shown", "!busier"] });
  assert.equal((await roomForSending(c as unknown as C, CASEY, "!shown")).roomId, "!shown");
});

test("an accepted group invite on screen is refused — never re-routed into a brand-new room", async () => {
  const { roomForSending } = await import("../../lib/matrixDm.ts");
  const group = fakeRoom("!group", "join", { inviter: CASEY, members: [{ userId: ME, membership: "join" }, { userId: CASEY, membership: "join" }, { userId: "@yan:site.test", membership: "join" }] });
  const c = fakeClient([group]);
  await assert.rejects(roomForSending(c as unknown as C, CASEY, "!group"), { message: "Not sent — this conversation isn't private any more." });
  assert.ok(!c.calls.some((x) => x.startsWith("createRoom")), "no room the person never saw");
});

test("both open a DM to each other: A's draft takes B's invite, A accepts, A's line goes into B's room — one room, no lost request", async () => {
  const { roomForSending } = await import("../../lib/matrixDm.ts");
  const { arriveInto } = await import("./dmQueue.ts");
  const draft = { current: { seq: 1, person: { matrixId: CASEY, username: "casey", displayName: null }, phase: "open" as const, incoming: false, accepted: true, draft: true }, queue: [] };
  const s = arriveInto(draft, { partner: CASEY, roomId: "!theirs", invite: true }, null, () => 2);
  assert.equal(s.current?.roomId, "!theirs");
  assert.equal(s.current?.incoming, true, "answered as their request");
  assert.equal(s.current?.accepted, false, "Accept · Decline · Block show");
  const theirs = fakeRoom("!theirs", "invite", { inviter: CASEY, members: [{ userId: ME, membership: "join" }, { userId: CASEY, membership: "join" }] });
  const c = fakeClient([theirs]);
  await acceptInvite(c as unknown as C, "!theirs");
  assert.equal((await roomForSending(c as unknown as C, CASEY, "!theirs")).roomId, "!theirs");
  assert.ok(!c.calls.some((x) => x.startsWith("createRoom")), "one room on both sides");
});

test("Retry passes the privacy gate first: refused (no resend) once someone else joined; sent otherwise", async () => {
  const { retryDmLine } = await import("./dmMatrix.ts");
  const members = [{ userId: ME, membership: "join" }, { userId: CASEY, membership: "join" }];
  const echo = { getId: () => "~!dm:t1", status: "not_sent" as string | null };
  const room = Object.assign(fakeRoom("!dm", "join", { members }), { findEventById: (id: string) => (id === "~!dm:t1" ? echo : null) });
  const resent: unknown[] = [];
  const c = Object.assign(fakeClient([room], { [CASEY]: ["!dm"] }), {
    resendEvent: async (ev: typeof echo) => { resent.push(ev); ev.status = null; return {}; },
  });
  members.push({ userId: "@sam:site.test", membership: "join" });
  assert.equal(await retryDmLine(c as unknown as C, "!dm", CASEY, "~!dm:t1"), "refused");
  assert.deepEqual(resent, [], "nothing resent into a room that is not private");
  members.pop();
  assert.equal(await retryDmLine(c as unknown as C, "!dm", CASEY, "~!dm:t1"), "sent");
  assert.equal(resent.length, 1);
  assert.equal(await retryDmLine(c as unknown as C, "!dm", CASEY, "~!dm:none"), "gone");
});

test("the DM window never runs a crypto flow: it reads encryption state and nothing else", () => {
  const src = stripComments(readFileSync(new URL("./dmMatrix.ts", import.meta.url), "utf8"));
  assert.doesNotMatch(src, /bootstrapCrossSigning|crossSignDevice|setupCrypto|requestVerification|initRustCrypto|indexedDB|secretStorage|setupNewCrossSigning|resetEncryption|createRoom\(/i);
  assert.doesNotMatch(src, /^import \{[^}]*\} from "matrix-js-sdk"/m, "type-only SDK imports");
  const cryptoCalls = [...src.matchAll(/crypto\.(\w+)\(/g)].map((m) => m[1]).sort();
  assert.deepEqual(cryptoCalls, ["getUserDeviceInfo", "isEncryptionEnabledInRoom"], "the only crypto calls are the two reads");
  assert.match(src, /return null;\s*\}\s*$/, "vacuity anchor: the read reached the end of the file");
});
