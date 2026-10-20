"use client";

import type { ReactNode } from "react";
import { Avatar } from "@/app/components/Avatar";
import { MatrixHtml } from "@/app/components/MatrixHtml";
import { sanitizeMatrixHtml } from "@/app/lib/matrixHtml";
import { renderText } from "@/app/lib/renderText";
import { shortWhen } from "@/app/lib/textFormat";
import { senderLabel } from "@/app/lib/discordSender";
import { usernameColor } from "@/app/lib/avatarColor";
import { useWantUserStyles } from "@/app/lib/useUserColors";
import type { ForumThreadView } from "@/app/lib/forumModel";

// The read-only thread the Forums tab shows: the root post in full,
// its replies, and whatever the host puts in the composer slot (the reply box
// after the client boots, a "Sign in to reply" line, or nothing). The Matrix
// pane keeps its live ThreadPanel; this one reads the server model.

function Body({ body, formatted }: { body: string; formatted: string | null }) {
  if (formatted) {
    // sanitizeMatrixHtml is what makes a formatted_body safe to render — it is
    // hostile input from any signed-in account (MatrixMessageRow says why).
    const { nodes, truncated } = sanitizeMatrixHtml(formatted);
    return (
      <div className="matrix-html [overflow-wrap:anywhere]">
        <MatrixHtml nodes={nodes} truncated={truncated} emotes={{}} />
      </div>
    );
  }
  return <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{renderText(body, {})}</div>;
}

function Author({ sender, name, avatar, ts, userColors }: {
  sender: string; name: string; avatar: string | null; ts: number; userColors: Record<string, string>;
}) {
  useWantUserStyles([sender]);
  const { label } = senderLabel(name, sender);
  return (
    <div className="flex items-center gap-1.5 min-w-0" style={{ fontSize: "var(--text-chat-sm)" }}>
      <Avatar mxcUrl={avatar} name={label} size={18} />
      <span className="font-medium truncate" style={{ color: userColors[sender] || usernameColor(label) }}>{label}</span>
      <span className="text-muted shrink-0">· {shortWhen(ts)}</span>
    </div>
  );
}

export function ThreadView({
  thread,
  loading,
  error,
  onBack,
  onClose,
  composer,
  userColors,
}: {
  thread: ForumThreadView | null;
  loading: boolean;
  error: boolean;
  /** Drill-in (phone): a ← back to the list. */
  onBack?: () => void;
  /** Side by side (desktop): a ✕ that closes the thread. */
  onClose?: () => void;
  composer: ReactNode;
  userColors: Record<string, string>;
}) {
  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="flex items-center gap-2 px-3 py-2 shrink-0 min-w-0">
        {onBack && (
          <button type="button" onClick={onBack} aria-label="Back" className="text-secondary hover:text-strong text-sm px-1 shrink-0">←</button>
        )}
        <span className="truncate flex-1 min-w-0 font-semibold text-heading" style={{ fontSize: "var(--text-chat-lg)" }}>
          {thread?.root.title ?? "Thread"}
        </span>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close thread" className="text-muted hover:text-strong px-1 shrink-0">✕</button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto no-scrollbar px-3 pb-3 flex flex-col gap-3" style={{ fontSize: "var(--text-chat-md)" }}>
        {thread === null ? (
          <p className="text-muted">{loading ? "Loading…" : error ? "Couldn't load this thread right now." : ""}</p>
        ) : (
          <>
            <article className="rounded-xl border border-edge bg-surface-1 p-3 flex flex-col gap-2">
              <Author sender={thread.root.sender} name={thread.root.senderName} avatar={thread.root.senderAvatar} ts={thread.root.postedTs} userColors={userColors} />
              {thread.root.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {thread.root.tags.slice(0, 6).map((t) => (
                    <span key={t} className="px-1.5 py-0.5 rounded-md bg-accent/15 text-accent font-medium" style={{ fontSize: "var(--text-chat-xs)" }}>#{t}</span>
                  ))}
                </div>
              )}
              <Body body={thread.root.body} formatted={thread.root.formatted} />
            </article>
            {thread.replies.length === 0 && <p className="text-muted">No replies yet.</p>}
            {thread.replies.map((r) => (
              <div key={r.id} className="flex flex-col gap-1 px-1">
                <Author sender={r.sender} name={r.senderName} avatar={r.senderAvatar} ts={r.ts} userColors={userColors} />
                <Body body={r.body} formatted={r.formatted} />
              </div>
            ))}
          </>
        )}
      </div>
      {composer && <div className="shrink-0 px-3 pb-3">{composer}</div>}
    </div>
  );
}
