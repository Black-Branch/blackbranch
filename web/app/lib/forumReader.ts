// The read-only Matrix reader behind the Forums tab and Home's Active-threads
// widget. A SERVICE ACCOUNT, not the viewer: an ordinary member of
// the forum rooms with no powers, whose MAS compatibility token is one env
// line (MATRIX_READER_TOKEN). Forum rooms are DISCOVERED by the
// ROOM_TYPE state event (matrixNamespace.ts) across the rooms the reader has joined —
// never a hardcoded space id. Joining the reader to a room is the admin step
// that makes that forum public.
//
// Plain fetch against the constant local homeserver (publicAvatar.ts says
// why: no host to inject, and the SSRF guard's aliased imports would make this
// module unloadable under node --test). Relative `.ts` imports for the same
// reason.
//
// Failure shape: no token → ForumReaderUnavailable; an upstream non-2xx → a
// thrown Error. Neither is remembered (ttlCache leaves a rejected load
// uncached), so one blip is one failed request, not 60s of a blank tab.
import { createTtlCache } from "./ttlCache.ts";
import { titleFromContent, previewFromContent, tagsFromContent, thumbnailFromContent } from "./matrixForum.ts";
import type { ForumRoomInfo, ForumPostView, ForumReplyView } from "./forumModel.ts";
import { matrixBaseUrl } from "./matrixConfig.ts";
import { ROOM_TYPE } from "./matrixNamespace.ts";
const PAGE = 100;
const MAX_EVENTS = 300;
const POSTS_TTL_MS = 60_000;
const ROOMS_TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 8000;
const MSG_FILTER = encodeURIComponent(JSON.stringify({ types: ["m.room.message", "m.sticker"] }));
const MAX_THREAD_CACHES = 200;

type RawUnsigned = {
  redacted_because?: unknown;
  "m.relations"?: {
    "m.thread"?: { count?: number; latest_event?: RawEvent; current_user_participated?: boolean };
    "m.replace"?: { content?: Record<string, unknown> };
  };
};
export type RawEvent = {
  event_id: string;
  sender: string;
  origin_server_ts: number;
  type: string;
  content: Record<string, unknown>;
  unsigned?: RawUnsigned;
  room_id?: string;
};
export type RawMember = { state_key: string; content: { displayname?: string; avatar_url?: string; membership?: string } };

/** A post as the reader sees it: everything but the per-viewer joins (score, own vote, pin) and the proxied thumbnail. */
export type ReaderPost = Omit<ForumPostView, "score" | "myVote" | "pinned" | "thumbnail"> & { thumbnailMxc: string | null };
export type ReaderReply = ForumReplyView;
export type ReaderThread = { root: ReaderPost; replies: ReaderReply[] };

export type ForumReader = {
  /** The forum rooms the reader has joined, cached 5 min. */
  rooms(): Promise<ForumRoomInfo[]>;
  /** One room's posts, cached 60s, single-flight. */
  posts(roomId: string): Promise<ReaderPost[]>;
  /** One thread, cached 60s; null when the event is not a post of that room. */
  thread(roomId: string, eventId: string): Promise<ReaderThread | null>;
  /** Who sent an event in a forum room, or null (not a forum room / not found).
   *  For the vote route's author lookup when the voter is not a member yet:
   *  the reader's view IS the public view. Not cached — the vote route is
   *  rate-limited per user. */
  sender(roomId: string, eventId: string): Promise<string | null>;
  /** Drop the room's posts snapshot and every thread of it (after a viewer posts). */
  invalidate(roomId: string): void;
};

export class ForumReaderUnavailable extends Error {
  constructor(msg = "MATRIX_READER_TOKEN is not set") {
    super(msg);
    this.name = "ForumReaderUnavailable";
  }
}

type Content = Record<string, unknown>;
type Member = { name: string; avatar: string | null };

const localpart = (id: string) => id.replace(/^@/, "").replace(/:.*$/, "");

