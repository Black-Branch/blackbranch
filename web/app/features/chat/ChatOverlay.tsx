"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { useEmotes, type EmoteMap } from "@/app/lib/useEmotes";
import { useChatDirectory } from "@/app/lib/useChatDirectory";
import { useOutsideClick } from "@/app/lib/useOutsideClick";
import { useChatSocket, type ChatSocketEvent } from "@/app/lib/useChatSocket";
import { useSetting } from "@/app/lib/useSetting";
import { spotlightKeyOf, type SpotlightPick } from "@/app/lib/chatSpotlight";
import { mergeOverlayHistory, seedOverlayRows } from "@/app/lib/chatOverlaySeed";
import { CHAT_OVERLAY_CAP } from "@/app/lib/chatCaps";
import { ScrollBottomBeforeHydration } from "@/app/components/ScrollBottomBeforeHydration";
import ChatMessage from "./ChatMessage";
import type { ChatMsg } from "@/app/lib/chatMsg";
import UserCard from "@/app/components/UserCard";
import { USER_CARD_H, clampCardLeft } from "@/app/lib/userCardLayout";
import { useChatBgContrastRef } from "@/app/lib/useChatBgContrastRef";
import { OverlaySettingsPanel } from "./OverlaySettingsPanel";

const MAX_MESSAGES = CHAT_OVERLAY_CAP;

function positionCard(el: HTMLElement): { x: number; y: number; above: boolean } {
  const r = el.getBoundingClientRect();
  const above = r.bottom + USER_CARD_H > window.innerHeight && r.top > USER_CARD_H;
  const x = clampCardLeft(r.left, window.innerWidth);
  const y = above ? r.top : r.bottom + 4;
  return { x, y, above };
}

