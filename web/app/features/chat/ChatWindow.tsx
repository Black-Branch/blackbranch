"use client";

import ModUndoToast from "@/app/components/ModUndoToast";
import { useMarkedPolling } from "@/app/lib/markedPeople";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEmotes, type EmoteMap } from "@/app/lib/useEmotes";
import { useChatMessages } from "@/app/lib/useChatMessages";
import { useChatPin } from "@/app/lib/useChatPin";
import { useSpotlightToggle } from "@/app/lib/useChatSpotlight";
import { chatKey } from "@/app/lib/chatSeed";
import { useChatRowDerivations } from "@/app/lib/useChatRowDerivations";
import { useOwnPublicIds } from "@/app/lib/ownIdentity";
import { useChatTakeover } from "@/app/lib/chatTakeover";
import { useOutsideClick } from "@/app/lib/useOutsideClick";
import { useChatBgContrastRef } from "@/app/lib/useChatBgContrastRef";
import { chatScrollKey, scrollChatByKey } from "@/app/lib/chatScrollKeys";
import { settingGet } from "@/app/lib/settingsRegistry";
import { useSetting, useMinuteTick } from "@/app/lib/useSetting";
import { useLocalStorageString } from "@/app/lib/useClientState";
import type { TsFormat } from "@/app/lib/chatTime";
import { getJson, postJson } from "@/app/lib/http";
import { noticeOnFailure } from "@/app/lib/chatNotice";
import { useChatNoticeText } from "@/app/lib/useChatNoticeText";
import { USER_CARD_H, clampCardLeft } from "@/app/lib/userCardLayout";
import type { ChatMsg } from "@/app/lib/chatMsg";
import { useShownMessages } from "@/app/lib/useShownMessages";
import { useBehaviorLists } from "@/app/lib/behaviorStore";
import { publishLiveDirectory } from "@/app/lib/liveDirectory";
import type { PinnedMessage } from "@/app/lib/pinnedMessage";
import UserCard from "@/app/components/UserCard";
import PinnedBanner from "@/app/components/PinnedBanner";
import EmptyState from "@/app/components/EmptyState";
import { PausedPill } from "@/app/components/PausedPill";
import ChatMessage from "./ChatMessage";
import ReplyPreview from "./ReplyPreview";
import { useReplyJump } from "@/app/lib/useReplyJump";
import { ScrollBottomBeforeHydration } from "@/app/components/ScrollBottomBeforeHydration";
import { OverlaySettingsPanel } from "./OverlaySettingsPanel";

// /chat — the broadcaster's own chat WINDOW. Not an OBS source: that is
// /overlay/chat (ChatOverlay), which follows the newest message unconditionally
// and keeps 60 rows, because a broadcast never scrolls up. A window does. This
// page runs on the site chat's engine — useChatMessages over useAnchoredChat —
// so scrolling up pauses the feed, the pill counts what arrived, the top of the
// list loads earlier history from the database, and votes, deletes, purges,
// pins and sticker boosts behave as they do in the site's chat column.
//
// What it keeps from the OBS source: ?scale= (the whole window through the
// root font-size), the isolated "ov:" settings keyspace with its gear, the
// user card on a username, and the TRANSPARENT canvas — the window may run in
// a browser with a transparency mod, where the browser paints the background
// and an opaque page would defeat it. What it has that the
// source does not: the pinned banner, PgUp/PgDn/Home/End on the document
// (there is no composer to catch them), and the reconnect pill only after the
// socket was up once.
//
// No composer: this is a reading window. Typing stays on the site.

type Me = { signedIn: boolean; isMod: boolean; isAdmin: boolean; matrixId: string | null; canonicalId: string | null };
const NOBODY: Me = { signedIn: false, isMod: false, isAdmin: false, matrixId: null, canonicalId: null };

function positionCard(el: HTMLElement): { x: number; y: number; above: boolean } {
  const r = el.getBoundingClientRect();
  const above = r.bottom + USER_CARD_H > window.innerHeight && r.top > USER_CARD_H;
  const x = clampCardLeft(r.left, window.innerWidth);
  const y = above ? r.top : r.bottom + 4;
  return { x, y, above };
}

