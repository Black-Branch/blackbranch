// The server-side forum reader, pinned on the SHAPE of real rows from a forum room (every key
// real; names, ids and bodies made up): an edited post, a threaded post, its reply, an image
// post, a redacted post and a member row.
import "./legacyNamespace.setup.test.ts"; // first: this suite pins read-both (a legacy prefix is set)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createForumReader, effectiveContent, memberIndex, parsePosts, parseReplies, ForumReaderUnavailable, type RawEvent, type RawMember } from "./forumReader.ts";
import { listPosts } from "./matrixForum.ts";
import type { Room, MatrixEvent } from "matrix-js-sdk";

// A post that was EDITED: the bundled m.replace carries the new content.
const EDITED: RawEvent = {
  event_id: "$editedPost0000000000000000000000000000000001", sender: "@.wren.:example.org", origin_server_ts: 1789804104129, type: "m.room.message",
  content: { body: "# Example\nA documentary worth a look.", format: "org.matrix.custom.html", formatted_body: "<h1>Example</h1><p>A documentary worth a look.</p>", msgtype: "m.text" },
  unsigned: { "m.relations": { "m.replace": { content: { body: "* # Example\n\nA documentary worth a look (edited).", format: "org.matrix.custom.html", formatted_body: "* <h1>Example</h1><p>A documentary worth a look (edited).</p>", msgtype: "m.text", "m.new_content": { body: "# Example\n\nA documentary worth a look (edited).", format: "org.matrix.custom.html", formatted_body: "<h1>Example</h1><p>A documentary worth a look (edited).</p>", msgtype: "m.text" }, "m.relates_to": { rel_type: "m.replace", event_id: "$editedPost0000000000000000000000000000000001" } } } } },
};
// A post WITH a thread: the bundled m.thread carries count + latest_event.
const THREADED: RawEvent = {
  event_id: "$threadedPost00000000000000000000000000000002", sender: "@morgan:site.test", origin_server_ts: 1788735930619, type: "m.room.message",
  content: { body: "Stream lead-up videos\nA few ideas for the pre-stream.\n#ideas", "net.prior.forum.title": "Stream lead-up videos", "net.prior.forum.tags": ["ideas"], "net.prior.forum.body": "A few ideas for the pre-stream.", msgtype: "m.text" },
  unsigned: { "m.relations": { "m.thread": { count: 1, current_user_participated: false, latest_event: { event_id: "$threadReply000000000000000000000000000000003", sender: "@bram:site.test", origin_server_ts: 1788746815623, type: "m.room.message", content: { body: "https://www.youtube.com/watch?v=w5KnFmKjFTA this one first probably for the lead-up", msgtype: "m.text", "m.relates_to": { rel_type: "m.thread", event_id: "$threadedPost00000000000000000000000000000002", is_falling_back: true, "m.in_reply_to": { event_id: "$threadedPost00000000000000000000000000000002" } } } } } } },
};
// The reply itself, as /messages and /relations both return it.
const REPLY: RawEvent = {
  event_id: "$threadReply000000000000000000000000000000003", sender: "@bram:site.test", origin_server_ts: 1788746815623, type: "m.room.message",
  content: { body: "https://www.youtube.com/watch?v=w5KnFmKjFTA this one first probably for the lead-up", msgtype: "m.text", "m.relates_to": { rel_type: "m.thread", event_id: "$threadedPost00000000000000000000000000000002", is_falling_back: true, "m.in_reply_to": { event_id: "$threadedPost00000000000000000000000000000002" } } },
  unsigned: { membership: "join" } as RawEvent["unsigned"],
};
// An image post (real content keys: body is the filename, url is the mxc).
const IMAGE: RawEvent = { event_id: "$img", sender: "@pebble:site.test", origin_server_ts: 1788700000000, type: "m.room.message", content: { body: "screenshot.png", filename: "screenshot.png", msgtype: "m.image", url: "mxc://site.test/AbC123", info: { w: 800, h: 600, mimetype: "image/png", size: 1234 } } };
// A redacted post (spec shape: empty content, unsigned.redacted_because).
const REDACTED: RawEvent = { event_id: "$gone", sender: "@x:site.test", origin_server_ts: 1788600000000, type: "m.room.message", content: {}, unsigned: { redacted_because: { type: "m.room.redaction", sender: "@casey:site.test" } } };
// One real member row.
const MEMBER: RawMember = { state_key: "@pebble:site.test", content: { displayname: "pebblehook", membership: "join" } };