/** @test-only the reader's own member parser, exported so the fixture tests can drive it; the caches call it in-file. */
export function memberIndex(chunk: RawMember[]): Map<string, Member> {
  const m = new Map<string, Member>();
  for (const e of chunk) {
    if (!e?.state_key) continue;
    const dn = e.content?.displayname;
    const name = typeof dn === "string" && dn.trim() ? dn.trim() : localpart(e.state_key);
    const av = e.content?.avatar_url;
    const avatar = typeof av === "string" && av.startsWith("mxc://") ? av : null;
    m.set(e.state_key, { name, avatar });
  }
  return m;
}

function isRedacted(ev: RawEvent): boolean {
  if (ev.unsigned?.redacted_because) return true;
  // A redaction strips content; a message with neither body nor msgtype is one.
  return ev.type === "m.room.message" && typeof ev.content?.body !== "string" && ev.content?.msgtype === undefined;
}
function relType(c: Content): string | null {
  const rel = c["m.relates_to"] as { rel_type?: string } | undefined;
  return rel?.rel_type ?? null;
}
function threadRootOf(c: Content): string | null {
  const rel = c["m.relates_to"] as { rel_type?: string; event_id?: string } | undefined;
  return rel?.rel_type === "m.thread" && rel.event_id ? rel.event_id : null;
}

/** The content to show: a bundled edit's m.new_content wins over the original.
 *  @test-only exported for the fixture and parity tests; the parsers call it in-file. */
export function effectiveContent(ev: RawEvent): Content {
  const rep = ev.unsigned?.["m.relations"]?.["m.replace"]?.content;
  if (!rep) return ev.content;
  const nc = rep["m.new_content"] as Content | undefined;
  if (nc && typeof nc === "object") return nc;
  const strip = (v: unknown) => (typeof v === "string" ? v.replace(/^\* /, "") : v);
  return { ...rep, body: strip(rep.body), formatted_body: strip(rep.formatted_body) };
}

function who(members: Map<string, Member>, id: string): Member {
  return members.get(id) ?? { name: localpart(id), avatar: null };
}
function formattedOf(c: Content): string | null {
  return c.format === "org.matrix.custom.html" && typeof c.formatted_body === "string" ? c.formatted_body : null;
}

/** Top-level posts out of a page of raw events (replies, edits, reactions and redactions excluded).
 *  @test-only exported for the real-row fixture and the listPosts parity test; the snapshot cache calls it in-file. */
export function parsePosts(events: RawEvent[], members: Map<string, Member>, room: ForumRoomInfo): ReaderPost[] {
  // Replies seen on this page, for rooms/servers that bundle no aggregation.
  const seen = new Map<string, { count: number; lastTs: number }>();
  for (const ev of events) {
    if (isRedacted(ev)) continue;
    const root = threadRootOf(ev.content);
    if (!root) continue;
    const s = seen.get(root) ?? { count: 0, lastTs: 0 };
    s.count += 1;
    s.lastTs = Math.max(s.lastTs, ev.origin_server_ts);
    seen.set(root, s);
  }
  const out: ReaderPost[] = [];
  for (const ev of events) {
    if (ev.type !== "m.room.message" && ev.type !== "m.sticker") continue;
    if (isRedacted(ev)) continue;
    const rt = relType(ev.content);
    if (rt === "m.thread" || rt === "m.replace" || rt === "m.annotation") continue;
    const c = effectiveContent(ev);
    const bundled = ev.unsigned?.["m.relations"]?.["m.thread"];
    const s = seen.get(ev.event_id);
    const replyCount = Math.max(bundled?.count ?? 0, s?.count ?? 0);
    const lastTs = Math.max(bundled?.latest_event?.origin_server_ts ?? 0, s?.lastTs ?? 0) || ev.origin_server_ts;
    const m = who(members, ev.sender);
    out.push({
      roomId: room.roomId,
      roomName: room.name,
      id: ev.event_id,
      sender: ev.sender,
      senderName: m.name,
      senderAvatar: m.avatar,
      title: titleFromContent(c),
      preview: previewFromContent(c),
      body: typeof c.body === "string" ? c.body : "",
      formatted: formattedOf(c),
      tags: tagsFromContent(c),
      thumbnailMxc: thumbnailFromContent(ev.type, c),
      replyCount,
      lastTs,
      postedTs: ev.origin_server_ts,
    });
  }
  return out;
}

