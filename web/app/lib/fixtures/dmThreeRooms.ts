// @test-only the DM list's fixture (dm-crypto-research B.1, with fake ids): the shape prod held for
// one pair of people — three rooms over two months, the newest made by the other person's client
// and missing from our m.direct — plus a DM carrying a banned third member (B.5) and an empty room
// whose invite was never accepted (C.2). A fake client and fake rooms, as the SDK answers them.

export const ME = "@me:site.test";
export const THEM = "@robin:site.test";
export const SAM = "@sam:site.test";
export const QUINN = "@quinn:site.test";
export const RIVER = "@river:site.test";
export const BANNED = "@bigdawg:site.test";

export const T = Date.UTC(2026, 7, 5, 7, 41, 17);
const DAY = 86_400_000;

export type FakeEvent = {
  getId(): string;
  getType(): string;
  getTs(): number;
  getSender(): string;
  getContent(): Record<string, unknown>;
  getWireContent(): Record<string, unknown>;
  getStateKey(): string | undefined;
  isRedacted(): boolean;
  isDecryptionFailure(): boolean;
  isState(): boolean;
  status: null;
};

let n = 0;
export function ev(type: string, sender: string, ts: number, content: Record<string, unknown> = {}, opts: { state?: string; failed?: boolean } = {}): FakeEvent {
  const id = `$e${++n}`;
  return {
    getId: () => id,
    getType: () => type,
    getTs: () => ts,
    getSender: () => sender,
    getContent: () => content,
    getWireContent: () => content,
    getStateKey: () => opts.state,
    isRedacted: () => false,
    isDecryptionFailure: () => opts.failed === true,
    isState: () => opts.state !== undefined,
    status: null,
  };
}

export const text = (sender: string, ts: number, body: string) => ev("m.room.message", sender, ts, { msgtype: "m.text", body });

type MemberSpec = { userId: string; membership: "join" | "invite" | "leave" | "ban"; name?: string; dmInviter?: string };

export type RoomSpec = {
  roomId: string;
  creator: string;
  created: number;
  members: MemberSpec[];
  /** Events after the create event (members, messages), oldest first. */
  events?: FakeEvent[];
  myMembership?: "join" | "invite";
  joinRule?: string;
  unread?: { total: number; highlight: number };
  tags?: Record<string, Record<string, unknown>>;
  /** false: the live timeline does not reach back to the create event. */
  createLoaded?: boolean;
  /** The invite we RECEIVED is marked direct by this person. */
  inviter?: string;
};

export function fakeRoom(spec: RoomSpec) {
  const create = ev("m.room.create", spec.creator, spec.created, { room_version: "10" }, { state: "" });
  const timeline = [...(spec.createLoaded === false ? [] : [create]), ...(spec.events ?? [])];
  const members = spec.members.map((m) => ({
    userId: m.userId,
    membership: m.membership,
    name: m.name ?? m.userId.slice(1).split(":")[0],
    rawDisplayName: m.name ?? m.userId.slice(1).split(":")[0],
    getMxcAvatarUrl: () => null,
    getDMInviter: () => m.dmInviter,
    events: { member: { getContent: () => ({ membership: m.membership }), getSender: () => m.userId } },
  }));
  const count = (s: string) => members.filter((m) => m.membership === s).length;
  const room = {
    roomId: spec.roomId,
    name: "",
    tags: { ...(spec.tags ?? {}) } as Record<string, Record<string, unknown>>,
    timeline,
    getMyMembership: () => spec.myMembership ?? "join",
    isSpaceRoom: () => false,
    getType: () => undefined,
    getDMInviter: () => spec.inviter,
    getMembers: () => members,
    getMember: (id: string) => members.find((m) => m.userId === id) ?? null,
    getJoinedMemberCount: () => count("join"),
    getInvitedMemberCount: () => count("invite"),
    getJoinRule: () => spec.joinRule ?? "invite",
    getHistoryVisibility: () => "shared",
    getLastActiveTimestamp: () => Math.max(spec.created, ...timeline.map((e) => e.getTs())),
    getLiveTimeline: () => ({ getEvents: () => room.timeline }),
    getUnreadNotificationCount: (type?: string) => (type === "highlight" ? spec.unread?.highlight ?? 0 : spec.unread?.total ?? 0),
    loadMembersIfNeeded: async () => true,
    currentState: {
      getStateEvents: (type: string, key?: string) => (type === "m.room.create" && key === "" ? create : key === undefined ? [] : null),
    },
  };
  return room;
}
export type FakeRoom = ReturnType<typeof fakeRoom>;

