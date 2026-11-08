"use client";

import { useState, useEffect, useRef, useCallback, Fragment } from "react";
import { flushSync } from "react-dom";
import { EventType } from "matrix-js-sdk";
import type { Room, MatrixEvent, TimelineEvents, StateEvents } from "matrix-js-sdk";
import { useMatrixClient } from "@/app/lib/MatrixClientContext";
import { MatrixMessageRow } from "@/app/components/MatrixMessageRow";
import { rowRedacted } from "@/app/lib/timelineRows";
import { stripReplyFallback } from "@/app/lib/stripReplyFallback";
import { EMPTY_REACTIONS } from "@/app/lib/matrixReactions";
import { mentionsMe } from "@/app/lib/matrixMentions";
import { useRoomActions } from "@/app/lib/useRoomActions";
import { PIN_LIMIT, canPin, pinnedAfterToggle, pinnedEventIds, writePinned } from "@/app/lib/matrixPins";
import { usePinnedEventIds } from "./usePins";
import { countThreadReplies } from "@/app/lib/matrixThreads";
import { lockCopy, useKeyWait } from "@/app/lib/keyWait";
import { stripes, groupEnds } from "@/app/lib/mxRows";
import { useUserLooks } from "@/app/lib/useUserLooks";
import { firstUnreadIndex, markerTs, unreadMarkerId } from "@/app/lib/unreadBoundary";
import { DayDivider, NewMessagesLine } from "@/app/components/DayDivider";
import { MatrixInput } from "@/app/components/MatrixInput";
import { Bar, BarButton, WindowLayerTarget } from "@/app/components/chrome";
import { useEmotes } from "@/app/lib/useEmotes";
import { useUserColors } from "@/app/lib/useUserColors";
import { useLocalStorageString } from "@/app/lib/useClientState";
import { useSetting, useMinuteTick } from "@/app/lib/useSetting";
import type { TsFormat } from "@/app/lib/chatTime";
import { useRoomTimeline } from "@/app/lib/useRoomTimeline";
import { TimelineBody } from "@/app/components/TimelineBody";
import { EncryptionBanner } from "@/app/components/EncryptionBanner";
import { useEncryptionStatus } from "@/app/lib/useEncryptionStatus";
import { useReadReceipts } from "@/app/lib/readReceipts";
import { PausedPill } from "@/app/components/PausedPill";
import { StatusPill } from "@/app/components/StatusPill";
import { echoState } from "@/app/lib/localEcho";
import { useEchoActions } from "@/app/lib/useEchoActions";
import { setRoomOnScreen } from "@/app/lib/dm/bus";
import { elementOnScreen } from "@/app/lib/onScreen";
import { useSyncHealth } from "@/app/lib/syncHealth";
import { PinnedMessages } from "./PinnedMessages";
import { buildMatrixMessage } from "@/app/lib/buildMatrixMessage";
import { useMatrixEditComposer } from "./useMatrixEditComposer";
import { useTypingSender, useTypingUsers } from "@/app/lib/useTyping";
import { TypingLine } from "@/app/components/TypingLine";
import { typingLabel } from "@/app/lib/typing";
import {
  getDmRoomIds,
  dmPartner,
  roomLabel,
  isEncryptedRoom,
} from "@/app/lib/matrixRooms";
import { getMemberDisplayName } from "@/app/lib/matrixDisplay";
import { senderLabel } from "@/app/lib/discordSender";
import { Chats, Users, PushPin, BellSimple, BellSimpleSlash } from "@phosphor-icons/react/dist/ssr";
import { NotificationMenu } from "./NotificationMenu";
import { EarlierConversation } from "./EarlierConversation";
import { pingDm } from "@/app/lib/dm/api";
import { useNotificationSetting, type PushClient } from "@/app/lib/useNotificationSetting";
import type { AvatarStep } from "@/app/lib/avatarSize";

// ─── unified timeline ─────────────────────────────────────────────────────────

