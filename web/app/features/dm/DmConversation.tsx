"use client";

// The DM window's conversation (client polish Task 11; k's QoL item 1): the SAME rows as a
// Community channel — MatrixMessageRow over the shared timeline engine (useRoomTimeline), drawn
// through TimelineBody — so a DM shows pictures beside grouped lines, day dividers, inline media,
// reactions and reply quotes, scrolls back, and never yanks the reader to the bottom.
//
// The window is always a narrow pane (data-mx-pane="narrow": the Cozy gutter's 32px picture and
// the head's short time, globals.css Community). A DM row offers React, Reply, Copy, Copy link and
// Delete on your own lines — never pin, vote or moderation — and only an accepted conversation can
// be answered or reacted to (a request has no chat box to answer in). It is marked read (Discord's
// rule) only while accepted and at its newest line.
//
// DmWindow loads this file behind next/dynamic: the row reaches matrix-js-sdk VALUES (the reply
// quote's fetch), and the chat column that mounts the window is on every page's first load
// (matrixSdkGraph.test.ts).

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";
import { MatrixMessageRow } from "@/app/components/MatrixMessageRow";
import { rowRedacted } from "@/app/lib/timelineRows";
import { TimelineBody } from "@/app/components/TimelineBody";
import { PausedPill } from "@/app/components/PausedPill";
import { DayDivider } from "@/app/components/DayDivider";
import { EMPTY_REACTIONS } from "@/app/lib/matrixReactions";
import { mentionsMe } from "@/app/lib/matrixMentions";
import { useRoomTimeline } from "@/app/lib/useRoomTimeline";
import { useRoomActions } from "@/app/lib/useRoomActions";
import { useReadReceipts } from "@/app/lib/readReceipts";
import { lockCopy, useKeyWait } from "@/app/lib/keyWait";
import { echoState } from "@/app/lib/localEcho";
import { stripes, groupEnds } from "@/app/lib/mxRows";
import { useEmotes } from "@/app/lib/useEmotes";
import { useUserColors } from "@/app/lib/useUserColors";
import { useUserLooks } from "@/app/lib/useUserLooks";
import { useLocalStorageString } from "@/app/lib/useClientState";
import { useSetting, useMinuteTick } from "@/app/lib/useSetting";
import type { TsFormat } from "@/app/lib/chatTime";
import { matrixHandle } from "@/app/lib/matrixHandle";
import { getMemberDisplayName } from "@/app/lib/matrixDisplay";
import { senderLabel } from "@/app/lib/discordSender";
import { stripReplyFallback } from "@/app/lib/stripReplyFallback";
import { useTypingSender, useTypingUsers } from "@/app/lib/useTyping";
import { typingLabel } from "@/app/lib/typing";
import { TypingLine } from "@/app/components/TypingLine";
import type { ReplyContext } from "@/app/lib/buildMatrixMessage";
import type { AvatarStep } from "@/app/lib/avatarSize";

type Props = {
  roomId: string;
  peerName: string;
  /** Only an accepted conversation is answered, reacted to, or marked read. */
  accepted: boolean;
  /** The chat box's text while it holds this conversation: our typing is announced from it. */
  typed: string;
  /** A row's Reply: the strip under the conversation names it; the next line answers it. */
  onReply: (reply: ReplyContext) => void;
  /** A "Not sent" line's Retry / Delete, by the line's (echo's) id. */
  onRetry: (id: string) => void;
  onDrop: (id: string) => void;
};

export default function DmConversation(props: Props) {
  const client = matrixHandle().client;
  const room = client?.getRoom(props.roomId) ?? null;
  // The client's own account: its lines are "mine" (Delete, the read marker's sender).
  const me = client?.getUserId() ?? null;
  if (!client || !room || !me) return null;
  return <Conversation {...props} client={client} room={room} me={me} />;
}

