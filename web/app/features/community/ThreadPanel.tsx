"use client";

import { useState, useEffect, useRef, useCallback, Fragment } from "react";
import { flushSync } from "react-dom";
import { EventType } from "matrix-js-sdk";
import type { Room, MatrixEvent, TimelineEvents } from "matrix-js-sdk";
import { useMatrixClient } from "@/app/lib/MatrixClientContext";
import { postJson } from "@/app/lib/http";
import { useLocalStorageString } from "@/app/lib/useClientState";
import { useSetting, useMinuteTick } from "@/app/lib/useSetting";
import type { TsFormat } from "@/app/lib/chatTime";
import { MatrixMessageRow } from "@/app/components/MatrixMessageRow";
import { PausedPill } from "@/app/components/PausedPill";
import { useAnchoredChat } from "@/app/lib/useAnchoredChat";
import { useReadReceipts } from "@/app/lib/readReceipts";
import { useOgData } from "@/app/components/LinkPreview";
import { aggregateReactions, EMPTY_REACTIONS, type ReactionsMap } from "@/app/lib/matrixReactions";
import { aggregateEdits, type EditsMap } from "@/app/lib/matrixEdits";
import { mentionsMe } from "@/app/lib/matrixMentions";
import { useRoomActions, eventKey } from "@/app/lib/useRoomActions";
import { subscribeRoomRefresh } from "@/app/lib/matrixRoomEvents";
import { isContinuation, startsNewDay } from "@/app/lib/messageGrouping";
import { stripes, groupEnds } from "@/app/lib/mxRows";
import { useUserLooks } from "@/app/lib/useUserLooks";
import { DayDivider } from "@/app/components/DayDivider";
import { threadReplies, threadRelation } from "@/app/lib/matrixThreads";
import { MatrixInput } from "@/app/components/MatrixInput";
import { Bar } from "@/app/components/chrome";
import { useEmotes } from "@/app/lib/useEmotes";
import { useUserColors } from "@/app/lib/useUserColors";
import { buildMatrixMessage } from "@/app/lib/buildMatrixMessage";
import { roomLabel, getDmRoomIds, isForumRoom } from "@/app/lib/matrixRooms";
import { useMatrixEditComposer } from "./useMatrixEditComposer";
import { useTypingSender } from "./useTyping";
import { getMemberDisplayName } from "@/app/lib/matrixDisplay";
import { senderLabel } from "@/app/lib/discordSender";
import { postTitle, postTags, postPreview } from "@/app/lib/matrixForum";
import { useForumVotes } from "@/app/lib/useForumVotes";

// Right-panel thread view: the root message, its m.thread replies, and a
// thread-scoped composer. Scrolling uses the same anchored-scroll engine as the
// main timeline (useAnchoredChat) — the old one-shot bottom scroll measured
// before emote/image loads, leaving the newest reply half below the fold.
// Reactions, edits and (mod/own) deletes work the same as the main timeline;
// everything the composer sends carries the m.thread relation back to the root.

