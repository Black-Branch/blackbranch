"use client";

import { Avatar } from "@/app/components/Avatar";
import { ForumVoteControl } from "@/app/components/ForumVoteControl";
import { useOgData } from "@/app/components/LinkPreview";
import PlatformIcon from "@/app/components/PlatformIcon";
import { renderText } from "@/app/lib/renderText";
import { extractUrls, shortWhen } from "@/app/lib/textFormat";
import { senderLabel } from "@/app/lib/discordSender";
import { usernameColor } from "@/app/lib/avatarColor";
import { useWantUserStyles } from "@/app/lib/useUserColors";
import type { ForumPostView } from "@/app/lib/forumModel";
import { PushPin, Chats } from "@phosphor-icons/react/dist/ssr";

// One forum post card, pure over the plain model. Both adapters
// render it: the Matrix pane's ForumView (live MatrixEvents → views) and the
// Forums tab (the server reader's views).

function PinIcon({ size = 13 }: { size?: number }) {
  return <PushPin size={size} weight="bold" />;
}

// Card thumbnail: the post's uploaded image if it has one, otherwise the OG
// image of the first link in the body (Reddit-style link embed). The OG case is
// a real link out (stops the card click so it doesn't also open the post).
function PostThumb({ thumbHttp, firstUrl }: { thumbHttp: string | null; firstUrl: string | null }) {
  const og = useOgData(thumbHttp ? null : firstUrl);
  if (thumbHttp) {
    return (
      <img
        src={thumbHttp}
        alt=""
        loading="lazy"
        className="w-24 h-24 rounded-lg object-cover shrink-0 bg-scrim"
        // A signed-out viewer's media-proxy fetch is refused; the card must not
        // show a broken image for it.
        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
      />
    );
  }
  if (firstUrl && og?.image) {
    return (
      <a
        href={firstUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="shrink-0"
      >
        <img
          src={og.image}
          alt=""
          loading="lazy"
          className="w-24 h-24 rounded-lg object-cover bg-scrim hover:opacity-90 transition-opacity"
          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
        />
      </a>
    );
  }
  return null;
}

export function PostCard({
  post,
  showRoom,
  myUserId,
  isAdmin,
  votesLoaded,
  userColors,
  onOpen,
  onTogglePin,
  onVote,
}: {
  post: ForumPostView;
  /** Name the room on the card (the tab's "All" view). */
  showRoom: boolean;
  myUserId: string | null;
  isAdmin: boolean;
  votesLoaded: boolean;
  userColors: Record<string, string>;
  onOpen: () => void;
  onTogglePin: () => void;
  onVote: (direction: -1 | 1) => void;
}) {
  const sender = post.sender;
  useWantUserStyles([sender]);
  const { label: name, fromDiscord } = senderLabel(post.senderName, sender);
  const nameColor = userColors[sender] || usernameColor(name);
  const preview = post.preview;
  const isOwn = myUserId !== null && sender === myUserId;
  // A post whose "title" is just a pasted link reads better with the link's own
  // title — fetch the embed's OG title and show that instead of the raw URL.
  const titleUrl = /^https?:\/\/\S+$/.test(post.title.trim()) ? post.title.trim() : null;
  const titleOg = useOgData(titleUrl);
  const displayTitle = titleUrl && titleOg?.title ? titleOg.title : post.title;
  // First URL in the body (or the title-link) — drives the link-embed thumbnail
  // when the post has no uploaded image.
  const firstUrl = extractUrls(preview)[0] ?? titleUrl;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      className={`group/post relative w-full text-left flex gap-3 rounded-xl p-3 cursor-pointer transition-colors border ${
        post.pinned
          ? "bg-accent/[0.06] border-accent/25 hover:bg-accent/[0.09]"
          : "bg-surface-1 border-edge hover:bg-surface-1 hover:border-edge"
      }`}
    >
      <div className="min-w-0 flex-1">
        {post.pinned && (
          <div className="flex items-center gap-1 mb-1 text-accent" style={{ fontSize: "var(--text-chat-xs)" }}>
            <PinIcon size={11} />
            <span className="font-semibold uppercase tracking-wider">Pinned</span>
          </div>
        )}

        {/* Author header: pfp + colored name + post age (top-left) */}
        <div
          className="flex items-center gap-1.5 min-w-0"
          style={{ fontSize: "var(--text-chat-sm)" }}
        >
          <Avatar mxcUrl={post.senderAvatar} name={name} size={18} />
          <span
            className="font-medium truncate"
            style={{ color: nameColor, fontFamily: "var(--chat-username-font, inherit)", fontWeight: "var(--chat-username-weight, 600)" as React.CSSProperties["fontWeight"], filter: "saturate(var(--chat-username-sat, 1))" }}
          >
            {name}
            {fromDiscord && (
              <PlatformIcon platform="discord" size="0.85em" className="ml-1 inline-block align-baseline opacity-70" />
            )}
          </span>
          <span className="text-muted shrink-0">· {shortWhen(post.postedTs)}</span>
          {showRoom && <span className="text-muted shrink-0 truncate">· {post.roomName}</span>}
        </div>

        {/* Title */}
        <h3
          className="font-semibold text-heading leading-snug line-clamp-2 [overflow-wrap:anywhere] pr-6 mt-1"
          style={{ fontSize: "var(--text-chat-lg)", fontFamily: "var(--chat-font-family, inherit)" }}
        >
          {displayTitle}
        </h3>

        {/* Body preview */}
        {preview && (
          <p
            className="text-secondary line-clamp-2 mt-1 [overflow-wrap:anywhere]"
            style={{ fontSize: "var(--text-chat-md)", fontFamily: "var(--chat-font-family, inherit)", fontWeight: "var(--chat-font-weight, 400)" as React.CSSProperties["fontWeight"] }}
            // Clicking a link opens it (new tab) without also opening the post.
            onClick={(e) => { if ((e.target as HTMLElement).closest("a")) e.stopPropagation(); }}
          >
            {renderText(preview, {})}
          </p>
        )}

        {post.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {post.tags.slice(0, 4).map((t) => (
              <span
                key={t}
                className="px-1.5 py-0.5 rounded-md bg-accent/15 text-accent font-medium"
                style={{ fontSize: "var(--text-chat-xs)" }}
              >
                #{t}
              </span>
            ))}
          </div>
        )}

        <div
          className="flex items-center gap-2 mt-2 text-muted"
          style={{ fontSize: "var(--text-chat-sm)" }}
        >
          {/* Reddit-new layout: vote group leads the action row */}
          <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            <ForumVoteControl score={post.score} myVote={post.myVote} onVote={onVote} disabled={isOwn} size="sm" loaded={votesLoaded} />
          </div>
          <span className="flex items-center gap-1 rounded-full bg-surface-1 px-2 py-1">
            <Chats size={13} weight="bold" />
            {post.replyCount}
          </span>
        </div>
      </div>

      <PostThumb thumbHttp={post.thumbnail} firstUrl={firstUrl} />

      {/* Admin pin/unpin — visible when pinned, on hover otherwise */}
      {isAdmin && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onTogglePin(); }}
          title={post.pinned ? "Unpin post" : "Pin post to top"}
          className={`absolute top-2 right-2 p-1 rounded-md transition-all ${
            post.pinned
              ? "text-accent hover:bg-surface-3"
              : "text-muted hover:text-body hover:bg-surface-3 opacity-0 group-hover/post:opacity-100"
          }`}
        >
          <PinIcon />
        </button>
      )}
    </div>
  );
}
