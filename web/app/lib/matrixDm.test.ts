// The one DM-room code path and the crypto rule as a test. An owner terminal's use of it is
// tested in its owner folder. Behaviour against a FAKE client (matrixDm.ts imports only the SDK's
// types, so node --test loads it); the crypto rule as a source scan, since it is about what the
// code never calls.
//
// Run: node --test app/lib/matrixDm.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./testSource.ts";
import { dmLines, findDmRoom, openOrCreateDm, partnerMembership } from "./matrixDm.ts";

const dm = stripComments(readFileSync("app/lib/matrixDm.ts", "utf8"));
const view = stripComments(readFileSync("app/features/community/MatrixView.tsx", "utf8"));

const ME = "@me:site.test";
const CASEY = "@casey:site.test";

type Membership = "join" | "invite" | "leave" | "ban";

/** A joined room with Casey. Their membership is known once members are loaded (lazyLoadMembers is
 *  on in the real client); `others` are more member rows (a banned third person, say). */
function fakeRoom(roomId: string, partner: Membership | null, calls: string[], opts: {
  active?: number; listed?: boolean; others?: { userId: string; membership: string }[];
  /** our member event marked is_direct (default true) */ direct?: boolean; joinRule?: string; inviter?: string;
  history?: string; created?: number; creator?: string;
  /** RoomMember.getDMInviter after the join (the invite's mark kept in prev_content), per member. */
  accepted?: Record<string, string>;
} = {}) {
  let loaded = false;
  let partnerNow: string | null = partner;
  const others = [...(opts.others ?? [])];
  const members = () => [
    { userId: ME, membership: "join" },
    ...(partnerNow ? [{ userId: CASEY, membership: partnerNow }] : []),
    ...others,
  ];
  const count = (m: string) => members().filter((x) => x.membership === m).length;
  return {
    roomId,
    others,
    /** As sync bringing a member event back into our own state. */
    setPartner: (m: string) => { partnerNow = m; },
    listed: opts.listed ?? true,
    getMyMembership: () => "join",
    isSpaceRoom: () => false,
    getDMInviter: () => opts.inviter,
    getMembers: members,
    getJoinedMemberCount: () => count("join"),
    getInvitedMemberCount: () => count("invite"),
    getJoinRule: () => opts.joinRule ?? "invite",
    getHistoryVisibility: () => opts.history ?? "shared",
    currentState: { getStateEvents: () => ({ getTs: () => opts.created ?? 0, getSender: () => opts.creator ?? ME }) },
    getLastActiveTimestamp: () => opts.active ?? 0,
    // As the SDK: loads once, then answers from memory.
    loadMembersIfNeeded: async () => { if (!loaded) calls.push(`loadMembers ${roomId}`); loaded = true; return true; },
    getMember: (id: string) => {
      if (id === CASEY && !loaded) return null;
      const m = members().find((x) => x.userId === id);
      const direct = id === ME && opts.direct !== false;
      return m ? { ...m, getDMInviter: () => opts.accepted?.[id], events: { member: { getContent: () => ({ membership: m.membership, ...(direct ? { is_direct: true } : {}) }) } } } : null;
    },
  };
}

function fakeClient(rooms: ReturnType<typeof fakeRoom>[], calls: string[], extra: Record<string, string[]> = {}) {
  let account: Record<string, string[]> = { ...extra, [CASEY]: rooms.filter((r) => r.listed).map((r) => r.roomId) };
  return {
    account: () => account,
    setAccount: (a: Record<string, string[]>) => { account = a; },
    getUserId: () => ME,
    getRooms: () => rooms,
    getRoom: (id: string) => rooms.find((r) => r.roomId === id) ?? null,
    getAccountData: () => ({ getContent: () => account }),
    setAccountData: async (_t: string, c: Record<string, string[]>) => { calls.push(`setAccountData ${JSON.stringify(c)}`); account = c; },
    invite: async (roomId: string, userId: string) => { calls.push(`plain invite ${roomId} ${userId}`); },
    sendStateEvent: async (roomId: string, type: string, content: Record<string, unknown>, key: string) => {
      calls.push(`${type} ${roomId} ${key} ${JSON.stringify(content)}`);
      // The invite shows in our own state at once here (the live wait is pinned in dmMatrix.test.ts).
      if (type === "m.room.member" && key === CASEY) rooms.find((r) => r.roomId === roomId)?.setPartner(String(content.membership));
      return { event_id: "$m" };
    },
    createRoom: async () => {
      calls.push("createRoom");
      await new Promise((r) => setTimeout(r, 5)); // the server takes a moment: a second call lands meanwhile
      rooms.push(fakeRoom("!new", "invite", calls));
      return { room_id: "!new" };
    },
    on: () => {},
    off: () => {},
  };
}
type C = Parameters<typeof openOrCreateDm>[0];
const notBanned = async () => false;

