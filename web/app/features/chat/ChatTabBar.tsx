"use client";

import { useRef, useState } from "react";
import { CaretDoubleRight, Columns, Plus } from "@phosphor-icons/react/dist/ssr";
import { useKeyboardOpenDetection } from "@/app/lib/useKeyboardOpenDetection";
import { useSetting } from "@/app/lib/useSetting";
import { CHAT_CONSOLE } from "@/app/lib/plugins/chat";
import { splitLeading, isPinnedTab, type SiteTabDef, type SiteTabKey } from "@/app/lib/tabRegistry";
import { FloatingPicker } from "@/app/components/FloatingPicker";
import { fullToggleLabel } from "@/app/components/fullToggleLabel";
import { Bar, BarButton, Panes, Sections, type TabItem } from "@/app/components/chrome";

type ChatTabBarProps = {
  compactOverlay: boolean;
  onToggleCompact?: () => void;
  compact?: boolean;
  split: boolean;
  setSplitPref: (v: boolean) => void;
  tab: "live" | "matrix";
  setTab: (t: "live" | "matrix") => void;
  liveUnseen: boolean;
  matrixUnseen: boolean;
  setMatrixOpened: (v: boolean) => void;
  narrow?: boolean;
  /** Registry-armed content tabs shown in the bar (mobile). */
  contentTabs: readonly SiteTabDef[];
  contentTab: SiteTabKey | null;
  setContentTab: (k: SiteTabKey | null) => void;
  /** Registry tabs available but not armed — the + picker's contents. */
  unarmedTabs: readonly SiteTabDef[];
  onArmTab: (k: SiteTabKey) => void;
  onCloseContentTab: (k: SiteTabKey) => void;
  splitAvailable: boolean;
  onToggleFull?: () => void;
  isFull?: boolean;
  /** What `onToggleFull` actually does here, because the host rebinds it: on
   *  desktop it is the magnetic full-screen community panel, but on a phone
   *  StreamView hands it `toggleFold` — the player fold.
   *  The button therefore has to say which; "Community mode" over a control
   *  that folds the player would be wrong. Defaults to the desktop meaning. */
  fullKind?: "community" | "fold";
  /** Desktop: folds the chat sidebar (otherwise it folds only by dragging its
   *  edge shut). Undefined on a phone — there is no sidebar to fold. */
  onFoldChat?: () => void;
  /** The host's ONE "open this pane" function — the same one a pager settle
   *  commits through. Passed down rather than re-spelled here so a click and a
   *  swipe cannot open a pane two different ways. */
  selectPane: (k: ChatTabKey) => void;
  /** Pager: fractional pane index while a swipe/smooth scroll
   *  is hot, `undefined` at rest. Handed straight to `Sections`, which lets the
   *  cap and the band's hole follow a finger instead of the committed tab. */
  progress?: number;
  /** Pager: present only while the pager owns motion (narrow, unsplit).
   *  When it is, a tab CLICK becomes a smooth scroll and the settle commits —
   *  so click and swipe are one motion system rather than two. */
  requestPane?: (k: ChatTabKey) => void;
  /** The reveal-swipe: ChatSidebar's
   *  `!!compact && !!narrow && !barRevealHold` — true when mobile compact
   *  should hide this bar for real. Reaches Bar's own `hidden` unchanged. */
  mobileHidden: boolean;
};

/** Live and Matrix share the strip with the registry's content tabs; the key sets are disjoint. */
export type ChatTabKey = "live" | "matrix" | SiteTabKey;

