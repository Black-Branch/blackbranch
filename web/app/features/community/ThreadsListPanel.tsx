"use client";

import { useState, useEffect, useRef } from "react";
import { subscribeRoomRefresh } from "@/app/lib/matrixRoomEvents";
import type { Room, MatrixEvent } from "matrix-js-sdk";
import { useMatrixClient } from "@/app/lib/MatrixClientContext";
import { Bar } from "@/app/components/chrome";
import { Avatar } from "@/app/components/Avatar";
import { stripReplyFallback } from "@/app/lib/stripReplyFallback";
import { memberName } from "@/app/lib/matrixDisplay";
import { senderLabel } from "@/app/lib/discordSender";
import PlatformIcon from "@/app/components/PlatformIcon";
import { useOutsideClick } from "@/app/lib/useOutsideClick";
import { listThreads, threadReplies, type ThreadSummary } from "@/app/lib/matrixThreads";
import { mediaKindLabel } from "@/app/lib/mediaKind";

// Discord-style "<day> at 10:42 AM" short form for the list. (Named apart from
// textFormat.ts's shortWhen, which is the relative "5m ago" form — different
// semantics, easy to import the wrong one.)
function threadWhen(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function preview(room: Room, ev: MatrixEvent): { name: string; fromDiscord: boolean; mxc: string | null; text: string } {
  const senderId = ev.getSender() ?? "";
  const member = room.getMember(senderId);
  const { label: name, fromDiscord } = senderLabel(memberName(member, senderId), senderId);
  const c = ev.getContent() as Record<string, unknown>;
  const text = mediaKindLabel(ev.getType(), c.msgtype) ?? stripReplyFallback((c.body as string) ?? "");
  return { name, fromDiscord, mxc: member?.getMxcAvatarUrl() ?? null, text };
}

// Right-panel list of every thread in the open channel (the footer "Threads"
// button opens it). Clicking a row opens that thread in the single-thread panel.
export function ThreadsListPanel({
  room,
  myUserId,
  onOpenThread,
  onClose,
  onBack,
}: {
  room: Room;
  myUserId: string;
  onOpenThread: (rootEvent: MatrixEvent) => void;
  onClose: () => void;
  /** Mode 1 (single panel): a ← at the left that returns to the channel. */
  onBack?: () => void;
}) {
  const { client } = useMatrixClient();
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [filter, setFilter] = useState<"all" | "mine">("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const refresh = () => setThreads(listThreads(room));
    refresh();
    return subscribeRoomRefresh(room, client, refresh);
  }, [room, client]);

  useOutsideClick(filterRef, () => setFilterOpen(false), { enabled: filterOpen, escape: true });

  // "My threads" = threads I started or replied in.
  const shown = filter === "all"
    ? threads
    : threads.filter(({ root }) =>
        root.getSender() === myUserId ||
        threadReplies(room, root.getId() ?? "").some((r) => r.getSender() === myUserId)
      );

  return (
    <div className="flex flex-col min-h-0 h-full">
      <Bar slot="top" name="mx-header" center={
        <>
          {onBack && (
            <button onClick={onBack} aria-label="Back" className="text-secondary hover:text-strong text-sm px-1 shrink-0">
              ←
            </button>
          )}
          <span className="text-base">🧵</span>
          <span className="text-sm font-medium text-body flex-1 truncate">Threads</span>
          <button onClick={onClose} className="text-muted hover:text-strong text-xs shrink-0" title="Close">
            ✕
          </button>
        </>
      } />

      {/* Show: All threads / My threads */}
      <div className="px-2 py-1.5 border-b border-edge shrink-0 relative" ref={filterRef}>
        <button
          type="button"
          onClick={() => setFilterOpen((o) => !o)}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-body-dim hover:bg-surface-2 transition-colors"
          style={{ fontSize: "var(--text-chat-md)" }}
        >
          <span className="text-muted">Show:</span>
          <span className="font-medium">{filter === "all" ? "All threads" : "My threads"}</span>
          <span className="text-muted">▾</span>
        </button>
        {filterOpen && (
          <div className="absolute left-2 top-full mt-1 z-(--z-panel-menu) w-56 glass rounded-lg overflow-hidden">
            {([["all", "All threads", "Shows all threads in this channel"], ["mine", "My threads", "Threads you've participated in"]] as const).map(([k, label, desc]) => (
              <button
                key={k}
                type="button"
                onClick={() => { setFilter(k); setFilterOpen(false); }}
                className="w-full text-left px-3 py-2 hover:bg-surface-2 transition-colors flex gap-2"
              >
                <span className="w-3 shrink-0 text-accent">{filter === k ? "✓" : ""}</span>
                <span className="min-w-0">
                  <span className="block text-body text-sm">{label}</span>
                  <span className="block text-muted" style={{ fontSize: "var(--text-chat-sm)" }}>{desc}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto no-scrollbar py-1">
        {shown.length === 0 ? (
          <p className="text-muted text-xs text-center mt-8 px-4">
            {filter === "mine"
              ? "You haven't participated in any threads here yet."
              : "No threads in this channel yet. Start one from any message’s thread action."}
          </p>
        ) : (
          shown.map(({ root, count, last }) => {
            const rp = preview(room, root);
            const lp = last ? preview(room, last) : null;
            const whenTs = last?.getTs() ?? root.getTs();
            return (
              <button
                key={root.getId()}
                type="button"
                onClick={() => onOpenThread(root)}
                className="w-full text-left px-3 py-2 hover:bg-surface-1 border-b border-edge transition-colors"
              >
                {/* Root line */}
                <div className="flex items-center gap-2 min-w-0">
                  <Avatar mxcUrl={rp.mxc} name={rp.name} size={20} />
                  <span className="text-body font-medium truncate" style={{ fontSize: "var(--text-chat-md)" }}>
                    {rp.name}
                    {rp.fromDiscord && (
                      <PlatformIcon platform="discord" size="0.85em" className="ml-1 inline-block align-baseline opacity-70" />
                    )}
                  </span>
                  <span className="text-muted shrink-0 ml-auto" style={{ fontSize: "var(--text-chat-xs)" }}>
                    {threadWhen(whenTs)}
                  </span>
                </div>
                <div className="text-muted truncate mt-0.5" style={{ fontSize: "var(--text-chat-md)" }}>
                  {rp.text}
                </div>
                {/* Activity line */}
                <div className="flex items-center gap-1.5 mt-1 min-w-0">
                  <span className="font-medium shrink-0" style={{ color: "var(--accent)", fontSize: "var(--text-chat-sm)" }}>
                    {count} {count === 1 ? "reply" : "replies"}
                  </span>
                  {lp && (
                    <span className="text-muted truncate" style={{ fontSize: "var(--text-chat-sm)" }}>
                      <span className="text-secondary">{lp.name}</span> {lp.text}
                    </span>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