export function ThreadPanel({
  room,
  rootEvent,
  myUserId,
  compact = false,
  onBack,
  onClose,
  onMessageUser,
  moderationScope,
}: {
  room: Room;
  rootEvent: MatrixEvent;
  myUserId: string;
  compact?: boolean;
  /** When set (opened from the threads list), shows a ← back-to-list control. */
  onBack?: () => void;
  onClose: () => void;
  /** Message this user from a row's shared member card. */
  onMessageUser?: (userId: string) => void;
  /** Which channels one moderation action from a row's card covers. */
  moderationScope?: () => Room[];
}) {
  const { client } = useMatrixClient();
  const rootId = rootEvent.getId() ?? "";
  const emotes = useEmotes();
  const userColors = useUserColors();
  const tsFormat = (useSetting("chatStyle_tsFormat") ?? "standard") as TsFormat;
  const tick = useMinuteTick(tsFormat === "rel");
  // ⑥ Community settings — the same list-level reads as Timeline.tsx.
  const looks = useUserLooks();
  const showEdited = useSetting("chatStyle_mxEditedTag") !== "0";
  const avatarSize = useSetting("chatStyle_mxLayout") === "compact" ? 12 : 14;

  const [replies, setReplies] = useState<MatrixEvent[]>([]);
  const [reactions, setReactions] = useState<ReactionsMap>(() => new Map());
  const [edits, setEdits] = useState<EditsMap>(() => new Map());
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  // Own username color — localStorage-backed (cross-tab updates included).
  const [ownColor] = useLocalStorageString("chatUsernameColor");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Anchored-scroll engine (shared with the main timeline): follows new
  // replies while anchored, and re-asserts the bottom on content growth
  // (emote/image loads) via its ResizeObserver.
  const {
    scrollRef,
    contentRef,
    anchored,
    rendered: renderedReplies,
    queued,
    anchorToBottom,
    onScroll,
  } = useAnchoredChat({ items: replies, getKey: eventKey });

  // Forum posts + comments are votable (threads in non-forum rooms are not).
  const isForum = isForumRoom(room);
  const { scores: voteScores, myVotes, vote, reloadVotes } = useForumVotes(room.roomId);
  const voteCb = useCallback(
    (ev: MatrixEvent, dir: -1 | 1) => { const id = ev.getId(); if (id) vote(id, dir); },
    [vote]
  );
  const onVote = isForum ? voteCb : undefined;

  // Recompute the thread's replies + reactions/edits from the live timeline on
  // every relevant change (matches the main timeline's aggregation approach).
  useEffect(() => {
    const refresh = () => {
      const all = room.getLiveTimeline().getEvents();
      setReplies(threadReplies(room, rootId));
      setReactions(aggregateReactions(all, myUserId));
      setEdits(aggregateEdits(all));
    };
    refresh();
    return subscribeRoomRefresh(room, client, refresh);
  }, [room, rootId, client, myUserId]);

  // Switching to another thread re-anchors to its newest reply (the panel is
  // reused across roots, not remounted).
  useEffect(() => {
    anchorToBottom();
  }, [rootId, anchorToBottom]);

  const { handleReact, handleUnreact, handleDelete } = useRoomActions(client, room);

  // The open thread's newest reply is read the same way — threaded receipt.
  // An empty thread has nothing threaded to mark; the main timeline is
  // Timeline's job. (The SDK's threadIdForReceipt treats a thread ROOT as
  // main-timeline, so falling back to rootEvent here sent a main-timeline
  // m.read at an OLD event, which could walk the room's read marker backwards.)
  useReadReceipts({ client, room, newestEvent: replies[replies.length - 1] ?? null, anchored, thread: true });

  // Edit/mention half of the composer — shared with Timeline (the hook's header
  // documents the identity-stability invariant).
  const { editing, handleEdit, cancelEdit, stopEditing, handleMention, peekMentions, clearMentions, sendEdit } = useMatrixEditComposer({
    client, room, emotes, edits, setInput, inputRef,
  });

  // A thread reply is typed into the same room — Element announces it too.
  useTypingSender({ client, room, text: input, enabled: !editing });

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const body = input.trim();
    if (!body || !client || sending) return;
    const capturedEdit = editing;
    flushSync(() => {
      setSending(true);
      setInput("");
      if (editing) stopEditing();
    });

    // Edit path: m.replace via the shared hook (restores composer on failure).
    if (capturedEdit) {
      try {
        await sendEdit(capturedEdit, body);
      } finally {
        setSending(false);
      }
      return;
    }

    // New thread reply: tie it to the root, falling back as an m.in_reply_to to
    // the latest event in the thread (root if there are none yet) so plain
    // clients still render it as a reply in context.
    try {
      // Captured before the send, and only cleared once it succeeds — a failed
      // send restores the input (below) and must keep its pills too.
      const mentions = peekMentions();
      const content = buildMatrixMessage(body, emotes, undefined, mentions) as Record<string, unknown>;
      const latestId = replies[replies.length - 1]?.getId() ?? rootId;
      content["m.relates_to"] = threadRelation(rootId, latestId);
      const res = await client.sendEvent(room.roomId, EventType.RoomMessage, content as unknown as TimelineEvents[EventType.RoomMessage]);
      clearMentions();
      // Sending your own reply always snaps the view back to the bottom.
      anchorToBottom();
      // Reddit-style: your own comment starts auto-upvoted (+1, immutable).
      if (isForum) {
        const nid = res?.event_id ?? res;
        if (nid) {
          postJson("/api/forum/vote", { roomId: room.roomId, eventId: nid, vote: 1 })
            .then(() => reloadVotes()).catch(() => {});
        }
      }
    } catch (err) {
      console.error("thread reply failed", err);
      setInput(body);
    } finally {
      setSending(false);
    }
  }

  const forumTitle = isForum ? postTitle(rootEvent) : "";
  // URL-only post title → show the link's own title (like the post card does).
  const titleUrl = isForum && /^https?:\/\/\S+$/.test(forumTitle.trim()) ? forumTitle.trim() : null;
  const titleOg = useOgData(titleUrl);
  const displayTitle = titleUrl && titleOg?.title ? titleOg.title : forumTitle;
  const forumTags = isForum ? postTags(rootEvent) : [];
  const label = roomLabel(room, myUserId, getDmRoomIds(client));
  const rootSenderId = rootEvent.getSender() ?? "";
  const rootSender = senderLabel(getMemberDisplayName(room, rootSenderId), rootSenderId).label;

  const rowProps = {
    room,
    myUserId,
    emotes,
    ownColor,
    userColors,
    onMention: handleMention,
    onReact: handleReact,
    onUnreact: handleUnreact,
    onEdit: handleEdit,
    onDelete: handleDelete,
    onVote,
    hideThread: true,
    tsFormat,
    tick,
    looks,
    showEdited,
    avatarSize,
  };
  // The replies' group ends and stripes (mxRows.ts); the root stands alone.
  const replyGrouped = renderedReplies.map((ev, i) => isContinuation(renderedReplies[i - 1], ev));
  const replyEnds = groupEnds(renderedReplies.length, (i) => !!replyGrouped[i]);
  const replyAlt = stripes(renderedReplies);

  return (
    <div className="flex flex-col min-h-0 h-full">
      <Bar slot="top" name="mx-header" center={
        <>
          {onBack ? (
            <button onClick={onBack} className="text-secondary hover:text-strong text-sm px-1 shrink-0" title="Back to threads">
              ←
            </button>
          ) : (
            <span className="text-base">{isForum ? "📋" : "🧵"}</span>
          )}
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-body leading-tight truncate">{isForum ? "Post" : "Thread"}</div>
            {!compact && (
              <div className="text-2xs text-muted truncate leading-tight">{label}</div>
            )}
          </div>
          <button onClick={onClose} className="text-muted hover:text-strong text-xs shrink-0" title="Close thread">
            ✕
          </button>
        </>
      } />

      <div className="relative flex-1 min-h-0 flex flex-col">
      {/* Anchored: native scroll anchoring off — it would fight the bottom
          lock. Paused: on — it keeps the reading position stable through
          image loads above the viewport. */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        // `overscroll-y-contain`, NOT the bare `overscroll-contain` — same
        // both-axes mechanism as Timeline.tsx (see the comment there):
        // `overflow-y-auto` with no
        // `overflow-x` set computes the x-axis to `auto` too, so this IS a
        // horizontal scroll container with zero scrollable range, and a
        // both-axes `contain` blocks chaining even at zero range. On mobile a
        // thread panel is one pane of ChatSidebar's OUTER pager row (the Matrix
        // INNER pager yields to an open thread — matrixPagerEnabled), so the
        // bare class would leave a dead zone: pans over the header (outside
        // this scroller) page the outer row, pans over the thread BODY would
        // not. `overscroll-y-contain` keeps this
        // scroller's own vertical containment while freeing the horizontal
        // axis to chain out to the outer pager.
        className={`flex-1 overflow-y-auto overscroll-y-contain py-1 no-scrollbar ${
          anchored ? "[overflow-anchor:none]" : "[overflow-anchor:auto]"
        }`}
      >
        {/* Content wrapper — the scroll engine observes its size so emote and
            image growth keep the view anchored */}
        <div ref={contentRef} className="flex flex-col">
        {/* Forum post header: title + tags above the OP */}
        {isForum && (
          <div className="px-4 pt-2 pb-1">
            <h2 className="font-semibold text-heading leading-snug [overflow-wrap:anywhere]" style={{ fontSize: "var(--text-chat-lg)" }}>
              {displayTitle}
            </h2>
            {forumTags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {forumTags.map((t) => (
                  <span key={t} className="px-1.5 py-0.5 rounded-md bg-accent/15 text-accent font-medium" style={{ fontSize: "var(--text-chat-xs)" }}>
                    #{t}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
        {/* Root message — for forum posts the title/tags are shown above, so the
            row renders only the description (with links + formatting). */}
        <MatrixMessageRow
          ev={rootEvent}
          reactions={reactions.get(rootId) ?? EMPTY_REACTIONS}
          editedContent={edits.get(rootId) ?? null}
          voteScore={voteScores.get(rootId) ?? 0}
          myVote={myVotes.get(rootId) ?? null}
          bodyOverride={isForum ? (postPreview(rootEvent) || titleUrl || "") : undefined}
          onMessageUser={onMessageUser}
          moderationScope={moderationScope}
          mentioned={mentionsMe(rootEvent.getContent() as Record<string, unknown>, edits.get(rootId) ?? null, myUserId)}
          groupEnd
          {...rowProps}
        />

        <div className="flex items-center gap-2 px-4 py-1.5">
          <div className="h-px flex-1 bg-raised" />
          <span className="text-2xs text-muted shrink-0">
            {replies.length === 0
              ? "No replies yet"
              : `${replies.length} ${replies.length === 1 ? "reply" : "replies"}`}
          </span>
          <div className="h-px flex-1 bg-raised" />
        </div>

        {renderedReplies.map((ev, i) => {
          const prev = renderedReplies[i - 1];
          return (
            <Fragment key={ev.getId()}>
              {startsNewDay(i === 0 ? rootEvent : prev, ev) && <DayDivider ts={ev.getTs()} />}
              <MatrixMessageRow
                ev={ev}
                reactions={reactions.get(ev.getId() ?? "") ?? EMPTY_REACTIONS}
                editedContent={edits.get(ev.getId() ?? "") ?? null}
                voteScore={voteScores.get(ev.getId() ?? "") ?? 0}
                myVote={myVotes.get(ev.getId() ?? "") ?? null}
                grouped={replyGrouped[i]}
                groupEnd={replyEnds[i]}
                alt={replyAlt[i]}
                onMessageUser={onMessageUser}
                moderationScope={moderationScope}
                mentioned={mentionsMe(ev.getContent() as Record<string, unknown>, edits.get(ev.getId() ?? "") ?? null, myUserId)}
                {...rowProps}
              />
            </Fragment>
          );
        })}
        </div>
      </div>
      {!anchored && <PausedPill queued={queued} onClick={anchorToBottom} />}
      </div>

      {/* Same bottom Bar as the Timeline's composer and live chat's — one
          primitive, one height token. The edit banner is an extra in-flow row,
          so it flags `data-chrome-grow` to let the bar grow past the token. */}
      <Bar
        slot="bottom"
        name="mx-composer"
        center={
          <form onSubmit={send} className="flex flex-col min-w-0 w-full">
            {editing && (
              <div data-chrome-grow className="flex items-center gap-2 text-xs text-muted mb-1.5">
                <span>✎ Editing message <span className="text-muted">— Esc to cancel</span></span>
                <button type="button" onClick={cancelEdit} aria-label="Cancel editing" className="ml-auto text-muted hover:text-secondary">
                  ✕
                </button>
              </div>
            )}
            <MatrixInput
              value={input}
              onChange={setInput}
              onSubmit={() => {
                if (!sending && input.trim()) send({ preventDefault: () => {} } as React.FormEvent);
              }}
              onEscape={editing ? cancelEdit : undefined}
              placeholder={editing ? "Edit message…" : `Reply to ${rootSender}'s thread…`}
              disabled={sending}
              inputRef={inputRef}
              isSignedIn
              hideUserMenu={!isForum}
              room={room}
            />
          </form>
        }
      />
    </div>
  );
}