async function open(partner: Membership | null) {
  const calls: string[] = [];
  const room = fakeRoom("!dm", partner, calls);
  const client = fakeClient([room], calls);
  const got = await openOrCreateDm(client as unknown as C, CASEY, notBanned);
  return { got: got?.roomId ?? null, calls };
}

test("partner leave → invite, no createRoom, same room", async () => {
  const { got, calls } = await open("leave");
  assert.equal(got, "!dm", "the same room, so the history is kept");
  // Marked is_direct: a plain /invite stores none (seen on the throwaway Synapse, 2026-10-24), and
  // the other side's client recognises a DM request only by it (Room.getDMInviter) — a plain
  // re-invite reached the server and was never shown to them.
  assert.deepEqual(calls, ["loadMembers !dm", `m.room.member !dm ${CASEY} {"membership":"invite","is_direct":true}`], "re-invited as a DM; nothing new made");
});

test("join → room, no invite", async () => {
  const { got, calls } = await open("join");
  assert.equal(got, "!dm");
  assert.deepEqual(calls, ["loadMembers !dm"]);
});

test("invite → room", async () => {
  const { got, calls } = await open("invite");
  assert.equal(got, "!dm", "they still have the request; nothing to add");
  assert.deepEqual(calls, ["loadMembers !dm"]);
});

test("ban → createRoom", async () => {
  const { got, calls } = await open("ban");
  assert.equal(got, "!new", "a room they are banned from cannot reach them");
  assert.ok(calls.includes("createRoom"));
  assert.ok(!calls.some((c) => /invite/.test(c)), "never re-invite into a ban");
});

test("a filed room the person was never in (no member row after loading) is not their conversation", async () => {
  const { got, calls } = await open(null);
  assert.equal(got, "!new", "a private room with them is made instead; the odd room is left alone");
  assert.ok(!calls.some((c) => /invite/.test(c)), "nothing is sent into the odd room");
});

test("members loaded before the check", async () => {
  // getMember answers null until loadMembersIfNeeded has run: a check made first reads no
  // partner, and the left partner would never be re-invited.
  const calls: string[] = [];
  const room = fakeRoom("!dm", "leave", calls);
  assert.equal(await partnerMembership(room as never, CASEY), "leave");
  assert.deepEqual(calls, ["loadMembers !dm"]);
});

test("a banned viewer re-invites no one either (the same courtesy check as making a room)", async () => {
  const calls: string[] = [];
  const room = fakeRoom("!dm", "leave", calls);
  const got = await openOrCreateDm(fakeClient([room], calls) as unknown as C, CASEY, async () => true);
  assert.equal(got, null);
  assert.ok(!calls.some((c) => /invite/.test(c) || c === "createRoom"));
});

test("several rooms with one person: the most recently active is the conversation (Element's rule)", async () => {
  const calls: string[] = [];
  const old = fakeRoom("!old", "join", calls, { active: 100 });
  const recent = fakeRoom("!recent", "join", calls, { active: 900 });
  const got = await openOrCreateDm(fakeClient([old, recent], calls) as unknown as C, CASEY, notBanned);
  assert.equal(got?.roomId, "!recent");
  assert.ok(!calls.includes("createRoom"));
});

test("a two-person room WE made that our m.direct lost is found, and filed again (merged, nothing else lost)", async () => {
  const calls: string[] = [];
  const ours = fakeRoom("!ours", "join", calls, { listed: false, active: 500 });
  const c = fakeClient([ours], calls, { "@sam:site.test": ["!s"] });
  const got = await openOrCreateDm(c as unknown as C, CASEY, notBanned);
  assert.equal(got?.roomId, "!ours");
  assert.ok(!calls.includes("createRoom"), "no duplicate");
  assert.deepEqual(c.account(), { "@sam:site.test": ["!s"], [CASEY]: ["!ours"] });
});

