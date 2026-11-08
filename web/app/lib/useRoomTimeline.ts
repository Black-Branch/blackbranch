"use client";

// ONE room-timeline engine, shared by the community timeline (features/community/Timeline.tsx)
// and the DM window (features/dm/DmConversation.tsx) — client polish Task 11, extracted from
// MatrixTimeline with no change in behaviour:
//
// - the render window over the live timeline (`limit`, widened by scroll-back, snapped back to
//   the base on re-anchor) and the anchored-scroll engine (useAnchoredChat) under it;
// - reactions, edits and the thread index read from the RAW timeline, the rows filtered by the
//   one renderability rule (timelineRows.ts);
// - scroll-back at the top, the auto-fill that pages until the list can scroll, and the jump to
//   a message (pinned panel, reply quote) with its highlight;
// - the grouping flags (messageGrouping.ts), and
// - ONE loading phase (dm-crypto-research D, k's item 12): opening a DM ran five message-area
//   states in 235 ms. `phase` is "loading" until the first read of the room, the auto-fill and
//   any row still being decrypted are done (bounded by LOADING_CEILING_MS), then "ready" for the
//   rest of the room's life — TimelineBody shows the skeleton for the first, the rows for the
//   second, and nothing in between.
//
// The SDK is a value import here (Direction): this module is reached only behind a dynamic
// boundary (MatrixPanel's, and the DM window's DmConversation).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Direction } from "matrix-js-sdk";
import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";
import { aggregateReactions, type ReactionsMap } from "./matrixReactions";
import { aggregateEdits, type EditsMap } from "./matrixEdits";
import { buildThreadIndex, type ThreadIndex } from "./matrixThreads";
import { subscribeRoomRefresh } from "./matrixRoomEvents";
import { isTimelineRow, noteRelationIds } from "./timelineRows";
import { isContinuation, startsNewDay } from "./messageGrouping";
import { useAnchoredChat } from "./useAnchoredChat";
import { eventKey, MATRIX_ROWS } from "./useRoomActions";

// Runaway guard while paused: the render window may grow this far so reading
// position survives heavy traffic, then snaps back to baseLimit on re-anchor.
const PAUSED_CAP = 1000;

// Jump-to-message (pinned panel): how far back scrollback() may page before
// giving up and telling the panel the target is too far back to jump to.
const JUMP_MAX_PAGES = 8;

const PAGE = 60;

// The loading phase never outlives this: a decrypt that never resolves (no crypto in this
// browser) or a fill that never ends must not leave the skeleton up for good.
const LOADING_CEILING_MS = 3000;

/** A row whose decryption has not resolved yet (it renders as the lock row meanwhile). */
const decrypting = (e: MatrixEvent) => e.getType() === "m.room.encrypted" && !e.isDecryptionFailure();

