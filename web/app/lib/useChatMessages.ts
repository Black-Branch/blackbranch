"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMsg } from "./chatMsg";
import { useAnchoredChat } from "@/app/lib/useAnchoredChat";
import { useChatSocket, type ChatSocketEvent } from "@/app/lib/useChatSocket";
import { useBadges } from "@/app/lib/BadgesContext";
import { getJson, postJsonOrThrow, HttpError } from "@/app/lib/http";
import { pokeCoinHeartbeat } from "@/app/lib/useCoinHeartbeat";
import { useLocalStorageString } from "@/app/lib/useClientState";
import { useSetting } from "@/app/lib/useSetting";
import {
  cursorOf,
  cursorQuery,
  msgTs,
  seedRunCursor,
  type HistCursor,
} from "@/app/lib/historyCursor";
import {
  CHAT_LIVE_CAP,
  CHAT_SCROLLBACK_CAP,
  historyCaps,
  CHAT_HISTORY_PAGE,
} from "@/app/lib/chatCaps";
import { assignAlt, chatKey, isKeyable, newAltState, seedMessages } from "@/app/lib/chatSeed";
import { spotlightKeyOf, type SpotlightPick } from "@/app/lib/chatSpotlight";
import { publishAnnouncement } from "@/app/lib/dm/bus";

// Mod-only display preference (default OFF — see ModPanel.tsx's toggle): a mod
// deleting a message doesn't want to keep seeing it struck-out in their own
// view, but other mods reviewing moderation still want that transparency, so
// it's per-viewer rather than a site setting. Actual deletion/removal state is
// unaffected — this only controls whether a MOD's own client keeps the row.
export const MOD_SHOW_DELETED_LS_KEY = "modShowDeletedMessages";

// The row caps live in chatCaps.ts — the server pages read the live cap too.
// Bound the moderation-delete id set so it can't grow for the page's lifetime.
const DELETED_CAP = 2000;
// Safety-net flush delay (ms) for backgrounded tabs where requestAnimationFrame
// is throttled to ~0 — the WS keeps delivering, so we must still drain.
const FLUSH_FALLBACK_MS = 1000;

// chatKey / isKeyable / the stripe ordinal are shared with the server-seed path
// — see chatSeed.ts.

// Drop oldest entries from a Set (insertion-ordered) once it exceeds `max`.
function capSet(s: Set<string>, max: number) {
  if (s.size <= max) return;
  let over = s.size - max;
  for (const k of s) { s.delete(k); if (--over <= 0) break; }
}

// History rows carry an extra `cts` (full-precision created_at text) used only as
// the keyset cursor — never rendered, so it stays off the shared ChatMsg type.
// Cursor mechanics (msgTs/cursorOf/cursorQuery/seedRunCursor) live in
// historyCursor.ts so node --test can pin them without React in the graph.
type HistMsg = ChatMsg & { cts?: string };

