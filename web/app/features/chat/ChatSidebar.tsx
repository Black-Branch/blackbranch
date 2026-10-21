"use client";

import ModUndoToast from "@/app/components/ModUndoToast";
import { useMarkedPolling } from "@/app/lib/markedPeople";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback, useSyncExternalStore, type CSSProperties } from "react";
import { subscribeHomeStore, readHomeStore } from "@/app/lib/homeStore";
import { useLocalStorageString } from "@/app/lib/useClientState";
import ChatMessage from "./ChatMessage";
import ReplyPreview from "./ReplyPreview";
import { useSetting, useMinuteTick } from "@/app/lib/useSetting";
import type { TsFormat } from "@/app/lib/chatTime";
import { useReplyJump } from "@/app/lib/useReplyJump";
import { useChatNoticeText } from "@/app/lib/useChatNoticeText";
import { ScrollBottomBeforeHydration } from "@/app/components/ScrollBottomBeforeHydration";
import { cardReplyContext, type ChatMsg } from "@/app/lib/chatMsg";
import { localpart } from "@/app/lib/matrixDisplay";
import { requestDm } from "@/app/lib/dm/bus";
import { AnnounceHost, DmHost } from "@/app/features/dm";
import { userCardPopoutUrl } from "@/app/lib/avatarSrc";
import { useNarrowViewport, narrowViewportNow } from "@/app/lib/useNarrowViewport";
import { useWindowDock } from "@/app/lib/chrome/windowDock";
import { OPEN_HOME_EVENT, OPEN_LIVE_EVENT } from "@/app/lib/visitFold";
import { OPEN_FORUM_THREAD_EVENT, readThreadDetail, type ThreadRef } from "@/app/lib/forumLinks";
import UserCard from "@/app/components/UserCard";
import UserMenu from "@/app/components/UserMenu";
import nextDynamic from "next/dynamic";

// The Matrix panel is the whole embedded community client (matrix-js-sdk +
// RustCrypto — by far the largest dependency in the app). Load its chunk only
// when the user first opens the Matrix tab, not on every page view.
const MatrixPanel = nextDynamic(() => import("@/app/components/MatrixPanel"), {
  ssr: false,
  loading: () => (
    <div className="flex-1 flex items-center justify-center text-xs text-muted">
      Loading community…
    </div>
  ),
});
import FeedPanel from "@/app/components/FeedPanel";
import VodList from "@/app/components/VodList";
import { type Vod } from "@/app/lib/vods";
import {
  CHATBAR_DEFAULT_ARMED, readArmed, writeArmed, armTab, closeTab, partitionTabs,
  splitLeading, armFlagKey, armOnce, type SiteTabKey,
} from "@/app/lib/tabRegistry";
import { HomeTab } from "@/app/features/home";
import type { HomePayload } from "@/app/lib/homePayload";
import type { RssItem } from "@/app/lib/rssServer";
import { ForumsTab } from "@/app/features/forums";
import { StreamTab } from "@/app/features/stream";
import { SUGGEST_EVENT } from "@/app/lib/contentSuggest";
import { useSupportConversation } from "./support/useSupportConversation";
import { SupportPanel } from "./support/SupportPanel";
import {
  CLOSE_HINT, FIRST_VISIT, LINK_NUDGE_LINE, linkNudgeOptions,
  NUDGE_LATER_KEY, NUDGE_NEVER_KEY,
} from "@/app/lib/support/flows";
import { useBadges, badgesForMatrixId } from "@/app/lib/BadgesContext";
import { dispatchClaimable, claimEvent } from "@/app/lib/claimableEvent";
import { useEmotes, type EmoteMap } from "@/app/lib/useEmotes";
import { useChatMessages } from "@/app/lib/useChatMessages";
import { useChatSplitView } from "@/app/lib/useChatSplitView";
import { useBanStatus } from "@/app/lib/useBanStatus";
import { postJson, postJsonOrThrow, getJson } from "@/app/lib/http";
import { noticeOnFailure } from "@/app/lib/chatNotice";
import { lsGet, lsSet } from "@/app/lib/safeLocalStorage";
import { USER_CARD_H, USER_CARD_W } from "@/app/lib/userCardLayout";
import { userCardDataWithin, USER_CARD_OPEN_CAP_MS, type UserCardData } from "@/app/lib/userCardData";
import { centeredBox, type Box } from "@/app/lib/chrome/useDragResize";
import { PausedPill } from "@/app/components/PausedPill";
import PinnedBanner, { type PinnedMessage } from "@/app/components/PinnedBanner";
import ChatInput from "./ChatInput";
import EmptyState from "@/app/components/EmptyState";
import { useChatPin } from "@/app/lib/useChatPin";
import { useChatRowDerivations } from "@/app/lib/useChatRowDerivations";
import { useOwnPublicIds } from "@/app/lib/ownIdentity";
import { useMentionSound } from "@/app/lib/useMentionSound";
import { useShownMessages, useHidesMessage } from "@/app/lib/useShownMessages";
import { useBehaviorLists } from "@/app/lib/behaviorStore";
import { publishLiveDirectory } from "@/app/lib/liveDirectory";
import { publishChatMessage, publishChatBuffer } from "@/app/lib/chatEvents";
import { useChatTakeover, useComposerReplaced } from "@/app/lib/chatTakeover";
import { useHiddenIgnoreSync } from "@/app/lib/useHiddenIgnoreSync";
import { useSendChatMessage } from "@/app/lib/useSendChatMessage";
import { useHeldLines } from "@/app/lib/useHeldLines";
import HeldLine from "./HeldLine";
import { useSpotlightToggle } from "@/app/lib/useChatSpotlight";
import { chatKey } from "@/app/lib/chatSeed";
import { useChatBgContrastRef } from "@/app/lib/useChatBgContrastRef";
import { ChatTabBar, type ChatTabKey } from "./ChatTabBar";
import { usePanePager } from "@/app/lib/chrome/usePanePager";
import { createBarScrollReveal, BAR_AUTO_HIDE_MS } from "@/app/lib/chrome/barScrollReveal";
import { Bar, Window, WindowLayerTarget } from "@/app/components/chrome";
import { setActivePane as setWindowLayerPane, useAnyWindowOpen } from "@/app/lib/chrome/windowLayer";
import { scrollChatByKey } from "@/app/lib/chatScrollKeys";
import AutomodHoldBar from "@/app/components/AutomodHoldBar";
import { FoldedTabControl } from "@/app/components/FoldedTabControl";
import { useLiftToken } from "@/app/lib/chrome/liftToken";
import { topWindowUnderKeyboard } from "@/app/lib/chrome/keyboardOwner";

// A pager slot: full row width, never shrinking, its own snap stop.
// `snap-always` is one pane per swipe (the Discord feel), which is also what
// makes every settle adjacent. Held here as one string so the three slots that
// wear it cannot drift — a slot whose content is unmounted still holds this
// geometry, which is what keeps the scroller from shifting under a gesture.
const PANE_SLOT = "w-full shrink-0 snap-start snap-always flex flex-col min-h-0 min-w-0";