const ROOM = { roomId: "!forumRoom0000000000000000000000000000000004", name: "Content" };
const members = memberIndex([MEMBER, { state_key: "@morgan:site.test", content: { displayname: "morgan", avatar_url: "mxc://site.test/av1", membership: "join" } }]);

test("effectiveContent: an edited post reads its m.new_content; an unedited one its content", () => {
  assert.equal((effectiveContent(EDITED).body as string).startsWith("# Example"), true);
  assert.match(effectiveContent(EDITED).body as string, /\(edited\)/);
  assert.doesNotMatch(effectiveContent(EDITED).formatted_body as string, /^\* /);
  assert.equal(effectiveContent(THREADED), THREADED.content);
});

test("parsePosts: replies, redactions and edits are not posts; counts and times come from the bundled thread", () => {
  const posts = parsePosts([REPLY, THREADED, EDITED, IMAGE, REDACTED], members, ROOM);
  assert.deepEqual(posts.map((p) => p.id), [THREADED.event_id, EDITED.event_id, IMAGE.event_id]);
  const t = posts[0]!;
  assert.equal(t.title, "Stream lead-up videos");
  assert.deepEqual(t.tags, ["ideas"]);
  assert.equal(t.preview, "A few ideas for the pre-stream.");
  assert.equal(t.replyCount, 1);
  assert.equal(t.lastTs, 1788746815623, "latest_event's time");
  assert.equal(t.postedTs, 1788735930619);
  assert.equal(t.senderName, "morgan");
  assert.equal(t.senderAvatar, "mxc://site.test/av1");
  assert.equal(t.roomName, "Content");
  const e = posts[1]!;
  assert.equal(e.title, "Example");
  assert.match(e.preview, /\(edited\)/, "the edit is what the reader shows");
  assert.equal(e.senderName, ".wren.", "no member row → the localpart");
  assert.equal(posts[2]!.thumbnailMxc, "mxc://site.test/AbC123");
  assert.equal(posts[2]!.senderName, "pebblehook");
});

test("parsePosts counts replies seen in the page when the server bundles nothing", () => {
  const bare: RawEvent = { ...THREADED, unsigned: {} };
  const posts = parsePosts([REPLY, bare], members, ROOM);
  assert.equal(posts[0]!.replyCount, 1);
  assert.equal(posts[0]!.lastTs, REPLY.origin_server_ts);
});

test("parseReplies keeps thread replies in order and drops redacted ones", () => {
  const out = parseReplies([REPLY, { ...REDACTED, event_id: "$goneReply" }], members);
  assert.deepEqual(out.map((r) => r.id), [REPLY.event_id]);
  assert.equal(out[0]!.senderName, "bram");
});

