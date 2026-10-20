"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import nextDynamic from "next/dynamic";
import { useMatrixIdentity } from "@/app/lib/MatrixClientContext";
import { useBadges } from "@/app/lib/BadgesContext";
import { useUserColors } from "@/app/lib/useUserColors";
import { useContainerWidth } from "@/app/lib/useContainerWidth";
import { lsGet, lsSet } from "@/app/lib/safeLocalStorage";
import { postJson, postJsonOrThrow } from "@/app/lib/http";
import type { PostSort } from "@/app/lib/matrixForum";
import type { ForumAction, ForumPostView } from "@/app/lib/forumModel";
import type { ThreadRef } from "@/app/lib/forumLinks";
import { useForumPosts } from "./useForumPosts";
import { useForumThread } from "./useForumThread";
import { ForumsView } from "./ForumsView";

// The registry tab's content: the server adapter. Reading is public
// and never boots the Matrix client; a signed-in viewer's New Post / Reply
// mounts ForumActionHost, which does. The community feature (and with it
// matrix-js-sdk) loads only then — the tab's own static graph never reaches
// the SDK (matrixSdkGraph.test.ts).
const ForumActionHost = nextDynamic(
  () => import("@/app/features/community").then((m) => m.ForumActionHost),
  { ssr: false },
);
const WIDE_PX = 720;
const TIGHT_PX = 560;
const SORTS: PostSort[] = ["active", "new", "top"];

export function ForumsTab({ active, signedIn, openThread, onThreadConsumed }: {
  /** The host's "this pane is on screen" — polling runs only then. */
  active: boolean;
  signedIn: boolean;
  /** A thread deep link the host claimed (bb:open-forum-thread); consumed once. */
  openThread: ThreadRef | null;
  onThreadConsumed: () => void;
}) {
  const { matrixId } = useMatrixIdentity();
  const { isAdmin } = useBadges();
  const userColors = useUserColors();
  const [paneRef, width] = useContainerWidth();
  const wide = width >= WIDE_PX;
  const tight = width > 0 && width < TIGHT_PX;
  const [room, setRoomState] = useState<string>(() => lsGet("forums_room") || "all");
  const [sort, setSortState] = useState<PostSort>(() => {
    const s = lsGet("mx-forum-sort") as PostSort | null;
    return s && SORTS.includes(s) ? s : "active";
  });
  const [query, setQuery] = useState("");
  const [thread, setThread] = useState<ThreadRef | null>(null);
  const [action, setAction] = useState<ForumAction | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const posts = useForumPosts(active, room);
  const th = useForumThread(thread);
  const setRoom = (r: string) => { setRoomState(r); lsSet("forums_room", r); setHint(null); };
  const setSort = (s: PostSort) => { setSortState(s); lsSet("mx-forum-sort", s); };
  // A stored room that no longer exists → All (render-time state adjust, no
  // effect, no storage write — the next explicit choice overwrites the key).
  if (posts.data && room !== "all" && !posts.data.rooms.some((r) => r.roomId === room)) setRoomState("all");

  // The deep link: consume once, microtask-deferred (ForumView's
  // initialPost pattern keeps the setters out of the synchronous effect pass).
  useEffect(() => {
    if (!openThread) return;
    Promise.resolve().then(() => {
      setThread(openThread);
      setRoomState(openThread.roomId);
      onThreadConsumed();
    });
  }, [openThread, onThreadConsumed]);

  // The hooks hand back fresh objects each render; the action host's callback
  // reads the latest refreshers through a ref.
  const refreshRef = useRef<() => void>(() => {});
  useEffect(() => { refreshRef.current = () => { posts.refresh(); th.refresh(); }; });

  const onVote = (p: ForumPostView, dir: -1 | 1) => {
    if (!signedIn) { setHint("Sign in to vote"); return; }
    const cur = p.myVote ?? 0;
    const next = cur === dir ? 0 : dir;
    posts.patch(p.id, (x) => ({ ...x, score: x.score - cur + next, myVote: next === 0 ? null : next }));
    postJsonOrThrow<{ score: number; myVote: number | null }>("/api/forum/vote", { roomId: p.roomId, eventId: p.id, vote: next })
      .then((d) => posts.patch(p.id, (x) => ({ ...x, score: Number(d.score), myVote: d.myVote === 1 || d.myVote === -1 ? d.myVote : null })))
      // A refused vote is SAID — a lit arrow that quietly unlights reads as a
      // broken site (final review). The list refreshes to the server's truth.
      .catch(() => { setHint("Couldn't vote right now."); posts.refresh(); });
  };
  const onTogglePin = (p: ForumPostView) => {
    postJsonOrThrow("/api/forum/pins", { roomId: p.roomId, eventId: p.id, pinned: !p.pinned })
      .then(() => posts.refresh())
      .catch(() => posts.refresh());
  };
  const onNewPost = () => {
    if (!signedIn) { setHint("Sign in to post"); return; }
    const target = room !== "all" ? posts.data?.rooms.find((r) => r.roomId === room) : posts.data?.rooms[0];
    if (target) setAction({ kind: "post", roomId: target.roomId, roomName: target.name });
  };
  const onReply = () => {
    if (!thread || !th.thread) return;
    const last = th.thread.replies[th.thread.replies.length - 1];
    setAction({ kind: "reply", roomId: thread.roomId, rootId: thread.eventId, latestId: last?.id ?? thread.eventId, rootSenderName: th.thread.root.senderName });
  };
  const onDone = useCallback((roomId: string) => {
    setAction(null);
    // Drop the reader's snapshot so the viewer's own post shows, then refetch.
    postJson("/api/forum/refresh", { roomId }).catch(() => {}).then(() => { refreshRef.current(); });
  }, []);

  const composer: ReactNode = !thread ? null : !signedIn
    ? <a href="/auth/signin" className="text-sm text-accent hover:underline">Sign in to reply</a>
    : (
      <button type="button" onClick={onReply} className="w-full text-left rounded-lg bg-surface-1 border border-edge px-3 py-2 text-secondary hover:text-strong">
        Reply to this thread…
      </button>
    );

  return (
    <div ref={paneRef} className="h-full min-h-0">
      <ForumsView
        rooms={posts.data?.rooms ?? null}
        posts={posts.data?.posts ?? null}
        loading={posts.loading}
        error={posts.error}
        unavailable={posts.unavailable}
        room={room}
        onRoom={setRoom}
        sort={sort}
        onSort={setSort}
        query={query}
        onQuery={setQuery}
        thread={th.thread}
        threadOpen={thread !== null}
        threadLoading={th.loading}
        threadError={th.error}
        onCloseThread={() => setThread(null)}
        wide={wide}
        tight={tight}
        signedIn={signedIn}
        myUserId={matrixId}
        isAdmin={isAdmin}
        userColors={userColors}
        hint={hint}
        composer={composer}
        onOpen={(p) => { setHint(null); setThread({ roomId: p.roomId, eventId: p.id }); }}
        onTogglePin={onTogglePin}
        onVote={onVote}
        onNewPost={onNewPost}
        onRetry={posts.refresh}
      />
      {action && (
        <ForumActionHost action={action} onDone={() => onDone(action.roomId)} onClose={() => setAction(null)} />
      )}
    </div>
  );
}
