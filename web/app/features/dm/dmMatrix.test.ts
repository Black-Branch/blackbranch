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
    getType: () => type, getSender: () => sender, getTs: () => ts, isRedacted: () => false,
    isDecryptionFailure: () => false, getContent: () => ({ msgtype: "m.text", body }), getRoomId: () => "!dm",
  };
}

function fakeRoom(roomId: string, membership: string, opts: { inviter?: string; events?: unknown[]; unread?: number } = {}) {
  return {
    roomId,
    getMyMembership: () => membership,
    getDMInviter: () => opts.inviter,
    getMember: () => null,
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

test("openConversation: no room yet → the ONE DM-room path makes it, encrypted", async () => {
  const c = fakeClient([]);
  const room = await openConversation(c as unknown as C, CASEY);
  assert.equal(room?.roomId, "!new");
  assert.match(c.calls[0]!, /^createRoom .*"is_direct":true.*"m\.megolm\.v1\.aes-sha2"/);
});

test("acceptInvite = join + m.direct (the Community tab's Accept)", async () => {
  const c = fakeClient([fakeRoom("!inv", "invite", { inviter: CASEY })]);
  await acceptInvite(c as unknown as C, "!inv", CASEY);
  assert.deepEqual(c.calls, ["joinRoom !inv", `setAccountData {"${CASEY}":["!inv"]}`]);
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

test("the DM window never runs a crypto flow: it reads encryption state and nothing else", () => {
  const src = stripComments(readFileSync(new URL("./dmMatrix.ts", import.meta.url), "utf8"));
  assert.doesNotMatch(src, /bootstrapCrossSigning|crossSignDevice|setupCrypto|requestVerification|initRustCrypto|indexedDB|secretStorage|setupNewCrossSigning|resetEncryption|createRoom\(/i);
  assert.doesNotMatch(src, /^import \{[^}]*\} from "matrix-js-sdk"/m, "type-only SDK imports");
  const cryptoCalls = [...src.matchAll(/crypto\.(\w+)\(/g)].map((m) => m[1]).sort();
  assert.deepEqual(cryptoCalls, ["getUserDeviceInfo", "isEncryptionEnabledInRoom"], "the only crypto calls are the two reads");
  assert.match(src, /return null;\s*\}\s*$/, "vacuity anchor: the read reached the end of the file");
});
