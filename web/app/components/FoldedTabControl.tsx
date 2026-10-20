"use client";

import { useState, useEffect, useRef, type RefObject } from "react";
import { Columns } from "@phosphor-icons/react/dist/ssr";
import { BarButton, Sections, type TabItem } from "@/app/components/chrome";
import { fullToggleLabel } from "@/app/components/fullToggleLabel";

type FoldedTabControlProps = {
  asideRef: RefObject<HTMLElement | null>;
  tab: "live" | "matrix";
  setTab: (t: "live" | "matrix") => void;
  split: boolean;
  setSplitPref: (v: boolean) => void;
  setMatrixOpened: (v: boolean) => void;
  liveUnseen: boolean;
  matrixUnseen: boolean;
  splitAvailable: boolean;
  onToggleFull?: () => void;
  isFull?: boolean;
  /** What `onToggleFull` actually does — see ChatTabBar's own doc: desktop's
   *  magnetic full-screen community panel vs. a phone's player fold. Defaults
   *  to the desktop meaning, same as ChatTabBar. */
  fullKind?: "community" | "fold";
  /** Closes any mobile content tab (News/VODs) covering the live/matrix pair. */
  onLeaveContentTab?: () => void;
  /** Compact view (video bars hidden) — mirrors the tab bar's far-left toggle. */
  compact?: boolean;
  onToggleCompact?: () => void;
};

// Floating tab/community control — shown (desktop + mobile) while the tab bar
// is folded away, so the Live/Matrix switch and community-mode toggle stay
// reachable without giving the bar back its full height. Sits top-right over
// the message list, low-opacity until hovered.
export function FoldedTabControl({
  asideRef, tab, setTab, split, setSplitPref, setMatrixOpened,
  liveUnseen, matrixUnseen, splitAvailable, onToggleFull, isFull, fullKind,
  onLeaveContentTab, compact, onToggleCompact,
}: FoldedTabControlProps) {
  // Folded-tab-bar detection. The fold is driven by the `.chat-tabbar-hidden`
  // class on <html> (applied pre-paint + by the settings effect), so we follow
  // that class rather than re-reading localStorage — it updates the moment the
  // toggle flips.
  const [tabsFolded, setTabsFolded] = useState(false);
  useEffect(() => {
    const html = document.documentElement;
    const readFold = () => setTabsFolded(html.classList.contains("chat-tabbar-hidden"));
    readFold();
    const mo = new MutationObserver(readFold);
    mo.observe(html, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);

  // Publish the floating pill's width as `--folded-ctl-w` on the aside so the
  // panel headers + pinned banner can reserve that much right-padding and keep
  // their own top-right controls clear of it (see globals.css). When the pill is
  // hidden (off-switch → display:none) its width measures 0 → no padding wasted.
  const pillRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const aside = asideRef.current;
    if (!aside) return;
    const pill = pillRef.current;
    if (!pill) { aside.style.removeProperty("--folded-ctl-w"); return; }
    const apply = () => aside.style.setProperty("--folded-ctl-w", `${pill.offsetWidth}px`);
    const ro = new ResizeObserver(apply);
    ro.observe(pill);
    apply();
    return () => { ro.disconnect(); aside.style.removeProperty("--folded-ctl-w"); };
  }, [tabsFolded, asideRef]);

  if (!tabsFolded) return null;

  // Typed on the pair so `setTab(k)` narrows without a cast.
  const items: TabItem<"live" | "matrix">[] = [
    { key: "live", label: "Live", dot: liveUnseen },
    { key: "matrix", label: "Matrix", dot: matrixUnseen },
  ];

  return (
    // The pill is the player top bar's mode-rail tray — same radius, padding
    // and gap (chrome.css .chrome-iconrail) — and its buttons are BarButtons,
    // so a phone sees ONE button style above and below the fold. The heavy
    // scrim and border stay: unlike the rail, this floats over chat and needs
    // the contrast.
    <div ref={pillRef} data-folded-ctl className="absolute top-1.5 right-1.5 z-30 flex items-center gap-[2px] rounded-[.5625rem] bg-scrim-heavy border border-edge-strong p-[2px] text-2xs font-medium shadow-lg opacity-70 hover:opacity-100 active:opacity-100 transition-opacity">
      {/* Live / Matrix as Sections in floating density — the same strip as
          the bar, without its band. In split neither side is selected (they
          are "collapse split to this side" actions), so value is null. Every
          pick also leaves an open content tab — without that these read as
          dead buttons, since the content tab keeps covering the pair. */}
      <Sections
        density="floating"
        items={items}
        value={split ? null : tab}
        onChange={(k) => {
          onLeaveContentTab?.();
          setSplitPref(false);
          setTab(k);
          if (k === "matrix") setMatrixOpened(true);
        }}
        label="Chat sections"
      />
      {splitAvailable && (
        <BarButton
          icon={<Columns size={13} weight="bold" />}
          // Unlike the tab bar's split button (rendered only while unsplit),
          // this one stays while split IS on — so its name carries the state
          // that `active` only paints (BarButton never sets aria-pressed).
          label={split ? "Split view — on" : "Split view — live chat + Matrix"}
          active={split}
          onClick={() => { onLeaveContentTab?.(); setSplitPref(true); setMatrixOpened(true); }}
        />
      )}
      {/* Compact toggle — an EXIT, not a convenience: fold + compact together
          would otherwise have no way back to the video bars. */}
      {onToggleCompact && (
        <BarButton
          icon={compact ? (
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <rect x="1" y="2.5" width="12" height="9" rx="1.2" />
              <path d="M1 5h12M1 9h12" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 7h12M3 4h8M3 10h8" />
            </svg>
          )}
          label={compact ? "Show bars" : "Compact view — hide bars"}
          active={compact}
          onClick={onToggleCompact}
        />
      )}
      {/* The floating twin of ChatTabBar's own toggle — same fullKind/isFull
          pair, so it must say the same thing (fullToggleLabel is the one
          place that decides). This used to hardcode "Community mode" even on
          a phone, where the pair is rebound to the player fold — wrong verb,
          and with only a `title` not announced to assistive tech at all. */}
      {onToggleFull && (() => {
        const { label, Icon } = fullToggleLabel(fullKind, isFull);
        return (
          <BarButton
            icon={<Icon size={13} weight="bold" />}
            label={label}
            active={isFull}
            onClick={onToggleFull}
          />
        );
      })()}
    </div>
  );
}
