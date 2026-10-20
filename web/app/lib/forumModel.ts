// The plain forum model both adapters feed the presentation with:
// the Matrix pane's ForumView builds it from live MatrixEvents, the Forums tab
// gets it from /api/forum/*. Pure; no SDK, no React.
//
// `.ts` relative import: node --test loads this module (dockState.ts says why).
import type { PostSort } from "./matrixForum.ts";

export type ForumRoomInfo = { roomId: string; name: string };

export type ForumPostView = {
  roomId: string;
  roomName: string;
  id: string;
  sender: string;
  senderName: string;
  /** mxc:// of the author's avatar, or null. */
  senderAvatar: string | null;
  title: string;
  preview: string;
  body: string;
  /** The org.matrix.custom.html formatted_body, or null. */
  formatted: string | null;
  tags: string[];
  /** An http URL (already proxied), or null when the post has no image. */
  thumbnail: string | null;
  replyCount: number;
  lastTs: number;
  postedTs: number;
  score: number;
  myVote: -1 | 1 | null;
  pinned: boolean;
};

export type ForumReplyView = {
  id: string;
  sender: string;
  senderName: string;
  senderAvatar: string | null;
  body: string;
  formatted: string | null;
  ts: number;
};

export type ForumThreadView = { root: ForumPostView; replies: ForumReplyView[] };

/** What a signed-in viewer asked the booted client to do (ForumActionHost). */
export type ForumAction =
  | { kind: "post"; roomId: string; roomName: string }
  | { kind: "reply"; roomId: string; rootId: string; latestId: string; rootSenderName: string };

/** One row of Home's Active-threads widget. */
export type HomeThread = { roomId: string; roomName: string; eventId: string; title: string; replyCount: number; lastTs: number };

/** new: newest post first · top: score, ties by activity · active: newest activity first. */
export function sortPostViews(posts: readonly ForumPostView[], sort: PostSort): ForumPostView[] {
  const out = [...posts];
  if (sort === "new") out.sort((a, b) => b.postedTs - a.postedTs);
  else if (sort === "top") out.sort((a, b) => b.score - a.score || b.lastTs - a.lastTs);
  else out.sort((a, b) => b.lastTs - a.lastTs);
  return out;
}

/** Pinned posts float to the top, each half keeping its order. */
export function pinnedFirst(posts: readonly ForumPostView[]): ForumPostView[] {
  return [...posts.filter((p) => p.pinned), ...posts.filter((p) => !p.pinned)];
}

/** The widget's rows: threads with replies first (newest activity first), then the rest, capped. */
export function topThreads(posts: readonly ForumPostView[], limit: number): HomeThread[] {
  const byActivity = [...posts].sort((a, b) => b.lastTs - a.lastTs);
  const ordered = [...byActivity.filter((p) => p.replyCount > 0), ...byActivity.filter((p) => p.replyCount === 0)];
  return ordered.slice(0, limit).map((p) => ({
    roomId: p.roomId, roomName: p.roomName, eventId: p.id, title: p.title, replyCount: p.replyCount, lastTs: p.lastTs,
  }));
}