/** A thread's replies in time order (edits and redactions excluded).
 *  @test-only exported for the fixture tests; the thread cache calls it in-file. */
export function parseReplies(events: RawEvent[], members: Map<string, Member>): ReaderReply[] {
  const out: ReaderReply[] = [];
  for (const ev of events) {
    if (ev.type !== "m.room.message" && ev.type !== "m.sticker") continue;
    if (isRedacted(ev)) continue;
    if (relType(ev.content) === "m.replace") continue;
    const c = effectiveContent(ev);
    const m = who(members, ev.sender);
    out.push({
      id: ev.event_id, sender: ev.sender, senderName: m.name, senderAvatar: m.avatar,
      body: typeof c.body === "string" ? c.body : "", formatted: formattedOf(c), ts: ev.origin_server_ts,
    });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** @test-only the factory, exported so tests inject a fake fetch and clock; product code uses the `forumReader` singleton below. */
export function createForumReader({
  token, fetch: f = globalThis.fetch, now = Date.now, base = matrixBaseUrl(),
}: { token: string | null; fetch?: typeof globalThis.fetch; now?: () => number; base?: string }): ForumReader {
  const enc = encodeURIComponent;
  async function raw(path: string): Promise<Response> {
    if (!token) throw new ForumReaderUnavailable();
    return f(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  }
  async function get<T>(path: string): Promise<T> {
    const res = await raw(path);
    if (!res.ok) throw new Error(`matrix ${res.status} for ${path.split("?")[0]}`);
    return res.json() as Promise<T>;
  }
  async function getOr404<T>(path: string): Promise<T | null> {
    const res = await raw(path);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`matrix ${res.status} for ${path.split("?")[0]}`);
    return res.json() as Promise<T>;
  }

  const roomsCache = createTtlCache<ForumRoomInfo[]>({ ttlMs: ROOMS_TTL_MS, now, load: async () => {
    const { joined_rooms } = await get<{ joined_rooms: string[] }>("/_matrix/client/v3/joined_rooms");
    const infos = await Promise.all((joined_rooms ?? []).map(async (roomId) => {
      // Product name first; the legacy flag is read only when the room has no product one
      // (same rule as matrixRooms.isForumRoom — a cleared flag, {}, counts as none).
      let type: unknown;
      for (const name of ROOM_TYPE.read) {
        type = (await getOr404<{ type?: unknown }>(`/_matrix/client/v3/rooms/${enc(roomId)}/state/${name}/`))?.type;
        if (typeof type === "string") break;
      }
      if (type !== "forum") return null;
      const n = await getOr404<{ name?: string }>(`/_matrix/client/v3/rooms/${enc(roomId)}/state/m.room.name/`);
      return { roomId, name: typeof n?.name === "string" && n.name ? n.name : roomId };
    }));
    return { data: infos.filter((x): x is ForumRoomInfo => x !== null), cacheable: true };
  } });

  /** Only a DISCOVERED forum room is ever read: the join is the admin step that
   *  makes a forum public, and an undiscovered id must not become a
   *  cache entry or a token-bearing fetch. A discovery failure
   *  rejects, as any reader failure does — never "unknown". */
  async function isForum(roomId: string): Promise<boolean> {
    return (await roomsCache.get()).some((r) => r.roomId === roomId);
  }

  async function roomInfo(roomId: string): Promise<ForumRoomInfo> {
    // Discovery failing must not sink a read of a room we were asked about by id.
    const rooms = await roomsCache.get().catch(() => [] as ForumRoomInfo[]);
    return rooms.find((r) => r.roomId === roomId) ?? { roomId, name: roomId };
  }

  type Snapshot = { posts: ReaderPost[]; members: Map<string, Member> };
  const snapshots = new Map<string, ReturnType<typeof createTtlCache<Snapshot>>>();
  function snapshotOf(roomId: string) {
    let c = snapshots.get(roomId);
    if (!c) {
      c = createTtlCache<Snapshot>({ ttlMs: POSTS_TTL_MS, now, load: async () => {
        const [membersRes, room] = await Promise.all([
          get<{ chunk: RawMember[] }>(`/_matrix/client/v3/rooms/${enc(roomId)}/members?membership=join`),
          roomInfo(roomId),
        ]);
        const members = memberIndex(membersRes.chunk ?? []);
        const events: RawEvent[] = [];
        let from: string | undefined;
        do {
          const page = await get<{ chunk: RawEvent[]; end?: string }>(
            `/_matrix/client/v3/rooms/${enc(roomId)}/messages?dir=b&limit=${PAGE}&filter=${MSG_FILTER}${from ? `&from=${enc(from)}` : ""}`,
          );
          events.push(...(page.chunk ?? []));
          from = page.end;
        } while (from && events.length < MAX_EVENTS);
        return { data: { posts: parsePosts(events, members, room), members }, cacheable: true };
      } });
      snapshots.set(roomId, c);
    }
    return c;
  }

  const threads = new Map<string, ReturnType<typeof createTtlCache<ReaderThread | null>>>();
  function threadCache(roomId: string, eventId: string) {
    const key = `${roomId}\u0000${eventId}`;
    let c = threads.get(key);
    if (!c) {
      if (threads.size > MAX_THREAD_CACHES) threads.clear();
      c = createTtlCache<ReaderThread | null>({ ttlMs: POSTS_TTL_MS, now, load: async () => {
        const [rootRaw, snap] = await Promise.all([
          getOr404<RawEvent>(`/_matrix/client/v3/rooms/${enc(roomId)}/event/${enc(eventId)}`),
          snapshotOf(roomId).get(),
        ]);
        if (!rootRaw) return { data: null, cacheable: true };
        const room = await roomInfo(roomId);
        const root = parsePosts([rootRaw], snap.members, room)[0];
        if (!root) return { data: null, cacheable: true };
        const replies: RawEvent[] = [];
        let from: string | undefined;
        do {
          const page = await get<{ chunk: RawEvent[]; next_batch?: string }>(
            `/_matrix/client/v1/rooms/${enc(roomId)}/relations/${enc(eventId)}/m.thread?dir=f&limit=${PAGE}${from ? `&from=${enc(from)}` : ""}`,
          );
          replies.push(...(page.chunk ?? []));
          from = page.next_batch;
        } while (from && replies.length < MAX_EVENTS);
        const parsed = parseReplies(replies, snap.members);
        // The root's own count/time follow the replies actually read.
        const last = parsed[parsed.length - 1];
        const data: ReaderThread = {
          root: { ...root, replyCount: Math.max(root.replyCount, parsed.length), lastTs: last ? Math.max(root.lastTs, last.ts) : root.lastTs },
          replies: parsed,
        };
        return { data, cacheable: true };
      } });
      threads.set(key, c);
    }
    return c;
  }

  return {
    rooms: () => roomsCache.get(),
    posts: async (roomId) => ((await isForum(roomId)) ? (await snapshotOf(roomId).get()).posts : []),
    thread: async (roomId, eventId) => ((await isForum(roomId)) ? threadCache(roomId, eventId).get() : null),
    sender: async (roomId, eventId) => {
      if (!(await isForum(roomId))) return null;
      const ev = await getOr404<RawEvent>(`/_matrix/client/v3/rooms/${enc(roomId)}/event/${enc(eventId)}`);
      return typeof ev?.sender === "string" ? ev.sender : null;
    },
    invalidate(roomId) {
      snapshots.get(roomId)?.invalidate();
      for (const k of threads.keys()) if (k.startsWith(`${roomId}\u0000`)) threads.delete(k);
    },
  };
}

/** The process-wide reader the routes use. */
export const forumReader: ForumReader = createForumReader({ token: process.env.MATRIX_READER_TOKEN ?? null });