test("a partner-created room that passes the strict check is used (no duplicate) but never auto-filed in m.direct", async () => {
  const calls: string[] = [];
  const theirs = fakeRoom("!element", "join", calls, { listed: false, active: 500, creator: CASEY });
  const c = fakeClient([theirs], calls);
  const got = await openOrCreateDm(c as unknown as C, CASEY, notBanned);
  assert.equal(got?.roomId, "!element", "sent into after the strict two-member check");
  assert.ok(!calls.includes("createRoom"));
  assert.deepEqual(c.account()[CASEY], [], "m.direct is our own record: finding their room does not file it");
});

test("a three-member room flagged is_direct is not a DM candidate, and is never filed in m.direct", async () => {
  const calls: string[] = [];
  const trap = fakeRoom("!trap", "join", calls, { listed: false, inviter: CASEY, others: [{ userId: "@sam:site.test", membership: "join" }] });
  const c = fakeClient([trap], calls);
  assert.equal(await findDmRoom(c as unknown as C, CASEY), null);
  assert.deepEqual(c.account()[CASEY], [], "not written into m.direct");
  // An invited third person counts the same as a joined one.
  const trap2 = fakeRoom("!trap2", "join", calls, { listed: false, inviter: CASEY, others: [{ userId: "@sam:site.test", membership: "invite" }] });
  assert.equal(await findDmRoom(fakeClient([trap2], calls) as unknown as C, CASEY), null);
});

test("an unlisted two-person room needs a closed join rule and an is_direct member event", async () => {
  const calls: string[] = [];
  const pub = fakeRoom("!pub", "join", calls, { listed: false, joinRule: "public" });
  assert.equal(await findDmRoom(fakeClient([pub], calls) as unknown as C, CASEY), null, "public: anyone can walk in");
  const plain = fakeRoom("!plain", "join", calls, { listed: false, direct: false });
  assert.equal(await findDmRoom(fakeClient([plain], calls) as unknown as C, CASEY), null, "no is_direct: a two-person channel, not a DM");
  const ok = fakeRoom("!ok", "join", calls, { listed: false });
  assert.equal((await findDmRoom(fakeClient([ok], calls) as unknown as C, CASEY))?.roomId, "!ok");
});

test("strictlyOurs (the one predicate, and the gate before every send): refuses once a third person joins", async () => {
  const { strictlyOurs } = await import("./matrixDm.ts");
  const calls: string[] = [];
  const room = fakeRoom("!dm", "join", calls);
  const c = fakeClient([room], calls);
  assert.equal(await strictlyOurs(c as never, room as never, CASEY), true);
  room.others.push({ userId: "@sam:site.test", membership: "join" });
  assert.equal(await strictlyOurs(c as never, room as never, CASEY), false);
});

test("a LISTED room with a public join rule, or world-readable history, is not sent into (m.direct is no free pass)", async () => {
  const { strictlyOurs } = await import("./matrixDm.ts");
  const calls: string[] = [];
  const pub = fakeRoom("!pub", "join", calls, { joinRule: "public" });
  const c = fakeClient([pub], calls);
  assert.equal(await strictlyOurs(c as never, pub as never, CASEY), false);
  assert.equal(await findDmRoom(c as unknown as C, CASEY), null, "not the conversation either");
  const open2 = fakeRoom("!open", "join", calls, { history: "world_readable" });
  assert.equal(await strictlyOurs(fakeClient([open2], calls) as never, open2 as never, CASEY), false);
});

test("an accepted invite to a world-readable room is not remembered in m.direct; a private one is", async () => {
  const { rememberDm } = await import("./matrixDm.ts");
  const calls: string[] = [];
  const open3 = fakeRoom("!open", "join", calls, { listed: false, history: "world_readable" });
  const c = fakeClient([open3], calls);
  await rememberDm(c as never, CASEY, "!open");
  assert.ok(!calls.some((x) => x.startsWith("setAccountData")), "not written");
  const ok = fakeRoom("!ok", "join", calls, { listed: false });
  const c2 = fakeClient([ok], calls);
  await rememberDm(c2 as never, CASEY, "!ok");
  assert.deepEqual(c2.account()[CASEY], ["!ok"]);
});

