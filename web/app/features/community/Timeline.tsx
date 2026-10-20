"use client";

import { useState, useEffect, useRef, useCallback, Fragment } from "react";
import { flushSync } from "react-dom";
import { Direction, EventType } from "matrix-js-sdk";
import type { Room, MatrixEvent, MatrixClient, TimelineEvents, StateEvents } from "matrix-js-sdk";
import { useMatrixClient } from "@/app/lib/MatrixClientContext";
import { MatrixMessageRow } from "@/app/components/MatrixMessageRow";
import { stripReplyFallback } from "@/app/lib/stripReplyFallback";
import { aggregateReactions, EMPTY_REACTIONS, type ReactionsMap } from "@/app/lib/matrixReactions";
import { aggregateEdits, type EditsMap } from "@/app/lib/matrixEdits";
import { mentionsMe } from "@/app/lib/matrixMentions";
import { useRoomActions, eventKey } from "@/app/lib/useRoomActions";
import { PIN_LIMIT, canPin, pinnedAfterToggle, pinnedEventIds, writePinned } from "@/app/lib/matrixPins";
import { usePinnedEventIds } from "./usePins";
import { buildThreadIndex, countThreadReplies, type ThreadIndex } from "@/app/lib/matrixThreads";
import { subscribeRoomRefresh } from "@/app/lib/matrixRoomEvents";
import { isTimelineRow, noteRelationIds } from "@/app/lib/timelineRows";
import { stripes, groupEnds } from "@/app/lib/mxRows";
import { useUserLooks } from "@/app/lib/useUserLooks";
import { isContinuation, startsNewDay } from "@/app/lib/messageGrouping";
import { firstUnreadIndex, markerTs, unreadMarkerId } from "@/app/lib/unreadBoundary";
import { DayDivider, NewMessagesLine } from "@/app/components/DayDivider";
import { MatrixInput } from "@/app/components/MatrixInput";
import { Bar, WindowLayerTarget } from "@/app/components/chrome";
import { useEmotes } from "@/app/lib/useEmotes";
import { useUserColors } from "@/app/lib/useUserColors";
import { useLocalStorageString } from "@/app/lib/useClientState";
import { useSetting, useMinuteTick } from "@/app/lib/useSetting";
import type { TsFormat } from "@/app/lib/chatTime";
import { useAnchoredChat } from "@/app/lib/useAnchoredChat";
import { useReadReceipts } from "@/app/lib/readReceipts";
import { PausedPill } from "@/app/components/PausedPill";
import { PinnedMessages } from "./PinnedMessages";
import { buildMatrixMessage } from "@/app/lib/buildMatrixMessage";
import { useMatrixEditComposer } from "./useMatrixEditComposer";
import { useTypingSender, useTypingUsers } from "./useTyping";
import { TypingLine } from "./TypingLine";
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
import EmptyState from "@/app/components/EmptyState";
import { NotificationMenu } from "./NotificationMenu";
import { useNotificationSetting, type PushClient } from "@/app/lib/useNotificationSetting";

// ─── encryption banner (DMs only) ────────────────────────────────────────────

function EncryptionBanner({
  room,
  client,
  myUserId,
}: {
  room: Room;
  client: MatrixClient;
  myUserId: string;
}) {
  const encrypted = isEncryptedRoom(room);
  const [isVerified, setIsVerified] = useState<boolean | null>(null);
  const [enabling, setEnabling] = useState(false);

  useEffect(() => {
    if (!encrypted) return;
    let cancelled = false;
    // Verdict computed in the async chain; setIsVerified only fires in the
    // .then callback (never synchronously in the effect body).
    (async () => {
      const crypto = client.getCrypto?.();
      const deviceId = client.getDeviceId() ?? "";
      if (!crypto || !deviceId) return false;
      const vs = await crypto.getDeviceVerificationStatus(myUserId, deviceId).catch(() => null);
      return vs?.crossSigningVerified ?? false;
    })().then((v) => { if (!cancelled) setIsVerified(v); });
    return () => { cancelled = true; };
  }, [client, encrypted, myUserId]);

  async function enableEncryption() {
    setEnabling(true);
    try {
      await client.sendStateEvent(
        room.roomId,
        EventType.RoomEncryption,
        { algorithm: "m.megolm.v1.aes-sha2" } as StateEvents[EventType.RoomEncryption],
        ""
      );
    } catch (e) {
      console.error("[Matrix] failed to enable encryption:", e);
    } finally {
      setEnabling(false);
    }
  }

  if (!encrypted) {
    return (
      <div className="mx-2 mt-1 px-3 py-1.5 rounded-md bg-raised/60 flex items-center gap-2 text-xs text-secondary">
        <span>🔓</span>
        <span className="flex-1">Not encrypted</span>
        <button
          onClick={enableEncryption}
          disabled={enabling}
          className="text-body-dim hover:text-strong underline disabled:opacity-50"
        >
          {enabling ? "Enabling…" : "Enable E2EE"}
        </button>
      </div>
    );
  }

  if (isVerified === false) {
    return (
      <div className="mx-2 mt-1 px-3 py-1.5 rounded-md bg-yellow-900/20 border border-yellow-700/30 flex items-center gap-2 text-xs text-yellow-400/80">
        <span>⚠️</span>
        <span>Session unverified — open Devices &amp; Security to verify</span>
      </div>
    );
  }

  return null;
}

