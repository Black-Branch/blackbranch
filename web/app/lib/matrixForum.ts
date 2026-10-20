import type { Room, MatrixEvent } from "matrix-js-sdk";
import { countThreadReplies, lastThreadReply, buildThreadIndex } from "./matrixThreads.ts";
import { isIgnoredSender } from "./ignoredBots.ts";
import { FORUM_BODY, FORUM_TAGS, FORUM_TITLE, readFirst } from "./matrixNamespace.ts";

// ─── forum model ──────────────────────────────────────────────────────────────
//
// A forum room is an ordinary Matrix room flagged with the ROOM_TYPE
// state event (matrixNamespace.ts) ({ type: "forum" } — see matrixRooms.isForumRoom). We re-present it
// Reddit/Discord-forum style: every top-level message is a *post*; its m.thread
// replies are the post's *comments* (exactly the thread model we already ship).
//
// This is deliberately Matrix-native so the room stays fully usable in Element,
// Cinny, etc.: posts are normal messages, comments are normal threads. Titles and
// tags live in custom content fields for clean parsing, but always degrade to the
// human-readable body (first line = title, #hashtags = tags) so posts authored
// from any client still render here.

// The field names a NEW post is written with (matrixNamespace.ts — the readers below accept both
// namespaces). FORUM_BODY is the explicit post body/description, used when the message `body`
// isn't the readable description (e.g. an image post whose body is the filename/caption).
export const FORUM_TITLE_KEY = FORUM_TITLE.write;
export const FORUM_TAGS_KEY = FORUM_TAGS.write;
export const FORUM_BODY_KEY = FORUM_BODY.write;

export type PostSort = "active" | "new" | "top"; // "top" = by forum vote score

export type ForumPost = {
  root: MatrixEvent;
  title: string;
  tags: string[];
  replyCount: number;
  last: MatrixEvent | null;
  /** Last-activity time (newest reply, or the post itself). */
  lastTs: number;
  /** Original post time. */
  postedTs: number;
  /** mxc:// of an inline image on the post, if any (null otherwise). */
  thumbnail: string | null;
};

// Drop the leading "> …" reply-fallback quote lines so they don't become the
// title. (A lighter local copy of MatrixShared.stripReplyFallback to keep this
// module free of component imports.)
function stripQuoteFallback(body: string): string {
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length && lines[i]?.startsWith("> ")) i++;
  // a blank line separates the fallback from the real body
  if (i > 0 && lines[i] === "") i++;
  return lines.slice(i).join("\n");
}

/** The content shape every parser here reads: an event's `content` object.
 *  The server-side forum reader (forumReader.ts) has raw events, not
 *  MatrixEvents, so the parsing lives on content and the event helpers wrap. */
type ForumContent = Record<string, unknown>;

/** Post title from raw content: explicit field → first non-empty body line → "Untitled post". */
export function titleFromContent(c: ForumContent): string {
  const explicit = readFirst(FORUM_TITLE, (k) => {
    const v = c[k];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  });
  if (explicit) return explicit;
  const body = stripQuoteFallback(typeof c.body === "string" ? c.body : "");
  const firstLine = body
    .split("\n")
    .map((s) => s.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  return (firstLine ?? "").slice(0, 160) || "Untitled post";
}

/** Post title: explicit field → first non-empty body line → "Untitled post". */
export function postTitle(ev: MatrixEvent): string {
  return titleFromContent(ev.getContent() as ForumContent);
}

// A line that is nothing but #hashtags (and whitespace) — shown as chips, not preview.
function isHashtagLine(line: string): boolean {
  const s = line.trim();
  return s.length > 0 && /^(#[\p{L}\p{N}_-]+\s*)+$/u.test(s);
}

/** Post body preview from raw content (everything that isn't the title or the tag line). */
export function previewFromContent(c: ForumContent): string {
  const explicitBody = readFirst(FORUM_BODY, (k) => {
    const v = c[k];
    return typeof v === "string" && v.trim() ? v : undefined;
  });
  if (explicitBody) {
    return explicitBody
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => !isHashtagLine(l))
      .join(" ")
      .slice(0, 240);
  }
  const title = titleFromContent(c);
  const body = stripQuoteFallback(typeof c.body === "string" ? c.body : "");
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !isHashtagLine(l));
  // Drop a leading line that's just the title (possibly as a markdown heading) —
  // whether the title came from the explicit field or that same first line.
  if (lines.length && (lines[0] ?? "").replace(/^#+\s*/, "").toLowerCase() === title.toLowerCase()) {
    lines.shift();
  }
  return lines.join(" ").slice(0, 240);
}

/** Post body preview (everything that isn't the title or the tag line). */
export function postPreview(ev: MatrixEvent): string {
  return previewFromContent(ev.getContent() as ForumContent);
}

/** Tags from raw content: explicit array field → #hashtags parsed from the body. Lower-cased dedupe, first spelling kept. */
export function tagsFromContent(c: ForumContent): string[] {
  const explicit = readFirst(FORUM_TAGS, (k) => (Array.isArray(c[k]) ? (c[k] as unknown[]) : undefined));
  let raw: string[];
  if (Array.isArray(explicit)) {
    raw = explicit.filter((t): t is string => typeof t === "string").map((t) => t.replace(/^#/, ""));
  } else {
    const body = typeof c.body === "string" ? c.body : "";
    raw = [...body.matchAll(/(?:^|\s)#([\p{L}\p{N}][\p{L}\p{N}_-]{1,29})/gu)].map((m) => m[1]!);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    const k = t.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(t); }
  }
  return out;
}

/** Tags: explicit array field → #hashtags parsed from the body. Lower-cased, deduped. */
export function postTags(ev: MatrixEvent): string[] {
  return tagsFromContent(ev.getContent() as ForumContent);
}

/** mxc of an inline image on the post (image/sticker message), else null. */
export function thumbnailFromContent(type: string, c: ForumContent): string | null {
  if (type === "m.sticker" || c.msgtype === "m.image") {
    const url = c.url;
    if (typeof url === "string" && url.startsWith("mxc://")) return url;
  }
  return null;
}

// Every top-level message in the room = one post. Excludes thread replies
// (comments), edit echoes, reactions, and redacted (deleted) posts.
export function listPosts(room: Room): ForumPost[] {
  const all = room.getLiveTimeline().getEvents();
  // Built once for the whole pass. Two full timeline scans PER post
  // (lastThreadReply, then countThreadReplies) would be multiplied by every
  // refresh of ForumView's scrollback(80) on a single "load older posts" click.
  const threads = buildThreadIndex(room);
  const posts: ForumPost[] = [];
  for (const ev of all) {
    const t = ev.getType();
    if (t !== "m.room.message" && t !== "m.sticker") continue;
    if (ev.isRedacted()) continue;
    if (isIgnoredSender(room, ev)) continue;
    const rel = (ev.getContent() as Record<string, unknown>)["m.relates_to"] as
      | { rel_type?: string }
      | undefined;
    if (rel?.rel_type === "m.thread" || rel?.rel_type === "m.replace" || rel?.rel_type === "m.annotation") {
      continue;
    }
    const id = ev.getId() ?? "";
    const last = lastThreadReply(room, id, threads);
    posts.push({
      root: ev,
      title: postTitle(ev),
      tags: postTags(ev),
      replyCount: countThreadReplies(room, id, threads),
      last,
      lastTs: last?.getTs() ?? ev.getTs(),
      postedTs: ev.getTs(),
      thumbnail: thumbnailFromContent(ev.getType(), ev.getContent() as ForumContent),
    });
  }
  return posts;
}