test("dmPartnerOf (the DM list's grouping): the same predicate — a third member, a public room or a banned partner is not a DM", async () => {
  const { dmPartnerOf } = await import("./matrixDm.ts");
  const isDmRoom = (r: never, me: string, d: Set<string>) => dmPartnerOf(r, me, d) !== null;
  const calls: string[] = [];
  const ok = fakeRoom("!ok", "join", calls, { listed: false });
  await ok.loadMembersIfNeeded();
  assert.equal(dmPartnerOf(ok as never, ME, new Set()), CASEY, "the partner is the key the list groups by");
  const three = fakeRoom("!three", "join", calls, { listed: false, inviter: CASEY, others: [{ userId: "@sam:site.test", membership: "join" }] });
  await three.loadMembersIfNeeded();
  assert.equal(isDmRoom(three as never, ME, new Set(["!three"])), false, "even when m.direct lists it");
  const pub = fakeRoom("!pub", "join", calls, { joinRule: "public" });
  await pub.loadMembersIfNeeded();
  assert.equal(isDmRoom(pub as never, ME, new Set(["!pub"])), false);
  const banned = fakeRoom("!b", "ban", calls);
  await banned.loadMembersIfNeeded();
  assert.equal(isDmRoom(banned as never, ME, new Set(["!b"])), false);
});

test("an accepted DM invite still marks the room direct after the join (its prev_content), both ways", async () => {
  const { dmPartnerOf, findExistingDm, isOwnDmRoom } = await import("./matrixDm.ts");
  const calls: string[] = [];
  // Their room, accepted in a client that never filed it: no m.direct entry, no is_direct on the join.
  const theirs = fakeRoom("!z", "join", calls, { listed: false, direct: false, creator: CASEY, accepted: { [ME]: CASEY } });
  await theirs.loadMembersIfNeeded();
  assert.equal(dmPartnerOf(theirs as never, ME, new Set()), CASEY, "they invited me marked direct");
  const client = fakeClient([theirs], calls);
  assert.equal(findExistingDm(client as never, ME, CASEY)?.roomId, "!z", "the sender finds it too");
  // Ours, they joined: the mark is on their member's prev_content, from me.
  const mine = fakeRoom("!x", "join", calls, { listed: false, direct: false, accepted: { [CASEY]: ME } });
  await mine.loadMembersIfNeeded();
  assert.equal(dmPartnerOf(mine as never, ME, new Set()), CASEY);
  // A mark from anyone else is no mark; and it never takes a room out of moderation (our filing only).
  const stranger = fakeRoom("!s", "join", calls, { listed: false, direct: false, accepted: { [ME]: "@sam:site.test" } });
  await stranger.loadMembersIfNeeded();
  assert.equal(dmPartnerOf(stranger as never, ME, new Set()), null);
  assert.equal(isOwnDmRoom(theirs as never, ME, new Set()), false, "the moderation fence reads only our m.direct");
});

test("ties in activity go to the newer room", async () => {
  const calls: string[] = [];
  const older = fakeRoom("!older", "join", calls, { active: 500, created: 1 });
  const newer = fakeRoom("!newer", "join", calls, { active: 500, created: 2 });
  assert.equal((await findDmRoom(fakeClient([older, newer], calls) as unknown as C, CASEY))?.roomId, "!newer");
});

test("an unlisted room with a third person who is still in it is not a DM; a banned third row does not count", async () => {
  const calls: string[] = [];
  const group = fakeRoom("!group", "join", calls, { listed: false, others: [{ userId: "@sam:site.test", membership: "join" }] });
  const banRow = fakeRoom("!dm", "join", calls, { listed: false, others: [{ userId: "@troll:site.test", membership: "ban" }] });
  const got = await findDmRoom(fakeClient([group, banRow], calls) as unknown as C, CASEY);
  assert.equal(got?.roomId, "!dm");
});