export function useRoomTimeline(
  client: MatrixClient | null | undefined,
  room: Room,
  { showDeleted, myUserId, baseLimit = 100 }: { showDeleted: boolean; myUserId: string; baseLimit?: number },
) {
  const [events, setEvents] = useState<MatrixEvent[]>([]);
  const [reactions, setReactions] = useState<ReactionsMap>(() => new Map());
  const [edits, setEdits] = useState<EditsMap>(() => new Map());
  // rootId → replies, rebuilt once per refresh. Rows read their chip's count and
  // last-reply from this instead of each re-scanning the timeline.
  const [threads, setThreads] = useState<ThreadIndex>(() => new Map());
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
  } = useAnchoredChat({ items: events, getKey: eventKey, onAnchored: handleAnchored, anchorRows: MATRIX_ROWS });

  // Fresh room → fresh pagination state (render-time adjust), anchored to the
  // bottom (effect — it touches the scroll engine's refs/DOM).
  const [paginationKey, setPaginationKey] = useState<string | null>(null);
  if (paginationKey !== room.roomId) {
    setPaginationKey(room.roomId);
    setLimit(baseLimit);
    setHitStart(false);
  }
  // A width class change (the Community pane crossing 680 px: 100 ↔ 200 rows) is not a fresh
  // room: the reader keeps their place. A window still at the old base follows the new one;
  // a window widened by scroll-back keeps its rows.
  const [windowBase, setWindowBase] = useState(baseLimit);
  if (windowBase !== baseLimit) {
    setWindowBase(baseLimit);
    setLimit((l) => (l === windowBase ? baseLimit : Math.max(l, baseLimit)));
  }

  useEffect(() => {
    anchorToBottom();
  }, [room, anchorToBottom]);

  // The loading phase's terms, each keyed by the room it was true for, so a room switch starts
  // loading again without a reset.
  const [refreshedRoom, setRefreshedRoom] = useState<string | null>(null);
  const [overflowRoom, setOverflowRoom] = useState<string | null>(null);
  const [fillFailedRoom, setFillFailedRoom] = useState<string | null>(null);
  const [ceilingRoom, setCeilingRoom] = useState<string | null>(null);
  const [readyRoom, setReadyRoom] = useState<string | null>(null);

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
    setRefreshedRoom(room.roomId);
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

  useEffect(() => {
    const id = room.roomId;
    const t = setTimeout(() => setCeilingRoom(id), LOADING_CEILING_MS);
    return () => clearTimeout(t);
  }, [room.roomId]);

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
      // A fill that cannot page ends the loading phase: the rows there are shown.
      setFillFailedRoom(room.roomId);
    } finally {
      paginatingRef.current = false;
      setPaginating(false);
    }
  }, [client, room, hitStart, limit, captureAnchor]);

  // Jump to a message (the pinned panel, a reply quote): page back until it is
  // loaded (bounded), widen the render window over it, pause the scroll engine
  // so the bottom lock lets go, then scroll to the row once it is rendered.
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

  const handleScroll = useCallback(() => {
    onScroll();
    const el = scrollRef.current;
    if (el && el.scrollTop < 60) void paginate();
  }, [onScroll, paginate, scrollRef]);

  // Auto-fill: if the loaded timeline doesn't overflow the viewport there's
  // nothing to scroll, so scroll-to-top back-pagination can never fire and older
  // history looks "missing". Pull older messages until the panel is scrollable
  // (or we reach the start). Runs after each render that changes the content.
  // The first time the list overflows is also the end of the loading phase's fill.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || hitStart || paginatingRef.current) return;
    const roomId = room.roomId;
    const id = requestAnimationFrame(() => {
      const cur = scrollRef.current;
      if (!cur || paginatingRef.current) return;
      if (cur.scrollHeight <= cur.clientHeight + 8) void paginate();
      else setOverflowRoom(roomId);
    });
    return () => cancelAnimationFrame(id);
  }, [rendered, events, hitStart, paginate, scrollRef, room.roomId]);

  // The grouping flags (messageGrouping.ts, shared with the thread panel).
  const grouped = useMemo(() => rendered.map((ev, i) => isContinuation(rendered[i - 1], ev)), [rendered]);
  const newDay = useMemo(() => rendered.map((ev, i) => startsNewDay(rendered[i - 1], ev)), [rendered]);

  // ONE loading phase, computed here only. Ready latches for the room (render-time adjust): a
  // message arriving later — still being decrypted for a moment — never brings the skeleton back.
  const roomId = room.roomId;
  const settled =
    refreshedRoom === roomId &&
    (ceilingRoom === roomId ||
      ((hitStart || overflowRoom === roomId || fillFailedRoom === roomId) && !rendered.some(decrypting)));
  if (settled && readyRoom !== roomId) setReadyRoom(roomId);
  const phase: "loading" | "ready" = settled || readyRoom === roomId ? "ready" : "loading";

  return {
    /** Every row in the window (the newest is the one a read receipt marks). */
    events,
    /** What to render: the window, or the frozen slice while paused. */
    rendered,
    reactions,
    edits,
    threads,
    grouped,
    newDay,
    paginate,
    paginating,
    hitStart,
    jumpToEvent,
    highlightId,
    scrollRef,
    /** The content wrapper the scroll engine watches for growth. */
    contentRef,
    /** Attach to the scroller's onScroll: the engine, and scroll-back at the top. */
    onScroll: handleScroll,
    atBottom: anchored,
    paused: !anchored,
    /** Back to the newest line (the pill, an own send). */
    resume: anchorToBottom,
    /** Lines held back while paused (the pill's count). */
    queued,
    phase,
  };
}