export default function ChatWindow({ scaleFactor = 1.5, initialMessages, initialEmotes }: {
  scaleFactor?: number;
  /** The newest page of history, read by app/chat/page.tsx so the rows are in
   *  the HTML before hydration (useChatMessages seeds from it). */
  initialMessages?: ChatMsg[];
  /** The emotes those rows use, so they render as <img>s at SSR (useEmotes). */
  initialEmotes?: EmoteMap;
}) {
  const [me, setMe] = useState<Me>(NOBODY);
  const [card, setCard] = useState<{ msg: ChatMsg; x: number; y: number; above: boolean } | null>(null);
  const [showTimestamps, setShowTimestamps] = useState(false);
  const tsFormat = (useSetting("chatStyle_tsFormat") ?? "standard") as TsFormat;
  const tick = useMinuteTick(tsFormat === "rel");
  // "Animated emotes" off — read once here, passed down as
  // ChatMessage's stillEmotes prop rather than subscribed per-row.
  const stillEmotes = useSetting("chatStyle_animEmotes") === "0";
  // Behavior › Hide swear words — read once here and passed down, like stillEmotes.
  const maskSwears = useSetting("chatStyle_profanityFilter") === "1";
  const [showMatrixName, setShowMatrixName] = useState(false);
  // Your name colour is your ACCOUNT's, not part of this window's look: read the SITE's key
  // live (a pick in another tab lands at once) and refresh it from the account below. An
  // "ov:" copy seeded once and never refreshed would never see a colour changed on the site.
  const [ownColor, setOwnColorLs] = useLocalStorageString("chatUsernameColor");
  // Keep username readability-clamp pointed at the resolved chat-panel background.
  useChatBgContrastRef();
  const emotes = useEmotes(initialEmotes);
  const cardRef = useRef<HTMLDivElement>(null);

  // Scale the whole window via the root font-size, and clear the canvas the
  // same way the OBS source does: globals.css paints `html` opaque (a mobile
  // keyboard white-flash fix), so both html and body must be cleared or the
  // browser's transparency shows nothing.
  useEffect(() => {
    const prevBody = document.body.style.background;
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
    getJson<Partial<Me>>("/api/me")
      .then((d) => setMe({
        signedIn: !!d.signedIn,
        isMod: !!d.isMod,
        isAdmin: !!d.isAdmin,
        matrixId: d.matrixId ?? null,
        canonicalId: d.canonicalId ?? null,
      }))
      .catch(() => {});
  }, []);

  // The account's colour, for a window opened on a device where it was picked elsewhere.
  useEffect(() => {
    if (!me.signedIn) return;
    getJson<{ color?: string | null }>("/api/me/color").then((d) => {
      if (d.color) setOwnColorLs(d.color);
    }).catch(() => {});
  }, [me.signedIn, setOwnColorLs]);

  // The non-CSS row settings, read scope-aware (the "ov:" keyspace) once the
  // page-load hydrator has run. Live changes arrive from the panel through its
  // onShow*Change props below (the hydrated event fires once per load).
  useEffect(() => {
    const sync = () => {
      setShowTimestamps(settingGet("showTimestamps") === "true");
      setShowMatrixName(settingGet("chatStyle_showMatrixName") === "1");
    };
    sync();
    window.addEventListener("bb:settings-hydrated", sync);
    return () => window.removeEventListener("bb:settings-hydrated", sync);
  }, []);

  const { pin, setPin, dismissedPinId, pinHeight, setPinHeight, handlePin, handleUnpin, dismissPin } = useChatPin();

  const {
    messages, connected, loadingHistory, handleVote,
    scrollRef, contentRef, anchored, rendered, anchorToBottom, reassertBottom, handleScroll, pause,
    spotlightKey,
  } = useChatMessages({
    isMod: me.isMod,
    onPin: (p) => setPin((p as PinnedMessage | null) ?? null),
    initialMessages,
  });
  // Mods: the "Marked" badge beside a name reads one page-wide set (markedPeople.ts).
  useMarkedPolling(me.isMod);
  // Click a reply line to jump to what it answers; hover it to read it.
  const { flashKey, preview, onReplyJump, onReplyPreview, dismissPreview } = useReplyJump({ scrollRef, messages, pause, anchorToBottom });

  // The pin banner pads the scroller's top via inline style — a geometry change
  // the scroll engine can't see on its own. Re-snap in the same paint.
  useLayoutEffect(() => {
    reassertBottom();
  }, [pinHeight, pin?.id, dismissedPinId, reassertBottom]);

  // Was the socket EVER up? The reconnect pill must not flash on a fresh load,
  // where the DB fill can land before the socket opens (the site gates on
  // messages.length; the OBS source keeps a three-state). Derived during
  // render — React's storing-previous-render pattern — never in an effect.
  const [everConnected, setEverConnected] = useState(false);
  // There is no composer here, so nothing else is listening for a failed
  // delete / pin / unpin (chatNotice.ts) — this window shows the line itself,
  // as a pill like the reconnect one, for five seconds.
  const actionNotice = useChatNoticeText();
  if (connected && !everConnected) setEverConnected(true);

  // ⑤ Behavior half B: the viewer's hidden people / bots are not drawn here either.
  const lists = useBehaviorLists();
  const shown = useShownMessages(rendered);
  const shownAll = useShownMessages(messages);
  // Replies to a hidden person keep their name but not their quoted words.
  const hiddenNames = useMemo(() => new Set(lists.hidden.map((h) => h.name.toLowerCase())), [lists]);
  // One chat on screen: while the chat TUI has the terminal window, the rows stand aside.
  const chatInTerminal = useChatTakeover();
  const ownIds = useOwnPublicIds();
  const { rows, directory } = useChatRowDerivations({
    messages, rendered: shown, userId: me.matrixId, ownIds, ownColor, words: lists.words,
  });
  // Lets this window's name cards tell the viewer's own platform lines apart.
  useEffect(() => { publishLiveDirectory(directory, { matrixId: me.matrixId ?? null, canonicalId: me.canonicalId ?? null, ownIds: [...ownIds] }); }, [directory, me.matrixId, me.canonicalId, ownIds]);

  const handleDelete = useCallback((msg: ChatMsg) => {
    void noticeOnFailure(postJson("/api/mod/delete", { platform: msg.platform, messageId: msg.id }), "Couldn’t delete that message.");
  }, []);
  // The broadcaster's highlighted message (chatSpotlight.ts) — the click is the broadcaster's only.
  const handleSpotlight = useSpotlightToggle(spotlightKey);

  // PgUp/PgDn/Home/End move the feed. There is no composer here, so the
  // keys are read on the document; the browser would otherwise page the
  // document, which does not scroll. A field, the settings panel (its own
  // scroll box) and the user card keep their keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (t?.closest("[data-chat-panel]")) return;
      const k = chatScrollKey(e.key, { textEmpty: true, modified: e.ctrlKey || e.metaKey || e.altKey || e.shiftKey });
      if (!k) return;
      const el = scrollRef.current;
      if (!el) return;
      e.preventDefault();
      scrollChatByKey(el, k, anchorToBottom, pause);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [scrollRef, anchorToBottom, pause]);

  useOutsideClick(cardRef, () => setCard(null), { enabled: !!card, touch: false });

  const openCard = useCallback((msg: ChatMsg, el: HTMLElement) => {
    setCard({ msg, ...positionCard(el) });
  }, []);

  const pinShown = !!pin && pin.id !== dismissedPinId;

  return (
    <div className="chat-window relative h-screen w-screen overflow-hidden flex flex-col text-body bg-transparent overlay-host">
      {/* Same scroller contract as the site's chat column: overflow-x-clip (a
          boosted sticker must never turn the window into a sideways
          scroller), overscroll-y-contain, and native scroll anchoring off while
          following / on while reading. */}
      <div
        ref={scrollRef}
        onScroll={() => { handleScroll(); dismissPreview(); }}
        className={`chat-scroll-layer flex-1 overflow-y-auto overflow-x-clip overscroll-y-contain py-1 no-scrollbar flex flex-col ${
          anchored ? "[overflow-anchor:none]" : "[overflow-anchor:auto]"
        }`}
        style={pinShown ? { paddingTop: pinHeight, "--chat-fade-top": `${pinHeight}px` } as React.CSSProperties : undefined}
      >
        {/* Spacer — pushes messages to the bottom when few; shrinks to 0 when they overflow */}
        <div className="flex-1" />
        <div
          ref={contentRef}
          className="pb-3 flex flex-col"
          role="log"
          aria-live="polite"
          aria-label="Live chat messages"
        >
          {loadingHistory && (
            <p className="text-muted text-3xs text-center py-1 shrink-0">
              Loading earlier messages…
            </p>
          )}
          {messages.length === 0 && (
            <EmptyState className="text-center mt-8">
              {connected ? "No messages yet" : "Connecting to chat…"}
            </EmptyState>
          )}
          {chatInTerminal && (
            <EmptyState className="text-center mt-8">chat is in the terminal · Esc there brings it back</EmptyState>
          )}
          {!chatInTerminal && rows.map((row) => {
            const msg = row.msg;
            return (
              <ChatMessage
                key={`${msg.platform}-${msg.id}`}
                msg={msg}
                emotes={emotes}
                compact={row.compact}
                showTimestamps={showTimestamps}
                tsFormat={tsFormat}
                stillEmotes={stillEmotes}
                tick={tick}
                showMatrixName={showMatrixName}
                onUsernameClick={openCard}
                onVote={me.signedIn && !row.isOwn && !row.isOwnStream ? handleVote : undefined}
                onPin={me.signedIn && me.isMod ? handlePin : undefined}
                onModDelete={me.isMod ? handleDelete : undefined}
                highlight={row.highlight}
                own={row.isOwn || row.isOwnStream}
                maskSwears={maskSwears}
                quoteHidden={!!row.msg.reply_to_username && hiddenNames.has(row.msg.reply_to_username.toLowerCase())}
                directory={directory}
                spotlight={spotlightKey !== null && spotlightKey === chatKey(msg)}
                onSpotlight={me.isAdmin ? handleSpotlight : undefined}
                onReplyJump={onReplyJump}
                onReplyPreview={onReplyPreview}
                replyTargetHighlight={flashKey !== null && flashKey === chatKey(msg)}
              />
            );
          })}
        </div>
      </div>
      {/* Directly after the scroller — it targets its previous sibling. */}
      {initialMessages && initialMessages.length > 0 && <ScrollBottomBeforeHydration />}
      <ReplyPreview preview={preview} />
      {pinShown && pin && (
        <PinnedBanner
          pin={pin}
          emotes={emotes}
          isMod={me.isMod}
          onUnpin={handleUnpin}
          onDismiss={() => dismissPin(pin.id)}
          onHeightChange={setPinHeight}
        />
      )}
      {/* Only what the viewer will SEE counts as new (hidden people / bots don't). */}
      {!anchored && <PausedPill queued={Math.max(0, shownAll.length - shown.length)} onClick={anchorToBottom} />}
      {everConnected && !connected && (
        <div
          role="status"
          className="absolute top-2 left-1/2 -translate-x-1/2 z-10 rounded-full border border-edge bg-surface-2 px-3 py-1 text-xs text-body-dim"
        >
          Reconnecting to chat…
        </div>
      )}
      {actionNotice && (
        <div
          role="status"
          className="absolute bottom-2 left-1/2 -translate-x-1/2 z-10 rounded-full border border-edge bg-surface-2 px-3 py-1 text-xs text-body-dim"
        >
          {actionNotice}
        </div>
      )}
      {/* Settings — top-right, showing only on hover or a touch tap. The root
          div carries overlay-host, so globals.css's
          `.overlay-host:hover .overlay-gear` reaches this normally-nested
          child directly — OverlaySettingsPanel owns the counter-scale. */}
      <OverlaySettingsPanel page="window"
        scaleFactor={scaleFactor}
        onShowTimestampsChange={setShowTimestamps}
        onShowMatrixNameChange={setShowMatrixName}
      />

      {card && typeof document !== "undefined" && createPortal(
        <div ref={cardRef} data-chat-panel="" className="fixed z-(--z-float)"
          style={{ left: card.x, top: card.y, transform: card.above ? "translateY(-100%)" : "none" }}>
          <UserCard msg={card.msg} isMod={me.isMod} onClose={() => setCard(null)} />
        </div>,
        document.body
      )}
      {me.isMod && <ModUndoToast />}
    </div>
  );
}