// Live-chat message buffer + scroll engine for the chat sidebar. Owns the WS
// transport dispatch, the (platform,id) dedupe/merge, history pagination, the
// optimistic-then-reconciled vote, and the anchored-scroll integration.
// `onMessageReceived` fires once per incoming live message (drives the
// unseen-tab dot).
//
// `initialMessages` — the newest page of history, read by the SERVER page
// (loadChatHistory) so the rows are in the HTML before any script runs (the
// chat must not open empty). It seeds the buffer's first state and stands in
// for the mount-time DB fetch; the WS `history` frame still merges on top of
// it. A consumer that passes nothing keeps the mount-time fetch.
export function useChatMessages({
  isMod,
  onMessageReceived,
  onPin,
  initialMessages,
}: {
  isMod: boolean;
  /** Once per flushed batch of live messages (the Live unread dot); gets the batch
   *  so a caller can ignore hidden senders (⑤ Behavior). */
  onMessageReceived?: (batch: readonly ChatMsg[]) => void;
  onPin?: (pin: unknown) => void;
  initialMessages?: ChatMsg[];
}) {
  // Off by default: a mod purely wants to just remove messages without still
  // seeing them, but can opt in (per-viewer) to keep the struck-out copies.
  const [showDeletedLs] = useLocalStorageString(MOD_SHOW_DELETED_LS_KEY);
  const modShowsDeleted = isMod && showDeletedLs === "1";
  // The buffer's first state, computed ONCE: the server page's rows, with
  // stripe parity assigned by the same ordinal the live path then continues
  // (chatSeed.ts) — so the ordinal is created here, alongside the seed, and
  // handed to the ref below rather than read from it during render. A later
  // prop change (the server value never changes, but a re-render could pass
  // a new array) can neither re-seed nor re-trigger the fetch it replaced.
  const [seed] = useState(() => {
    const st = newAltState();
    // Seeded means ROWS arrived, not that the prop was passed: a page whose
    // history read failed hands down [] (its catch), and that page must keep
    // the client fetch — with stream-api freshly restarted there is no WS
    // history frame either, and the chat would sit empty for good.
    return { st, rows: seedMessages(initialMessages, st, CHAT_LIVE_CAP), seeded: (initialMessages?.length ?? 0) > 0 };
  });
  const altOrdinalRef = useRef(seed.st);
  const seededRef = useRef(seed.seeded);
  const [messages, setMessages] = useState<ChatMsg[]>(seed.rows);
  // Synchronous read of the latest committed messages — the `stickerMove`
  // handler needs to know (right away, not via a stale closure) whether the
  // boosted row is already the last one before deciding whether to animate a
  // move at all.
  const messagesRef = useRef<ChatMsg[]>(messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  const [connected, setConnected] = useState(false);
  // The streamer's highlighted message (chatSpotlight.ts) — the `spotlight`
  // frame, kept as it arrived; consumers compare rows against `spotlightKey` below.
  const [spotlight, setSpotlight] = useState<SpotlightPick>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const loadingHistoryRef = useRef(false);
  const historyDoneRef = useRef(false);
  // Keyset pagination cursor = the oldest row fetched so far, as the tuple the
  // server orders by: (created_at, platform, id). `beforeMs` is the first-page
  // fallback bound; `tsIso`/`platform`/`id` (present after the first page) drive
  // the full-precision keyset so every page strictly advances and no same-ms row
  // is skipped (a millisecond cursor would skip them). Kept in a ref, not the
  // rendered buffer, so a page of already-seen rows still advances it.
  //
  // The ref is only trustworthy WITHIN one scroll-back run — runActiveRef
  // marks a run, and loadOlder re-seeds the cursor whenever a new one starts
  // (the full run lifecycle lives on seedRunCursor's docstring).
  const cursorRef = useRef<HistCursor>({ beforeMs: Number.MAX_SAFE_INTEGER });
  const runActiveRef = useRef(false);
  const deletedIds = useRef<Set<string>>(new Set());
  // Incoming live frames are coalesced into one state update per animation
  // frame, so a burst of N messages causes ~1 render instead of N.
  const pendingRef = useRef<ChatMsg[]>([]);
  const flushScheduledRef = useRef(false);
  const rafIdRef = useRef<number | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onMessageReceivedRef = useRef(onMessageReceived);
  const onPinRef = useRef(onPin);
  // Instant badge push: a `badges_changed` frame nudges the badge map to refetch
  // (admin re-pointed the Supporter badge, or an entitlement changed) without
  // waiting out the 60s poll. Held in a ref so the socket handler stays stable.
  const refreshBadges = useBadges().refresh;
  const refreshBadgesRef = useRef(refreshBadges);
  // Behavior › Chat history length (per-device): swaps the cap
  // NUMBERS only — the anchored/unanchored split in the callbacks below never
  // forks (trimming while scrolled back yanks rows out from under the reader).
  // A live ref, so the stable socket/merge callbacks read the current caps
  // without dep churn; written post-commit like the callback refs.
  // useSetting (scope-aware): the /chat window keeps its own "ov:" copy.
  const histLengthLs = useSetting("chatStyle_histLength");
  const capsRef = useRef({ live: CHAT_LIVE_CAP, scrollback: CHAT_SCROLLBACK_CAP });
  // Latest-callback refs, written post-commit (not during render) so the stable
  // socket handlers always see the current props.
  useEffect(() => {
    onMessageReceivedRef.current = onMessageReceived;
    onPinRef.current = onPin;
    refreshBadgesRef.current = refreshBadges;
    capsRef.current = historyCaps(histLengthLs);
  });

  // Re-anchored (pill, gesture, or own message): shed scrollback so memory
  // stays bounded, and re-arm history loading (trimmed rows can simply be
  // refetched). Ending the run makes the next loadOlder re-seed its cursor
  // from the on-screen oldest row (see seedRunCursor).
  const handleAnchored = useCallback(() => {
    historyDoneRef.current = false;
    runActiveRef.current = false;
    setMessages((prev) => (prev.length > capsRef.current.live ? prev.slice(-capsRef.current.live) : prev));
  }, []);

  const {
    scrollRef,
    contentRef,
    anchored,
    anchoredRef,
    rendered,
    queued,
    captureAnchor,
    anchorToBottom,
    reassertBottom,
    onScroll,
    pause,
  } = useAnchoredChat({ items: messages, getKey: chatKey, onAnchored: handleAnchored });

  // Union new messages into the list by the (platform, id) dedupe key. Both
  // the WS history event and the initial DB fetch land here — whichever
  // arrives second fills the other's gaps. Vote fields are overlaid onto
  // already-present rows (the WS buffer copy may lack the DB's score/myVote).
  // Alternating-row stripe parity — the stable ordinal in chatSeed.ts (its
  // header says why it is an ordinal and not list position).
  const withAlt = useCallback((m: ChatMsg): ChatMsg => assignAlt(altOrdinalRef.current, m), []);

  const mergeMessages = useCallback((incoming: ChatMsg[]) => {
    setMessages((prev) => {
      // Same guard as the live `message` handler: drop unkeyable frames here too so a
      // history replay can't resurrect a row the live path refused (e.g. a store-failed
      // broadcast).
      incoming = incoming.filter(isKeyable);
      const incomingByKey = new Map(incoming.map((m) => [chatKey(m), m]));
      const isDel = (m: ChatMsg) => !!m.deleted || deletedIds.current.has(chatKey(m));
      let changed = false;
      // Overlay vote totals AND the mod-deletion flag onto rows already present
      // (a deletion may have landed while the row was offscreen / since reconnect).
      const updated = prev.map((m) => {
        const inc = incomingByKey.get(chatKey(m));
        let nm = m;
        if ((isDel(m) || (inc != null && isDel(inc))) && !nm.deleted) {
          nm = { ...nm, deleted: true }; changed = true;
        }
        if (inc && inc.score !== undefined &&
            ((nm.score ?? 0) !== inc.score || (nm.myVote ?? null) !== (inc.myVote ?? null))) {
          nm = { ...nm, score: inc.score, myVote: inc.myVote ?? nm.myVote ?? null };
          changed = true;
        }
        return nm;
      });
      const seen = new Set(prev.map(chatKey));
      const add = incoming
        .filter((m) => !seen.has(chatKey(m)))
        .map((m) => (isDel(m) ? { ...withAlt(m), deleted: true } : withAlt(m)));
      let next = add.length ? [...updated, ...add].sort((a, b) => msgTs(a) - msgTs(b)) : updated;
      // Non-mods never see deleted content; mods keep it struck-out only when
      // they've opted into that view (modShowsDeleted, off by default).
      if (!modShowsDeleted) {
        const filtered = next.filter((m) => !m.deleted);
        if (filtered.length !== next.length) { next = filtered; changed = true; }
      }
      if (!changed && add.length === 0) return prev;
      const cap = anchoredRef.current ? capsRef.current.live : capsRef.current.scrollback;
      return next.length > cap ? next.slice(-cap) : next;
    });
  }, [anchoredRef, modShowsDeleted, withAlt]);

  // Drain the buffered live frames into one state update. Cancels whichever of the
  // rAF / timeout siblings didn't fire. Safe to call eagerly (e.g. on refocus).
  const flushPending = useCallback(() => {
    if (rafIdRef.current != null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafIdRef.current);
    if (flushTimerRef.current != null) clearTimeout(flushTimerRef.current);
    rafIdRef.current = null;
    flushTimerRef.current = null;
    flushScheduledRef.current = false;
    const batch = pendingRef.current;
    if (batch.length === 0) return;
    pendingRef.current = [];
    onMessageReceivedRef.current?.(batch);
    setMessages((prev) => {
      const next = prev.concat(batch.map(withAlt));
      // Only trim from the front when anchored — while the user reads scrollback,
      // trimming would yank rows out from under them. The scrollback cap is the guard.
      const cap = anchoredRef.current ? capsRef.current.live : capsRef.current.scrollback;
      return next.length > cap ? next.slice(-cap) : next;
    });
  }, [anchoredRef, withAlt]);

  // Schedule a flush on the next frame for snappy coalescing when visible, with a
  // setTimeout safety-net so a backgrounded tab (rAF throttled to ~0, WS still
  // delivering) still drains. First to fire wins; the buffer is capped on push so
  // memory stays bounded between flushes regardless.
  const scheduleFlush = useCallback(() => {
    if (flushScheduledRef.current) return;
    flushScheduledRef.current = true;
    if (typeof requestAnimationFrame === "function") rafIdRef.current = requestAnimationFrame(flushPending);
    flushTimerRef.current = setTimeout(flushPending, FLUSH_FALLBACK_MS);
  }, [flushPending]);

  // WebSocket with reconnect — transport in useChatSocket, dispatch here
  const onSocketEvent = useCallback((data: ChatSocketEvent) => {
    if (data.type === "history") {
      // Merged, not replaced: the initial DB fetch may already have filled
      // the list (deleted messages are filtered inside the merge)
      mergeMessages(data.messages.slice(-capsRef.current.live));
    } else if (data.type === "message") {
      const m: ChatMsg = data;
      // Defensive: our own server builds these, but a malformed frame must not poison
      // the buffer — chatKey/dedupe/render all assume platform + id are present.
      if (!isKeyable(m)) return;
      // Buffer the frame; flush coalesces a burst into ~1 render. Cap the buffer so
      // a backgrounded tab (rAF throttled, WS still delivering) can't accumulate
      // unbounded — keep only the last scrollback-cap's worth.
      const buf = pendingRef.current;
      buf.push({ ...m, _anim: true });
      const sb = capsRef.current.scrollback;
      if (buf.length > sb) buf.splice(0, buf.length - sb);
      scheduleFlush();
    } else if (data.type === "stickerMove") {
      // A sticker boost updates its ONE row in place and re-sorts it to the
      // bottom (stream-api) — never a second row, never removed+recreated.
      // The array reorder happens atomically, in one state update; the ROW
      // ITSELF (same React key, same component instance) detects the
      // resulting position change and animates a genuine FLIP slide (see
      // ChatMessage.tsx's `_justMoved` handling) — smoother than a fade
      // out/in pair, which still reads as two disconnected pops. If the row
      // is already last, there's nothing to move; it just grows in place.
      const m: ChatMsg = data;
      if (!isKeyable(m)) return;
      const key = chatKey(m);
      pendingRef.current = pendingRef.current.filter((b) => chatKey(b) !== key);
      const cur = messagesRef.current;
      const idx = cur.findIndex((p) => chatKey(p) === key);
      const curEntry = idx === -1 ? undefined : cur[idx];
      if (idx === -1 || !curEntry) {
        pendingRef.current.push({ ...m, _anim: true });
        scheduleFlush();
        return;
      }
      const prevBoostCoins = curEntry.boostCoins;
      setMessages((prev) => {
        const i = prev.findIndex((p) => chatKey(p) === key);
        if (i === -1) return prev;
        const updated: ChatMsg = { ...prev[i], ...m, _prevBoostCoins: prevBoostCoins, _justMoved: i !== prev.length - 1 };
        if (i === prev.length - 1) {
          const next = prev.slice();
          next[i] = updated;
          return next;
        }
        const without = prev.slice(0, i).concat(prev.slice(i + 1));
        return without.concat([updated]);
      });
    } else if (data.type === "vote") {
      setMessages((prev) =>
        prev.map((m) =>
          m.platform === data.platform && String(m.id) === String(data.messageId)
            ? { ...m, score: data.score }
            : m
        )
      );
    } else if (data.type === "pin") {
      // Pin state lives in the component (drives PinnedBanner) — forward it.
      onPinRef.current?.(data.pin);
    } else if (data.type === "delete") {
      deletedIds.current.add(`${data.platform}:${data.messageId}`);
      capSet(deletedIds.current, DELETED_CAP);
      // A mod who's opted into seeing deleted content keeps it struck-out
      // (moderation transparency); everyone else has it removed outright.
      setMessages((prev) => {
        // String() both sides like the vote/purge branches — ChatMsg.id and the
        // wire id are both string|number, and every producer normalizing to
        // number today is a convention, not a contract.
        const hit = (m: ChatMsg) => String(m.id) === String(data.messageId) && m.platform === data.platform;
        return modShowsDeleted
          ? prev.map((m) => (hit(m) ? { ...m, deleted: true } : m))
          : prev.filter((m) => !hit(m));
      });
    } else if (data.type === "purge") {
      // Bulk delete (mod purged a user) — one frame, same semantics as `delete`
      // per item: an opted-in mod keeps struck-out copies, everyone else loses them.
      const items = (Array.isArray(data.ids) ? data.ids : []).filter(isKeyable);
      if (items.length > 0) {
        const keys = new Set(items.map((it) => `${it.platform}:${String(it.id)}`));
        for (const k of keys) deletedIds.current.add(k);
        capSet(deletedIds.current, DELETED_CAP);
        setMessages((prev) => {
          const hit = (m: ChatMsg) => keys.has(`${m.platform}:${String(m.id)}`);
          return modShowsDeleted
            ? prev.map((m) => (hit(m) ? { ...m, deleted: true } : m))
            : prev.filter((m) => !hit(m));
        });
      }
    } else if (data.type === "pollUpdate" || data.type === "pollEnd") {
      // Live poll tallies/state: swap the payload into the poll card in place
      // (same in-place-update pattern as the `vote` frame). The pending buffer
      // is untouched — a card still waiting to flush carries its own snapshot.
      const p = data.poll;
      if (p && p.pollId != null) {
        setMessages((prev) =>
          prev.map((m) =>
            m.system === "poll" && m.poll?.pollId === p.pollId ? { ...m, poll: p } : m
          )
        );
      }
    } else if (data.type === "chat_settings") {
      // Native chat settings changed (slow mode). ChatInput lives in a different
      // subtree, so forward via the same window-event pattern the accounts panel
      // uses — it keeps the setting out of this hook's render state entirely.
      const s = Number(data.slowModeSeconds);
      if (Number.isFinite(s) && s >= 0) {
        window.dispatchEvent(
          new CustomEvent("bb:chat-settings", { detail: { slowModeSeconds: Math.round(s) } })
        );
      }
    } else if (data.type === "badges_changed") {
      // Instant badge refresh (admin re-pointed the Supporter badge, or an
      // entitlement changed) — refetch the badge map now instead of polling.
      refreshBadgesRef.current?.();
    } else if (data.type === "spotlight") {
      setSpotlight(data.spotlight);
    } else if (data.type === "announce") {
      // A mod's announcement goes to the DM feature's listeners (app/lib/dm/bus.ts). A DM nudge is
      // never on this public socket: the DM host asks for its own (app/lib/dm/nudgeBox.ts).
      if (typeof data.text === "string" && typeof data.id === "string") {
        publishAnnouncement({ id: data.id, text: data.text, by: typeof data.by === "string" ? data.by : "", at: Number(data.at) || Date.now() });
      }
    }
  }, [mergeMessages, scheduleFlush, modShowsDeleted]);

  useChatSocket(onSocketEvent, {
    onOpen: () => setConnected(true),
    onClose: () => setConnected(false),
  });

  // A backgrounded tab throttles rAF (and timers), so buffered frames may sit
  // undrained; flush immediately on return-to-visible so they land at once. Also
  // clear any pending timers on unmount.
  useEffect(() => {
    const onVis = () => { if (!document.hidden) flushPending(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      if (rafIdRef.current != null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafIdRef.current);
      if (flushTimerRef.current != null) clearTimeout(flushTimerRef.current);
    };
  }, [flushPending]);

  // Initial history fill from the DB — the WS buffer only holds the last
  // ~200 messages in memory and is empty right after a stream-api restart.
  // A SEEDED buffer already holds this page (the server read it), so the
  // fetch is skipped — except for a mod who keeps struck-out copies: the seed
  // carries no deleted rows (chatSeed.ts), so their page is fetched once more
  // to overlay them. At most one fetch per mount either way.
  const initialFetchedRef = useRef(false);
  useEffect(() => {
    if (seededRef.current && !modShowsDeleted) return;
    if (initialFetchedRef.current) return;
    initialFetchedRef.current = true;
    // Fetch exactly what the anchored buffer retains (the live cap), not more —
    // mergeMessages caps the anchored buffer to that newest slice, so a larger
    // page (was 100) just discarded its oldest rows. No cursor to seed
    // here: loadOlder re-seeds from the on-screen oldest row at the start of
    // every scroll-back run (seedRunCursor), including the first.
    getJson<{ messages?: HistMsg[] }>(`/api/chat/history?before=${Date.now()}&limit=${capsRef.current.live}`)
      .then((d) => {
        const page = (d?.messages as HistMsg[]) ?? [];
        if (page.length > 0) mergeMessages(page as ChatMsg[]);
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps -- initial fill, once per mount (the ref above guards it). mergeMessages is a useCallback with real deps, so listing it would re-fetch the whole history page every time one of those changes and merge a second copy of it
  }, [modShowsDeleted]);

  // Fetch the page of messages older than the cursor. The keyset cursor
  // (cursorRef) strictly advances every page even through dense single-user
  // bursts or same-timestamp ties, so it can never re-query the same window. A
  // page that returns no NEW visible rows but reports more history auto-continues
  // (bounded) so the user never sees the loader stop with nothing added.
  const loadOlder = useCallback(async () => {
    if (loadingHistoryRef.current || historyDoneRef.current || messages.length === 0) return;
    loadingHistoryRef.current = true;
    setLoadingHistory(true);
    // New run (first scroll-up since mount or the last re-anchor): re-seed the
    // cursor from the oldest row actually on screen (see seedRunCursor).
    if (!runActiveRef.current) {
      const seeded = seedRunCursor(messages[0] as HistMsg);
      if (seeded) cursorRef.current = seeded;
      runActiveRef.current = true;
    }
    try {
      for (let attempt = 0; attempt < 6; attempt++) {
        const res = await fetch(
          `/api/chat/history?${cursorQuery(cursorRef.current)}&limit=${CHAT_HISTORY_PAGE}`
        );
        if (!res.ok) break;
        const d = await res.json();
        const page = (d.messages as HistMsg[]) ?? [];
        const first = page[0];
        if (page.length === 0 || !first) { historyDoneRef.current = true; break; }
        // Advance the keyset cursor past this page (oldest-first → [0] is oldest)
        // regardless of how many rows are new — strict keyset guarantees forward
        // progress, so a fully-seen page can't re-query the same window.
        cursorRef.current = cursorOf(first);
        if (!d.hasMore) historyDoneRef.current = true;

        const seen = new Set(messages.map((m) => `${m.platform}:${m.id}`));
        const older = page.filter(
          (m) => !seen.has(`${m.platform}:${m.id}`) && !deletedIds.current.has(`${m.platform}:${m.id}`)
        );
        if (older.length > 0) {
          captureAnchor();
          // Bound the scroll-back buffer so memory/DOM stay capped even on a
          // long scroll up.
          const sb = capsRef.current.scrollback;
          setMessages((prev) => {
            const merged = [...older, ...prev];
            return merged.length > sb ? merged.slice(0, sb) : merged;
          });
          if (messages.length + older.length >= sb) historyDoneRef.current = true;
          break;
        }
        // No new visible rows but more history exists — loop to skip the
        // duplicate/boundary window. historyDoneRef stops us when exhausted.
        if (historyDoneRef.current) break;
      }
    } catch {
      // network hiccup — next scroll-to-top retries
    } finally {
      loadingHistoryRef.current = false;
      setLoadingHistory(false);
    }
  }, [messages, captureAnchor]);

  // History loads only while PAUSED. While anchored, a near-top scroll event is
  // layout noise (onScroll snaps it straight back to bottom) — reacting to it
  // fetched a wasted 50-row page on every fresh load (observed: an extra page
  // during initial layout, +62% mounted rows before any interaction). It would
  // also start a pagination "run" while the anchored cap keeps trimming the
  // buffer's front, which is exactly the stale-cursor state the run re-seed
  // exists to prevent. Every human scroll-up unanchors before it can reach the
  // top (wheel-up pauses immediately; touch/pointer gestures pause via
  // onScroll's state machine), so no real gesture is lost by the gate.
  const handleScroll = useCallback(() => {
    onScroll();
    const el = scrollRef.current;
    if (el && el.scrollTop < 60 && !anchoredRef.current) loadOlder();
  }, [onScroll, scrollRef, anchoredRef, loadOlder]);

  // Per-message vote request epoch. Rapid up/down toggling fires overlapping
  // POSTs whose responses can arrive OUT OF ORDER — without this guard a stale
  // response's authoritative { score, myVote } would clobber a newer one, leaving
  // the button desynced (it thinks you've up-voted when the server has cleared it,
  // so the next click sends the wrong toggle) until a refresh reloads authoritative
  // state. The WS "vote" frame only corrects `score`, never `myVote`, so nothing
  // else heals this. We stamp each vote with a seq and apply only the latest.
  const voteSeq = useRef<Map<string, number>>(new Map());

  // Optimistic vote: bump the score locally, then reconcile with the server
  // total (the WS "vote" broadcast also corrects everyone's score).
  const handleVote = useCallback(async (msg: ChatMsg, vote: 1 | -1 | 0) => {
    const key = `${msg.platform}:${msg.id}`;
    const seq = (voteSeq.current.get(key) ?? 0) + 1;
    voteSeq.current.set(key, seq);
    const stale = () => voteSeq.current.get(key) !== seq; // a newer vote superseded us
    const prevVote = msg.myVote ?? 0;
    // Optimistic update computed from LIVE state each call, so the score
    // transitions toward the target rather than applying a captured delta —
    // re-applying is a no-op, so rapid clicks can't drift the running score.
    const setVoteState = (target: number) =>
      setMessages((prev) =>
        prev.map((m) => {
          if (m.platform !== msg.platform || m.id !== msg.id) return m;
          const d = target - (m.myVote ?? 0);
          return { ...m, score: (m.score ?? 0) + d, myVote: target === 0 ? null : target };
        })
      );
    setVoteState(vote);
    try {
      const d = await postJsonOrThrow<{ score: number; myVote: number | null }>(
        "/api/chat/vote",
        { platform: msg.platform, messageId: msg.id, vote }
      );
      // Casting a vote earns, and the route awards forgetfully — the response
      // cannot carry it. Poked here rather than after the stale() guard below:
      // a superseded click still cast a vote that may have paid, and the chip
      // is about the wallet, not about which render won.
      pokeCoinHeartbeat();
      // Only the latest in-flight vote for this message may write authoritative
      // state — a stale response arriving late must not overwrite a newer click.
      if (stale()) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.platform === msg.platform && m.id === msg.id
            ? { ...m, score: d.score, myVote: d.myVote }
            : m
        )
      );
    } catch (e) {
      if (stale()) return; // a newer click owns the state now; don't revert it
      setVoteState(prevVote); // revert toward the pre-click vote
      // A REFUSAL MUST BE VISIBLE. The vote clamp (2 per target per 30s)
      // returns 429 and the revert above silently undoes the click — so a
      // rate-limited viewer would see the arrow bounce back and nothing else,
      // which reads as a broken button rather than a rule. There is no toast
      // system, and the app's own convention is to surface errors in place —
      // AutomodHoldBar does the same — so this marks the row and the vote
      // control explains itself.
      if (e instanceof HttpError && e.status === 429) {
        const mark = (on: boolean) =>
          setMessages((prev) =>
            prev.map((m) =>
              m.platform === msg.platform && m.id === msg.id ? { ...m, _voteCooling: on } : m
            )
          );
        mark(true);
        // Long enough to read, far shorter than the 30s window — this says
        // "that didn't count", not "the wait is over".
        setTimeout(() => mark(false), 4000);
      }
    }
  }, []);

  const spotlightKey = spotlightKeyOf(spotlight);

  return {
    messages,
    connected,
    loadingHistory,
    handleVote,
    // scroll engine
    scrollRef,
    contentRef,
    anchored,
    rendered,
    queued,
    anchorToBottom,
    reassertBottom,
    handleScroll,
    // The engine's programmatic pause — the scroll keys need it (chatScrollKeys).
    pause,
    // The streamer's highlighted message as the buffer's `platform:id` key, or null.
    spotlightKey,
  };
}