export function fakeClient(rooms: FakeRoom[], account: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...account };
  const calls: string[] = [];
  const client = {
    calls,
    data,
    getUserId: () => ME,
    getRooms: () => rooms,
    getRoom: (id: string) => rooms.find((r) => r.roomId === id) ?? null,
    getAccountData: (type: string) => (type in data ? { getContent: () => data[type] } : undefined),
    setAccountData: async (type: string, content: Record<string, unknown>) => { calls.push(`setAccountData ${type} ${JSON.stringify(content)}`); data[type] = content; return {}; },
    setRoomTag: async (roomId: string, tag: string) => { calls.push(`setRoomTag ${roomId} ${tag}`); const r = rooms.find((x) => x.roomId === roomId); if (r) r.tags[tag] = {}; return {}; },
    deleteRoomTag: async (roomId: string, tag: string) => { calls.push(`deleteRoomTag ${roomId} ${tag}`); const r = rooms.find((x) => x.roomId === roomId); if (r) delete r.tags[tag]; return {}; },
    leave: async (roomId: string) => { calls.push(`leave ${roomId}`); return {}; },
    on: () => {},
    off: () => {},
  };
  return client;
}

const pair = (dmInviterOfThem?: string, dmInviterOfMe?: string): MemberSpec[] => [
  { userId: ME, membership: "join", name: "me", ...(dmInviterOfMe ? { dmInviter: dmInviterOfMe } : {}) },
  { userId: THEM, membership: "join", name: "Robin", ...(dmInviterOfThem ? { dmInviter: dmInviterOfThem } : {}) },
];

const lines = (from: number, count: number, gap: number) =>
  Array.from({ length: count }, (_, i) => text(i % 2 ? THEM : ME, from + (i + 1) * gap, `line ${i + 1}`));

/** The scene: X and Y made by me one second apart (both in my m.direct, both joined by them; Y's
 *  two lines came a day after X's thirteen); Z
 *  made by them 67 days later, the newest activity, NOT in my m.direct (I accepted their invite in
 *  a client that never filed it); a DM with Sam holding a banned member row; an empty room whose
 *  invite Quinn never accepted; a DM request from River I have not answered. */
export function threeRooms() {
  const x = fakeRoom({ roomId: "!x", creator: ME, created: T, members: pair(ME), events: lines(T, 13, 60_000) });
  const y = fakeRoom({ roomId: "!y", creator: ME, created: T + 1000, members: pair(ME), events: lines(T + DAY, 2, 60_000) });
  const zFrom = T + 67 * DAY;
  const z = fakeRoom({
    roomId: "!z", creator: THEM, created: zFrom, members: pair(undefined, THEM), events: lines(zFrom, 17, 3_600_000),
    unread: { total: 2, highlight: 0 },
  });
  // The ban row lists the banned member FIRST, so member order cannot make them the partner.
  const sam = fakeRoom({
    roomId: "!sam", creator: ME, created: T + 2 * DAY,
    members: [{ userId: BANNED, membership: "ban" }, { userId: ME, membership: "join" }, { userId: SAM, membership: "join", name: "Sam", dmInviter: ME }],
    events: [text(SAM, T + 3 * DAY, "hey"), ev("m.room.member", "@mod:site.test", T + 4 * DAY, { membership: "ban", reason: "Banned on the site" }, { state: BANNED })],
  });
  const empty = fakeRoom({
    roomId: "!empty", creator: ME, created: T + 5 * DAY,
    members: [{ userId: ME, membership: "join" }, { userId: QUINN, membership: "invite" }],
  });
  const request = fakeRoom({
    roomId: "!req", creator: RIVER, created: T + 6 * DAY, myMembership: "invite", inviter: RIVER,
    members: [{ userId: ME, membership: "invite" }, { userId: RIVER, membership: "join" }],
  });
  const rooms = [x, y, z, sam, empty, request];
  const client = fakeClient(rooms, { "m.direct": { [THEM]: ["!x", "!y"], [SAM]: ["!sam"], [QUINN]: ["!empty"] } });
  return { x, y, z, sam, empty, request, rooms, client };
}