// The chat panel's top Bar: compact toggle · Sections
// (Live · Matrix · armed content tabs on mobile, with the ✕ on the active
// one) · split / + / community. In split view the Sections give way to
// `Panes`: one pane header per open side, each with the band's hole cut over
// it and the header's split line on the real live/matrix divider. Neither
// side is "selected" — both are open — and clicking a header EXPANDS that
// pane back to the whole panel.
//
// Desktop compact parks the bar past the top edge and reveals it on
// proximity / focus (Bar `overlay`); the mobile keyboard folds it via
// `occluded` (inert + invisible, no geometry change). Mobile COMPACT hides it
// for real (Bar `hidden`, an animated distance): mobile has no hover to bring
// a hidden bar back with, so the pager supplies a swipe to reveal it WITH —
// ChatSidebar computes the hold (`barRevealHold`: hot, a settle-out linger, or
// a compact toggle flip) and hands the result down as `mobileHidden`. The
// far-left toggle stays the way back once revealed. The "Fold tab bar"
// setting display:none's it through `[data-bar="chat-top"]` (globals.css) on
// top of all of this.
export function ChatTabBar({
  compactOverlay, onToggleCompact, compact, split, setSplitPref, tab, setTab, onFoldChat,
  liveUnseen, matrixUnseen, setMatrixOpened, narrow,
  contentTabs, contentTab, setContentTab, unarmedTabs, onArmTab, onCloseContentTab,
  splitAvailable, onToggleFull, isFull, fullKind = "community", selectPane, progress, requestPane, mobileHidden,
}: ChatTabBarProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const plusRef = useRef<HTMLSpanElement>(null);
  // While typing, the whole chat panel rises by K and this bar
  // slides BEHIND the video column — occlusion hides it, so it keeps its
  // geometry (no fold: a margin pull inside the moving panel would shift the
  // list mid-lift, two motions where the model wants one). `occluded` makes the
  // covered controls inert — a tap can't reach them (the column is opaque and
  // in front) but Tab and a screen reader could.
  // Never in the desktop compact-overlay form (the keyboard truth only fires
  // on touch-primary devices).
  const keyboardOpen = useKeyboardOpenDetection();
  const foldForKeyboard = keyboardOpen && !compactOverlay;
  // The install's console button, on the top bar of the side panel next to the fold button, when
  // it has a console (app/lib/plugins/chat.ts). On unless Settings › Behavior › Terminal ›
  // Terminal button is off; an unset setting is on. One tap opens it, another closes it.
  const termSetting = useSetting("chatStyle_termButton");
  const termButton = !!CHAT_CONSOLE && termSetting !== "0";

  // Bar renders no trailing lane for a slot handed nothing — but a FRAGMENT is
  // something, however empty it renders. All three controls below are
  // conditional and the popout has none of them, so the fragment alone would
  // leave an empty `.chrome-bar-trail` plus the bar's own .5rem gap sitting at
  // the right edge. The conditions have to be summed HERE, where the slot is
  // decided, not inside it.
  const hasTrailing =
    (!split && narrow && unarmedTabs.length > 0) || (!split && splitAvailable) || !!onToggleFull || !!onFoldChat || termButton;

  // Leading tabs (Home) go BEFORE the pinned pair, the rest after it — the
  // same split ChatSidebar builds `paneKeys` from, so index agrees.
  const { leading: leadingTabs, rest: restTabs } = splitLeading(contentTabs);
  const items: TabItem<ChatTabKey>[] = [
    ...(narrow ? leadingTabs.map((t) => ({ key: t.key, label: t.label, closable: !isPinnedTab(t.key) })) : []),
    { key: "live", label: "Live", dot: liveUnseen },
    { key: "matrix", label: "Matrix", dot: matrixUnseen },
    // Armed content tabs — mobile only (desktop hosts these in the bottom
    // dock; the registry is what both hosts share). Peers of Live and Matrix,
    // text only.
    ...(narrow ? restTabs.map((t) => ({ key: t.key, label: t.label, closable: !isPinnedTab(t.key) })) : []),
  ];
  const value: ChatTabKey = contentTab ?? tab;
  const select = (k: ChatTabKey) => {
    // While the pager owns motion, a click is a SCROLL: the row slides to the
    // pane and its settle commits through `selectPane` — the same function the
    // fall-through below calls directly. One commit body, in ChatSidebar.
    // The Matrix latch is the one thing that cannot wait for that settle — the
    // pane has to be real while it slides in — so a CLICK latches here, up
    // front. (`selectPane` latches too, but only when it eventually runs; the
    // approach happens first.) A swipe that merely APPROACHES Matrix must not:
    // the row renders `matrixOpened ? … : null`, and only a commit or a click
    // ever sets it.
    if (requestPane) {
      if (k === "matrix") setMatrixOpened(true);
      requestPane(k);
      return;
    }
    selectPane(k);
  };

  const compactIcon = compact ? (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="2.5" width="12" height="9" rx="1.2" />
      <path d="M1 5h12M1 9h12" />
    </svg>
  ) : (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 7h12M3 4h8M3 10h8" />
    </svg>
  );

  return (
    <Bar
      slot="top"
      name="chat-top"
      band
      overlay={compactOverlay}
      occluded={foldForKeyboard}
      // Mobile compact's real hide. `hidden`
      // and `occluded` CAN both be true at once — typing in mobile compact
      // folds the bar for the keyboard while it is also pager-hidden — and
      // that is fine: both are inert/invisible mechanics (Bar.tsx's own
      // `inert={hidden || occluded}` / `aria-hidden={hidden || occluded}`),
      // so they compose rather than conflict. `hidden` wins the VISUAL
      // distance (it pulls the bar's own height out of flow; `occluded` alone
      // has no geometry) — there is nothing left to occlude once hidden has
      // already removed it from flow.
      hidden={mobileHidden}
      // The chat panel's TOP bar. In flow it paints --panel-tint-bar (the panel
      // tint at bar strength); floating/compact it uses the glass fill.
      background={compactOverlay ? "var(--glass-bg)" : "var(--panel-tint-bar)"}
      leading={
        // Compact view toggle — BOTH platforms, and on mobile the only way
        // back. Hides the video bars; on desktop this bar goes with them as a
        // hover-revealed overlay, on mobile it stays put.
        onToggleCompact && (
          <BarButton
            icon={compactIcon}
            label={compact ? "Show bars" : "Compact view — hide bars"}
            active={compact}
            onClick={onToggleCompact}
          />
        )
      }
      center={
        split ? (
          <Panes
            panes={[
              { key: "live", label: "Live", dot: liveUnseen, expandTitle: "Expand live chat" },
              { key: "matrix", label: "Matrix", dot: matrixUnseen, expandTitle: "Expand Matrix" },
            ]}
            firstWidth="var(--live-col-w, 50%)"
            label="Split panes"
            onExpand={(k) => {
              setContentTab(null);
              setSplitPref(false);
              setTab(k);
              if (k === "matrix") setMatrixOpened(true);
            }}
          />
        ) : (
          <Sections
            items={items}
            value={value}
            onChange={select}
            progress={progress}
            label="Chat sections"
            onClose={(k) => { if (k !== "live" && k !== "matrix") onCloseContentTab(k); }}
          />
        )
      }
      trailing={
        hasTrailing && (
          <>
            {!split && narrow && unarmedTabs.length > 0 && (
              <span ref={plusRef} className="shrink-0 self-center">
                <button
                  onClick={() => setPickerOpen((v) => !v)}
                  title="Add a tab"
                  aria-label="Add a tab"
                  aria-expanded={pickerOpen}
                  className="px-2 py-1 text-muted hover:text-strong transition-colors"
                >
                  <Plus size={12} weight="bold" />
                </button>
                {/* A PORTAL (FloatingPicker), not an absolute child — the bar's
                    clipping/stacking context would swallow an inline menu, so
                    the + would read as dead (same fix as the dock). */}
                <FloatingPicker
                  anchorRef={plusRef}
                  open={pickerOpen}
                  onClose={() => setPickerOpen(false)}
                  items={unarmedTabs}
                  onPick={onArmTab}
                  align="right"
                />
              </span>
            )}
            {!split && splitAvailable && (
              <BarButton
                icon={<Columns size={13} weight="bold" />}
                label="Split view — live chat + Matrix"
                onClick={() => setSplitPref(true)}
              />
            )}
            {/* The host's one "give this panel the screen" toggle. Desktop: the
                magnetic full-screen community state. Phone: the player fold —
                same button, different verb, so it names the one it is bound to
                (fullKind) and says it to assistive tech as well as on hover.
                fullToggleLabel is the one place that decides label + icon —
                FoldedTabControl renders the same control in its floating pill
                and must never spell this out separately. */}
            {termButton && CHAT_CONSOLE && (
              <BarButton icon={<CHAT_CONSOLE.button.Icon size={13} weight="bold" />} label={CHAT_CONSOLE.button.label} onClick={CHAT_CONSOLE.toggle} />
            )}
            {onFoldChat && (
              <BarButton icon={<CaretDoubleRight size={13} weight="bold" />} label="Fold chat" onClick={onFoldChat} />
            )}
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
          </>
        )
      }
    />
  );
}