export default function ChatOverlay({ scaleFactor = 1.5, initialMessages, initialEmotes }: {
  scaleFactor?: number;
  /** The newest rows, read by app/overlay/chat/page.tsx so they are in the
   *  HTML before hydration (chatOverlaySeed.ts). */
  initialMessages?: ChatMsg[];
  /** The emotes those rows use, so they render as <img>s at SSR (useEmotes). */
  initialEmotes?: EmoteMap;
}) {
  const [messages, setMessages] = useState<ChatMsg[]>(() => seedOverlayRows(initialMessages));
  const [isMod, setIsMod] = useState(false);
  // The broadcaster's highlighted message (chatSpotlight.ts) — shown on stream like everywhere.
  const [spotlight, setSpotlight] = useState<SpotlightPick>(null);
  const spotlightKey = spotlightKeyOf(spotlight);
  const [card, setCard] = useState<{ msg: ChatMsg; x: number; y: number; above: boolean } | null>(null);
  // Keep username readability-clamp pointed at the resolved chat-panel background.
  useChatBgContrastRef();
  // "Animated emotes" off — the overlay's own "ov:" scoped copy
  // (settingGet lazily seeds it from the site value on first read), read once
  // here and passed down as ChatMessage's stillEmotes prop.
  const stillEmotes = useSetting("chatStyle_animEmotes") === "0";
  const emotes = useEmotes(initialEmotes);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // Scale entire overlay via root font-size
  useEffect(() => {
    const prevBody = document.body.style.background;
    // globals.css sets an opaque `html { background-color }` (a mobile-keyboard
    // white-flash fix) that this body-only override never reached — OBS was
    // capturing that opaque color instead of transparency. Clear both.
    const prevHtml = document.documentElement.style.backgroundColor;
    document.body.style.background = "transparent";
    document.documentElement.style.backgroundColor = "transparent";
    document.documentElement.style.fontSize = `${scaleFactor * 16}px`;
    return () => {
      document.body.style.background = prevBody;
      document.documentElement.style.backgroundColor = prevHtml;
      document.documentElement.style.fontSize = "";
    };
  }, [scaleFactor]);

  useEffect(() => {
    fetch("/api/me").then(r => r.json()).then(d => { if (d?.isMod) setIsMod(true); }).catch(() => {});
  }, []);

  useOutsideClick(cardRef, () => setCard(null), { enabled: !!card, touch: false });

  function openCard(msg: ChatMsg, el: HTMLElement) {
    const pos = positionCard(el);
    setCard({ msg, ...pos });
  }

  const onSocketEvent = useCallback((data: ChatSocketEvent) => {
    // Overlay is shown on stream — deleted messages are removed for everyone,
    // unconditionally. Live deletes drop via the "delete" branch below; the
    // history/reconnect buffer can still carry deleted:true rows, so the merge
    // drops them. Poll cards never enter: the dedicated /overlay/poll browser
    // source owns on-stream polls, and this overlay never receives pollUpdate
    // frames (the card would freeze at its starting tallies). MERGED, not
    // replaced: the buffer may already hold the server page's rows, and after
    // a stream-api restart this frame is empty (chatOverlaySeed.ts).
    if (data.type === "history") {
      setMessages((prev) => mergeOverlayHistory(prev, data.messages));
    } else if (data.type === "spotlight") {
      setSpotlight(data.spotlight);
    } else if (data.type === "message") {
      if (data.system === "poll") return;
      setMessages(prev => { const n = [...prev, { ...data, _anim: true }]; return n.length > MAX_MESSAGES ? n.slice(-MAX_MESSAGES) : n; });
    } else if (data.type === "vote") {
      setMessages(prev => prev.map(m =>
        m.platform === data.platform && String(m.id) === String(data.messageId)
          ? { ...m, score: data.score }
          : m
      ));
    } else if (data.type === "delete") {
      // String() both sides: the wire id and ChatMsg.id are each string|number.
      setMessages(prev => prev.filter(m => !(String(m.id) === String(data.messageId) && m.platform === data.platform)));
    } else if (data.type === "purge") {
      // Bulk delete (a mod purged a user). The overlay previously ignored this
      // frame entirely, so a purged user's messages stayed on the BROADCAST while
      // the mod panel reported success and the website chat cleared — moderation
      // visibly failing on the one surface the audience actually sees.
      //
      // Unlike useChatMessages there is no "mods keep struck-out copies" mode here:
      // the overlay is the public stream, so purged rows are always removed.
      const items = (Array.isArray(data.ids) ? data.ids : [])
        .filter((it) => it && typeof it.platform === "string" && it.id != null);
      if (items.length > 0) {
        const keys = new Set(items.map((it) => `${it.platform}:${String(it.id)}`));
        setMessages(prev => prev.filter(m => !keys.has(`${m.platform}:${String(m.id)}`)));
      }
    } else if (data.type === "stickerMove") {
      // Mirrors useChatMessages.ts's stickerMove reducer: reorder the boosted
      // row to the end in one state update and stamp _justMoved/_prevBoostCoins
      // so ChatMessage's existing FLIP/grow effects animate it — this overlay
      // has no pendingRef buffer to integrate with, so it applies directly.
      const m: ChatMsg = data;
      if (typeof m.platform !== "string" || m.id == null) return;
      setMessages(prev => {
        const i = prev.findIndex(p => p.platform === m.platform && String(p.id) === String(m.id));
        const cur = i === -1 ? undefined : prev[i];
        if (i === -1 || !cur) return prev; // e.g. boosted row already scrolled out of MAX_MESSAGES
        const updated: ChatMsg = { ...cur, ...m, _prevBoostCoins: cur.boostCoins, _justMoved: i !== prev.length - 1 };
        if (i === prev.length - 1) {
          const next = prev.slice();
          next[i] = updated;
          return next;
        }
        const without = prev.slice(0, i).concat(prev.slice(i + 1));
        return without.concat([updated]);
      });
    }
  }, []);

  // Mirrors ChatSidebar (:852): a socket drop with messages on screen freezes
  // the feed with no signal once the reconnect backoff reaches 30s — a dead
  // overlay and a quiet chat look identical without this.
  // Three states, not a boolean: "never" is the socket's initial not-yet-open
  // state on a fresh load — no pill. "down" is a real drop, after having been
  // up at least once — pill shown. "up" clears it. A bare `!connected` boolean
  // can't tell "never opened yet" from "just dropped", so every overlay load
  // flashed the pill until the first onOpen; this can't regress to that because
  // there is no boolean left to read bare.
  type Conn = "never" | "up" | "down";
  const [conn, setConn] = useState<Conn>("never");
  useChatSocket(onSocketEvent, {
    onOpen: () => setConn("up"),
    onClose: () => setConn((c) => (c === "never" ? "never" : "down")),
  });

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  // The overlay is permanently anchored to the newest message, but the
  // one-shot scroll above measures scrollHeight BEFORE emote/badge images
  // load — rows then grow (and text re-wraps around the now-wider emotes),
  // pushing the newest message half below the fold. Worst on refresh, when
  // every history row's emotes load at once; also fires on sticker boosts.
  // Same technique as useAnchoredChat: re-assert the bottom whenever the
  // scroller or its content resizes. RO callbacks run after layout and
  // before paint, so the correction never flickers.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const assertBottom = () => { el.scrollTop = el.scrollHeight; };
    const ro = new ResizeObserver(assertBottom);
    ro.observe(el);
    if (contentRef.current) ro.observe(contentRef.current);
    return () => ro.disconnect();
  }, []);

  // The OBS overlay has no viewer identity, so there is no "you were tagged"
  // highlight here — but an @name must still render in that person's colour, or
  // the same chat looks different on stream than it does on the site.
  const { directory } = useChatDirectory(messages);

  return (
    <>
      {/* overflow-x-clip for the same reason as the sidebar scroller: an
          oversized sticker must not turn the OBS overlay into a horizontal
          scroller. See the long note in ChatSidebar. overlay-host: the gear's
          hover/tap visibility (globals.css) keys off this ancestor. */}
      <div ref={scrollRef} className="overlay-host h-screen w-screen overflow-y-auto overflow-x-clip overscroll-contain flex flex-col bg-transparent">
        {/* Spacer — pushes messages to bottom when few; shrinks to 0 when messages overflow */}
        <div className="flex-1" />
        <div ref={contentRef} className="pb-3 flex flex-col">
          {messages.map((msg, i) => (
            <ChatMessage
              firstTag={false}
              key={`${msg.platform}-${msg.id}`}
              msg={msg}
              emotes={emotes}
              compact={i > 0 && messages[i - 1]?.username === msg.username && messages[i - 1]?.platform === msg.platform}
              stillEmotes={stillEmotes}
              onUsernameClick={isMod ? openCard : undefined}
              directory={directory}
              spotlight={spotlightKey !== null && spotlightKey === `${msg.platform}:${msg.id}`}
            />
          ))}
        </div>
        {/* Settings — kept reachable at the top-right, showing only
            on hover (or OBS's Interact window) or a touch tap.
            Nested INSIDE the overlay-host div (rather than a sibling) so
            globals.css's `.overlay-host:hover .overlay-gear` descendant rule
            can reach it — `position: fixed` keeps it anchored to the viewport
            regardless of this nesting, the same as the reconnect pill below. */}
        <OverlaySettingsPanel page="obs" scaleFactor={scaleFactor} />
      </div>
      {/* Directly after the scroller — it targets its previous sibling. */}
      {initialMessages && initialMessages.length > 0 && <ScrollBottomBeforeHydration />}
      {/* Sibling of the scroller, not a child: the pill exists for exactly the
          outage where the feed keeps growing, so it must not scroll away with it. */}
      {conn === "down" && (
        <div
          role="status"
          className="fixed top-2 left-1/2 -translate-x-1/2 z-10 rounded-full border border-edge bg-surface-2 px-3 py-1 text-xs text-body-dim"
        >
          Reconnecting to chat…
        </div>
      )}

      {card && typeof document !== "undefined" && createPortal(
        <div ref={cardRef} className="fixed z-(--z-float)"
          style={{ left: card.x, top: card.y, transform: card.above ? "translateY(-100%)" : "none" }}>
          <UserCard msg={card.msg} isMod={isMod} onClose={() => setCard(null)} />
        </div>,
        document.body
      )}
    </>
  );
}