function Conversation({ client, room, me, peerName, accepted, typed, onReply, onRetry, onDrop }: Props & { client: MatrixClient; room: Room; me: string }) {
  // Typing, as the Community timeline does it: ours from the bound chat box (Community › Privacy ›
  // Send typing applies), theirs over the bottom edge of the list.
  useTypingSender({ client, room, text: typed, enabled: accepted });
  const typingText = typingLabel(useTypingUsers({ client, room, myUserId: me }));

  // The same list-level reads as the Community timeline (80 rows must not each subscribe).
  const emotes = useEmotes();
  const userColors = useUserColors();
  const looks = useUserLooks();
  const [ownColor] = useLocalStorageString("chatUsernameColor");
  const tsFormat = (useSetting("chatStyle_tsFormat") ?? "standard") as TsFormat;
  const tick = useMinuteTick(tsFormat === "rel");
  const showDeleted = useSetting("chatStyle_mxDeleted") === "placeholder";
  const showEdited = useSetting("chatStyle_mxEditedTag") !== "0";
  const mxLayout = useSetting("chatStyle_mxLayout");
  const avatarStep: AvatarStep = mxLayout === "compact" ? "xs" : "line";
  // Cozy is the layout with no stored value too (its registry default).
  const gutterAvatar = mxLayout !== "compact" && mxLayout !== "bubbles";

  const {
    events, rendered, reactions, edits, grouped, newDay, paginating, hitStart,
    jumpToEvent, highlightId, scrollRef, contentRef, onScroll, atBottom, paused, resume, queued, phase,
  } = useRoomTimeline(client, room, { showDeleted, myUserId: me });

  // Marked read as the Community timeline does — only an accepted conversation (an unanswered
  // request stays unread), at its newest line.
  useReadReceipts({ client, room, newestEvent: events[events.length - 1] ?? null, anchored: accepted && atBottom });

  // Sending your own line takes you to it, as the Community timeline does on send (Discord too):
  // the line is typed in the chat box (DmHost), so the cue is its local echo arriving newest —
  // a line of mine with a send state, not seen before. A "Not sent" echo counts the same, so its
  // Retry is never hidden behind the pill.
  const lastOwnEcho = useRef<string | null>(null);
  useEffect(() => {
    const newest = events[events.length - 1];
    if (!newest || newest.getSender() !== me || newest.status === null) return;
    const id = newest.getId() ?? "";
    if (lastOwnEcho.current === id) return;
    lastOwnEcho.current = id;
    resume();
  }, [events, me, resume]);

  const { handleReact, handleUnreact, handleDelete } = useRoomActions(client, room);
  // A line waiting for its key asks the key backup again and resolves in place.
  const keySettled = useKeyWait(client, room);

  // The host's handlers change identity with its state; the rows are memoised on theirs.
  const latest = useRef({ onReply, onRetry, onDrop });
  useLayoutEffect(() => { latest.current = { onReply, onRetry, onDrop }; });
  const handleReply = useCallback((ev: MatrixEvent) => {
    const sender = ev.getSender() ?? "";
    latest.current.onReply({
      eventId: ev.getId() ?? "",
      roomId: room.roomId,
      senderUserId: sender,
      senderLabel: senderLabel(getMemberDisplayName(room, sender), sender).label,
      body: stripReplyFallback(((ev.getContent() as Record<string, unknown>).body as string) ?? ""),
    });
  }, [room]);
  const handleRetry = useCallback((ev: MatrixEvent) => latest.current.onRetry(ev.getId() ?? ""), []);
  const handleDrop = useCallback((ev: MatrixEvent) => latest.current.onDrop(ev.getId() ?? ""), []);

  const ends = groupEnds(rendered.length, (i) => !!grouped[i]);
  const alt = stripes(rendered);
  const rows = rendered.map((ev, i) => (
    <Fragment key={ev.getId()}>
      {newDay[i] && <DayDivider ts={ev.getTs()} />}
      <MatrixMessageRow
        ev={ev}
        redacted={rowRedacted(ev)}
        room={room}
        myUserId={me}
        emotes={emotes}
        ownColor={ownColor}
        userColors={userColors}
        onReply={accepted ? handleReply : undefined}
        reactions={reactions.get(ev.getId() ?? "") ?? EMPTY_REACTIONS}
        onReact={accepted ? handleReact : undefined}
        onUnreact={handleUnreact}
        onDelete={ev.getSender() === me ? handleDelete : undefined}
        hideThread
        tsFormat={tsFormat}
        tick={tick}
        editedContent={edits.get(ev.getId() ?? "") ?? null}
        grouped={grouped[i]}
        groupEnd={ends[i]}
        alt={alt[i]}
        looks={looks}
        avatarStep={avatarStep}
        gutterAvatar={gutterAvatar}
        showEdited={showEdited}
        highlighted={highlightId === ev.getId()}
        mentioned={mentionsMe(ev.getContent() as Record<string, unknown>, edits.get(ev.getId() ?? "") ?? null, me)}
        echo={echoState(ev)}
        onRetry={handleRetry}
        onDrop={handleDrop}
        onJumpToReply={jumpToEvent}
        lock={lockCopy(ev, keySettled)}
      />
    </Fragment>
  ));

  return (
    // -mx-3: the rows carry their own inset (globals.css --mx-row-inset), edge to edge
    // like a Community channel, inside the window body's padding.
    <div data-mx-pane="narrow" className="relative -mx-3 flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-label={`Conversation with ${peerName}`}
        // Anchored: native scroll anchoring off — it would fight the bottom lock. Paused: on — it
        // keeps the reading position through image loads above the viewport (Timeline.tsx).
        // mx-scroll: its top padding is the head row's hover-bar reach (globals.css).
        className={`flex-1 overflow-y-auto overscroll-y-contain mx-scroll pb-1 no-scrollbar ${
          atBottom ? "[overflow-anchor:none]" : "[overflow-anchor:auto]"
        } min-h-0`}
      >
        <div ref={contentRef} className="flex min-h-full flex-col">
          <TimelineBody
            phase={phase}
            count={rendered.length}
            hitStart={hitStart}
            paginating={paginating}
            emptyText="No messages yet — type in the chat box below to say something."
            rows={rows}
          />
        </div>
      </div>
      {typingText && <TypingLine text={typingText} />}
      {paused && <PausedPill queued={queued} onClick={resume} />}
    </div>
  );
}