test("two opens at once make ONE room (one create in flight per person)", async () => {
  const calls: string[] = [];
  const c = fakeClient([], calls);
  const [a, b] = await Promise.all([
    openOrCreateDm(c as unknown as C, CASEY, notBanned),
    openOrCreateDm(c as unknown as C, CASEY, notBanned),
  ]);
  assert.equal(calls.filter((x) => x === "createRoom").length, 1);
  assert.equal(a?.roomId, "!new");
  assert.equal(b?.roomId, "!new");
  // And the next open, after the first finished, finds the room instead of making another.
  await openOrCreateDm(c as unknown as C, CASEY, notBanned);
  assert.equal(calls.filter((x) => x === "createRoom").length, 1);
});

test("findDmRoom only looks: no room is made and no one is invited (opening is not sending)", async () => {
  const calls: string[] = [];
  assert.equal(await findDmRoom(fakeClient([], calls) as unknown as C, CASEY), null);
  const left = fakeRoom("!dm", "leave", calls);
  assert.equal((await findDmRoom(fakeClient([left], calls) as unknown as C, CASEY))?.roomId, "!dm");
  assert.ok(!calls.some((c) => c === "createRoom" || /invite/.test(c)));
});

test("the m.direct write merges an entry written in between (read at the moment of the write)", async () => {
  const calls: string[] = [];
  const element = fakeRoom("!element", "join", calls, { listed: false });
  const c = fakeClient([element], calls);
  c.setAccount({ ...c.account(), "@new:site.test": ["!n"] }); // another client wrote meanwhile
  await findDmRoom(c as unknown as C, CASEY);
  assert.deepEqual(c.account()["@new:site.test"], ["!n"]);
  assert.deepEqual(c.account()[CASEY], ["!element"]);
});

function msg(id: string, sender: string, content: Record<string, unknown>, extra: { status?: string | null; broken?: boolean } = {}) {
  return {
    getId: () => id, getType: () => "m.room.message", getSender: () => sender, getTs: () => 1, isRedacted: () => false,
    isDecryptionFailure: () => !!extra.broken, getContent: () => content, status: extra.status ?? null,
  };
}
const roomOf = (events: unknown[], byId: Record<string, unknown> = {}) =>
  ({ roomId: "!dm", getLiveTimeline: () => ({ getEvents: () => events }), findEventById: (id: string) => byId[id] ?? null }) as never;

test("reply line is the reply only and carries replyTo", () => {
  const reply = msg("$r", CASEY, {
    msgtype: "m.text",
    body: "> <@cho:x> earlier\n\nreply",
    "m.relates_to": { "m.in_reply_to": { event_id: "$orig" } },
  });
  const [line] = dmLines(roomOf([reply]));
  assert.equal(line?.text, "reply");
  assert.deepEqual(line?.replyTo, { id: "$orig", sender: "@cho:x" });
  // The original's real sender wins over the quoted one (the fallback is the sender's own text).
  const [known] = dmLines(roomOf([reply], { $orig: { getSender: () => ME } }));
  assert.deepEqual(known?.replyTo, { id: "$orig", sender: ME });
  // A line that merely starts with a quote is not a reply: kept as written.
  const [quote] = dmLines(roomOf([msg("$q", CASEY, { msgtype: "m.text", body: "> a quote\n\nmine" })]));
  assert.equal(quote?.text, "> a quote\n\nmine");
  assert.equal(quote?.replyTo, undefined);
});

test("a verification request is never a DM line; an unreadable line carries its failure code", () => {
  const lines = dmLines(roomOf([
    msg("$v", CASEY, {
      msgtype: "m.key.verification.request",
      body: "@casey:site.test is requesting to verify your key, but your client does not support in-chat key verification. You will need to use legacy key verification to verify keys.",
      to: ME, from_device: "PHONEDEV", methods: ["m.sas.v1"],
    }),
    msg("$hi", CASEY, { msgtype: "m.text", body: "hi" }),
    { ...msg("$utd", CASEY, { msgtype: "m.bad.encrypted", body: "** Unable to decrypt **" }, { broken: true }), decryptionFailureReason: "MEGOLM_UNKNOWN_INBOUND_SESSION_ID" },
  ]));
  assert.deepEqual(lines.map((l) => l.id), ["$hi", "$utd"]);
  assert.equal(lines[1]?.undecryptable, true);
  assert.equal(lines[1]?.code, "MEGOLM_UNKNOWN_INBOUND_SESSION_ID");
});

