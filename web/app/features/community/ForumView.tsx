"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { getJson, postJsonOrThrow } from "@/app/lib/http";
import { lsGet, lsSet } from "@/app/lib/safeLocalStorage";
import { Direction } from "matrix-js-sdk";
import { subscribeRoomRefresh } from "@/app/lib/matrixRoomEvents";
import type { Room, MatrixEvent } from "matrix-js-sdk";
import { useMatrixClient } from "@/app/lib/MatrixClientContext";
import { useBadges } from "@/app/lib/BadgesContext";
import { Bar } from "@/app/components/chrome";
import { PostList } from "@/app/components/forum/PostList";
import { ForumToolbar } from "@/app/components/forum/ForumToolbar";
import { getMemberDisplayName } from "@/app/lib/matrixDisplay";
import { senderLabel } from "@/app/lib/discordSender";
import { useUserColors } from "@/app/lib/useUserColors";
import { sortPostViews, type ForumPostView } from "@/app/lib/forumModel";
import { useForumVotes } from "@/app/lib/useForumVotes";
import { NewPostModal } from "./NewPostModal";
import { useContainerWidth } from "@/app/lib/useContainerWidth";
import { Chats, Users } from "@phosphor-icons/react/dist/ssr";
import {
  listPosts,
  postPreview,
  type ForumPost,
  type PostSort,
} from "@/app/lib/matrixForum";

// ─── Discord/Reddit-style forum view ──────────────────────────────────────────
// Center pane for forum rooms: a sortable list of posts (each post = a top-level
// message; its thread replies are the comments). Clicking a post opens its thread
// in the right panel. Admins can pin posts to the top (site-only).

// The card, the list and the toolbar live in app/components/forum/ (pure over
// ForumPostView) so the Forums tab renders the same thing from the server
// reader. This file is the CLIENT adapter: live MatrixEvents → views.