function fakeMatrix(routes: Record<string, unknown | (() => unknown)>, log: string[] = []) {
  return (async (url: string | URL) => {
    const u = String(url); log.push(u);
    const key = Object.keys(routes).find((k) => u.includes(k));
    if (!key) return new Response(JSON.stringify({ errcode: "M_NOT_FOUND" }), { status: 404 });
    const v = routes[key]; const body = typeof v === "function" ? (v as () => unknown)() : v;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
}

test("rooms(): only joined rooms flagged net.prior.room_type=forum, named", async () => {
  const log: string[] = [];
  const r = createForumReader({ token: "t", fetch: fakeMatrix({
    "/joined_rooms": { joined_rooms: ["!forum:x", "!chat:x"] },
    "/rooms/!forum%3Ax/state/net.prior.room_type/": { type: "forum" },
    "/rooms/!forum%3Ax/state/m.room.name/": { name: "Content" },
  }, log) });
  assert.deepEqual(await r.rooms(), [{ roomId: "!forum:x", name: "Content" }]);
  assert.ok(log.every((u) => !/access_token=|[?&]t=/.test(u)), "the token travels in a header, never a URL");
});

test("rooms(): read-both — a room flagged with the PRODUCT name is a forum too; the product flag wins", async () => {
  const r = createForumReader({ token: "t", fetch: fakeMatrix({
    "/joined_rooms": { joined_rooms: ["!new:x", "!old:x", "!both:x", "!chat:x"] },
    "/rooms/!new%3Ax/state/app.blackbranch.room_type/": { type: "forum" },
    "/rooms/!old%3Ax/state/net.prior.room_type/": { type: "forum" },
    "/rooms/!both%3Ax/state/app.blackbranch.room_type/": { type: "chat" },
    "/rooms/!both%3Ax/state/net.prior.room_type/": { type: "forum" },
    "/state/m.room.name/": { name: "N" },
  }) });
  assert.deepEqual((await r.rooms()).map((x) => x.roomId), ["!new:x", "!old:x"]);
});

test("posts(): pages /messages until no end, caches 60s single-flight, invalidate() drops it", async () => {
  let clock = 0; let pages = 0;
  const r = createForumReader({ token: "t", now: () => clock, fetch: fakeMatrix({
    "/joined_rooms": { joined_rooms: [ROOM.roomId] },
    [`/rooms/${encodeURIComponent(ROOM.roomId)}/state/net.prior.room_type/`]: { type: "forum" },
    [`/rooms/${encodeURIComponent(ROOM.roomId)}/state/m.room.name/`]: { name: "Content" },
    "/members?membership=join": { chunk: [MEMBER] },
    "/messages?": () => (++pages % 2 === 1 ? { chunk: [THREADED], start: "s", end: "e1" } : { chunk: [EDITED], start: "e1" }),
  }) });
  const [a, b] = await Promise.all([r.posts(ROOM.roomId), r.posts(ROOM.roomId)]);
  assert.equal(pages, 2, "two pages, fetched once for two concurrent callers");
  assert.equal(a, b);
  assert.deepEqual(a.map((p) => p.id), [THREADED.event_id, EDITED.event_id]);
  clock = 30_000; await r.posts(ROOM.roomId); assert.equal(pages, 2, "still cached");
  r.invalidate(ROOM.roomId); await r.posts(ROOM.roomId); assert.equal(pages, 4, "reloaded after invalidate");
});

test("thread(): root + relations, null when the root is not a post", async () => {
  const r = createForumReader({ token: "t", fetch: fakeMatrix({
    "/joined_rooms": { joined_rooms: [ROOM.roomId] },
    [`/rooms/${encodeURIComponent(ROOM.roomId)}/state/net.prior.room_type/`]: { type: "forum" },
    [`/rooms/${encodeURIComponent(ROOM.roomId)}/state/m.room.name/`]: { name: "Content" },
    "/members?membership=join": { chunk: [MEMBER] },
    "/messages?": { chunk: [THREADED, REPLY], start: "s" },
    [`/event/${encodeURIComponent(THREADED.event_id)}`]: THREADED,
    "/relations/": { chunk: [REPLY] },
    "/event/%24reply": REPLY,
  }) });
  const t = await r.thread(ROOM.roomId, THREADED.event_id);
  assert.equal(t?.root.title, "Stream lead-up videos");
  assert.deepEqual(t?.replies.map((x) => x.id), [REPLY.event_id]);
  assert.equal(await r.thread(ROOM.roomId, "$reply"), null, "a reply is not a thread root");
});

test("no token → ForumReaderUnavailable; an upstream 5xx → a thrown error, nothing cached", async () => {
  await assert.rejects(createForumReader({ token: null }).rooms(), ForumReaderUnavailable);
  let calls = 0;
  const r = createForumReader({ token: "t", fetch: (async () => { calls++; return new Response("x", { status: 502 }); }) as unknown as typeof globalThis.fetch });
  await assert.rejects(r.posts("!r:x"), /502/);
  const firstAttempt = calls;
  assert.ok(firstAttempt > 0);
  await assert.rejects(r.posts("!r:x"), /502/);
  assert.equal(calls, firstAttempt * 2, "a failure is not remembered: the second read fetches everything again");
});

// ── Parity with the client adapter: the same raw events, wrapped
// as the SDK would, through listPosts — the two readers must agree.
function asEvent(raw: RawEvent): MatrixEvent {
  // What the SDK exposes for an edited event: getContent() is the replacement.
  const content = effectiveContent(raw);
  return {
    getId: () => raw.event_id, getType: () => raw.type, getSender: () => raw.sender, getTs: () => raw.origin_server_ts,
    getContent: () => content, isRedacted: () => !!raw.unsigned?.redacted_because,
  } as unknown as MatrixEvent;
}
function asRoom(events: MatrixEvent[], raws: RawEvent[]): Room {
  const counts = new Map(raws.map((r) => [r.event_id, r.unsigned?.["m.relations"]?.["m.thread"]?.count ?? 0]));
  return {
    roomId: ROOM.roomId, name: ROOM.name, client: null,
    getLiveTimeline: () => ({ getEvents: () => events }),
    findEventById: (id: string) => events.find((e) => e.getId() === id) ?? null,
    getThread: (id: string) => (counts.get(id) ? { length: counts.get(id) } : null),
  } as unknown as Room;
}

test("parity: parsePosts and listPosts agree on the same events (title, tags, preview, count, times, thumbnail)", () => {
  const raws = [REPLY, THREADED, EDITED, IMAGE, REDACTED];
  const evs = raws.map(asEvent);
  const client = listPosts(asRoom(evs, raws));
  const server = parsePosts(raws, members, ROOM);
  assert.deepEqual(
    client.map((p) => ({ id: p.root.getId(), title: p.title, tags: p.tags, replyCount: p.replyCount, lastTs: p.lastTs, postedTs: p.postedTs, thumbnail: p.thumbnail })),
    server.map((p) => ({ id: p.id, title: p.title, tags: p.tags, replyCount: p.replyCount, lastTs: p.lastTs, postedTs: p.postedTs, thumbnail: p.thumbnailMxc })),
  );
});

test("rooms are discovered by the state event — no space id lives in the reader", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./forumReader.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /FORUM_SPACE_IDS|!lembZf8h/);
  assert.match(src, /ROOM_TYPE\.read/); // discovery by the namespaced flag (matrixNamespace.ts)
  assert.match(src, /\}\);\s*$/); // END anchor (the singleton line)
});

