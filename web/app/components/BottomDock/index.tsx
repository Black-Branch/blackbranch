"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { subscribeHomeStore, readHomeStore } from "@/app/lib/homeStore";
import { Plus } from "@phosphor-icons/react/dist/ssr";
import FeedPanel from "@/app/components/FeedPanel";
import { HomeTab } from "@/app/features/home";
import { ForumsTab } from "@/app/features/forums";
import { StreamTab } from "@/app/features/stream";
import VodList from "@/app/components/VodList";
import { Bar, Sections } from "@/app/components/chrome";
import { FloatingPicker } from "@/app/components/FloatingPicker";
import { CHROME_TOP_H, readChromePx } from "@/app/lib/chrome/chromeTokens";
import {
  readDockTab, writeDockTab, dockShown, contentAvail,
} from "@/app/lib/dockState";
import {
  DOCK_DEFAULT_ARMED, readArmed, writeArmed, armTab, closeTab,
  partitionTabs, clampOpen, openAfterClose, armFlagKey, armOnce, isPinnedTab, type SiteTabKey,
} from "@/app/lib/tabRegistry";
import { OPEN_FORUM_THREAD_EVENT, readThreadDetail, type ThreadRef } from "@/app/lib/forumLinks";
import { claimEvent } from "@/app/lib/claimableEvent";
import { narrowViewportNow } from "@/app/lib/useNarrowViewport";
import { viewForHeight } from "@/app/lib/feedMode";
import { useFeedResize } from "@/app/lib/useFeedResize";
import { useLocalStorageString } from "@/app/lib/useClientState";
import { type Vod } from "@/app/lib/vods";
import type { HomePayload } from "@/app/lib/homePayload";
import type { RssItem } from "@/app/lib/rssServer";