function formatRemaining(ms: number): string {
  if (ms <= 0) return "0s";
  const s = Math.ceil(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export default function ChatSidebar({ isSignedIn, userId, canonicalId, isMod, isAdmin = false, isPopout, onToggleFull, isFull, fullKind, onFoldChat, compact, narrow, onToggleCompact, vods = [], homeInitial = null, selectedVodId = null, onPickVod, onWatchCommunity, initialMessages, initialEmotes }: { isSignedIn: boolean; userId?: string | null; canonicalId?: string | null; isMod: boolean;
  /** The owner (site.users.is_admin, from the server render): the one account
   *  whose click sets the highlighted message (chatSpotlight.ts). */
  isAdmin?: boolean; isPopout?: boolean; onToggleFull?: () => void; isFull?: boolean; fullKind?: "community" | "fold"; onFoldChat?: () => void; compact?: boolean; narrow?: boolean; onToggleCompact?: () => void; vods?: Vod[]; homeInitial?: HomePayload | null; selectedVodId?: string | null; onPickVod?: (v: Vod) => void;
  /** Home's "<name> is live → Watch": the host switches the player to Community. */
  onWatchCommunity?: () => void;
  /** The newest page of history, read by the server page so the rows are in
   *  the HTML before hydration (useChatMessages seeds from it). */
  initialMessages?: ChatMsg[];
  /** The emotes those rows use, so they render as <img>s at SSR (useEmotes). */
  initialEmotes?: EmoteMap }) {
  // Mods: the "Marked" badge beside a name reads one page-wide set (markedPeople.ts).
  useMarkedPolling(isMod);
  // The user card's own device signal. NOT the `narrow`
  // prop above: that one is StreamView's layout signal and is undefined in
  // the popout (isPopout — see PopoutView), which is itself always well
  // under the breakpoint (420px wide). Calling the hook here means the
  // card still picks "page" there instead of floating in a 420px window.
  const cardNarrow = useNarrowViewport();
  const cardWin = useWindowDock("usercard", cardNarrow);
  // Compact view differs by platform. Desktop slides the tab bar out to an
  // overlay revealed by hovering the top strip. Mobile has no hover, so the
  // bar hides in flow for real and comes back the way a phone browser's
  // chrome does: scroll UP in any pane reveals it,
  // scroll DOWN hides it, a no-scroll downward drag reveals it (short pane /
  // already at top), a compact toggle flip reveals it, and every reveal
  // auto-hides after a couple seconds — see `barLingerHold` /
  // `mobileCompactHidden`, below, fed to ChatTabBar as `mobileHidden`. Page
  // SWIPES deliberately do not touch it (a reveal on pager motion would
  // flicker the bar on every pane change). The far-left toggle stays the way
  // back once revealed.
  const compactOverlay = compact && !narrow;
  // Keep username readability-clamp pointed at the resolved chat-panel background.
  useChatBgContrastRef();
  // Compact composer: it hides below the chat and reveals on bottom-edge hover or
  // while focused (typing). The messages translate up by the composer's measured
  // height in sync, so the chat "slides up with" the typing bar rather than the
  // bar overlaying frozen messages. CSS siblings can't react to the composer's own
  // hover/focus, so this is React-state-driven.
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerH, setComposerH] = useState(0);
  const composerRef = useRef<HTMLDivElement>(null);
  const composerFocusedRef = useRef(false);
  // Two more independent signals `composerOpen` has to OR with focus: real hover on the bar's own (now on-screen) box
  // and Bar's coordinate proximity are DIFFERENT events that can each hold
  // while the other's condition does not — the pointer can cross OUT of the
  // bar's own box (firing a real onMouseLeave) while still comfortably
  // inside Bar's 96px release band (nearEdge still true), or proximity can
  // release while the pointer is still literally on the bar (a real hover).
  // Closing on ONE signal's release regardless of the others is exactly the
  // "mouseleave fights proximity" failure mode: composerOpen would flip
  // false while Bar's own `data-revealed` (which ORs `revealed` with its
  // OWN live `nearEdge`, independent of what this component echoes back)
  // stays true, and the message list would untranslate out from under a
  // bar that is still visually open. Closing is safe only when ALL THREE
  // agree nothing holds it open — `syncComposerOpen` below is that OR.
  const composerHoverRef = useRef(false);
  const composerNearRef = useRef(false);
  // A window (page / panel / dialog — the mod panel, say) open over the pane
  // makes the bottom-edge proximity reveal wrong: the pointer is working IN
  // the window, and the typing bar sliding up under it would read as a bug.
  // The Bar stands its pointer reveal down (`standDown`) and
  // reports proximity as false for as long as a window is open — so this OR
  // stays a plain OR and `composerOpen` keeps agreeing with the bar's own
  // `data-revealed`. Focus still opens it — typing is typing.
  const windowOpen = useAnyWindowOpen();
  const syncComposerOpen = () => {
    setComposerOpen(composerHoverRef.current || composerFocusedRef.current || composerNearRef.current);
  };
  // Leaving compact mode closes the composer — render-time adjust.
  if (!compactOverlay && composerOpen) setComposerOpen(false);
  useEffect(() => {
    if (!compactOverlay) {
      composerFocusedRef.current = false;
      composerHoverRef.current = false;
      composerNearRef.current = false;
      return;
    }
    const el = composerRef.current;
    if (!el) return;
    const update = () => setComposerH(el.offsetHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [compactOverlay]);
  // Mobile content tabs — registry-armed (cycle 6b): News by default, VODs
  // armable via the + picker; ✕ closes one out. Live + Matrix stay pinned this
  // cycle (unpinning Matrix means reworking the split-view plumbing — the
  // registry supports it later; see the cycle-6 plan). The ARMED set persists
  // (chat_armed); `contentTab` is session-local exactly like newsActive was.
  //
  // Declared ABOVE useChatSplitView because an open content tab COVERS the
  // live/matrix pair, and the split hook needs to know that to keep its unseen
  // dots honest (see below).
  const [chatArmedRaw, setChatArmedRaw] = useLocalStorageString("chat_armed");
  const armed = readArmed(chatArmedRaw, CHATBAR_DEFAULT_ARMED);
  // A one-time arm — same rule as the dock.
  const [homeArmFlag, setHomeArmFlag] = useLocalStorageString(armFlagKey("home", "chat"));
  useEffect(() => {
    if (homeArmFlag === "1") return;
    const next = armOnce(chatArmedRaw, homeArmFlag, CHATBAR_DEFAULT_ARMED, "home");
    if (next !== null) setChatArmedRaw(next);
    setHomeArmFlag("1");
  }, [homeArmFlag, chatArmedRaw, setChatArmedRaw, setHomeArmFlag]);
  // The Stream tab: armed once, for an admin only.
  const [streamArmFlag, setStreamArmFlag] = useLocalStorageString(armFlagKey("stream", "chat"));
  useEffect(() => {
    if (!isAdmin || streamArmFlag === "1") return;
    const next = armOnce(chatArmedRaw, streamArmFlag, CHATBAR_DEFAULT_ARMED, "stream");
    if (next !== null) setChatArmedRaw(next);
    setStreamArmFlag("1");
  }, [isAdmin, streamArmFlag, chatArmedRaw, setChatArmedRaw, setStreamArmFlag]);
  // Readiness is exhaustive over SiteTabKey (tabRegistry.ts) — a new registry
  // tab does not compile here until this host answers for it. VODs needs BOTH
  // a list and a picker: the popout renders this sidebar with neither. Home
  // has nothing to do in a 420px popout either.
  const newsHasItems = (useSyncExternalStore(subscribeHomeStore, readHomeStore, () => null)?.news?.length ?? 0) > 0;
  const { shown: shownContent, tabs: contentTabs, unarmed: unarmedTabs } =
    partitionTabs(armed, {
      home: !isPopout,
      forums: !isPopout,
      // Hidden until a feed has items (§0): read from the remembered Home body.
      news: newsHasItems,
      vods: vods.length > 0 && !!onPickVod,
      stream: isAdmin && !isPopout,
    });
  const [contentTab, setContentTab] = useState<SiteTabKey | null>(null);
  // The buttons are mobile-only, and a selection whose tab was closed or lost
  // its data would strand the panel. Render-time adjusts (no effect pass).
  if (!narrow && contentTab !== null) setContentTab(null);
  if (contentTab !== null && !shownContent.includes(contentTab)) setContentTab(null);

  // Tabs + responsive split layout + per-tab unseen dots (see useChatSplitView).
  const {
    asideRef, tab, setTab, split, splitAvailable, setSplitPref,
    matrixVisible, liveVisible, matrixOpened, setMatrixOpened,
    liveUnseen, matrixUnseen, markLiveUnseen,
    liveColRef, liveColStyle, liveColW, dividerHandlers,
  } = useChatSplitView(contentTab !== null);

  // ── Pager: on narrow the middle is ONE snap row and this
  // hook is its brain. Committed state (tab/contentTab) is the source of truth
  // at rest; the scroller is the source during motion; settle commits.
  // Split needs a 640px panel and narrow is everything under 768px, so the two
  // OVERLAP in a 640–767px band (a small tablet, a landscape phone): the pager
  // yields there and the desktop pair renders, which is why `!split` is a term
  // and not a comment.
  const pagerOn = !!narrow && !split;
  const activePane: ChatTabKey = contentTab ?? tab;
  // The window layer follows what the user is looking at — a panel window
  // opens in this pane and stays with it. Cleared on unmount: with
  // no active pane, panel windows fall back to full-viewport shapes.
  useEffect(() => {
    setWindowLayerPane(activePane);
    return () => setWindowLayerPane(null);
  }, [activePane]);
  // The ONE commit path, by construction rather than by convention: a swipe
  // settles into it (usePanePager's onCommit), a click while the pager owns
  // motion reaches it through requestPane's scroll, and a click when it does
  // not is this same function — ChatTabBar is handed it as a prop and calls it,
  // so there is no second copy of the body to drift from this one.
  const selectPane = (k: ChatTabKey) => {
    if (k === "live") { setContentTab(null); setTab("live"); return; }
    if (k === "matrix") { setContentTab(null); setTab("matrix"); setMatrixOpened(true); return; }
    setContentTab(k);
  };
  // THE single ordered key list — leading content tabs (Home), live, matrix,
  // then the rest of the armed content tabs. The row below renders its
  // children in exactly that order and ChatTabBar's `items` is built from the
  // same splitLeading call, so pane index and tab index agree by construction
  // rather than by two arrays staying in step — which matters because
  // `progress` is a fractional index read against both.
  // Deliberately not memoized: `partitionTabs` hands back a fresh
  // `contentTabs` array every render, so a `[contentTabs]` memo would never
  // hit — and it does not need to, because usePanePager keys its effects on
  // the JOINED key signature, not on this array's identity.
  const { leading: leadingTabs, rest: restTabs } = splitLeading(contentTabs);
  const paneKeys: ChatTabKey[] = [
    ...leadingTabs.map((t) => t.key), "live", "matrix", ...restTabs.map((t) => t.key),
  ];
  // ── The compact bar's phone-browser reveal ─────────────────────────────────
  // Between pages the bar stays hidden: a reveal on pager motion would
  // re-appear (and visibly flicker) the bar on every pane swipe. The reveal
  // triggers are:
  //   · scroll UP in any pane (finger swiping down — the phone-browser model);
  //     scroll DOWN hides it again immediately;
  //   · a downward drag that SCROLLED NOTHING (the pane is too short, or
  //     already at its top) — without this, a non-scrollable pane in compact
  //     would strand the viewer with no reveal gesture at all;
  //   · any `compact` toggle flip (tapping the toggle can't hide the very
  //     control that just changed it, in the same frame);
  // and every reveal auto-hides after BAR_AUTO_HIDE_MS with no further
  // up-scroll — "a couple seconds" — one shared timer, so
  // overlapping triggers extend a single countdown instead of racing two.
  const [barLingerHold, setBarLingerHold] = useState(false);
  const barLingerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armBarLingerTimer = useCallback(() => {
    if (barLingerTimerRef.current !== null) clearTimeout(barLingerTimerRef.current);
    barLingerTimerRef.current = setTimeout(() => {
      setBarLingerHold(false);
      barLingerTimerRef.current = null;
    }, BAR_AUTO_HIDE_MS);
  }, []);
  // Never leave an armed timer past teardown.
  useEffect(() => {
    return () => {
      if (barLingerTimerRef.current !== null) clearTimeout(barLingerTimerRef.current);
    };
  }, []);
  // The compact-flip reveal is a RENDER-TIME ADJUST — same pattern
  // LinkPreview.tsx's `prevUrl` uses (a STATE-held previous value, never a
  // ref: react-hooks/refs refuses `.current` during render), not an effect:
  // a flip must never paint a hidden bar for even one frame, and a pure
  // setState correction during render is the only mechanism that guarantees
  // that (`react-hooks/set-state-in-effect` refuses the effect-body form for
  // exactly this cascading-render reason).
  const [prevCompact, setPrevCompact] = useState(compact);
  if (prevCompact !== compact) {
    setPrevCompact(compact);
    if (!barLingerHold) setBarLingerHold(true);
  }
  // Entering/leaving compact arms the shared auto-hide — the reveal itself
  // already landed above, in the same render as the flip.
  const compactMountedRef = useRef(false);
  useEffect(() => {
    if (!compactMountedRef.current) { compactMountedRef.current = true; return; }
    armBarLingerTimer();
  }, [compact, armBarLingerTimer]);
  // The scroll-direction listener: ONE capture-phase `scroll` listener on the
  // aside hears every descendant pane's vertical scroller (scroll doesn't
  // bubble, but capture descends), feeds signed deltas to the pure
  // accumulator (barScrollReveal.ts — thresholded, so anchoring jitter can't
  // flap the bar), and reveals/hides on its emits. Horizontal scrollers (the
  // pager rows) never move `scrollTop`, so they contribute zero deltas and
  // are skipped by construction. The touch listeners are the no-scroll drag
  // fallback: a touch that moves ≥24px downward while NO scroll event fired
  // anywhere in the panel means nothing was scrollable in that direction —
  // reveal, exactly like a phone browser at the top of a short page. All
  // listeners are passive; setState from a DOM listener is fine (the lint
  // rule above concerns effect bodies).
  const barRevealEnabled = pagerOn && !!compact;
  useEffect(() => {
    if (!barRevealEnabled) return;
    const el = asideRef.current;
    if (!el) return;
    // The bar's own show/hide is a LAYOUT SHIFT that feeds back into this
    // machine: the bar is in flow, so a flip changes the chat scroller's
    // height, the bottom-lock compensates `scrollTop` by the same 36px, and
    // that write lands well inside the input-recency window (the user's
    // pointer/wheel is what triggered the flip) — reading as a user scroll in
    // the OPPOSITE direction, which flips the bar back: a sustained
    // reveal/hide oscillator when hovering the strip edge or wheel-scrolling
    // near it. So every flip DEAFENS the machine for 350ms (the ~200ms margin
    // transition plus settle) — its own aftershock can never reach it.
    // Initialized to "now" so the attach moment (entering compact — itself a
    // layout shift) starts deaf too. Cost: a genuine direction change within
    // 350ms of a flip is ignored — invisible next to the oscillation it prevents.
    let deafUntilTs = performance.now() + 350;
    const reveal = () => { if (topWindowUnderKeyboard(el)) return; deafUntilTs = performance.now() + 350; setBarLingerHold(true); armBarLingerTimer(); };
    const hide = () => {
      deafUntilTs = performance.now() + 350;
      if (barLingerTimerRef.current !== null) { clearTimeout(barLingerTimerRef.current); barLingerTimerRef.current = null; }
      setBarLingerHold(false);
    };
    const machine = createBarScrollReveal({ up: reveal, down: hide });
    const lastTops = new WeakMap<Element, number>();
    let sawScroll = false;
    let touchStartY: number | null = null;
    let revealedThisTouch = false;
    // The machine hears USER scrolling only. Panes scroll themselves all
    // the time — the chat bottom-lock writes scrollTop DOWN on every new
    // message (which would hide a just-revealed bar under live chat), and the
    // inert Matrix timeline's history backfill compensates scrollTop UP
    // (which would reveal the bar out of nowhere and cycle it against the
    // auto-hide). Two guards: a
    // scroller inside an `inert` pane is never the user (they cannot reach
    // it), and any delta more than 400ms from the last real input
    // (wheel / touch / pointerdown — momentum's direction is established
    // well inside the window) is the app scrolling, not the viewer.
    let lastInputTs = 0;
    const markInput = () => { lastInputTs = performance.now(); };
    const onScroll = (e: Event) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      sawScroll = true;
      const top = t.scrollTop;
      const prev = lastTops.get(t);
      lastTops.set(t, top);
      if (prev === undefined) return;
      if (t.closest("[inert]")) return;
      // Deaf after a flip (see deafUntilTs above): the aftershock also voids
      // any half-accumulated run — post-deaf deltas start a clean slate.
      if (performance.now() < deafUntilTs) { machine.reset(); return; }
      if (performance.now() - lastInputTs > 400) return;
      machine.delta(top - prev);
    };
    const onTouchStart = (e: TouchEvent) => {
      markInput();
      sawScroll = false;
      revealedThisTouch = false;
      touchStartY = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e: TouchEvent) => {
      markInput();
      if (sawScroll || revealedThisTouch || touchStartY === null) return;
      const y = e.touches[0]?.clientY;
      if (y !== undefined && y - touchStartY >= 24) { revealedThisTouch = true; reveal(); }
    };
    // The hover reveal: the stacked layout on a
    // DESKTOP-narrow window runs this same compact hide with a mouse, where
    // hovering the bar's home strip is the native reveal idiom (it is how the
    // side-by-side desktop overlay already behaves). A non-touch pointer
    // within 48px of the panel's top reveals and keeps re-arming the
    // auto-hide (so the bar stays while hovered); leaving the strip simply
    // lets the shared timer drop it — timer-based hide, so no proximity-exit
    // oscillation to hysteresis away. rAF-throttled like Bar's own zone.
    let hoverRaf = 0;
    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      markInput();
      if (hoverRaf) return;
      const { clientX, clientY } = e;
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0;
        const r = el.getBoundingClientRect();
        const inStrip =
          clientY >= r.top && clientY - r.top <= 48 && clientX >= r.left && clientX <= r.right;
        if (inStrip) reveal();
      });
    };
    const onWheel = () => { markInput(); };
    const onPointerDown = () => { markInput(); };
    el.addEventListener("scroll", onScroll, { capture: true, passive: true });
    el.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    el.addEventListener("touchmove", onTouchMove, { capture: true, passive: true });
    el.addEventListener("pointermove", onPointerMove, { passive: true });
    el.addEventListener("wheel", onWheel, { capture: true, passive: true });
    el.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll, { capture: true });
      el.removeEventListener("touchstart", onTouchStart, { capture: true });
      el.removeEventListener("touchmove", onTouchMove, { capture: true });
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("wheel", onWheel, { capture: true });
      el.removeEventListener("pointerdown", onPointerDown, { capture: true });
      if (hoverRaf) cancelAnimationFrame(hoverRaf);
    };
  }, [barRevealEnabled, armBarLingerTimer, asideRef]);
  // Mobile compact's real hide, fed to ChatTabBar's `mobileHidden` (below) →
  // Bar's own `hidden`. Desktop compact (`compactOverlay`, above) is
  // untouched by any of this — this term is `false` there regardless of
  // `barRevealHold`. `!!compact` (not bare
  // `compact`, which is optional and would leak `boolean | undefined` into a
  // required `boolean` prop) — ChatTabBar's `mobileHidden` is not optional.
  // Gated on `pagerOn`, not bare `narrow` — the bar may hide ONLY where a
  // reveal gesture exists (`barRevealEnabled` shares the same gate). In the
  // 640–767px panel band (narrow viewport, split active) a plain `narrow`
  // term would strand a compact viewer with a hidden, inert bar (untappable
  // toggle; `barsHidden` unpersisted, so only rotate/reload escapes). Compact
  // keeps the bar there.
  const mobileCompactHidden = pagerOn && !!compact && !barLingerHold;
  // While the chat TUI has the slide-in window (`composerReplaced`, below) the tab bar folds
  // as well: the window layer sits under the bar, so a bar that hid later (mobile compact)
  // would pull the window up with it. Folded from the start, nothing moves.
  // DESTRUCTURED on purpose, not held as one `pager` object. `scrollerRef`
  // is handed to a `ref=` attribute below, and react-hooks/refs then treats the
  // WHOLE hook result as a ref value — every `pager.x` read in render becomes
  // "Cannot access refs during render", including `progress` and `mounted`,
  // which exist to be read during render. Naming the members here is the fix.
  const {
    scrollerRef: pagerScrollerRef, progress: pagerProgress, requestPane, mounted: paneMounted,
  } = usePanePager<ChatTabKey>({
    keys: paneKeys, activeKey: activePane, enabled: pagerOn,
    // No `onHotChange`: pager motion does not touch the bar (a between-pages
    // reveal would flicker; the scroll-direction machinery above is the reveal).
    onCommit: selectPane,
  });

  const onArmTab = (k: SiteTabKey) => { setChatArmedRaw(writeArmed(armTab(armed, k))); setContentTab(k); };
  // The thread deep link — this host claims it on narrow viewports;
  // the dock claims it on desktop. Same latest-value-ref pattern as selectPane
  // below: arm/open reads the current armed list, the subscription is once.
  const [pendingThread, setPendingThread] = useState<ThreadRef | null>(null);
  const openForumsRef = useRef<() => void>(() => {});
  useEffect(() => { openForumsRef.current = () => (armed.includes("forums") ? selectPane("forums") : onArmTab("forums")); });
  const consumeThread = useCallback(() => setPendingThread(null), []);
  // A headline from Home opens the News tab ON that story — the
  // same once-consumed handoff as pendingThread.
  const [pendingStory, setPendingStory] = useState<RssItem | null>(null);
  const consumeStory = useCallback(() => setPendingStory(null), []);
  const openNewsOn = (item: RssItem) => {
    setPendingStory(item);
    if (armed.includes("news")) selectPane("news"); else onArmTab("news");
  };
  const onCloseContentTab = (k: SiteTabKey) => {
    setChatArmedRaw(writeArmed(closeTab(armed, k)));
    if (contentTab === k) setContentTab(null); // back to the live/matrix pair
  };
  // The feed's "Suggest" button switches the panel to Matrix (MatrixView then opens
  // the New Post modal in the Content forum — see contentSuggest/MatrixView).
  useEffect(() => {
    const onSuggest = () => { setContentTab(null); setTab("matrix"); setMatrixOpened(true); };
    window.addEventListener(SUGGEST_EVENT, onSuggest);
    return () => window.removeEventListener(SUGGEST_EVENT, onSuggest);
  }, [setTab, setMatrixOpened]);

  // The visit rule and the live edge reach the phone pane by event (StreamView
  // owns the stream state; this component owns the pane). Both are no-ops on
  // desktop: contentTab is forced null there anyway, and Live is the pair.
  // The live edge moves a phone pane to Live from ANY tab, the same
  // takeover the player makes — not only from Home.
  // `selectPane` is re-created every render, so the listeners read it through
  // a latest-value ref (usePanePager's pattern: written in an effect, never
  // during render) and the subscription itself is registered once.
  // A LAYOUT effect, on purpose: StreamView dispatches OPEN_HOME_EVENT from
  // its own layout effect (the visit rule runs before paint), and React runs
  // a child's layout effects before the parent's but a child's PASSIVE effects
  // after — a passive listener here would miss the mount-time dispatch and the
  // phone would open on Live. The ref is read at
  // dispatch time; on the mount render it still holds the first selectPane,
  // whose setters are stable, so that is the right function too.
  const selectPaneRef = useRef(selectPane);
  useEffect(() => { selectPaneRef.current = selectPane; });
  useLayoutEffect(() => {
    const onOpenHome = () => { if (narrowViewportNow()) selectPaneRef.current("home"); };
    const onOpenLive = () => { if (narrowViewportNow()) selectPaneRef.current("live"); };
    const onThread = (e: Event) => {
      if (!narrowViewportNow()) return;
      const ref = readThreadDetail(e);
      if (!ref) return;
      claimEvent(e);
      setPendingThread(ref);
      openForumsRef.current();
    };
    window.addEventListener(OPEN_HOME_EVENT, onOpenHome);
    window.addEventListener(OPEN_LIVE_EVENT, onOpenLive);
    window.addEventListener(OPEN_FORUM_THREAD_EVENT, onThread);
    return () => {
      window.removeEventListener(OPEN_HOME_EVENT, onOpenHome);
      window.removeEventListener(OPEN_LIVE_EVENT, onOpenLive);
      window.removeEventListener(OPEN_FORUM_THREAD_EVENT, onThread);
    };
  }, []);

  // Tell the contextual Matrix-apps hint when the user first opens the Matrix tab.
  useEffect(() => {
    if (matrixOpened) window.dispatchEvent(new Event("bb:matrix-opened"));
  }, [matrixOpened]);

  // Own username color — localStorage-backed store (SSR null; same-tab writers
  // notify through the shared setter, cross-tab via the storage event).
  const [ownColor, setOwnColorLs] = useLocalStorageString("chatUsernameColor");

  // ── The help desk (support) ─────────────────────────────────────────────────
  // The sidebar owns the conversation; the destination state lives in
  // ChatInput's hook, reached through the registered enter/leave controls.
  const supportCtl = useRef<{ enter: () => void; leave: () => void } | null>(null);
  const badgeState = useBadges(); // own badges for the panel's user rows
  const [supportActive, setSupportActive] = useState(false);
  // One-time close hint. localStorage so it never nags twice.
  const [supportHinted, setSupportHinted] = useLocalStorageString("support_hinted");
  const [supportHint, setSupportHint] = useState(false);
  const supportConvo = useSupportConversation({
    onReport: async (username, reason) => {
      const res = await postJson("/api/support/report", { username, reason });
      if (res.status === 404) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(d?.error === "ambiguous" ? "ambiguous" : "user_not_found");
      }
      if (!res.ok) throw new Error("failed");
    },
    onTicket: async (kind, body, transcript) => {
      const res = await postJson("/api/support/ticket", {
        kind, body,
        transcript: transcript.slice(-40).map((m) => ({ role: m.role, text: m.text.slice(0, 500) })),
      });
      if (!res.ok) throw new Error("failed");
    },
    onFreeText: async (text, history) => {
      const res = await postJson("/api/support/message", {
        text,
        history: history.slice(-8).map((m) => ({ role: m.role, text: m.text.slice(0, 500) })),
      });
      if (res.status === 429) {
        const d = (await res.json().catch(() => null)) as { retryAfterSeconds?: number } | null;
        throw new Error(`cooldown:${d?.retryAfterSeconds ?? 60}`);
      }
      if (!res.ok) throw new Error("failed");
      const d = (await res.json().catch(() => null)) as { text?: string } | null;
      const reply = String(d?.text ?? "");
      if (!reply) throw new Error("failed");
      return reply;
    },
  });
  const { open: convoOpen, sendText: convoSendText, reset: convoReset, pick: convoPick } = supportConvo;
  const handleSupportModeChange = useCallback((active: boolean) => {
    setSupportActive(active);
    if (active) convoOpen(); // no-op if a thread is already going
  }, [convoOpen]);
  const registerSupportControls = useCallback((c: { enter: () => void; leave: () => void }) => {
    supportCtl.current = c;
  }, []);
  // /support [message] — open the thread SYNCHRONOUSLY (commit sets the ref
  // before returning), so the first turn can't outrun the greeting. Explicit
  // opens also show the panel directly — the typing-opens rule is only for
  // arming via the send-to cycle.
  const openSupportWith = useCallback((firstMessage?: string) => {
    convoOpen();
    setSupportActive(true);
    if (firstMessage) void convoSendText(firstMessage);
  }, [convoOpen, convoSendText]);
  // True while the open thread began as the link-account reminder — ✕ during
  // one counts as a plain dismissal (the 48 h clock; v90 semantics live
  // server-side, untouched). Cleared once any dismissal is posted.
  const nudgeShowing = useRef(false);
  const postNudgeDismiss = useCallback((never: boolean) => {
    nudgeShowing.current = false;
    // Fire-and-forget, same as the old card: the user's intent is the close,
    // which just happened. A lost write costs one extra reminder in 48 h.
    void postJson("/api/nudges", { kind: "link_account", never }).catch(() => {});
  }, []);
  const closeSupport = useCallback(() => {
    supportCtl.current?.leave();
    setSupportActive(false);
    if (nudgeShowing.current) postNudgeDismiss(false);
    // Exiting clears the history — a reopened panel greets
    // fresh rather than resuming a stale thread.
    convoReset();
    if (!supportHinted) {
      setSupportHinted("1");
      setSupportHint(true);
      setTimeout(() => setSupportHint(false), 4000);
    }
  }, [supportHinted, setSupportHinted, convoReset, postNudgeDismiss]);
  // The reminder's dismissal chips are panel-level acts the reducer never
  // sees (same pattern as FILE_LAST_BUG): post with the right `never`, then
  // close — closeSupport's own plain-dismiss is already spent by then.
  const handleSupportPick = useCallback((key: string) => {
    if (key === NUDGE_LATER_KEY || key === NUDGE_NEVER_KEY) {
      postNudgeDismiss(key === NUDGE_NEVER_KEY);
      closeSupport();
      return;
    }
    convoPick(key);
  }, [postNudgeDismiss, closeSupport, convoPick]);
  const [showTimestamps, setShowTimestamps] = useState(false);
  const tsFormat = (useSetting("chatStyle_tsFormat") ?? "standard") as TsFormat;
  const tick = useMinuteTick(tsFormat === "rel");
  // "Animated emotes" off — read once here, passed down as
  // ChatMessage's stillEmotes prop rather than subscribed per-row.
  const stillEmotes = useSetting("chatStyle_animEmotes") === "0";
  // Behavior › Hide swear words — read once here and passed down, like stillEmotes.
  const maskSwears = useSetting("chatStyle_profanityFilter") === "1";
  // SSR-safe default; the mount `sync()` effect below restores it from
  // localStorage (avoids a hydration mismatch — see the tab comment in the hook).
  const [showMatrixName, setShowMatrixName] = useState(false);
  const [replyTo, setReplyTo] = useState<ChatMsg | null>(null);
  const [replyHoverTarget, setReplyHoverTarget] = useState<string | number | null>(null);
  const handleReplyHover = useCallback((id: string | number | null) => setReplyHoverTarget(id), []);
  // Stable so ChatMessage's memo holds (an inline arrow here re-rendered every row
  // on every parent render — incoming message, hover, etc.).
  // Replying to an ephemeral monetization card (gift/donation/sub/alert) is
  // treated like replying to a normal message, but normalized to a native-only
  // shout-back with a synthesized actor + quote (see cardReplyContext).
  const handleReply = useCallback((m: ChatMsg) => setReplyTo(m.system ? cardReplyContext(m) : m), []);

  // ── Pinned message: fetched on load, kept live by WS {type:"pin"} ──
  const { pin, setPin, dismissedPinId, pinHeight, setPinHeight, handlePin, handleUnpin, dismissPin } = useChatPin();
  const pinShown = !!pin && pin.id !== dismissedPinId;
  // Mod-only per-message delete, surfaced in the hover overlay + touch menu.
  // The WS 'delete' broadcast removes the row for everyone, so no local edit here.
  const handleDelete = useCallback((msg: ChatMsg) => {
    void noticeOnFailure(postJson("/api/mod/delete", { platform: msg.platform, messageId: msg.id }), "Couldn’t delete that message.");
  }, []);
  // Boosted sticker reappears at the bottom of the feed as an ordinary new
  // message (the existing WS `type: "message"` append path), same as any other
  // coin-spend card — no optimistic edit here, same as a sticker send itself.
  const handleStickerBoost = useCallback(async (originalMessageId: number, amount: number) => {
    await postJsonOrThrow("/api/points/spend/sticker-boost", {
      originalMessageId, amount, spendId: crypto.randomUUID(),
    });
  }, []);

  const emotes = useEmotes(initialEmotes);

  // ── Live-chat buffer + scroll engine (see useChatMessages) ──
  // ⑤ Behavior: a batch of only hidden people / hidden bots never lights the Live dot.
  const hidesMessage = useHidesMessage();
  // One chat on screen: while the chat TUI has the terminal window, the rows stand aside.
  const chatInTerminal = useChatTakeover();
  // …and while the TUI has a SLIDE-IN window, the chat box folds away under it:
  // the window then reaches the column's bottom edge and its own typing line is the
  // chat box. Folded the way the tab bar folds for the keyboard — out of flow, inert.
  const composerReplaced = useComposerReplaced();
  // The window ceiling's chrome-above term (chrome.css): the tab bar's height, or 0 once it folds.
  // Written through useLiftToken, never as an inline style — with the keyboard up, the bar's flip
  // is announced like the keyboard's K, so a top window's lift-follow eases it instead of jumping.
  useLiftToken(asideRef, "--pane-chrome-above", mobileCompactHidden || compactOverlay || composerReplaced ? "0px" : "var(--chrome-top-h)");
  // The terminal's hooks hear
  // each new line this list shows, with this list's own verdict on whether it tags
  // the viewer — read through a ref, since that verdict is derived further down.
  const alertsRef = useRef<(m: ChatMsg) => boolean>(() => false);
  const onLiveBatch = useCallback((batch: readonly ChatMsg[]) => {
    if (batch.some((m) => !hidesMessage(m))) markLiveUnseen();
    for (const m of batch) if (!hidesMessage(m)) publishChatMessage(m, alertsRef.current(m));
  }, [hidesMessage, markLiveUnseen]);
  // (spotlightKey below feeds handleSpotlight, declared after the hook.)
  const {
    messages, connected, loadingHistory, handleVote,
    scrollRef, contentRef, anchored, rendered, anchorToBottom, reassertBottom, handleScroll, pause,
    spotlightKey,
  } = useChatMessages({
    isMod,
    onMessageReceived: onLiveBatch,
    onPin: (p) => setPin((p as PinnedMessage | null) ?? null),
    initialMessages,
  });
  // The sender's own held messages (heldMessages.ts) — local lines, never in `messages`.
  const { heldLines, dismissHeld } = useHeldLines(messages);
  // Click a reply line to jump to what it answers; hover it to read it.
  const noticeText = useChatNoticeText();
  const { flashKey, preview, onReplyJump, onReplyPreview, dismissPreview } = useReplyJump({ scrollRef, messages, pause, anchorToBottom });

  // The pin banner pads the scroller's top via inline style (below) — a
  // geometry change the scroll engine can't see on its own since it comes
  // from ChatSidebar state, not from `items`. Re-snap in the same paint so an
  // anchored view never shows a message half-cut-off under the banner.
  useLayoutEffect(() => {
    reassertBottom();
  }, [pinHeight, pin?.id, dismissedPinId, reassertBottom]);
  // The broadcaster's highlighted message (chatSpotlight.ts) — the click is the broadcaster's only.
  const handleSpotlight = useSpotlightToggle(spotlightKey);

  // ── Ban / timeout state for the input (see useBanStatus) ──
  const { banExpiry, setBanExpiry, nowTick } = useBanStatus(isSignedIn);

  // ── The help desk as the site's voice: the load-time-only support opener ──
  // The ONLY auto-open path for the panel: reminders fire on load or reload,
  // never mid-session, so the bubble can't interrupt anyone. The
  // SERVER decides whether the link-account reminder shows (GET /api/nudges —
  // linked-account count, 48 h clock, never-latch all live in site.user_nudges);
  // the else-branch greets a first-ever visitor once.
  // The greeting flag is read at decision time via lsGet, not a state hook —
  // the post-mount localStorage sync would hand this fetch's closure a stale
  // null and re-greet on every load.
  const nudgeChecked = useRef(false);
  useEffect(() => {
    if (isPopout || !isSignedIn || nudgeChecked.current) return;
    nudgeChecked.current = true;
    let cancelled = false;
    let settled = false;
    getJson<{ link_account?: { show: boolean; offerNever: boolean } }>("/api/nudges")
      .then((d) => {
        settled = true;
        if (cancelled) return;
        if (d.link_account?.show) {
          nudgeShowing.current = true;
          convoOpen(LINK_NUDGE_LINE, linkNudgeOptions(d.link_account.offerNever));
        } else if (!lsGet("support_greeted")) {
          lsSet("support_greeted", "1");
          convoOpen(FIRST_VISIT);
        } else {
          return;
        }
        supportCtl.current?.enter();
        setSupportActive(true);
      })
      // A failed fetch shows nothing — a reminder is never worth an error state.
      .catch(() => { settled = true; });
    // A run torn down before its answer arrived (a re-render, React's dev double-mount) did not
    // greet anyone, so it must not use up the one check — the next run asks again.
    return () => { cancelled = true; if (!settled) nudgeChecked.current = false; };
  }, [isPopout, isSignedIn, convoOpen]);

  // Per-row derivations (own-color override, continuation grouping, reply-to-me
  // highlight) + @mention candidates — see useChatRowDerivations.
  // ⑤ Behavior half B: hidden people (and bots, when asked) are dropped from what
  // is drawn and from what can ping; the buffer itself keeps everything.
  const lists = useBehaviorLists();
  const shown = useShownMessages(rendered);
  // Replies to a hidden person keep their name but not their quoted words.
  const hiddenNames = useMemo(() => new Set(lists.hidden.map((h) => h.name.toLowerCase())), [lists]);
  const shownAll = useShownMessages(messages);
  // The terminal's /srv/chat is this list as it shows it to the viewer.
  useEffect(() => { publishChatBuffer(shownAll); }, [shownAll]);
  const ownIds = useOwnPublicIds();
  const { rows, mentionCandidates, directory, mentionsMe } = useChatRowDerivations({ messages, rendered: shown, userId, ownIds, ownColor, words: lists.words });
  // The Behavior menu's "+ hide someone" field resolves names against this.
  useEffect(() => { publishLiveDirectory(directory, { matrixId: userId ?? null, canonicalId: canonicalId ?? null, ownIds: [...ownIds] }); }, [directory, userId, canonicalId, ownIds]);
  // Hidden site accounts ride the Matrix ignore list too (Community, Element).
  useHiddenIgnoreSync();
  // Behavior › Mention sound. Site chat only — never the /chat window, which
  // doubles as an OBS dock (a ping there would go out on stream).
  // The gate sees the WHOLE buffer (so unhiding someone never replays their old
  // mentions as new); a hidden sender is simply never an alert.
  const alertsMe = useCallback((m: ChatMsg) => !hidesMessage(m) && mentionsMe(m), [hidesMessage, mentionsMe]);
  useMentionSound(messages, alertsMe);
  useEffect(() => { alertsRef.current = alertsMe; }, [alertsMe]);

  // Refresh from the DB (cross-device) — the store setter persists to
  // localStorage and notifies every same-tab subscriber of the key.
  useEffect(() => {
    if (!isSignedIn) return;
    getJson<{ color?: string | null }>("/api/me/color").then(d => {
      if (d.color) setOwnColorLs(d.color);
    }).catch(() => {});
  }, [isSignedIn, setOwnColorLs]);
  const [card, setCard] = useState<{ msg: ChatMsg; box: Box; data: UserCardData | null } | null>(null);
  // This component does not host the mod panel: it is the ModWindow tool
  // window. `bb:open-modpanel` is claimed by whoever hosts the
  // account card (useUserMenuEvents → UserMenu, mounted in this sidebar's own
  // ChatInput), which opens its window. A user card's shield just dispatches
  // the event.

  // Apply saved chat font size and timestamps toggle for all users. Also re-read
  // the two non-CSS toggles when the page-load hydrator pulls cross-device
  // settings (SettingsHydrator fires `bb:settings-hydrated` after writing
  // localStorage) so a second device updates without opening the settings panel.
  useEffect(() => {
    const sync = () => {
      const saved = lsGet("chatFontSize");
      if (saved) document.documentElement.style.setProperty("--chat-font-size", saved);
      setShowTimestamps(lsGet("showTimestamps") === "true");
      setShowMatrixName(lsGet("chatStyle_showMatrixName") === "1");
    };
    sync();
    window.addEventListener("bb:settings-hydrated", sync);
    return () => window.removeEventListener("bb:settings-hydrated", sync);
  }, []);

  // Username click → open the user card, centred over the chat column. The click
  // position is deliberately NOT used: anchoring to it lets the card get
  // clipped near a viewport edge. `el` is kept in the signature because
  // ChatMessage's callback contract passes it and ChatOverlay still anchors.
  // Stable identity so memoized ChatMessage rows don't re-render on it.
  //
  // Data-before-visible: the card is content-fit, so opening before its lookup
  // resolves means the panel measures a spinner and every later byte moves
  // visible layout (an entry stutter). The
  // press already prefetched (ChatMessage's onPointerDown), so this await is
  // usually a settled promise; the cap bounds the cold path, and a cap miss
  // opens the card with its loading block.
  // The seq guard keeps rapid clicks on different names last-click-wins even
  // if their gates resolve out of order.
  const openSeqRef = useRef(0);
  const openUserCard = useCallback((msg: ChatMsg) => {
    const host = asideRef.current?.getBoundingClientRect() ?? null;
    const box = centeredBox(host, USER_CARD_W, USER_CARD_H + 140, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    const seq = ++openSeqRef.current;
    void userCardDataWithin(msg, USER_CARD_OPEN_CAP_MS).then((data) => {
      if (openSeqRef.current === seq) setCard({ msg, box, data });
    });
  }, [setCard, asideRef]);

  // No outside-click close on the user card, deliberately. It sits ALONGSIDE
  // the page rather than over it — same rule as the account card — and closing
  // it on any stray click is the same class of surprise as closing it on
  // scroll. Close, Escape and popout are the ways out.

  const handleSendMessage = useSendChatMessage(setBanExpiry);

  // ── Pager panes ─────────────────────────────────────────────────────────────
  // Every pane body is built ONCE and handed to whichever skin the middle is
  // wearing, so each of them — and the refs inside the live column (liveColRef,
  // scrollRef, composerRef) — exists exactly once in the tree. Building the
  // element is not mounting it: React only runs a component when the element is
  // rendered, so a slot that renders nothing costs nothing (this is what keeps
  // MatrixPanel's dynamic chunk and the feed poll off the desktop path).
  const liveColumnEl = (
    <div
      // `key` + this element's fixed slot below are what let a half-typed
      // ChatInput draft survive a rotation across 767px — see the middle's own
      // note. It is load-bearing state plumbing, not list bookkeeping.
      key="live"
      ref={liveColRef}
      // Under the pager this element IS the pane slot (no wrapper — a wrapper
      // would be an extra tree level on one side of the flip and would remount
      // everything below it). At rest every non-active pane is inert; off the
      // pager the term is `false`, so React writes no attribute at all.
      inert={pagerOn && activePane !== "live"}
      className={
        // In the pager the ROW's scroll position is what puts a pane on
        // screen, so the live column is always visible and takes the pane
        // geometry. `liveVisible` is the desktop/split tab switcher: applying
        // it under the pager would blank this pane the moment a swipe
        // committed Matrix — i.e. for the whole swipe BACK.
        pagerOn
          ? `${PANE_SLOT} relative`
          : liveVisible
            ? `relative flex flex-col min-h-0 ${split ? "shrink-0" : "flex-1 min-w-0"}`
            : "hidden"
      }
      style={split ? liveColStyle : undefined}
    >
      {/* Messages — the relative wrapper hosts the jump-to-bottom pill and
          the pinned banner, which OVERLAYS the list (absolute) so messages
          scroll behind its frosted glass; the scroll area pads its top by
          the banner's measured height so nothing hides under it at rest.
          In compact view it translates up by the composer height while the
          typing bar is revealed, so the chat slides up with it. */}
      <div
        className={`chat-msg-area relative flex-1 min-h-0 flex flex-col ${compactOverlay ? "transition-transform duration-(--anim-default) anim-ease" : ""}`}
        // The panel BODY tint = the message area only (the space where messages
        // are read). Not the aside, not the pane row: the tab strip and the
        // typing bar are see-through bars, and any body tint behind them would
        // show through and move with Body strength.
        // The pin offset sits HERE so both the scroller's fade mask
        // and the area's top darkening (globals.css) start below the pin.
        style={{
          background: "var(--panel-tint-body)",
          ...(compactOverlay && composerOpen ? { transform: `translateY(-${composerH}px)` } : null),
          ...(pinShown ? { "--chat-fade-top": `${pinHeight}px` } : null),
        } as CSSProperties}
      >
        <div
          ref={scrollRef}
          // Do NOT close the user card here. A new message auto-scrolls
          // the anchored list, which fires onScroll, so closing on scroll would
          // make the card vanish whenever chat moves. The card is centred and
          // draggable, not anchored to a message row.
          onScroll={() => { handleScroll(); dismissPreview(); }}
          // Anchored: native scroll anchoring off — it would fight the
          // bottom lock. Paused: on — it keeps the reading position
          // stable through image loads and deletions above the viewport.
          // `overflow-x-clip` is LOAD-BEARING, not tidiness: a large sticker
          // expanding outside the area must not allow side scrolling.
          // `overflow-y-auto` with `overflow-x` unset computes to `auto` per
          // spec, so this element would be a horizontal scroller — and
          // `no-scrollbar` would hide the bar, so the whole conversation would
          // slide sideways on a swipe. A boosted sticker reaches 4.2em × 4.0 =
          // 16.8em and deliberately carries `max-width: none` (a boosted
          // sticker may grow past the row rather than be squeezed narrower).
          // Both stay true: it still grows, it just gets cropped at the column
          // edge instead of dragging the column with it.
          // `clip`, not `hidden` — `hidden` makes this a scroll container
          // in its own right, which is what we are removing.
          // `overscroll-y-contain`, NOT the bare `overscroll-contain`. Per spec
          // `overflow-x-clip` with `overflow-y-auto` computes to
          // `overflow-x: hidden` — this element IS a horizontal scroll
          // container — and `overscroll-behavior-x: contain` blocks
          // scroll-CHAINING on that axis even with zero scrollable range, so a
          // both-axes contain would eat every horizontal pan starting over
          // chat content: it would neither scroll here (not user-scrollable)
          // nor chain to the pager row above. `overscroll-y-contain` keeps the
          // vertical containment this class exists for (stop chat overscroll
          // from chaining into the page) while leaving the horizontal axis free
          // to chain into the pager. `overflow-x-clip` is untouched, so the
          // layer stays not-user-scrollable horizontally; only chaining changes.
          className={`chat-scroll-layer flex-1 overflow-y-auto overflow-x-clip overscroll-y-contain pt-1 pb-2 no-scrollbar ${
            anchored ? "[overflow-anchor:none]" : "[overflow-anchor:auto]"
          }`}
          style={pinShown ? { paddingTop: pinHeight } : undefined}
        >
          {/* Content wrapper — the bottom lock observes its size so font
              and emote-load growth keep the view pinned.
              role="log" + polite live region: appended messages are announced
              to screen readers (aria-relevant defaults to additions) without
              interrupting; older rows changing/removing above the fold stay
              silent. ARIA attrs don't affect the observed size. */}
          <div
            ref={contentRef}
            className="flex flex-col"
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
            {!chatInTerminal && heldLines
              .filter((h) => !h.afterKey || !rows.some((r) => chatKey(r.msg) === h.afterKey))
              .map((h) => <HeldLine key={`held-${h.rowId}`} line={h} onDismiss={dismissHeld} />)}
            {!chatInTerminal && rows.map((row) => {
              const msg = row.msg;
              const heldAfter = heldLines.length ? heldLines.filter((h) => h.afterKey === chatKey(msg)) : [];
              return (
                <Fragment key={`${msg.platform}-${msg.id}`}>
                <ChatMessage
                  msg={msg}
                  emotes={emotes}
                  compact={row.compact}
                  showTimestamps={showTimestamps}
                  tsFormat={tsFormat}
                  stillEmotes={stillEmotes}
                  tick={tick}
                  showMatrixName={showMatrixName}
                  onUsernameClick={openUserCard}
                  onReply={isSignedIn ? handleReply : undefined}
                  onVote={isSignedIn && !row.isOwn && !row.isOwnStream ? handleVote : undefined}
                  onPin={isSignedIn && isMod ? handlePin : undefined}
                  onModDelete={isMod ? handleDelete : undefined}
                  onBoost={isSignedIn ? handleStickerBoost : undefined}
                  onReplyHover={handleReplyHover}
                  onReplyJump={onReplyJump}
                  onReplyPreview={onReplyPreview}
                  replyTargetHighlight={
                    (replyHoverTarget !== null && String(msg.id) === String(replyHoverTarget))
                    || (flashKey !== null && flashKey === chatKey(msg))
                  }
                  selected={!!replyTo && replyTo.id === msg.id && replyTo.platform === msg.platform}
                  highlight={row.highlight}
                  own={row.isOwn || row.isOwnStream}
                  maskSwears={maskSwears}
                  quoteHidden={!!row.msg.reply_to_username && hiddenNames.has(row.msg.reply_to_username.toLowerCase())}
                  directory={directory}
                  spotlight={spotlightKey !== null && spotlightKey === chatKey(msg)}
                  onSpotlight={isAdmin ? handleSpotlight : undefined}
                />
                {heldAfter.map((h) => <HeldLine key={`held-${h.rowId}`} line={h} onDismiss={dismissHeld} />)}
                </Fragment>
              );
            })}
          </div>
        </div>
        {/* Directly after the scroller — it targets its previous sibling. */}
        {initialMessages && initialMessages.length > 0 && <ScrollBottomBeforeHydration />}
        {pin && pin.id !== dismissedPinId && (
          <PinnedBanner
            pin={pin}
            emotes={emotes}
            isMod={isMod}
            onUnpin={handleUnpin}
            onDismiss={() => dismissPin(pin.id)}
            onHeightChange={setPinHeight}
          />
        )}
        {/* Counts only what the viewer will SEE — hidden people / bots waiting in
            the queue are not "new messages" (half-B review I5). */}
        {!anchored && <PausedPill queued={Math.max(0, shownAll.length - shown.length)} onClick={anchorToBottom} />}
        <ReplyPreview preview={preview} />
        {/* A notice with no composer to say it in (signed out, timed out) — the
            composer's own line covers everyone else. */}
        {noticeText && !(isSignedIn && banExpiry === undefined) && (
          <div
            role="status"
            className="absolute bottom-2 left-1/2 -translate-x-1/2 z-10 rounded-full border border-edge bg-surface-2 px-3 py-1 text-xs text-body-dim"
          >
            {noticeText}
          </div>
        )}
        {/* Socket drop with messages on screen: without this, `connected`
            only ever changed the EMPTY state's copy, so mid-stream drops
            (reconnect backoff reaches 30s) froze the feed with no signal —
            a quiet chat that was actually a dead socket. role="status",
            not alert: a blip is context, not an interruption
            (reconnectIndicator.test.ts). Cleared by onOpen → connected. */}
        {!connected && messages.length > 0 && (
          <div
            role="status"
            className="absolute top-2 left-1/2 -translate-x-1/2 z-10 rounded-full border border-edge bg-surface-2 px-3 py-1 text-xs text-body-dim"
          >
            Reconnecting to chat…
          </div>
        )}
        <WindowLayerTarget pane="live" />
      </div>

      {/* A SIBLING of the scroll container, never a child — held messages
          expire on Twitch in ~5 minutes, so a row that scrolled away during
          a busy stream would let holds expire unseen.
          Sits BETWEEN the messages and the composer rather than above the
          messages: it is a thing you ACT on, so it belongs next to the other
          controls, not stacked on top of the reading area. Renders nothing at
          all when the queue is empty. */}
      <AutomodHoldBar
        isMod={isMod}
        // Synthesize the minimal ChatMsg the card needs. The card resolves
        // everything else (profile, badges, platform reach) from the ids —
        // a review row is not a chat message, but it identifies the same
        // person, which is all the card requires.
        onModerate={(who) =>
          openUserCard({
            id: `automod:${who.matrixId ?? who.canonicalId ?? who.username}`,
            platform: who.platform,
            username: who.username,
            message: "",
            matrixId: who.matrixId,
            canonicalId: who.canonicalId,
          } as ChatMsg)
        }
      />

      {/* The help desk: in the column, between the messages and the composer — never a
          pop-up over the page (see SupportPanel). NOT gated on isPopout: `supportEnabled` below
          also puts the SUPPORT sentinel in the send-to cycle, and arming a destination with no
          panel to show is exactly what the prune deletes. */}
      {supportActive && supportConvo.state && (
        <SupportPanel
          state={supportConvo.state}
          onPick={handleSupportPick}
          onClose={closeSupport}
          self={{
            name: userId ? localpart(userId) : "you",
            color: ownColor || null,
            badges: badgesForMatrixId(badgeState, userId),
          }}
        />
      )}

      {/* The chat panel's BOTTOM Bar. In desktop compact it is an overlay
          parked below the panel, revealed by THREE independent signals
          `composerOpen` tracks as an OR: proximity —
          Bar's own coordinate-driven pointermove listener, invisible to
          React until Bar tells us via `onRevealChange` (reports ONLY
          its own nearEdge, never echoes `revealed` — see that prop's
          docblock for the latch this avoids) — real hover on the bar's
          own (already on-screen) box via onMouseEnter/onMouseLeave, and
          keyboard/typing focus via onFocusCapture/onBlurCapture. A CSS
          pseudo-class matching fires no DOM event by itself, so a
          parked, off-screen bar could never be hover-opened without
          proximity getting it on-screen first — hover only ever takes
          over FROM there. `composerOpen` is the OR of all three
          (`syncComposerOpen`, above): any one of them can open it, and
          closing requires ALL three to have released — one signal's
          release must never override another's still-active hold (the
          pointer can leave the bar's own box while still inside Bar's
          96px proximity band, or proximity can release while the mouse
          is still literally on the bar; either alone closing anyway is
          the "mouseleave fights proximity" failure this OR exists to
          rule out). This is what lets the messages translate up by the
          composer's measured height in sync (the wrapper above) in BOTH
          directions — reveal and release — not just on the way in. The
          fill: in flow, --panel-tint-bar (the panel tint at bar
          strength); floating/compact, the glass fill. Translucent, NOT
          glass. */}
      <Bar
        slot="bottom"
        name="chat-bottom"
        hidden={composerReplaced}
        overlay={!!compactOverlay}
        revealed={composerOpen}
        ref={composerRef}
        standDown={windowOpen}
        background={compactOverlay ? "var(--glass-bg)" : "var(--panel-bar-bg)"}
        onMouseEnter={compactOverlay ? () => { composerHoverRef.current = true; syncComposerOpen(); } : undefined}
        onMouseLeave={compactOverlay ? () => { composerHoverRef.current = false; syncComposerOpen(); } : undefined}
        onFocusCapture={compactOverlay ? () => { composerFocusedRef.current = true; syncComposerOpen(); } : undefined}
        onBlurCapture={compactOverlay ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) { composerFocusedRef.current = false; syncComposerOpen(); } } : undefined}
        // Proximity's third of the OR: `near` is
        // Bar's OWN nearEdge, reported directly — never `revealed`, so
        // there is nothing here to echo back into a latch.
        onRevealChange={compactOverlay ? (near) => { composerNearRef.current = near; syncComposerOpen(); } : undefined}
        center={
          <>
            {isSignedIn && banExpiry === undefined ? (
              <ChatInput
                replyTo={replyTo}
                onClearReply={() => setReplyTo(null)}
                onRestoreReply={setReplyTo}
                mentionCandidates={mentionCandidates}
                isMod={isMod}
                onSendMessage={handleSendMessage}
                anchorToBottom={anchorToBottom}
                onScrollKey={(k) => { const el = scrollRef.current; if (el) scrollChatByKey(el, k, anchorToBottom, pause); }}
                matrixId={userId ?? null}
                canonicalId={canonicalId ?? null}
                onShowTimestampsChange={setShowTimestamps}
                onShowMatrixNameChange={setShowMatrixName}
                isPopout={!!isPopout}
                supportEnabled
                onSupportText={convoSendText}
                onSupportOpen={openSupportWith}
                onSupportClose={closeSupport}
                onSupportModeChange={handleSupportModeChange}
                onRegisterSupportControls={registerSupportControls}
              />
            ) : !isSignedIn ? (
              /* Signed out: the typing bar itself is the sign-in CTA. Shape,
                 padding and height are the Bar's — the same primitive the
                 signed-in composer and the video panel's MetaBar render, so
                 this strip cannot drift from either.

                 The About/Privacy links ride the same row: this is the one
                 strip guaranteed visible on the anonymous home page (the
                 meta bar's copy sits in the collapsed-by-default, `inert`
                 meta row), and Google OAuth verification wants the privacy
                 policy reachable without sign-in. One row, not a second
                 line — nothing here flags `data-chrome-grow`, so the Bar
                 stays exactly one token tall. */
              <div className="flex items-center gap-3 w-full">
                <a
                  href="/auth/signin"
                  className="flex-1 min-w-0 text-center text-sm font-medium text-strong bg-surface-2 hover:bg-surface-3 border border-edge rounded px-3 py-2 transition-colors"
                >
                  Sign in to chat
                </a>
                <span className="shrink-0 text-xs text-muted whitespace-nowrap">
                  <a href="/about" className="hover:text-body-dim transition-colors">About</a>
                  {" · "}
                  <a href="/legal#privacy" className="hover:text-body-dim transition-colors">Privacy</a>
                </span>
              </div>
            ) : (
              /* Banned/timed out: the COMPOSER is the punishment, not the
                 account. UserMenu hosts the only listener for every
                 `bb:open-*` event (store, support, settings, mod panel…) —
                 if this branch replaced ChatInput it would silently unmount that
                 hub, so a routine 10-minute timeout would remove settings/support/
                 sign-out and turn the MetaBar's Donate/Subscribe/points buttons
                 into no-ops. The avatar rides beside the notice in the same
                 Bar as the other two branches, so the baseline with the
                 MetaBar holds (bannedSurface.test.ts). */
              <div className="flex items-center gap-3 w-full">
                <UserMenu
                  matrixId={userId ?? null}
                  canonicalId={canonicalId ?? null}
                  onShowTimestampsChange={setShowTimestamps}
                  onShowMatrixNameChange={setShowMatrixName}
                  isPopout={!!isPopout}
                />
                {banExpiry === null ? (
                  <p className="flex-1 min-w-0 text-center text-xs text-red-400">You are banned from chat.</p>
                ) : (
                  <p className="flex-1 min-w-0 text-center text-xs text-yellow-400">
                    Timed out — {formatRemaining(new Date(banExpiry as string).getTime() - nowTick)} remaining
                  </p>
                )}
              </div>
            )}
            {/* One-time close hint. Stays INSIDE the
                Bar: it is `bottom-full`, so it needs the composer's own box
                as its containing block — pinned to the panel column instead
                it would float above the whole chat. Absolutely positioned,
                so it is out of flow and cannot widen the bar. */}
            {supportHint && (
              <div className="pointer-events-none absolute bottom-full left-2 right-2 mb-1 rounded border border-edge bg-surface-2 px-2 py-1 text-center text-xs text-body-dim">
                {CLOSE_HINT}
              </div>
            )}
          </>
        }
      />
    </div>
  );

  const matrixPanelEl = (
    <MatrixPanel hideUserMenu={split && isSignedIn} />
  );

  const newsPaneEl = (
    <div className="flex flex-col flex-1 min-h-0 min-w-0">
      <FeedPanel view="list" active openStory={pendingStory} onStoryConsumed={consumeStory} />
    </div>
  );
  const vodsPaneEl = (
    <div className="relative flex flex-col flex-1 min-h-0 min-w-0">
      <VodList vods={vods} activeId={selectedVodId} onPick={onPickVod ?? (() => {})} />
    </div>
  );
  const forumsPaneEl = (
    <div className="flex flex-col flex-1 min-h-0 min-w-0">
      <ForumsTab active={activePane === "forums"} signedIn={isSignedIn} openThread={pendingThread} onThreadConsumed={consumeThread} />
    </div>
  );
  const streamPaneEl = (
    <div className="flex flex-col flex-1 min-h-0 min-w-0">
      <StreamTab active={activePane === "stream"} />
    </div>
  );
  const homePaneEl = (
    <div className="flex flex-col flex-1 min-h-0 min-w-0">
      <HomeTab
        active={activePane === "home"}
        initial={homeInitial ?? null}
        signedIn={isSignedIn}
        variant="grid"
        selectedVodId={selectedVodId}
        onPickVod={onPickVod ?? (() => {})}
        onWatchCommunity={onWatchCommunity ?? (() => {})}
        onOpenNews={openNewsOn}
      />
    </div>
  );

  return (
    // `--live-col-w` is the COMMITTED live-column width, published so the top
    // bar's split header can put its split line on the real divider. The drag
    // itself rewrites this same property on this same element (useChatSplitView)
    // so the header follows a finger without a re-render; this is what a render
    // triggered by anything else restores it to. Unsplit it is absent — and
    // `Panes` is not rendered then either.
    // --pane-chrome-above: what this pane host puts, IN FLOW, between the
    // lifted element's top and its window layers — the tab bar, and nothing
    // else (the layer's own box already starts below it). A window layer
    // inside a keyboard-lifted panel subtracts this to find its ceiling
    // (chrome.css .chrome-window-layer); without it the layer clamps to the
    // wrong edge and a panel's band lands under the video column.
    // `var(--chrome-top-h)`, NOT a number: that token is
    // `--tab-size + 22px`, so the bar's height moves with the user's chat-size
    // setting — and it is the SAME token `.chrome-bar-top` sizes itself with
    // and `[data-state="hidden"]` pulls itself out by. Referencing it is what
    // makes this survive a customization; measuring the bar would not.
    // Zero the moment the bar stops occupying flow: hidden on mobile compact
    // (same boolean ChatTabBar gets), or lifted OUT of flow by desktop
    // compact's overlay state.
    <aside ref={asideRef} className="relative flex-1 flex flex-col overflow-hidden" style={split ? ({ "--live-col-w": `${liveColW}px` } as React.CSSProperties) : undefined}>
      {/* A timeout or ban from the ⋯ menu acts at once; this offers its Undo. */}
      {isMod && <ModUndoToast />}
      <ChatTabBar
        compactOverlay={!!compactOverlay}
        onToggleCompact={onToggleCompact}
        compact={compact}
        split={split}
        setSplitPref={setSplitPref}
        tab={tab}
        setTab={setTab}
        liveUnseen={liveUnseen}
        matrixUnseen={matrixUnseen}
        setMatrixOpened={setMatrixOpened}
        narrow={narrow}
        contentTabs={contentTabs}
        contentTab={contentTab}
        setContentTab={setContentTab}
        unarmedTabs={unarmedTabs}
        onArmTab={onArmTab}
        onCloseContentTab={onCloseContentTab}
        splitAvailable={splitAvailable}
        onToggleFull={onToggleFull}
        onFoldChat={onFoldChat}
        isFull={isFull}
        fullKind={fullKind}
        // The band tracks a finger while the pager is hot, and a tab click
        // becomes a scroll — but only while the pager actually owns motion.
        // Off the pager a click calls `selectPane` directly; either way it is
        // this one function that commits, never a copy of it in the bar.
        selectPane={selectPane}
        progress={pagerProgress}
        requestPane={pagerOn ? requestPane : undefined}
        mobileHidden={mobileCompactHidden || composerReplaced}
      />

      {/* ── The middle. On narrow it is the pager — ONE horizontal snap row,
           children in `paneKeys` order. Native scroll-snap owns
           the physics: snap points, axis-locking against each pane's own
           vertical scroller, per-gesture target selection. `snap-always` is one
           pane per swipe, `overscroll-x-contain` keeps a rubber-band at the
           edges from becoming a history navigation, and vertical scrolling
           belongs to the panes, never to this row. Off the pager it is the
           live/matrix pair wrapper.

           ONE ELEMENT, TWO SKINS — deliberately NOT `pagerOn ? <div…> :
           <div…>`. Both forms render a div here, but React reconciles by
           position AND shape, and a ternary that swaps a keyed child LIST for
           static children changes the shape: the whole column would unmount on
           every flip. `narrow` and `split` both flip in normal use (rotating a
           phone across 767px; toggling split in the 640–767px band where the
           two overlap), and a remount there throws away a half-typed ChatInput
           draft and MatrixView's list anchor.
           What keeps it alive: this container stays ONE element at ONE slot in
           the aside, and the heavy children keep STABLE MATCHING KEYS across
           the flip — `key="live"` (liveColumnEl itself is the pane slot, so
           there is no extra tree level on one side) and `key="matrix"`. Change
           either — a wrapper around the live column on one side, a key drop, a
           second element type here — and the column remounts again. Content
           panes and the divider are keyed too but may remount: they hold no
           typed state. (chatPager.test.ts pins the keys; that the draft
           survives rotation is a real-browser check.) ── */}
      <div
        // Handed over unconditionally: with `enabled: false` every effect in
        // usePanePager returns early and `requestPane` commits without touching
        // the DOM, so off the pager this ref is inert — and a ref that came and
        // went would be one more thing changing across the flip.
        ref={pagerScrollerRef}
        className={
          pagerOn
            ? "flex flex-1 min-h-0 overflow-x-auto overflow-y-hidden snap-x snap-mandatory overscroll-x-contain no-scrollbar"
            : `flex flex-1 min-h-0 ${contentTab !== null ? "hidden" : ""}`
        }
      >
        {/* Leading content panes (Home) — before the pinned pair, in `paneKeys`
            order. Same literal guards as the trailing map below. */}
        {pagerOn && leadingTabs.map(({ key: k }) => (
          <div key={k} inert={k !== activePane} className={`${PANE_SLOT} relative`}>
            {k === "home" && paneMounted("home") && homePaneEl}
            <WindowLayerTarget pane={k} />
          </div>
        ))}
        {/* ── Live chat column — the first pinned pane; off the pager, locked to
             the left side of the split. Carries key="live" (see the note above). ── */}
        {liveColumnEl}

        {/* ── Split divider — a plain line; drag to resize the live column ── */}
        {!pagerOn && split && (
          <div
            key="divider"
            className="w-1 shrink-0 cursor-col-resize flex justify-center group/divider touch-none"
            {...dividerHandlers}
          >
            <div className="w-px h-full bg-surface-3 group-hover/divider:bg-surface-5 transition-colors" />
          </div>
        )}

        {/* ── Matrix column — mounted once opened, kept alive (hidden off the
             pager) to preserve sync; the second pane, and the right side of the
             split. hideUserMenu tells the panel a UserMenu is mounted in the
             live pane — split AND signed in; signed out the composer is a
             sign-in CTA.
             Approach never latches — only a commit (settle) or a bar click
             starts the Matrix client. Live and Matrix keep their mount rules
             (always / latched-once-opened); the pager never unmounts
             either. ── */}
        <div
          key="matrix"
          inert={pagerOn && activePane !== "matrix"}
          className={
            pagerOn
              ? PANE_SLOT
              : matrixVisible ? "flex flex-col flex-1 min-h-0 min-w-0" : "hidden"
          }
          // Community's reading area carries the same body tint.
          style={{ background: "var(--panel-tint-body)" }}
        >
          {matrixOpened ? matrixPanelEl : null}
        </div>

        {/* The WIDENED registry mount contract (tabRegistry.ts):
            a content pane renders while it is the committed tab OR while a live
            pager motion holds it within one pane of the viewport. Still a
            literal per-key guard, so adding a registry tab cannot forget this
            host. Same `contentTabs` list, same order, as the bar's items. */}
        {pagerOn && restTabs.map(({ key: k }) => (
          <div key={k} inert={k !== activePane} className={`${PANE_SLOT} relative`}>
            {k === "forums" && paneMounted("forums") && forumsPaneEl}
            {k === "news" && paneMounted("news") && newsPaneEl}
            {k === "vods" && paneMounted("vods") && vodsPaneEl}
            {k === "stream" && paneMounted("stream") && isAdmin && streamPaneEl}
            <WindowLayerTarget pane={k} />
          </div>
        ))}
      </div>

      {/* Armed content tabs, OFF the pager — literal per-key guards,
          UNMOUNTED when inactive (the registry contract's at-rest half: render
          only when active — what keeps polls dead and, structurally, what
          protects the Matrix lazy-start when a community tab arrives).
          Not desktop-only: narrow (<768px) and split (a panel ≥640px) overlap
          in a 640–767px band, and a content tab open there must still render —
          the pager yields to the split pair, so this is where it renders.
          `!pagerOn` is what keeps it from being a SECOND mount of the same pane
          while the row already holds one. */}
      {!pagerOn && contentTab === "home" && homePaneEl}
      {!pagerOn && contentTab === "forums" && forumsPaneEl}
      {!pagerOn && contentTab === "news" && newsPaneEl}
      {!pagerOn && contentTab === "vods" && vodsPaneEl}
      {!pagerOn && contentTab === "stream" && isAdmin && streamPaneEl}

      <FoldedTabControl
        asideRef={asideRef}
        tab={tab}
        setTab={setTab}
        split={split}
        setSplitPref={setSplitPref}
        setMatrixOpened={setMatrixOpened}
        liveUnseen={liveUnseen}
        matrixUnseen={matrixUnseen}
        splitAvailable={splitAvailable}
        onToggleFull={onToggleFull}
        isFull={isFull}
        fullKind={fullKind}
        onLeaveContentTab={() => setContentTab(null)}
        compact={compact}
        onToggleCompact={onToggleCompact}
      />

      {/* Direct messages and announcements slide up in the chat column. Each
          host renders nothing until it has something to show. */}
      <DmHost />
      <AnnounceHost />

      {/* User card — the SAME shell the account card uses, opened centred over
          the chat column. The floating Window portals itself to <body>
          (escaping this sidebar's backdrop-blur containing block), so there is
          no wrapper here. No storageKey: user cards are per-person and
          transient, and persisting one person's geometry onto the next card
          would be wrong. `key` per message so clicking a different name
          re-seeds the box. */}
      {card && (
        <Window
          // The HOST picks the presentation from the one device signal the app
          // already has — Window itself never reads matchMedia. Crossing the
          // breakpoint swaps components live; safe: the stack and all page
          // state live up here. PANEL/peek on narrow: the user card is meant
          // to be small so you can peek at it while chatting — a content-fit,
          // non-modal peek keeps the chat visible and live above; full-screen
          // would invert the intent.
          presentation={cardWin.presentation}
          dock={cardWin.dock}
          kind="peek"
          key={card.msg.id}
          name={localpart(card.msg.username)}
          title={localpart(card.msg.username)}
          onClose={() => setCard(null)}
          initialBox={card.box}
          popoutUrl={userCardPopoutUrl(card.msg)}
          fitHeight
        >
          <UserCard
            msg={card.msg}
            initialData={card.data}
            isMod={isMod}
            onClose={() => setCard(null)}
            // The Message button opens the DM window, never the Community tab.
            onStartDM={(matrixId) => { requestDm({ kind: "open", to: { matrixId, username: localpart(matrixId), displayName: card.msg.username } }); }}
            onOpenModPanel={(target) =>
              // The mod panel is the ModWindow tool window. Note the
              // card does NOT stay open — UserCard's shield handler calls
              // onClose() right after this dispatch.
              dispatchClaimable("bb:open-modpanel", { target })
            }
            liveMessages={messages}
          />
        </Window>
      )}
    </aside>
  );
}