test("a room the reader has not discovered as a forum is refused before any cache or fetch", async () => {
  const log: string[] = [];
  const r = createForumReader({ token: "t", fetch: fakeMatrix({
    "/joined_rooms": { joined_rooms: ["!forum:x"] },
    "/rooms/!forum%3Ax/state/net.prior.room_type/": { type: "forum" },
    "/rooms/!forum%3Ax/state/m.room.name/": { name: "Content" },
  }, log) });
  assert.equal(await r.thread("!not-a-forum:x", "$e"), null);
  assert.deepEqual(await r.posts("!not-a-forum:x"), []);
  assert.ok(log.every((u) => !u.includes("not-a-forum")), `no fetch for an unknown room: ${log.join(", ")}`);
});

test("sender(): the event's sender in a forum room, null elsewhere (the vote route's fallback author lookup)", async () => {
  const log: string[] = [];
  const r = createForumReader({ token: "t", fetch: fakeMatrix({
    "/joined_rooms": { joined_rooms: [ROOM.roomId] },
    [`/rooms/${encodeURIComponent(ROOM.roomId)}/state/net.prior.room_type/`]: { type: "forum" },
    [`/rooms/${encodeURIComponent(ROOM.roomId)}/state/m.room.name/`]: { name: "Content" },
    [`/event/${encodeURIComponent(THREADED.event_id)}`]: THREADED,
  }, log) });
  assert.equal(await r.sender(ROOM.roomId, THREADED.event_id), "@morgan:site.test");
  assert.equal(await r.sender(ROOM.roomId, "$missing"), null);
  assert.equal(await r.sender("!elsewhere:x", THREADED.event_id), null);
  assert.ok(log.every((u) => !u.includes("elsewhere")));
});