// The bottom dock — the space under the video, as a tabbed, collapsible strip.
// Its CONTENT sits directly on the site background (no surface of its own);
// its tab row is a band Bar, so the Console shade runs across the row.
// Three states:
// - FADED: a space outcome. Open with no room for content → the WHOLE dock
//   fades, tabs included (a tab row you can't open anything under is noise);
//   collapsed with no room for even the row → same. Everything stays mounted
//   at opacity 0 so the transition runs both ways; content gets active=false.
// - COLLAPSED: a user choice. Tab row only — the content is UNMOUNTED (after
//   its pull-up exit animation), so e.g. useRssFeed's poll cannot run. The
//   Sections strip shows nothing selected then (`value` null: no hole, no cap).
// - OPEN: tab row + the tab's content.
//
// The dock consumes leftover space only — the video (chat resize) and the
// sidebar keep priority.
export default function BottomDock({
  videoColRef,
  barsOverlay,
  vods,
  selectedVodId,
  onPickVod,
  homeInitial,
  isSignedIn,
  live,
  isAdmin = false,
  onWatchCommunity,
}: {
  videoColRef: RefObject<HTMLDivElement | null>;
  /** Desktop compact: the tab row leaves the flow as a hover-revealed
   *  overlay, the content keeps the whole height. */
  barsOverlay: boolean;
  vods: Vod[];
  selectedVodId: string | null;
  onPickVod: (v: Vod) => void;
  /** The Home body from the server render. */
  homeInitial: HomePayload | null;
  /** Home's signed-out column vs the signed-in page. */
  isSignedIn: boolean;
  /** Live: Home is a compact row under the player. */
  live: boolean;
  /** The owner's account (site.users.is_admin, from the server render): the Stream tab's readiness. */
  isAdmin?: boolean;
  /** Home's "<name> is live → Watch" switches the player to Community. */
  onWatchCommunity: () => void;
}) {
  // Registry-armed tabs (cycle 6b): the armed set persists (dock_armed) and
  // display filters to what this host can show right now — persistence ≠
  // display, tabRegistry.ts says why. The readiness Record is exhaustive over
  // SiteTabKey, so a new registry tab does not compile here until the dock
  // says whether it has anything to show.
  const [armedRaw, setArmedRaw] = useLocalStorageString("dock_armed");
  const armed = readArmed(armedRaw, DOCK_DEFAULT_ARMED);
  // A one-time arm: existing devices get Home added to their stored list
  // once; the flag makes a later close stick.
  const [homeArmFlag, setHomeArmFlag] = useLocalStorageString(armFlagKey("home", "dock"));
  useEffect(() => {
    if (homeArmFlag === "1") return;
    const next = armOnce(armedRaw, homeArmFlag, DOCK_DEFAULT_ARMED, "home");
    if (next !== null) setArmedRaw(next);
    setHomeArmFlag("1");
  }, [homeArmFlag, armedRaw, setArmedRaw, setHomeArmFlag]);
  // Forums: the same once, in the dock only.
  const [forumsArmFlag, setForumsArmFlag] = useLocalStorageString(armFlagKey("forums", "dock"));
  useEffect(() => {
    if (forumsArmFlag === "1") return;
    const next = armOnce(armedRaw, forumsArmFlag, DOCK_DEFAULT_ARMED, "forums");
    if (next !== null) setArmedRaw(next);
    setForumsArmFlag("1");
  }, [forumsArmFlag, armedRaw, setArmedRaw, setForumsArmFlag]);
  // The Stream tab: the same once, for an admin only — a device that is not an admin's spends no
  // flag on it.
  const [streamArmFlag, setStreamArmFlag] = useLocalStorageString(armFlagKey("stream", "dock"));
  useEffect(() => {
    if (!isAdmin || streamArmFlag === "1") return;
    const next = armOnce(armedRaw, streamArmFlag, DOCK_DEFAULT_ARMED, "stream");
    if (next !== null) setArmedRaw(next);
    setStreamArmFlag("1");
  }, [isAdmin, streamArmFlag, armedRaw, setArmedRaw, setStreamArmFlag]);
  const newsHasItems = (useSyncExternalStore(subscribeHomeStore, readHomeStore, () => null)?.news?.length ?? 0) > 0;
  const { shown, tabs, unarmed } = partitionTabs(armed, {
    home: true,
    forums: true,
    // Hidden until a feed has items (§0): read from the remembered Home body.
    news: newsHasItems,
    vods: vods.length > 0,
    stream: isAdmin,
  });

  // The user's choice, device-local (same mechanism as feed_manual_h). "" is
  // collapsed; unknown keys fall back to the default (dockState.ts says why),
  // then clamp to a tab that is actually shown (x-ing the open tab, or a
  // stored choice for a tab since un-armed, must not render an orphan pane).
  const [rawTab, setRawTab] = useLocalStorageString("dock_tab");
  const openTab = clampOpen(readDockTab(rawTab, shown), shown);
  const setOpenTab = (t: SiteTabKey | null) => setRawTab(writeDockTab(t));

  // Collapse plays a pull-up EXIT (mirroring the open slide-down) before the
  // content unmounts: `closingTab` keeps the old tab rendered with
  // .dock-tab-out until its animationend, then the unmount happens for real.
  // The stored choice flips to collapsed immediately — only the DOM lingers.
  const [closingTab, setClosingTab] = useState<SiteTabKey | null>(null);
  const collapse = () => {
    if (openTab !== null) setClosingTab(openTab);
    setOpenTab(null);
  };

  // Arming opens (you asked for it, show it); closing hands the open slot to
  // the next armed tab, or collapses with the same pull-up exit collapse uses.
  const onArm = (k: SiteTabKey) => {
    setArmedRaw(writeArmed(armTab(armed, k)));
    setOpenTab(k);
  };
  const onCloseTab = (k: SiteTabKey) => {
    setArmedRaw(writeArmed(closeTab(armed, k)));
    // `shown` is already armed ∩ ready in armed order, so dropping k from it
    // IS the next shown set — no second readiness pass to keep in step.
    const nextOpen = openAfterClose(openTab, k, closeTab(shown, k));
    if (nextOpen !== openTab) setOpenTab(nextOpen);
    if (openTab === k && nextOpen === null) setClosingTab(k);
  };
  // The thread deep link: Home's Active-threads widget (or anything else)
  // asks for a thread; this host claims it on desktop, arms/opens the
  // Forums tab and hands the tab the ref. The arm/open closure changes every
  // render, so the listener reads it through a ref written in an effect; the
  // subscription itself is registered once, in a layout effect (a passive
  // listener can miss a mount-time dispatch).
  const [pendingThread, setPendingThread] = useState<ThreadRef | null>(null);
  const openForumsRef = useRef<() => void>(() => {});
  useEffect(() => { openForumsRef.current = () => (armed.includes("forums") ? setOpenTab("forums") : onArm("forums")); });
  useLayoutEffect(() => {
    const onThread = (e: Event) => {
      if (narrowViewportNow()) return;
      const ref = readThreadDetail(e);
      if (!ref) return;
      claimEvent(e);
      setPendingThread(ref);
      openForumsRef.current();
    };
    window.addEventListener(OPEN_FORUM_THREAD_EVENT, onThread);
    return () => window.removeEventListener(OPEN_FORUM_THREAD_EVENT, onThread);
  }, []);
  const consumeThread = useCallback(() => setPendingThread(null), []);
  // A headline from Home opens the News tab ON that story: the
  // item waits here until FeedPanel mounts and consumes it once — the same
  // handoff as pendingThread, without the window event (Home's callback
  // already reaches this host).
  const [pendingStory, setPendingStory] = useState<RssItem | null>(null);
  const consumeStory = useCallback(() => setPendingStory(null), []);
  const openNewsOn = (item: RssItem) => {
    setPendingStory(item);
    if (armed.includes("news")) setOpenTab("news"); else onArm("news");
  };
  // Reopening (or switching) during the exit cancels it — the fresh mount
  // wins; without this a re-click inside the 300ms window would render the
  // same tab twice.
  if (openTab !== null && closingTab !== null) setClosingTab(null);

  // The tab whose content is in the DOM right now (null = nothing mounted).
  const shownTab = openTab ?? closingTab;

  // The + picker's own state (it lives beside the trigger, not in the menu).
  const [pickerOpen, setPickerOpen] = useState(false);
  const plusRef = useRef<HTMLSpanElement>(null);

  // Drag-to-fill handle between the video and the dock — unchanged mechanism,
  // still writing --feed-height on the video column (useFeedResize).
  const { feedResizeHandlers } = useFeedResize(videoColRef);

  // Space measurement. `leftover` is this block's own height (flex-1 in the
  // video column, so its size is what the video leaves over — no feedback loop
  // with what the dock renders). `tabRowPx` is the TOKEN the row's Bar is
  // exactly as tall as (--chrome-top-h), read back resolved; it changes only
  // with the Tab-size slider / zoom, and when it does the body — the flex-1
  // box under the bar — resizes, which is what re-runs the read.
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [leftoverPx, setLeftoverPx] = useState(0);
  const [tabRowPx, setTabRowPx] = useState(0);
  useEffect(() => {
    const root = rootRef.current;
    const body = bodyRef.current;
    if (!root || !body) return;
    const measure = () => {
      setLeftoverPx(root.clientHeight);
      setTabRowPx(readChromePx(root, CHROME_TOP_H));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    ro.observe(body);
    return () => ro.disconnect();
  }, []);

  // A parked row takes no height from the content (Review Focus 3).
  const rowPx = barsOverlay ? 0 : tabRowPx;
  const avail = contentAvail(leftoverPx, rowPx);

  // News's three-way render (list / ticker / hidden) — viewForHeight and its
  // constants keep their exact current meaning; only the input changed, from
  // the raw leftover to contentAvail. The 30px floor doubles as every tab's
  // content fade threshold, and (via dockShown) as the whole dock's: when the
  // content can't show, the tabs fade with it.
  const view = viewForHeight(avail);
  const visible = dockShown(openTab, leftoverPx, rowPx, view === "hidden");
  // The last non-hidden view — kept so the content stays rendered while it
  // fades (mounted across hidden↔shown so opacity animates both directions).
  const [displayView, setDisplayView] = useState<"ticker" | "list">("ticker");
  if (view !== "hidden" && view !== displayView) setDisplayView(view);
  const contentActive = visible && openTab !== null;

  return (
    <div ref={rootRef} className="relative flex-1 min-h-0 overflow-hidden">
      {/* Drag handle — an OVERLAY at the top edge (no layout space, revealed
          on hover) so when the dock is faded the MetaBar still lines up with
          the chat panel. z-40, not z-10: a Bar is z-index 10 in flow and 30 as
          an overlay (desktop compact), and comes LATER in the DOM, so at a tie
          the bar would paint over the handle and the split could not be
          dragged. The handle takes the top 12px of the row in both states. */}
      <div
        {...feedResizeHandlers}
        title="Drag to resize"
        className="group/fdrag absolute top-0 inset-x-0 h-3 z-40 flex items-start justify-center pt-0.5 cursor-row-resize touch-none"
      >
        <div className="w-10 h-1 rounded-full bg-transparent group-hover/fdrag:bg-surface-5 transition-colors" />
      </div>

      <div
        className={`h-full flex flex-col transition-opacity duration-(--anim-slow) anim-ease ${
          visible ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      >
        {/* The dock's top Bar: the registry's tabs as Sections in a band, with
            the ✕ on the open tab and + for the unarmed ones. Collapsed = the
            Bar alone: `value` null, no hole, no cap. Clicking the open tab
            collapses; an inactive one opens (the one branch the row owns). */}
        <Bar
          slot="top"
          name="dock"
          band
          overlay={barsOverlay}
          background={barsOverlay ? "var(--glass-bg)" : undefined}
          center={
            <Sections
              items={tabs.map((t) => ({ key: t.key, label: t.label, closable: !isPinnedTab(t.key) }))}
              value={openTab}
              onChange={(k) => (k === openTab ? collapse() : setOpenTab(k))}
              onClose={onCloseTab}
              label="Dock sections"
            />
          }
          trailing={unarmed.length > 0 && (
            <span ref={plusRef} className="shrink-0">
              <button
                type="button"
                onClick={() => setPickerOpen((v) => !v)}
                title="Add a tab"
                aria-label="Add a tab"
                aria-expanded={pickerOpen}
                className="px-1.5 py-1 rounded-md text-secondary hover:text-strong transition-colors"
              >
                <Plus size={11} weight="bold" />
              </button>
              {/* A PORTAL, not an absolute child: the strip is overflow-x-auto,
                  which clips an absolutely-positioned menu at the row edge, so
                  the picker would open invisibly. */}
              <FloatingPicker anchorRef={plusRef} open={pickerOpen} onClose={() => setPickerOpen(false)} items={unarmed} onPick={onArm} align="left" />
            </span>
          )}
        />

        {/* The body — ALWAYS mounted, and that is load-bearing twice over: it
            is the box whose resize re-reads --chrome-top-h, and it is where
            the content's own guards live.

            Collapsed means UNMOUNTED — the `shownTab === …` guards below
            are the whole point of the collapse feature (they are what stops
            the RSS poll; during the brief pull-up exit the content is still
            mounted but inert via active=false, and animationend unmounts it).
            Do not replace the guards with a `hidden` class; the faded state
            above is the one that hides-but-keeps-mounted.

            The pane carries NO background or border of its own — the content
            still sits directly on the site background; only the row above it
            is shaded now. Tab content renders BARE inside it: the tab already
            names the pane, so per-component headers are chrome for the OTHER
            hosts (player slot, mobile chat), not here. */}
        <div ref={bodyRef} className="flex-1 min-h-0 flex flex-col">
          {shownTab !== null && (
            <div
              className={`flex-1 min-h-0 overflow-hidden ${
                shownTab === "vods" || shownTab === "home" || shownTab === "forums" || displayView === "list" ? "dock-fade-bottom" : ""
              }`}
              onAnimationEnd={() => { if (openTab === null) setClosingTab(null); }}
            >
              {shownTab === "home" && (
                <div className={`h-full ${closingTab ? "dock-tab-out" : "dock-tab-in"}`}>
                  <HomeTab
                    active={contentActive}
                    initial={homeInitial}
                    signedIn={isSignedIn}
                    variant={live ? "compact" : "grid"}
                    selectedVodId={selectedVodId}
                    onPickVod={onPickVod}
                    onWatchCommunity={onWatchCommunity}
                    onOpenNews={openNewsOn}
                  />
                </div>
              )}
              {shownTab === "forums" && (
                <div className={`h-full ${closingTab ? "dock-tab-out" : "dock-tab-in"}`}>
                  <ForumsTab active={contentActive} signedIn={isSignedIn} openThread={pendingThread} onThreadConsumed={consumeThread} />
                </div>
              )}
              {shownTab === "news" && (
                <div className={`h-full ${closingTab ? "dock-tab-out" : "dock-tab-in"}`}>
                  <FeedPanel view={displayView} active={contentActive} openStory={pendingStory} onStoryConsumed={consumeStory} />
                </div>
              )}
              {shownTab === "vods" && (
                <div className={`relative h-full ${closingTab ? "dock-tab-out" : "dock-tab-in"}`}>
                  <VodList vods={vods} activeId={selectedVodId} onPick={onPickVod} />
                </div>
              )}
              {shownTab === "stream" && isAdmin && (
                <div className={`h-full ${closingTab ? "dock-tab-out" : "dock-tab-in"}`}>
                  <StreamTab active={contentActive} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