// ─── unified timeline ─────────────────────────────────────────────────────────

const lastOf = (r: MatrixEvent[] | undefined): MatrixEvent | null =>
  r && r.length ? (r[r.length - 1] ?? null) : null;


// Runaway guard while paused: the render window may grow this far so reading
// position survives heavy traffic, then snaps back to baseLimit on re-anchor.
const PAUSED_CAP = 1000;

// Jump-to-message (pinned panel): how far back scrollback() may page before
// giving up and telling the panel the target is too far back to jump to.
const JUMP_MAX_PAGES = 8;

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
}) {
  const { client } = useMatrixClient();
  const [events, setEvents] = useState<MatrixEvent[]>([]);
  const [reactions, setReactions] = useState<ReactionsMap>(() => new Map());
  const [edits, setEdits] = useState<EditsMap>(() => new Map());
  // rootId → replies, rebuilt once per refresh. Rows read their chip's count and
  // last-reply from this instead of each re-scanning the timeline.
  const [threads, setThreads] = useState<ThreadIndex>(() => new Map());
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
  const avatarSize = useSetting("chatStyle_mxLayout") === "compact" ? 12 : 14;
  const tick = useMinuteTick(tsFormat === "rel");
  const baseLimit = compact ? 100 : 200;
  const PAGE = 60;
  const [limit, setLimit] = useState(baseLimit);
  const [paginating, setPaginating] = useState(false);
  const [hitStart, setHitStart] = useState(false);
  const paginatingRef = useRef(false);
  // How many renderable events the SDK timeline already holds — lets
  // pagination widen the window over cached events before hitting the server.
  const eventsTotalRef = useRef(0);
  // Latest render-window size, read inside refresh() so widening `limit` doesn't
  // tear down and re-register all the timeline listeners (it just re-slices).
  const limitRef = useRef(limit);
  // Re-anchored: shrink the render window back to the live tail
  const handleAnchored = useCallback(() => setLimit(baseLimit), [baseLimit]);
  const {
    scrollRef,
    contentRef,
    anchored,
    anchoredRef,
    rendered,
    queued,
    captureAnchor,
    anchorToBottom,
    onScroll,
    pause,
  } = useAnchoredChat({ items: events, getKey: eventKey, onAnchored: handleAnchored });

  // Mark the room read when the newest message is on screen (Discord's rule).
  useReadReceipts({ client, room, newestEvent: events[events.length - 1] ?? null, anchored });

  // Fresh room → fresh pagination state (render-time adjust), anchored to the
  // bottom (effect — it touches the scroll engine's refs/DOM).
  const [paginationKey, setPaginationKey] = useState<string | null>(null);
  const nextPaginationKey = `${room.roomId}|${baseLimit}`;
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
  if (paginationKey !== nextPaginationKey) {
    setPaginationKey(nextPaginationKey);
    setLimit(baseLimit);
    setHitStart(false);
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

  useEffect(() => {
    anchorToBottom();
  }, [room, baseLimit, anchorToBottom]);

  const refresh = useCallback(() => {
    const all = room.getLiveTimeline().getEvents();
    const threadIndex = buildThreadIndex(room);
    // Thread replies first, so a deleted one is known for what it was (timelineRows.ts).
    for (const replies of threadIndex.values()) noteRelationIds(replies.map((r) => r.getId() ?? ""));
    const evs = all.filter((e) => isTimelineRow(room, e, { deleted: showDeleted }));
    // Reactions (m.annotation) + edits (m.replace) live in the same timeline;
    // recompute both each refresh so adds, redaction toggles, edits, and late
    // decrypts all land deterministically.
    setReactions(aggregateReactions(all, myUserId));
    setEdits(aggregateEdits(all));
    setThreads(threadIndex);
    eventsTotalRef.current = evs.length;
    // While paused the window must not slide — new arrivals would push the
    // rows being read out of it. Let it grow to the runaway cap instead;
    // re-anchoring resets the limit.
    const lim = limitRef.current;
    const cap = anchoredRef.current ? lim : Math.max(lim, PAUSED_CAP);
    setEvents(evs.slice(-cap));
  }, [room, anchoredRef, myUserId, showDeleted]);

  useEffect(() => {
    room.loadMembersIfNeeded().catch(() => {});
    // Microtask defer keeps refresh()'s setStates out of the effect pass.
    Promise.resolve().then(refresh);
    // Back-paginated encrypted events decrypt after they land — re-render then,
    // but only for decrypts in THIS room (the SDK event is client-wide).
    return subscribeRoomRefresh(room, client, refresh, { members: true });
  }, [room, client, refresh]);

  // Widening `limit` (pagination) only re-slices — no listener teardown.
  useEffect(() => {
    limitRef.current = limit;
    Promise.resolve().then(refresh);
  }, [limit, refresh]);

  const { handleReact, handleUnreact, handleDelete } = useRoomActions(client, room);

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

  // Scroll-to-top → fetch older events into the live timeline, then widen the
  // render window so they show. Anchor is captured AFTER scrollback resolves:
  // events arriving during the fetch don't change the rendered slice (the
  // window is still the old size), so the height only changes on the widen.
  const paginate = useCallback(async () => {
    if (paginatingRef.current || !client) return;
    // The SDK timeline already has more than the window shows (a previous
    // widen, or a room revisit) — just widen, no server round-trip.
    if (eventsTotalRef.current > limit) {
      captureAnchor();
      setLimit((l) => l + PAGE);
      return;
    }
    if (hitStart) return;
    paginatingRef.current = true;
    setPaginating(true);
    try {
      await client.scrollback(room, PAGE);
      if (!room.getLiveTimeline().getPaginationToken(Direction.Backward)) setHitStart(true);
      captureAnchor();
      setLimit((l) => l + PAGE);
    } catch (e) {
      console.warn("[Matrix] scrollback failed", e);
    } finally {
      paginatingRef.current = false;
      setPaginating(false);
    }
  }, [client, room, hitStart, limit, captureAnchor]);

  const unpinId = useCallback((id: string) => { void togglePin(id, true); }, [togglePin]);

  // Jump to a message (the pinned panel): page back until it is loaded
  // (bounded), widen the render window over it, pause the scroll engine so
  // the bottom lock lets go, then scroll to the row once it is rendered.
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const jumpToEvent = useCallback(async (id: string): Promise<boolean> => {
    if (!client) return false;
    // A multi-page jump can take a moment — show the same "Loading earlier
    // messages…" row scroll-to-top pagination uses, for its whole duration.
    setPaginating(true);
    try {
      let pages = 0;
      while (!room.findEventById(id) && pages < JUMP_MAX_PAGES) {
        if (!room.getLiveTimeline().getPaginationToken(Direction.Backward) || paginatingRef.current) break;
        paginatingRef.current = true;
        try {
          await client.scrollback(room, PAGE);
        } catch {
          break;
        } finally {
          paginatingRef.current = false;
        }
        pages++;
      }
    } finally {
      setPaginating(false);
    }
    const target = room.findEventById(id);
    if (!target || !isTimelineRow(room, target, { deleted: showDeleted })) return false;
    const all = room.getLiveTimeline().getEvents();
    const idx = all.findIndex((e) => e.getId() === id);
    const needed = all.length - idx; // an upper bound on the renderable events from it to the end
    setLimit((l) => Math.max(l, needed));
    pause();
    setHighlightId(id);
    return true;
  }, [client, room, pause, showDeleted]);

  // Scroll to the highlighted row once it exists, once per jump; drop the
  // highlight after a moment.
  const scrolledToRef = useRef<string | null>(null);
  useEffect(() => {
    if (!highlightId || scrolledToRef.current === highlightId) return;
    const el = scrollRef.current?.querySelector(`[data-event-id="${CSS.escape(highlightId)}"]`);
    if (!el) return;
    scrolledToRef.current = highlightId;
    el.scrollIntoView({ block: "center" });
  }, [highlightId, rendered, scrollRef]);
  useEffect(() => {
    if (!highlightId) return;
    const t = setTimeout(() => {
      // Clear the once-per-jump guard together with the highlight, so a
      // repeat jump to the SAME pin (after it already cleared) scrolls again
      // instead of silently no-oping on a stale scrolledToRef match.
      scrolledToRef.current = null;
      setHighlightId(null);
    }, 2000);
    return () => clearTimeout(t);
  }, [highlightId]);

  function handleScroll() {
    onScroll();
    const el = scrollRef.current;
    if (el && el.scrollTop < 60) paginate();
  }

  // Auto-fill: if the loaded timeline doesn't overflow the viewport there's
  // nothing to scroll, so scroll-to-top back-pagination can never fire and older
  // history looks "missing". Pull older messages until the panel is scrollable
  // (or we reach the start). Runs after each render that changes the content.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || hitStart || paginatingRef.current) return;
    if (el.scrollHeight <= el.clientHeight + 8) {
      const id = requestAnimationFrame(() => {
        const cur = scrollRef.current;
        if (cur && !hitStart && !paginatingRef.current && cur.scrollHeight <= cur.clientHeight + 8) {
          paginate();
        }
      });
      return () => cancelAnimationFrame(id);
    }
  }, [rendered, events, hitStart, paginate, scrollRef]);

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
      // Captured before the send, and only cleared once it succeeds — a failed
      // send restores the input (below) and must keep its pills too.
      const mentions = peekMentions();
      const content = buildMatrixMessage(body, emotes, replyCtx, mentions);
      await client.sendEvent(room.roomId, EventType.RoomMessage, content as TimelineEvents[EventType.RoomMessage]);
      clearMentions();
    } catch (err) {
      console.error("send failed", err);
      setInput(body);
    } finally {
      setSending(false);
    }
  }

  const dmRoomIds = getDmRoomIds(client);
  const isDM = !!dmPartner(room, myUserId, dmRoomIds);
  const label = roomLabel(room, myUserId, dmRoomIds);
  const encrypted = isEncryptedRoom(room);
  const topic = !compact
    ? (room.currentState
        .getStateEvents("m.room.topic")[0]
        ?.getContent()?.topic as string | undefined)
    : undefined;

  const replyToSender = replyTo
    ? senderLabel(getMemberDisplayName(room, replyTo.getSender() ?? ""), replyTo.getSender() ?? "").label
    : null;

  return (
    <div className={`flex flex-col min-h-0 ${compact ? "flex-1" : "h-full"}`}>
      <Bar slot="top" name="mx-header" center={
        <>
          {onBack && (
            <button onClick={onBack} aria-label="Back" className="text-secondary hover:text-strong text-sm px-1 shrink-0">
              ←
            </button>
          )}
          {onToggleDirectory && (
            <button
              onClick={onToggleDirectory}
              title={directoryOpen ? "Hide channels" : "Show channels"}
              className={`text-sm px-1 shrink-0 transition-colors ${
                directoryOpen ? "text-body" : "text-muted hover:text-strong"
              }`}
            >
              ☰
            </button>
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
          <button
            ref={bellRef}
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setBellAt(bellAt ? null : { x: r.left, y: r.bottom + 4 });
            }}
            title="Notification settings"
            aria-label="Notification settings"
            aria-expanded={!!bellAt}
            className={`shrink-0 px-1 transition-colors ${
              notifySetting === "all" ? "text-muted hover:text-strong" : "text-body"
            }`}
          >
            {notifySetting === "none"
              ? <BellSimpleSlash size={15} weight="fill" />
              : <BellSimple size={15} weight={notifySetting === "mentions" ? "fill" : "bold"} />}
          </button>
          <button
            onClick={() => setPinsOpen((o) => !o)}
            title="Pinned messages"
            aria-label={`${pinnedIds.length} pinned messages`}
            aria-expanded={pinsOpen}
            className={`shrink-0 px-1 transition-colors ${
              pinsOpen ? "text-body" : "text-muted hover:text-strong"
            }`}
          >
            <PushPin size={15} weight="bold" />
          </button>
          {onToggleThreads && (
            <button
              onClick={onToggleThreads}
              title={threadsOpen ? "Hide threads" : "Threads"}
              className={`shrink-0 px-1 transition-colors ${
                threadsOpen ? "text-body" : "text-muted hover:text-strong"
              }`}
            >
              <Chats size={15} weight="bold" />
            </button>
          )}
          {onToggleMembers && (
            <button
              onClick={onToggleMembers}
              title={membersOpen ? "Hide members" : "Show members"}
              className={`shrink-0 px-1 transition-colors ${
                membersOpen ? "text-body" : "text-muted hover:text-strong"
              }`}
            >
              <Users size={15} weight="bold" />
            </button>
          )}
        </>
      } />

      {isDM && client && (
        <EncryptionBanner room={room} client={client} myUserId={myUserId} />
      )}

      <div className="relative flex-1 min-h-0 flex flex-col">
        {/* Anchored: native scroll anchoring off — it would fight the bottom
            lock. Paused: on — it keeps the reading position stable through
            image loads and redactions above the viewport. */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          role="log"
          // `overscroll-y-contain`, NOT the bare `overscroll-contain`. This
          // scroller sits inside the mode-1 Matrix pager row
          // (MatrixView's inner wrapper) — a both-axes contain here would block
          // horizontal pans from chaining out to the pager exactly like
          // ChatSidebar's `.chat-scroll-layer` (see the comment there for the
          // full mechanism). `overscroll-y-contain` keeps vertical
          // containment and frees the horizontal axis to chain.
          className={`flex-1 overflow-y-auto overscroll-y-contain py-1 no-scrollbar ${
            anchored ? "[overflow-anchor:none]" : "[overflow-anchor:auto]"
          }`}
        >
          {/* Content wrapper — the scroll engine observes its size so font and
              image growth keep the view anchored */}
          <div ref={contentRef} className={`flex flex-col${typingText ? " pb-4" : ""}`}>
            {hitStart && events.length > 0 && (
              <p className="text-muted text-3xs text-center py-2">Beginning of conversation</p>
            )}
            {paginating && (
              <p className="text-muted text-3xs text-center py-1">Loading earlier messages…</p>
            )}
            {events.length === 0 && (
              <EmptyState className="text-center mt-8">
                {compact ? "No messages yet." : "No messages yet. Say something!"}
              </EmptyState>
            )}
            {client && (() => {
              // Per-row shape for the Community settings: grouped (no header),
              // the last row of a group (bubbles round it) and the stable
              // alternating stripe (mxRows.ts).
              const grouped = rendered.map((ev, i) => isContinuation(rendered[i - 1], ev) && i !== newIdx);
              const ends = groupEnds(rendered.length, (i) => !!grouped[i]);
              const alt = stripes(rendered);
              return rendered.map((ev, i) => {
                const prev = rendered[i - 1];
                return (
                  <Fragment key={ev.getId()}>
                    {startsNewDay(prev, ev) && <DayDivider ts={ev.getTs()} />}
                    {i === newIdx && <NewMessagesLine />}
                    <MatrixMessageRow
                      ev={ev}
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
                      grouped={grouped[i]}
                      groupEnd={ends[i]}
                      alt={alt[i]}
                      looks={looks}
                      avatarSize={avatarSize}
                      showEdited={showEdited}
                      pinned={pinnedIds.includes(ev.getId() ?? "")}
                      onTogglePin={mayPin && (pinnedIds.includes(ev.getId() ?? "") || pinnedIds.length < PIN_LIMIT) ? handleTogglePin : undefined}
                      highlighted={highlightId === ev.getId()}
                      mentioned={mentionsMe(ev.getContent() as Record<string, unknown>, edits.get(ev.getId() ?? "") ?? null, myUserId)}
                    />
                  </Fragment>
                );
              });
            })()}
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
              room={room}
            />
          </form>
        }
      />
    </div>
  );
}
