"use client";

import { CHAT_FONT } from "@/app/lib/chatFont";
import { pinnedFirst, type ForumPostView } from "@/app/lib/forumModel";
import { PostCard } from "./PostCard";

/** The forum post list both adapters render: pinned first, the empty line, an optional load-more. */
export function PostList({
  posts,
  query,
  showRoom,
  myUserId,
  isAdmin,
  votesLoaded,
  userColors,
  onOpen,
  onTogglePin,
  onVote,
  loadMore = null,
  emptyText = "No posts yet. Be the first to start a discussion!",
}: {
  posts: readonly ForumPostView[];
  query: string;
  showRoom: boolean;
  myUserId: string | null;
  isAdmin: boolean;
  votesLoaded: boolean;
  userColors: Record<string, string>;
  onOpen: (post: ForumPostView) => void;
  onTogglePin: (post: ForumPostView) => void;
  onVote: (post: ForumPostView, dir: -1 | 1) => void;
  loadMore?: { onClick: () => void; loading: boolean } | null;
  emptyText?: string;
}) {
  const shown = pinnedFirst(posts);
  if (shown.length === 0) {
    return (
      <p className="text-muted text-center mt-10 px-6" style={{ fontSize: CHAT_FONT }}>
        {query.trim() ? "No posts match your search." : emptyText}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {shown.map((post) => (
        <PostCard
          key={post.id}
          post={post}
          showRoom={showRoom}
          myUserId={myUserId}
          isAdmin={isAdmin}
          votesLoaded={votesLoaded}
          userColors={userColors}
          onOpen={() => onOpen(post)}
          onTogglePin={() => onTogglePin(post)}
          onVote={(dir) => onVote(post, dir)}
        />
      ))}
      {loadMore && (
        <button
          type="button"
          onClick={loadMore.onClick}
          disabled={loadMore.loading}
          className="mt-1 mx-auto text-muted hover:text-body-dim disabled:opacity-50 transition-colors py-2"
          style={{ fontSize: "var(--text-chat-sm)" }}
        >
          {loadMore.loading ? "Loading…" : "Load older posts"}
        </button>
      )}
    </div>
  );
}