test("NOT_SENT line has status failed and its id", () => {
  const lines = dmLines(roomOf([
    msg("$sent", ME, { msgtype: "m.text", body: "a" }),
    msg("~!dm:t1", ME, { msgtype: "m.text", body: "b" }, { status: "sending" }),
    msg("~!dm:t2", ME, { msgtype: "m.text", body: "c" }, { status: "not_sent" }),
  ]));
  assert.deepEqual(lines.map((l) => [l.id, l.status]), [["$sent", undefined], ["~!dm:t1", "sending"], ["~!dm:t2", "failed"]]);
});

test("a DM room is made in ONE place, with the shape the Community tab always made: direct, private, no guests, encrypted", () => {
  assert.match(dm, /export async function openOrCreateDm\(client: MatrixClient, userId: string, banned: \(\) => Promise<boolean> = viewerBanned\)/);
  assert.match(dm, /is_direct: true,\s*invite: \[userId\],\s*preset: "private_chat"/);
  assert.match(dm, /guest_access: "forbidden"/);
  assert.match(dm, /type: "m\.room\.encryption", state_key: "", content: \{ algorithm: "m\.megolm\.v1\.aes-sha2" \}/);
  assert.match(view, /import \{ acceptInviteAndFile, findDmRoom \} from "@\/app\/lib\/matrixDm"/);
  // The Community tab's Accept files a DM request the one way: judged on the invite before the join.
  assert.match(view, /await acceptInviteAndFile\(client, room\.roomId\);/);
  assert.doesNotMatch(view, /getDMInviter\(\)/, "never read after the join, which replaced the invite's mark");
  // Message looks first, then hands a new conversation to the DM window's draft, else opens the
  // draft here (DmDraftPane): it never makes a room (k's item 10 — the first send does).
  const find = view.indexOf("await findDmRoom(client, userId)");
  const toWindow = view.indexOf("requestDm({ kind: \"open\"");
  const here = view.indexOf("setDraftDm({ userId, name })");
  assert.ok(find > 0 && toWindow > find && here > toWindow, "find → draft window → draft here, in that order");
  assert.doesNotMatch(view, /createRoom\(|openOrCreateDm\(/, "the Community tab makes no room when Message is pressed");
  assert.match(view, /\}\s*$/, "vacuity anchor: the read reached the end of MatrixView.tsx");
});

test("the DM path never runs a crypto flow: no setup, bootstrap, signing, verification, store or device code", () => {
  for (const [name, src] of [["matrixDm", dm]] as const) {
    assert.doesNotMatch(src, /bootstrapCrossSigning|crossSignDevice|setupCrypto|requestVerification|initRustCrypto|indexedDB|getCrypto\(|secretStorage|deviceId|setupNewCrossSigning/i, `${name} touches crypto`);
    assert.doesNotMatch(src, /^import \{[^}]*\} from "matrix-js-sdk"/m, `${name} value-imports the SDK (it would land in the terminal's chunk)`);
  }
  assert.match(dm, /isDecryptionFailure\(\)\) return \{ id, ts, fromId: sender, text: "", undecryptable: true, code: String\(ev\.decryptionFailureReason \?\? ""\) \}/, "an unreadable line is reported with its reason, never requested");
  assert.match(dm, /\}\s*$/, "vacuity anchor");
});

test("no SDK value import in localEcho.ts (matrixDm.ts imports it, and the terminal's chunk must stay SDK-free)", () => {
  assert.match(dm, /from "\.\/localEcho\.ts"/, "matrixDm reads the send state through localEcho");
  const echo = stripComments(readFileSync("app/lib/localEcho.ts", "utf8"));
  assert.doesNotMatch(echo, /^import \{[^}]*\} from "matrix-js-sdk"/m);
  assert.doesNotMatch(echo, /^import (?!type\b)[^;]* from "matrix-js-sdk/m, "a default or namespace value import");
  assert.match(echo, /export function localEchoOf\([\s\S]*\}\s*$/, "vacuity anchor: the read reached the end of the file");
});
