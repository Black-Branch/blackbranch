"use client";

import type { ReactNode } from "react";
import type { PostSort } from "@/app/lib/matrixForum";
import { sortPostViews, type ForumPostView, type ForumRoomInfo, type ForumThreadView } from "@/app/lib/forumModel";
import { PostList } from "@/app/components/forum/PostList";
import { ForumToolbar } from "@/app/components/forum/ForumToolbar";
import { ThreadView } from "@/app/components/forum/ThreadView";

// The Forums tab's page, pure over its props: room chips over the
// toolbar, the shared post list, and the thread — beside the list when the
// pane is wide, in place of it (with a Back arrow) when it is not.
export type ForumsViewProps = {
  rooms: ForumRoomInfo[] | null;
  posts: ForumPostView[] | null;
  loading: boolean;
  error: boolean;
  /** The reader is not configured or the homeserver is down (a 503). */
  unavailable: boolean;
  /** "all" or a room id. */
  room: string;
  onRoom: (r: string) => void;
  sort: PostSort;
  onSort: (s: PostSort) => void;
  query: string;
  onQuery: (q: string) => void;
  thread: ForumThreadView | null;
  threadOpen: boolean;
  threadLoading: boolean;
  threadError: boolean;
  onCloseThread: () => void;
  /** Pane ≥ 720px: list and thread side by side. */
  wide: boolean;
  /** Pane < 560px: the toolbar collapses to icons. */
  tight: boolean;
  signedIn: boolean;
  myUserId: string | null;
  isAdmin: boolean;
  userColors: Record<string, string>;
  /** "Sign in to vote" / "Sign in to post" — one line under the toolbar. */
  hint: string | null;
  /** The thread's composer slot: the reply box, a sign-in line, or nothing. */
  composer: ReactNode;
  onOpen: (p: ForumPostView) => void;
  onTogglePin: (p: ForumPostView) => void;
  onVote: (p: ForumPostView, dir: -1 | 1) => void;
  onNewPost: () => void;
  onRetry: () => void;
};

function Chips({ rooms, room, onRoom }: { rooms: ForumRoomInfo[]; room: string; onRoom: (r: string) => void }) {
  const chip = (key: string, label: string) => (
    <button
      key={key}
      type="button"
      aria-pressed={room === key}
      onClick={() => onRoom(key)}
      className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
        room === key ? "bg-surface-4 text-strong" : "bg-surface-1 text-secondary hover:text-strong"
      }`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex gap-1.5 overflow-x-auto no-scrollbar min-w-0">
      {chip("all", "All")}
      {rooms.map((r) => chip(r.roomId, r.name))}
    </div>
  );
}

function Retry({ onRetry }: { onRetry: () => void }) {
  return <button type="button" onClick={onRetry} className="underline hover:text-strong">Try again</button>;
}

export function ForumsView(p: ForumsViewProps) {
  const q = p.query.trim().toLowerCase();
  const filtered = (p.posts ?? []).filter((x) =>
    !q || x.title.toLowerCase().includes(q) || x.tags.some((t) => t.toLowerCase().includes(q)) || x.preview.toLowerCase().includes(q),
  );
  const sorted = sortPostViews(filtered, p.sort);
  // Not asked yet is loading, not failure (Home's lesson: the first frame has no body).
  const pending = p.posts === null && !p.error && !p.unavailable;
  const list = (
    <div className="flex-1 overflow-y-auto no-scrollbar px-3 pb-3 min-h-0">
      {p.unavailable ? (
        <p className="text-muted text-center mt-10 px-6">Forums aren&apos;t available right now. <Retry onRetry={p.onRetry} /></p>
      ) : p.posts === null ? (
        <p className="text-muted text-center mt-10 px-6">
          {pending || p.loading ? "Loading…" : <>Couldn&apos;t load the forums right now. <Retry onRetry={p.onRetry} /></>}
        </p>
      ) : (
        <PostList
          posts={sorted}
          query={p.query}
          showRoom={p.room === "all"}
          myUserId={p.myUserId}
          isAdmin={p.isAdmin}
          votesLoaded
          userColors={p.userColors}
          onOpen={p.onOpen}
          onTogglePin={p.onTogglePin}
          onVote={p.onVote}
        />
      )}
    </div>
  );
  const thread = p.threadOpen ? (
    <ThreadView
      thread={p.thread}
      loading={p.threadLoading}
      error={p.threadError}
      onBack={p.wide ? undefined : p.onCloseThread}
      onClose={p.wide ? p.onCloseThread : undefined}
      composer={p.composer}
      userColors={p.userColors}
    />
  ) : null;
  return (
    <div className="flex flex-col h-full min-h-0">
      {(p.wide || !p.threadOpen) && (
        <ForumToolbar
          sort={p.sort}
          onSort={p.onSort}
          query={p.query}
          onQuery={p.onQuery}
          tight={p.tight}
          onNewPost={p.onNewPost}
          hint={p.hint}
          leading={<Chips rooms={p.rooms ?? []} room={p.room} onRoom={p.onRoom} />}
        />
      )}
      {p.wide && p.threadOpen ? (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(320px,42%)] flex-1 min-h-0">
          {list}
          <div className="border-l border-edge min-h-0">{thread}</div>
        </div>
      ) : p.threadOpen ? thread : list}
    </div>
  );
}