const lastOf = (r: MatrixEvent[] | undefined): MatrixEvent | null =>
  r && r.length ? (r[r.length - 1] ?? null) : null;


export function MatrixTimeline({
  room,
  myUserId,
  compact = false,
  hideUserMenu = false,
  windowLayerActive = true,
  onBack,
  onToggleDirectory,
  directoryOpen,
  onToggleMembers,
  membersOpen,
  onToggleThreads,
  threadsOpen,
  onOpenThread,
  activeThreadRootId,
  onMessageUser,
  moderationScope,
  serverRooms,
  earlier,
  onOpenEarlier,
  onBackToCurrent,
}: {
  room: Room;
  myUserId: string;
  compact?: boolean;
  hideUserMenu?: boolean;
  /** Gates the "matrix" WindowLayerTarget on top of `compact` (review fix,
   *  loading-discipline L1): true unless a host's OWN inner pager can leave
   *  this timeline mounted off-screen while another of its panes shows.
   *  Default true — the community page (which renders MatrixTimeline
   *  directly, no inner pager of its own) is unaffected. See MatrixView's
   *  `windowLayerActive` for the real gate. */
  windowLayerActive?: boolean;
  onBack?: () => void;
  onToggleDirectory?: () => void;
  directoryOpen?: boolean;
  onToggleMembers?: () => void;
  membersOpen?: boolean;
  onToggleThreads?: () => void;
  threadsOpen?: boolean;
  onOpenThread?: (ev: MatrixEvent) => void;
  /** Root id of the thread currently open in the right panel (highlights its chip). */
  activeThreadRootId?: string | null;
  /** Message this user from a row's shared member card. */
  onMessageUser?: (userId: string) => void;
  /** Which channels one moderation action from a row's card covers. */
  moderationScope?: () => Room[];
  /** Every channel in the active server — the notification menu's "Mark all as read". */
  serverRooms: Room[];
  /** A DM: the same person's older rooms, newest first — "Earlier conversation" at the start. */
  earlier?: Room[];
  onOpenEarlier?: (room: Room) => void;
  /** This room is an EARLIER conversation, read-only: the composer gives way to the way back to
   *  the active one (a line always goes into the room the person writes in). */
  onBackToCurrent?: () => void;
}) {
  const { client } = useMatrixClient();
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState<MatrixEvent | null>(null);
  // Own username color — localStorage-backed (cross-tab + same-tab updates).
  const [ownColor] = useLocalStorageString("chatUsernameColor");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const emotes = useEmotes();
  const userColors = useUserColors();
  const tsFormat = (useSetting("chatStyle_tsFormat") ?? "standard") as TsFormat;
  // ⑥ Community settings, read once here and handed down (80 rows must not each
  // subscribe — useSetting's own rule). The CSS-only ones (avatars, times,
  // reaction size, the layouts' spacing) are classes on <html> and need nothing.
  const looks = useUserLooks();
  const showDeleted = useSetting("chatStyle_mxDeleted") === "placeholder";
  const showEdited = useSetting("chatStyle_mxEditedTag") !== "0";
  const mxLayout = useSetting("chatStyle_mxLayout");
  const avatarStep: AvatarStep = mxLayout === "compact" ? "xs" : "line";
  // Cozy is the layout with no stored value too (its registry default).
  const gutterAvatar = mxLayout !== "compact" && mxLayout !== "bubbles";
  const tick = useMinuteTick(tsFormat === "rel");
  const baseLimit = compact ? 100 : 200;
  // The room's timeline engine, shared with the DM window (useRoomTimeline.ts): the render
  // window, reactions/edits/threads, scroll-back and auto-fill, the jump and its highlight,
  // the grouping flags and the one loading phase.
  const {
    events, rendered, reactions, edits, threads, grouped, newDay, paginating, hitStart,
    jumpToEvent, highlightId, scrollRef, contentRef, onScroll, atBottom: anchored, resume: anchorToBottom, queued, phase,
  } = useRoomTimeline(client, room, { showDeleted, myUserId, baseLimit });

  // Mark the room read when the newest message is on screen (Discord's rule).
  useReadReceipts({ client, room, newestEvent: events[events.length - 1] ?? null, anchored });

  // The pinned-messages panel, opened from the header's pin button; a room
  // switch closes it.
  const [pinsOpen, setPinsOpen] = useState(false);
  const closePins = useCallback(() => setPinsOpen(false), []);
  // Notification bell — position of the menu it opens, or null
  // when closed. `useNotificationSetting` is the same hook the menu itself
  // uses: it listens for the client's `accountData` event (m.push_rules) and
  // re-reads, so a change made in Element updates the icon without this
  // component needing a render of its own to notice. This instance never
  // calls `choose()`, so its optimistic state stays null and it only ever
  // reflects the server (or the menu's own optimistic write, once that one's
  // account-data round-trip lands and both instances re-read together).
  const [bellAt, setBellAt] = useState<{ x: number; y: number } | null>(null);
  // The bell button itself, so the menu's outside-click can treat it as
  // "inside" — otherwise the click that closes the menu also reopens it.
  const bellRef = useRef<HTMLButtonElement>(null);
  const { setting: notifySetting } = useNotificationSetting(
    client as unknown as PushClient | null,
    room.roomId
  );
  // A room switch closes the pins panel (render-time adjust).
  const [pinsKey, setPinsKey] = useState<string | null>(null);
  if (pinsKey !== room.roomId) {
    setPinsKey(room.roomId);
    setPinsOpen(false);
  }

  // The "New" line: the reader's read marker EVENT ID as it was when this
  // room was opened, captured before useReadReceipts (800 ms debounce) can
  // move it, and never re-read while the room stays open — Discord keeps the
  // line in place. Its timestamp is derived at render from the live room
  // (never stored), so the line shows once the marked event is loaded — the
  // client starts with initialSyncLimit: 30 and no persistent store, so an
  // old marker is often outside the window on a fresh page load.
  const [markerKey, setMarkerKey] = useState<string | null>(null);
  const [markerId, setMarkerId] = useState<string | null>(null);
  if (markerKey !== room.roomId) {
    setMarkerKey(room.roomId);
    setMarkerId(unreadMarkerId(room, myUserId));
  }
  const newIdx = firstUnreadIndex(rendered, markerTs(room, markerId), myUserId);

  // This conversation counts as on screen exactly while its message list is in front of the
  // person (elementOnScreen, asked at the moment a DM arrives): a DM arriving for it then opens no
  // window over it (lib/dm/bus.ts); on another tab or pane, it does.
  useEffect(() => setRoomOnScreen(room.roomId, () => elementOnScreen(scrollRef.current)), [room.roomId, scrollRef]);

  const { handleReact, handleUnreact, handleDelete } = useRoomActions(client, room);
  // A failed send's row: Retry resends the same echo, Delete drops it.
  const { handleRetry, handleDrop } = useEchoActions(client, room);
  const syncHealth = useSyncHealth();

  // Channel pins (m.room.pinned_events). `mayPin` is the room's PL rule; the
  // ⋯ menu offers Pin only under the limit, and Unpin always.
  const pinnedIds = usePinnedEventIds(room);
  const mayPin = canPin(room, myUserId);
  const togglePin = useCallback(async (eventId: string, pinned: boolean) => {
    if (!client) return;
    const next = pinnedAfterToggle(pinnedEventIds(room), eventId, pinned);
    if (!next) return;
    try {
      await writePinned(client, room, next);
    } catch (e) {
      console.warn("[Matrix] pin failed", e);
    }
  }, [client, room]);
  const handleTogglePin = useCallback((ev: MatrixEvent, pinned: boolean) => {
    const id = ev.getId();
    if (id) void togglePin(id, pinned);
  }, [togglePin]);

  const unpinId = useCallback((id: string) => { void togglePin(id, true); }, [togglePin]);

  // A reply quote's tap: the same jump; one it cannot make says so for a moment.
  const [replyJumpFailed, setReplyJumpFailed] = useState(false);
  const jumpToReply = useCallback((id: string) => {
    void jumpToEvent(id).then((ok) => setReplyJumpFailed(!ok));
  }, [jumpToEvent]);
  useEffect(() => {
    if (!replyJumpFailed) return;
    const t = setTimeout(() => setReplyJumpFailed(false), 3000);
    return () => clearTimeout(t);
  }, [replyJumpFailed]);
  // Messages waiting for their key: the backup is asked again; `settled` once the tries are spent.
  const keySettled = useKeyWait(client, room);

  // Edit/mention half of the composer — shared with ThreadPanel (the hook's
  // header documents the identity-stability invariant).
  const { editing, handleEdit, cancelEdit, stopEditing, handleMention, peekMentions, clearMentions, sendEdit } = useMatrixEditComposer({
    client, room, emotes, edits, setInput, inputRef,
    onBeginEdit: () => setReplyTo(null),
  });

  // Typing: announce ours from the composer, show everyone else's over the
  // bottom edge (typing is per room, so only this panel shows it).
  useTypingSender({ client, room, text: input, enabled: !editing });
  const typingNames = useTypingUsers({ client, room, myUserId });
  const typingText = typingLabel(typingNames);

  // Stable identity so the memoized MatrixMessageRow can skip re-rendering
  // untouched rows when a new event arrives.
  const handleReply = useCallback((ev: MatrixEvent) => {
    stopEditing();
    setReplyTo(ev);
    inputRef.current?.focus();
    // stopEditing is `useCallback(…, [])` in useMatrixEditComposer, so listing it
    // costs nothing and keeps that identity-stability claim checked by the dep
    // list itself rather than by a comment that can rot away from it.
  }, [stopEditing]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const body = input.trim();
    if (!body || !client || sending) return;
    const capturedReply = replyTo;
    const capturedEdit = editing;
    flushSync(() => {
      setSending(true);
      setInput("");
      setMarkerId(null);
      if (replyTo) setReplyTo(null);
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

    anchorToBottom();
    try {
      const replySenderId = capturedReply?.getSender() ?? "";
      const replyCtx = capturedReply
        ? {
            eventId: capturedReply.getId()!,
            roomId: room.roomId,
            senderUserId: replySenderId,
            senderLabel: senderLabel(getMemberDisplayName(room, replySenderId), replySenderId).label,
            body: stripReplyFallback(
              (capturedReply.getContent() as Record<string, unknown>).body as string ?? ""
            ),
          }
        : undefined;
      const mentions = peekMentions();
      const content = buildMatrixMessage(body, emotes, replyCtx, mentions);
      // The message carries its pills from here on, sent or not.
      clearMentions();
      await client.sendEvent(room.roomId, EventType.RoomMessage, content as TimelineEvents[EventType.RoomMessage]);
      // A DM nudges the other person's open pages, as a line from the DM window does: their Matrix
      // client is not running until they open it.
      if (dmPeer) pingDm(dmPeer);
    } catch (err) {
      // The box stays empty: the echo stays in the list as a "Not sent" row
      // with Retry (echoState), so the text is not lost — and putting it back
      // here as well would let a second press send it twice.
      console.error("send failed", err);
    } finally {
      setSending(false);
    }
  }

  const dmRoomIds = getDmRoomIds(client);
  const dmPeer = dmPartner(room, myUserId, dmRoomIds)?.userId ?? null;
  const isDM = !!dmPeer;
  const label = roomLabel(room, myUserId, dmRoomIds);
  const encrypted = isEncryptedRoom(room);
  // The app-wide verdict, known from the first render (the remembered one before Matrix has
  // checked): the DM banner's box is never a late insertion over the messages.
  const { verdict: encryptionVerdict } = useEncryptionStatus();
  async function enableEncryption() {
    if (!client) return;
    try {
      await client.sendStateEvent(
        room.roomId,
        EventType.RoomEncryption,
        { algorithm: "m.megolm.v1.aes-sha2" } as StateEvents[EventType.RoomEncryption],
        ""
      );
    } catch (e) {
      console.error("[Matrix] failed to enable encryption:", e);
    }
  }
  const topic = !compact
    ? (room.currentState
        .getStateEvents("m.room.topic")[0]
        ?.getContent()?.topic as string | undefined)
    : undefined;

  const replyToSender = replyTo
    ? senderLabel(getMemberDisplayName(room, replyTo.getSender() ?? ""), replyTo.getSender() ?? "").label
    : null;

  return (
    // data-mx-pane="narrow": MatrixView's mode 1 (a phone, the side panel) — the Cozy gutter's
    // 32px picture and the head's short time (globals.css, Community). The pane, not the viewport.
    <div data-mx-pane={compact ? "narrow" : undefined} className={`flex flex-col min-h-0 ${compact ? "flex-1" : "h-full"}`}>
      <Bar slot="top" name="mx-header" center={
        <>
          {onBack && (
            <BarButton size="touch" icon={<span className="text-sm">←</span>} label="Back" onClick={onBack} />
          )}
          {onToggleDirectory && (
            <BarButton
              size="touch"
              icon={<span className="text-sm">☰</span>}
              label={directoryOpen ? "Hide channels" : "Show channels"}
              active={directoryOpen}
              onClick={onToggleDirectory}
            />
          )}
          {!isDM && (
            <span
              className="w-1.5 h-1.5 rounded-full shrink-0 img-shadow-chat"
              style={{ background: "var(--accent)" }}
            />
          )}
          <span
            className={`truncate flex-1 ${
              compact
                ? "text-sm font-medium text-body"
                : "font-semibold text-heading"
            }`}
          >
            {label}
          </span>
          {encrypted && (
            <span className="text-muted text-xs shrink-0" title="End-to-end encrypted">
              🔒
            </span>
          )}
          {topic && (
            <span className="text-muted text-xs ml-2 truncate hidden md:block">— {topic}</span>
          )}
          <BarButton
            size="touch"
            ref={bellRef}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setBellAt(bellAt ? null : { x: r.left, y: r.bottom + 4 });
            }}
            label="Notification settings"
            expanded={!!bellAt}
            active={!!bellAt}
            // A non-default level stays brighter than the other icons.
            icon={
              <span className={`flex ${notifySetting === "all" ? "" : "text-body"}`}>
                {notifySetting === "none"
                  ? <BellSimpleSlash size={15} weight="fill" />
                  : <BellSimple size={15} weight={notifySetting === "mentions" ? "fill" : "bold"} />}
              </span>
            }
          />
          <BarButton
            size="touch"
            onClick={() => setPinsOpen((o) => !o)}
            label={`${pinnedIds.length} pinned messages`}
            expanded={pinsOpen}
            active={pinsOpen}
            icon={<PushPin size={15} weight="bold" />}
          />
          {onToggleThreads && (
            <BarButton
              size="touch"
              onClick={onToggleThreads}
              label={threadsOpen ? "Hide threads" : "Threads"}
              active={threadsOpen}
              icon={<Chats size={15} weight="bold" />}
            />
          )}
          {onToggleMembers && (
            <BarButton
              size="touch"
              onClick={onToggleMembers}
              label={membersOpen ? "Hide members" : "Show members"}
              active={membersOpen}
              icon={<Users size={15} weight="bold" />}
            />
          )}
        </>
      } />

      {isDM && client && (
        <EncryptionBanner encrypted={encrypted} verdict={encryptionVerdict} onEnable={enableEncryption} />
      )}

      <div className="relative flex-1 min-h-0 flex flex-col">
        {/* Under the header, outside the scroller so it cannot scroll away;
            only after a sustained loss (syncHealth.ts). */}
        {syncHealth === "reconnecting" && <StatusPill>Reconnecting to the community…</StatusPill>}
        {replyJumpFailed && <StatusPill>Can&apos;t jump to that message from here.</StatusPill>}
        {/* Anchored: native scroll anchoring off — it would fight the bottom
            lock. Paused: on — it keeps the reading position stable through
            image loads and redactions above the viewport. */}
        <div
          ref={scrollRef}
          onScroll={onScroll}
          role="log"
          // `overscroll-y-contain`, NOT the bare `overscroll-contain`. This
          // scroller sits inside the mode-1 Matrix pager row
          // (MatrixView's inner wrapper) — a both-axes contain here would block
          // horizontal pans from chaining out to the pager exactly like
          // ChatSidebar's `.chat-scroll-layer` (see the comment there for the
          // full mechanism). `overscroll-y-contain` keeps vertical
          // containment and frees the horizontal axis to chain.
          // mx-scroll: its top padding is the head row's hover-bar reach (globals.css).
          className={`flex-1 overflow-y-auto overscroll-y-contain mx-scroll pb-1 no-scrollbar ${
            anchored ? "[overflow-anchor:none]" : "[overflow-anchor:auto]"
          }`}
        >
          {/* Content wrapper — the scroll engine observes its size so font and
              image growth keep the view anchored */}
          <div ref={contentRef} className={`flex min-h-full flex-col${typingText ? " pb-4" : ""}`}>
            {/* The one message area (TimelineBody): skeleton while loading, then the rows or
                "No messages yet"; the top slot holds the scroll-back line at one height. */}
            <TimelineBody
              phase={phase}
              count={rendered.length}
              hitStart={hitStart}
              paginating={paginating}
              emptyText={compact ? "No messages yet." : "No messages yet. Say something!"}
              topSlot={earlier?.length && onOpenEarlier ? <EarlierConversation rooms={earlier} onOpen={onOpenEarlier} /> : undefined}
              rows={client && (() => {
                  // Per-row shape for the Community settings: grouped (no header),
                  // the last row of a group (bubbles round it) and the stable
                  // alternating stripe (mxRows.ts).
                  // A row under the New line shows its header.
                  const headless = grouped.map((g, i) => g && i !== newIdx);
                  const ends = groupEnds(rendered.length, (i) => !!headless[i]);
                  const alt = stripes(rendered);
                  return rendered.map((ev, i) => {
                    return (
                      <Fragment key={ev.getId()}>
                        {newDay[i] && <DayDivider ts={ev.getTs()} />}
                        {i === newIdx && <NewMessagesLine />}
                        <MatrixMessageRow
                          ev={ev}
                          redacted={rowRedacted(ev)}
                          room={room}
                          myUserId={myUserId}
                          emotes={emotes}
                          ownColor={ownColor}
                          userColors={userColors}
                          onReply={handleReply}
                          onMention={handleMention}
                          reactions={reactions.get(ev.getId() ?? "") ?? EMPTY_REACTIONS}
                          onReact={handleReact}
                          onUnreact={handleUnreact}
                          onEdit={handleEdit}
                          onDelete={handleDelete}
                          onOpenThread={onOpenThread}
                          activeThreadRootId={activeThreadRootId}
                          tsFormat={tsFormat}
                          tick={tick}
                          onMessageUser={onMessageUser}
                          moderationScope={moderationScope}
                          threadCount={countThreadReplies(room, ev.getId() ?? "", threads)}
                          lastReply={lastOf(threads.get(ev.getId() ?? ""))}
                          editedContent={edits.get(ev.getId() ?? "") ?? null}
                          grouped={headless[i]}
                          groupEnd={ends[i]}
                          alt={alt[i]}
                          looks={looks}
                          avatarStep={avatarStep}
                          gutterAvatar={gutterAvatar}
                          showEdited={showEdited}
                          pinned={pinnedIds.includes(ev.getId() ?? "")}
                          onTogglePin={mayPin && (pinnedIds.includes(ev.getId() ?? "") || pinnedIds.length < PIN_LIMIT) ? handleTogglePin : undefined}
                          highlighted={highlightId === ev.getId()}
                          mentioned={mentionsMe(ev.getContent() as Record<string, unknown>, edits.get(ev.getId() ?? "") ?? null, myUserId)}
                          echo={echoState(ev)}
                          onRetry={handleRetry}
                          onDrop={handleDrop}
                          onJumpToReply={jumpToReply}
                          lock={lockCopy(ev, keySettled)}
                        />
                      </Fragment>
                    );
                  });
                })()}
            />
          </div>
        </div>
        <PinnedMessages client={client} room={room} ids={pinnedIds} canPin={mayPin} onJump={jumpToEvent} onUnpin={unpinId} open={pinsOpen} onClose={closePins} />
        {bellAt && (
          <NotificationMenu room={room} serverRooms={serverRooms} x={bellAt.x} y={bellAt.y}
            onClose={() => setBellAt(null)} anchorRef={bellRef} />
        )}
        {typingText && <TypingLine text={typingText} />}
        {!anchored && <PausedPill queued={queued} onClick={anchorToBottom} />}
        {compact && windowLayerActive && <WindowLayerTarget pane="matrix" />}
      </div>

      {/* The Matrix composer is the same primitive as live chat's: a bottom Bar,
          exactly --chrome-bottom-h tall, so the two panels' bottom edges line up
          by construction. The edit / reply banners flag `data-chrome-grow`
          because they are extra in-flow rows — without it they would overflow
          the token instead of growing the bar. */}
      {onBackToCurrent ? (
        <Bar
          slot="bottom"
          name="mx-composer"
          center={
            <div data-earlier-readonly="" className="flex min-w-0 w-full items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs text-muted" title={`An earlier conversation with ${label}`}>Earlier conversation</span>
              <button type="button" onClick={onBackToCurrent}
                className="h-9 shrink-0 rounded-md px-3 text-xs font-semibold text-strong bg-surface-2 hover:bg-surface-3 focus-visible:outline focus-visible:outline-edge-bright">
                Back to the current one
              </button>
            </div>
          }
        />
      ) : (
      <Bar
        slot="bottom"
        name="mx-composer"
        center={
          <form onSubmit={send} className="flex flex-col min-w-0 w-full">
            {editing && (
              <div data-chrome-grow className={`flex items-center gap-2 text-xs text-muted ${compact ? "mb-1" : "mb-1.5"}`}>
                <span>✎ Editing message <span className="text-muted">— Esc to cancel</span></span>
                <button
                  type="button"
                  onClick={cancelEdit}
                  aria-label="Cancel editing"
                  className="ml-auto text-muted hover:text-secondary"
                >
                  ✕
                </button>
              </div>
            )}
            {!editing && replyTo && replyToSender && (
              <div data-chrome-grow className={`flex items-center gap-2 text-xs text-muted ${compact ? "mb-1" : "mb-1.5"}`}>
                <span>
                  ↩ Replying to <span className="text-body-dim">{replyToSender}</span>
                </span>
                <button
                  type="button"
                  onClick={() => setReplyTo(null)}
                  className="ml-auto text-muted hover:text-secondary"
                >
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
              placeholder={
                editing ? "Edit message…" : replyTo ? `Reply to ${replyToSender}…` : `Message ${label}…`
              }
              disabled={sending}
              inputRef={inputRef}
              isSignedIn
              hideUserMenu={hideUserMenu}
              // Off a phone the rail is docked beside this timeline, its profile tile on screen (#255).
              railBeside={!compact}
              room={room}
            />
          </form>
        }
      />
      )}
    </div>
  );
}