export function ForumView({
  room,
  myUserId,
  compact = false,
  onBack,
  onToggleDirectory,
  directoryOpen,
  onToggleMembers,
  membersOpen,
  onOpenPost,
  initialPost,
  onInitialConsumed,
}: {
  room: Room;
  myUserId: string;
  compact?: boolean;
  onBack?: () => void;
  onToggleDirectory?: () => void;
  directoryOpen?: boolean;
  onToggleMembers?: () => void;
  membersOpen?: boolean;
  onOpenPost: (rootEvent: MatrixEvent) => void;
  // A feed "Suggest" draft to open the New Post modal pre-filled (Content forum).
  initialPost?: { title: string; body: string } | null;
  onInitialConsumed?: () => void;
}) {
  const { client } = useMatrixClient();
  const { isAdmin } = useBadges();
  const userColors = useUserColors();
  const { scores, myVotes, loaded: votesLoaded, vote, reloadVotes } = useForumVotes(room.roomId);
  const [posts, setPosts] = useState<ForumPost[]>([]);
  const [pins, setPins] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<PostSort>(() => (lsGet("mx-forum-sort") as PostSort) || "active");
  const [query, setQuery] = useState("");
  const [newPostOpen, setNewPostOpen] = useState(false);
  // A feed Suggest hand-off → open the New Post modal pre-filled, then clear it
  // upstream so re-renders don't re-open it.
  const [initialDraft, setInitialDraft] = useState<{ title: string; body: string } | null>(null);
  useEffect(() => {
    if (!initialPost) return;
    // Microtask defer: consumes the hand-off (local state) and acks the parent
    // outside the synchronous effect pass.
    Promise.resolve().then(() => {
      setInitialDraft(initialPost);
      setNewPostOpen(true);
      onInitialConsumed?.();
    });
  }, [initialPost, onInitialConsumed]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hitStart, setHitStart] = useState(false);
  const didInitLoad = useRef(false);
  // The header collapses to icons based on the forum pane's OWN width, not the
  // global panel mode — in 2/3-panel layouts the pane can be narrow while the
  // panel is wide, which used to overflow the New Post button into the thread.
  const [paneRef, paneWidth] = useContainerWidth();
  const tight = compact || (paneWidth > 0 && paneWidth < 560);

  useEffect(() => {
    const refresh = () => setPosts(listPosts(room));
    refresh();
    return subscribeRoomRefresh(room, client, refresh, { members: true });
  }, [room, client]);

  // Load the admin-pinned set for this room.
  const loadPins = useCallback(async () => {
    try {
      const data = await getJson<{ pins?: string[] }>(`/api/forum/pins?roomId=${encodeURIComponent(room.roomId)}`);
      setPins(new Set<string>(Array.isArray(data.pins) ? data.pins : []));
    } catch { /* non-fatal */ }
  }, [room.roomId]);
  useEffect(() => { Promise.resolve().then(loadPins); }, [loadPins]);

  const togglePin = useCallback(
    async (eventId: string) => {
      const pinned = !pins.has(eventId);
      // optimistic
      setPins((prev) => {
        const next = new Set(prev);
        if (pinned) next.add(eventId); else next.delete(eventId);
        return next;
      });
      try {
        const data = await postJsonOrThrow<{ pins?: string[] }>("/api/forum/pins", { roomId: room.roomId, eventId, pinned });
        setPins(new Set<string>(Array.isArray(data.pins) ? data.pins : []));
      } catch (e) {
        console.warn("[Forum] pin toggle failed", e);
        loadPins(); // resync from server
      }
    },
    [pins, room.roomId, loadPins]
  );

  // Pull older history so the list isn't just the last handful of events.
  const loadMore = useCallback(async () => {
    if (!client || loadingMore || hitStart) return;
    setLoadingMore(true);
    try {
      await client.scrollback(room, 80);
      if (!room.getLiveTimeline().getPaginationToken(Direction.Backward)) setHitStart(true);
      setPosts(listPosts(room));
    } catch (e) {
      console.warn("[Forum] scrollback failed", e);
    } finally {
      setLoadingMore(false);
    }
  }, [client, room, loadingMore, hitStart]);

  // Fresh room → reset (render-time adjust) + warm a page of history.
  const [forumRoom, setForumRoom] = useState(room);
  if (forumRoom !== room) {
    setForumRoom(room);
    setHitStart(false);
    setPins(new Set());
  }
  useEffect(() => {
    didInitLoad.current = false;
  }, [room]);
  useEffect(() => {
    if (didInitLoad.current) return;
    didInitLoad.current = true;
    loadMore();
  }, [loadMore]);

  useEffect(() => {
    lsSet("mx-forum-sort", sort);
  }, [sort]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? posts.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.tags.some((t) => t.toLowerCase().includes(q)) ||
          postPreview(p.root).toLowerCase().includes(q)
      )
    : posts;
  // The plain model the shared PostList renders: one view per post,
  // with this viewer's votes and the admin pins folded in.
  const views: ForumPostView[] = filtered.map((p) => {
    const id = p.root.getId() ?? "";
    const sender = p.root.getSender() ?? "";
    const member = room.getMember(sender);
    const c = p.root.getContent() as Record<string, unknown>;
    return {
      roomId: room.roomId, roomName: room.name || room.roomId, id,
      // The name as SHOWN: a bridge ghost's "(Discord)" suffix is stripped here,
      // as at every site that resolves a member name (discordLabelSites.test.ts).
      sender, senderName: senderLabel(getMemberDisplayName(room, sender), sender).label, senderAvatar: member?.getMxcAvatarUrl() ?? null,
      title: p.title, preview: postPreview(p.root), body: typeof c.body === "string" ? c.body : "",
      formatted: c.format === "org.matrix.custom.html" && typeof c.formatted_body === "string" ? c.formatted_body : null,
      tags: p.tags,
      thumbnail: p.thumbnail && client ? client.mxcUrlToHttp(p.thumbnail, 256, 256, "crop") ?? null : null,
      replyCount: p.replyCount, lastTs: p.lastTs, postedTs: p.postedTs,
      score: scores.get(id) ?? 0, myVote: myVotes.get(id) ?? null, pinned: pins.has(id),
    };
  });
  const sortedViews = sortPostViews(views, sort);
  const rootById = new Map(filtered.map((p) => [p.root.getId() ?? "", p.root]));

  return (
    <div ref={paneRef} className={`flex flex-col min-h-0 ${compact ? "flex-1" : "h-full"}`}>
      {/* Header — matches the timeline/channel header chrome */}
      <Bar slot="top" name="mx-header" center={
        <>
          {onBack && (
            <button onClick={onBack} aria-label="Back" className="text-secondary hover:text-strong text-sm px-1 shrink-0">←</button>
          )}
          {onToggleDirectory && (
            <button
              onClick={onToggleDirectory}
              title={directoryOpen ? "Hide channels" : "Show channels"}
              className={`text-sm px-1 shrink-0 transition-colors ${directoryOpen ? "text-body" : "text-muted hover:text-strong"}`}
            >
              ☰
            </button>
          )}
          <span className="text-accent shrink-0" title="Forum">
            <Chats size={15} weight="bold" />
          </span>
          <span className={`truncate flex-1 min-w-0 ${compact ? "text-sm font-medium text-body" : "font-semibold text-heading"}`}>
            {room.name || room.roomId}
          </span>
          {onToggleMembers && (
            <button
              onClick={onToggleMembers}
              title={membersOpen ? "Hide members" : "Show members"}
              className={`shrink-0 px-1 transition-colors ${membersOpen ? "text-body" : "text-muted hover:text-strong"}`}
            >
              <Users size={15} weight="bold" />
            </button>
          )}
        </>
      } />

      <ForumToolbar sort={sort} onSort={setSort} query={query} onQuery={setQuery} tight={tight} onNewPost={() => setNewPostOpen(true)} />

      {/* Post list */}
      <div className="flex-1 overflow-y-auto no-scrollbar px-3 pb-3">
        <PostList
          posts={sortedViews}
          query={q}
          showRoom={false}
          myUserId={myUserId}
          isAdmin={isAdmin}
          votesLoaded={votesLoaded}
          userColors={userColors}
          onOpen={(v) => { const ev = rootById.get(v.id); if (ev) onOpenPost(ev); }}
          onTogglePin={(v) => togglePin(v.id)}
          onVote={(v, dir) => vote(v.id, dir)}
          loadMore={hitStart ? null : { onClick: loadMore, loading: loadingMore }}
        />
      </div>

      {newPostOpen && (
        <NewPostModal
          room={room}
          initialTitle={initialDraft?.title}
          initialBody={initialDraft?.body}
          onClose={() => { setNewPostOpen(false); setInitialDraft(null); }}
          onPosted={() => { setNewPostOpen(false); setInitialDraft(null); setPosts(listPosts(room)); reloadVotes(); }}
        />
      )}
    </div>
  );
}
