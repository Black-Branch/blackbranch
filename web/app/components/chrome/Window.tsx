// web/app/components/chrome/Window.tsx
"use client";

// Window — THE shell. One band: back (stack depth > 1) · mark · ONE
// text slot (title or Sections, never both — so the header row never wraps
// under four jobs) · actions · pop-out · close. One body. Four presentations here:
//
//   floating — drag/resize with geometry persistence, clamp on restore, rescue
//     on viewport change, Escape through the shared LIFO dismiss stack, no
//     scrim (the page beside the card stays legitimately usable), --z-float,
//     .glass.
//   dialog — Modal's: scrim at --z-modal, Tab trap over elements that can
//     actually take focus, focus-in on mount and restore on close, always
//     portalled to <body>.
//   page — the phone shape for a TASK surface: modal, inert shell, back-first
//     close, opaque canvas.
//   panel — the WindowLayer-registered shape: renders into the
//     active pane's registered target, two kinds. `peek` is a surface whose
//     purpose is the content BEHIND it: content-fit, non-modal, no
//     scrim, no inert, the chat above stays live, same back sentinel as page.
//     `task` is full pane height, covered body region inert. The band + a
//     grabber pill are the panel's drag handle (usePanelDrag.ts).
//     When no pane layer is registered (community page, /mod, the popout document),
//     PanelWindow falls back to full-viewport shapes —
//     peek's fallback is the sheet markup (`.chrome-window-sheet`),
//     which is why that class and its `sheet-in` keyframes stay.
//
// The host decides the presentation — Window never reads matchMedia.
//
// The band is a `Bar` (band mode when tabs are present, so the Sections
// inside cuts the Console hole). In floating the whole band is the drag
// handle, guarded ONCE at the handle: a press that lands on anything
// interactive is not a drag — rather than a stopPropagation on every
// control, which is one forgotten copy away from a control that drags.

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowSquareOut, CaretLeft, PictureInPicture, SquareHalfBottom, X } from "@phosphor-icons/react/dist/ssr";
import { fitMaxHeight, clampGeom, displayBox, type StoredGeom } from "@/app/lib/chrome/panelGeometry";
import { loadGeom, saveGeom } from "@/app/lib/chrome/panelGeometryStore";
import { createDebouncedPersister } from "@/app/lib/debouncedPersister";
import { useDragResize, centeredBox, reachableBox, type Box, type Corner } from "@/app/lib/chrome/useDragResize";
import { pushDismissLayer, useEscapeDismiss } from "@/app/lib/chrome/dismissStack";
import { keepFocus } from "@/app/lib/keepFocus";
import { usePageBack } from "@/app/lib/chrome/pageBackSentinel";
import { acquireShellInert, acquireSiblingInert } from "@/app/lib/chrome/shellInert";
import { KB_LIFT_EVENT, type KbLiftDetail } from "@/app/lib/useViewportHeightVar";
import { getActiveTarget, registerOpenWindow } from "@/app/lib/chrome/windowLayer";
import { currentTranslateY, layoutTop, releaseTranslate, setParkPad } from "@/app/lib/chrome/panelFollow";
import { usePanelDrag } from "@/app/lib/chrome/usePanelDrag";
import { usePanelPull } from "@/app/lib/chrome/usePanelPull";
import { useSetting } from "@/app/lib/useSetting";
import { useClientValue } from "@/app/lib/useClientState";
import { tweenHeight } from "@/app/lib/chrome/heightTween";
import { type CardPage } from "@/app/lib/cardStack";
import { type TabItem } from "@/app/lib/chrome/useTabList";
import { type WindowDock } from "@/app/lib/chrome/windowDock";
import { Bar } from "./Bar";
import { BarButton } from "./BarButton";
import { Sections } from "./Sections";
import { BootSequence } from "./BootSequence";

export type WindowProps<K extends string = string> = {
  presentation: "floating" | "dialog" | "page" | "panel";
  /** panel: peek = content-fit, non-modal (the surface behind stays live);
   *  task = full pane height, covered body region inert. Default peek. */
  kind?: "peek" | "task";
  /** The window's NAME — its aria-label and the mark's tooltip. Required on
   *  purpose: an unnamed dialog announces as just "dialog", and making the
   *  compiler enforce it is what retired the per-call-site label grep. */
  name: string;
  /** Band identity icon. A sectioned window shows no title — the mark IS its
   *  identity. */
  mark?: ReactNode;
  /** The band's one text slot. Not rendered while `tabs` is present. */
  title?: string;
  tabs?: readonly TabItem<K>[];
  activeTab?: K;
  onTab?: (k: K) => void;
  /** Host-ordered action controls, rendered before pop-out and close. */
  actions?: ReactNode;
  onClose: () => void;
  /** floating: persists position + size per device. Omit for transient
   *  windows (user cards) — one person's geometry is not the next person's. */
  storageKey?: string;
  /** floating: size used when there is no saved geometry. */
  defaultSize?: { w: number; h: number };
  /** floating: exact opening box, overriding `defaultSize`'s centring. */
  initialBox?: Box;
  /** floating: height follows the content until the user's first corner
   *  resize, which writes an explicit height that then persists. */
  fitHeight?: boolean;
  /** floating: floor for the width, raised by whichever page is showing. */
  minWidth?: number;
  /** floating: page stack (cardStack.ts). Depth > 1 shows the back control. */
  stack?: readonly CardPage[];
  onBack?: () => void;
  /** floating: a ⧉ control opens this URL as a sized window and closes. */
  popoutUrl?: string;
  /** floating / panel on a computer: the float ⇄ slide-in switch, beside
   *  pop-out (windowDock.ts). The host swaps `presentation` when it flips. */
  dock?: WindowDock;
  /** panel: which edge this window slides in from, over Settings › Windows "slide in from" — the
   *  terminal's own file can name it. Omit to follow the setting. */
  from?: "top" | "bottom";
  /** dialog: max-width in px; the scrim centres, width is 100% up to this. */
  width?: number;
  /** In-window loading: render a
   *  content-shaped placeholder INSTEAD of `children`, at least `height` px
   *  tall, so the window opens at its expected contentFit and grows into the
   *  real content when this clears (the content-growth follow carries the
   *  change). `readiness` composes stage keys into a compact BootSequence
   *  inside the placeholder; `label` is what a screen reader hears. Panel and
   *  floating (the DM window's fallback). */
  loading?: { height: number; readiness?: readonly string[]; label?: string } | null;
  /** Timed auto-dismiss: close after this many
   *  ms without interaction. `0` or `undefined` means never. — a pointer or a
   *  key INSIDE the window resets the clock. A panel closes through requestClose,
   *  so the exit animates like any other; floating closes at once. Panel and
   *  floating. Callers: the announcement and an unaccepted DM (accepting clears
   *  the prop, which cancels the timer). */
  autoDismissMs?: number;
  /** Panel and floating: the host's handle on the window's own close — the swipe's animated
   *  exit on a panel. Filled while mounted, null after. The DM window slides away this way when
   *  the send-to button releases it. */
  closeRef?: { current: (() => void) | null };
  /** panel: FILL the pane — the chat TUI has this window. A top task
   *  gives up the clear strip and takes the pane's full height; a size the user pulled is let
   *  go; the pull's cap becomes the pane. Pass a boolean (not undefined) to make the window
   *  fillable: its height then eases on every change (chrome.css [data-fillable]). The chat box
   *  under it is the host's to hide (chatTakeover.ts, composerReplaced). */
  fill?: boolean;
  children: ReactNode;
};

const DEFAULT_W = 384;
const DEFAULT_H = 560;
const MIN = { w: 260, h: 200 };
const SAVE_DEBOUNCE_MS = 300;
// PanelWindow's animation backstops: both timers are defensive
// fallbacks for a path where a CSS animation never fires its animationend
// (see PanelWindow's own comments) — the real work is delivered by the
// event. The value is silently COUPLED to globals.css's `--anim-default`
// (200ms) — what panel-seam-in/out actually animate for — and must stay
// comfortably above it. If the token ever grows past this margin, both
// consumers misfire: every panel exit truncates (deliverClose() runs before
// the exit animation finishes), and every entry-height freeze releases
// mid-slide (the stutter the freeze exists to prevent comes back for slow
// content).
const PANEL_ANIM_BACKSTOP_MS = 250;

/** The placeholder a loading panel shows in its body: three skeleton lines
 *  (the shared `.skeleton` shimmer from globals.css, reduced-motion aware
 *  there) at the expected content height, plus the readiness stages when
 *  the tenant is waiting on subsystems. One status region: the sequence
 *  announces when present, the placeholder itself otherwise.
 *
 *  `minBlockSize`, never `minHeight`: check-chrome.mjs rule 3 bans
 *  `min-height` / `minHeight` / `min-h-*` anywhere inside
 *  `app/components/chrome/`, so the logical property is what keeps the build
 *  green as well as what keeps taller content from clipping — "simplifying" it
 *  to `minHeight` fails a gate, it does not just change a style. */
function WindowLoading({ height, readiness, label }: NonNullable<WindowProps["loading"]>) {
  const text = label ?? "Loading";
  return (
    <div className="chrome-window-loading" style={{ minBlockSize: height }} role={readiness ? undefined : "status"}>
      {!readiness && <span className="sr-only">{text}</span>}
      <div className="chrome-window-skeleton" aria-hidden="true">
        <span className="skeleton chrome-window-skeleton-line" />
        <span className="skeleton chrome-window-skeleton-line" />
        <span className="skeleton chrome-window-skeleton-line" data-short="" />
      </div>
      {readiness && <BootSequence keys={readiness} label={text} compact />}
    </div>
  );
}

const CORNERS: readonly Corner[] = ["nw", "ne", "sw", "se"];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Is this element a text-entry surface whose focus loss would close a phone
// keyboard? Duck-typed on tagName/isContentEditable, not `instanceof
// HTMLElement` — the node test harness has no such global (shellInert.ts's
// exact precedent).
function isEditableEl(el: Element): boolean {
  const t = el.tagName;
  return t === "TEXTAREA" || t === "INPUT" ||
    (el as HTMLElement).isContentEditable === true;
}

/** Close after `ms` without interaction inside `el`; a press or a key inside resets the clock.
 *  `close` is read through a ref, so a re-render elsewhere never re-arms the timer — only the
 *  prop and the element do. */
function useAutoDismiss(el: HTMLElement | null, ms: number | undefined, close: () => void) {
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });
  useEffect(() => {
    if (!ms || !el) return;
    let t = setTimeout(() => closeRef.current(), ms);
    const reset = () => {
      clearTimeout(t);
      t = setTimeout(() => closeRef.current(), ms);
    };
    el.addEventListener("pointerdown", reset);
    el.addEventListener("keydown", reset);
    return () => {
      clearTimeout(t);
      el.removeEventListener("pointerdown", reset);
      el.removeEventListener("keydown", reset);
    };
  }, [ms, el]);
}

/** Hand the host the window's close while it is mounted. */
function useCloseHandle(handleRef: WindowProps["closeRef"], close: () => void) {
  const latest = useRef(close);
  useEffect(() => {
    latest.current = close;
  });
  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = () => latest.current();
    return () => { handleRef.current = null; };
  }, [handleRef]);
}

export function Window<K extends string = string>(props: WindowProps<K>) {
  // Counted for the lifetime of the mount — every presentation mounts only
  // while open — so hosts can stand pointer-driven reveals down while any
  // window is up (the chat composer under the mod panel).
  useEffect(() => registerOpenWindow(), []);
  // Every presentation portals into <body>, which a server render cannot do. The FIRST
  // client render must match the server's (nothing), or React throws #418 and re-renders
  // the whole page (the popout pages /mod, /mod/chat, /admin render a window on the
  // server). false on the server and while hydrating, true from the next render — and
  // at once for a window opened later. windowHydration.render.test.ts pins it.
  const onClient = useClientValue(() => true, false);
  if (!onClient) return null;
  // Hooks differ per presentation, so each is its own component — never fold
  // them into one body behind conditionals.
  return props.presentation === "dialog" ? <DialogWindow {...props} />
    : props.presentation === "page" ? <PageWindow {...props} />
    : props.presentation === "panel" ? <PanelWindow {...props} />
    : <FloatingWindow {...props} />;
}

type DragHandle = {
  onPointerDown: (e: ReactPointerEvent) => void;
  onPointerMove: (e: ReactPointerEvent) => void;
  onPointerUp: (e: ReactPointerEvent) => void;
  onPointerCancel: (e: ReactPointerEvent) => void;
};

function WindowBand<K extends string>({
  name, mark, title, tabs, activeTab, onTab, actions, onBack, onPopout, dock, onClose, dragHandle,
}: {
  name: string;
  mark?: ReactNode;
  title?: string;
  tabs?: readonly TabItem<K>[];
  activeTab?: K;
  onTab?: (k: K) => void;
  actions?: ReactNode;
  /** Present only at stack depth > 1. */
  onBack?: () => void;
  onPopout?: () => void;
  dock?: WindowDock;
  onClose: () => void;
  /** Present only on floating — the whole band is the drag handle. */
  dragHandle?: DragHandle;
}) {
  const hasTabs = !!tabs && tabs.length > 0;
  const bar = (
    <Bar
      slot="top"
      name="window"
      band={hasTabs}
      leading={
        (onBack || mark) && (
          <>
            {/* keepFocus on Back and Close: closing or navigating a window must
                not cost the keyboard — a mid-typing ✕ that blurred the
                composer would close the phone keyboard and drop the whole
                K-lifted assembly exactly as the exit played. Coarse-pointer-
                gated inside keepFocus, so desktop click behaviour is untouched. */}
            {onBack && (
              <BarButton icon={<CaretLeft size={14} weight="bold" />} label="Back" onClick={onBack} onMouseDown={keepFocus} />
            )}
            {mark && (
              <span className="chrome-window-mark" title={name}>
                {mark}
              </span>
            )}
          </>
        )
      }
      center={
        // Inline `tabs && tabs.length > 0` (not `hasTabs`) so TS narrows
        // `tabs` for the items prop — the boolean const cannot.
        tabs && tabs.length > 0 ? (
          <Sections items={tabs} value={activeTab ?? null} onChange={(k) => onTab?.(k)} label={name} />
        ) : title ? (
          <span className="chrome-window-title">{title}</span>
        ) : undefined
      }
      trailing={
        <>
          {actions}
          {dock && (
            dock.docked
              ? <BarButton icon={<PictureInPicture size={13} weight="bold" />} label="Float this window" onClick={dock.toggle} />
              : <BarButton icon={<SquareHalfBottom size={13} weight="bold" />} label="Slide into chat" onClick={dock.toggle} />
          )}
          {onPopout && (
            <BarButton icon={<ArrowSquareOut size={13} weight="bold" />} label="Open in a new window" onClick={onPopout} />
          )}
          <BarButton icon={<X size={13} weight="bold" />} label="Close" onClick={onClose} onMouseDown={keepFocus} />
        </>
      }
    />
  );
  if (!dragHandle) return bar;
  return (
    <div
      {...dragHandle}
      onPointerDown={(e) => {
        // One guard at the handle, not a stopPropagation on every control: a
        // press on anything interactive is not a drag. The Sections strip's
        // own touch-scroll survives via touch-action (chrome.css).
        if ((e.target as Element).closest('button, [role="button"], a, input, select, textarea')) return;
        dragHandle.onPointerDown(e);
      }}
      className="chrome-window-grab"
    >
      {bar}
    </div>
  );
}

function FloatingWindow<K extends string>({
  name, mark, title, tabs, activeTab, onTab, actions, onClose,
  storageKey, defaultSize, initialBox, fitHeight, minWidth, stack, onBack, popoutUrl, dock, loading, autoDismissMs, closeRef, children,
}: WindowProps<K>) {
  const [initial] = useState<Box>(() => {
    const vw = typeof window === "undefined" ? 1280 : window.innerWidth;
    const vh = typeof window === "undefined" ? 800 : window.innerHeight;
    const saved = storageKey ? loadGeom(storageKey) : null;
    // Never replayed verbatim. Geometry outlives the window it was saved
    // in: a card placed on a wide monitor and reopened on a laptop would open
    // outside the visible area with no way back. The clamp is easy to orphan
    // while a green suite says it works — check that it is still WIRED UP.
    if (saved) {
      return clampGeom({ x: saved.x, y: saved.y, w: saved.w, h: saved.h }, vw, vh, MIN, { w: vw, h: vh });
    }
    if (initialBox) return initialBox;
    return centeredBox(null, defaultSize?.w ?? DEFAULT_W, defaultSize?.h ?? DEFAULT_H, {
      width: vw,
      height: vh,
    });
  });

  // A saved row without `fit` predates content-fit — its height was already
  // the rendered truth for that user, so keep honouring it.
  const [autoHeight] = useState(() => {
    if (!fitHeight) return false;
    const saved = storageKey ? loadGeom(storageKey) : null;
    return saved ? saved.fit === true : true;
  });

  const [vw, setVw] = useState(() => (typeof window === "undefined" ? 1280 : window.innerWidth));

  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const { box, setBox, dragHandleProps, resizeHandleProps, explicitH } = useDragResize(initial, {
    minW: MIN.w,
    minH: MIN.h,
    autoHeight,
    measureH: () => panel?.offsetHeight ?? null,
    adopt: (corner) =>
      corner
        ? disp.w !== box.w ? { w: disp.w, x: disp.x } : null
        : disp.x !== box.x ? { x: disp.x } : null,
  });
  // Content-fit refits ease both ways — a section switch that
  // makes the card taller or shorter slides its bottom edge instead of jumping.
  // Only while the height is content-fit: once the user has sized the card
  // (explicitH) its height is theirs and nothing here runs.
  useEffect(() => {
    if (!panel || !autoHeight || explicitH || typeof ResizeObserver === "undefined") return;
    let prevH = panel.offsetHeight;
    let cancel: (() => void) | null = null;
    const ro = new ResizeObserver(() => {
      const h = panel.offsetHeight;
      const oldH = prevH;
      prevH = h;
      if (panel.dataset.tween !== undefined) return; // the easing's own frames
      if (oldH > 0 && Math.abs(h - oldH) > 0.5) cancel = tweenHeight(panel, oldH, h);
    });
    ro.observe(panel);
    return () => { ro.disconnect(); cancel?.(); };
  }, [panel, autoHeight, explicitH]);

  // Floors are a render-time fit, never a write:
  const disp = displayBox(box, minWidth, vw);

  // A viewport that changes WHILE the window is open can strand it out of
  // reach just as a restore can. `reachableBox`, NOT the stricter
  // `clampGeom`: this fires on every resize event, and re-fitting would yank
  // a card the user deliberately parked half off the edge back into the
  // middle. The LAYOUT viewport, never the keyboard-aware one — reacting to
  // the on-screen keyboard would shove every open window upward each time the
  // composer is focused.
  useEffect(() => {
    const clamp = () => {
      setVw(window.innerWidth);
      setBox((b) => {
        const next = reachableBox(b, { width: window.innerWidth, height: window.innerHeight });
        return next.x === b.x && next.y === b.y ? b : next;
      });
    };
    window.addEventListener("resize", clamp);
    window.addEventListener("orientationchange", clamp);
    return () => {
      window.removeEventListener("resize", clamp);
      window.removeEventListener("orientationchange", clamp);
    };
  }, [setBox]);

  // Geometry is written on a trailing debounce (a drag fires one schedule per
  // frame). The pending write MUST be flushed on unmount — clearing it
  // instead silently discards a just-dragged position when the panel
  // closes inside the debounce window.
  const [persister] = useState(() =>
    createDebouncedPersister<{ key: string; geom: StoredGeom }>(
      ({ key, geom }) => saveGeom(key, geom),
      SAVE_DEBOUNCE_MS
    )
  );
  useEffect(() => () => persister.flush(), [persister]);
  useEffect(() => {
    if (!storageKey) return;
    persister.schedule({ key: storageKey, geom: { ...box, fit: !explicitH } });
  }, [box, explicitH, storageKey, persister]);

  // Escape closes, via the shared LIFO dismiss stack. No scrim and no
  // outside-click close by design — the card sits alongside the page, so
  // clicking the page is a legitimate thing to do while it is open.
  // useEscapeDismiss holds the layer STABLE across re-renders (registers
  // once, tracks the latest onClose through a ref) — a plain
  // `useEffect(() => pushDismissLayer(onClose), [onClose])` re-pushes to the
  // top of the stack on every onClose identity change, which for an inline
  // arrow is every parent re-render (chat re-renders per message), so
  // Escape over a dialog opened above this card could close the hidden card
  // instead of the dialog.
  // A window layer: Escape closes the window that holds focus, so with two
  // windows open the one being used closes, not the newest.
  useEscapeDismiss(onClose, { el: () => panel });
  useAutoDismiss(panel, autoDismissMs, onClose);
  useCloseHandle(closeRef, onClose);

  // Focus in on open, restore on close. Keyed on `panel` (a state ref): it is null until the
  // portal mounts.
  useEffect(() => {
    if (!panel) return;
    const prev = document.activeElement as HTMLElement | null;
    if (!panel.contains(document.activeElement)) panel.focus();
    return () => { prev?.focus?.(); };
  }, [panel]);

  // Focus stays inside while it is here: Tab and Shift+Tab wrap within the
  // window. There is no scrim — the page beside it stays usable by pointer, and a click outside
  // moves focus out as it always did; only the keyboard's cycle is kept in the window.
  useEffect(() => {
    if (!panel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !panel.contains(document.activeElement)) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) { e.preventDefault(); return; }
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    panel.addEventListener("keydown", onKey);
    return () => panel.removeEventListener("keydown", onKey);
  }, [panel]);

  const canGoBack = !!stack && stack.length > 1 && !!onBack;

  return createPortal(
    <div
      ref={setPanel}
      role="dialog"
      aria-modal="false"
      aria-label={name}
      tabIndex={-1}
      className="chrome-window chrome-window-floating glass rounded-xl"
      style={{
        left: disp.x,
        top: box.y,
        width: disp.w,
        // Content-fit: height follows the children, clamped so a card dragged
        // low can never grow past the viewport bottom.
        ...(explicitH ? { height: box.h } : { maxHeight: fitMaxHeight(box.y) }),
      }}
    >
      <WindowBand
        name={name}
        mark={mark}
        title={title}
        tabs={tabs}
        activeTab={activeTab}
        onTab={onTab}
        actions={actions}
        onBack={canGoBack ? onBack : undefined}
        dock={dock}
        onPopout={
          popoutUrl
            ? () => {
                // Size the new window to the card's CURRENT box, so popping
                // out preserves whatever the user dragged it to.
                window.open(
                  popoutUrl,
                  `bb-panel-${popoutUrl}`,
                  `popup=yes,width=${Math.round(box.w)},height=${Math.round(box.h)}`
                );
                onClose();
              }
            : undefined
        }
        onClose={onClose}
        dragHandle={dragHandleProps}
      />
      <div className="chrome-window-body no-scrollbar">{loading ? <WindowLoading {...loading} /> : children}</div>
      {CORNERS.map((corner) => (
        <div key={corner} {...resizeHandleProps(corner)} aria-hidden="true" data-corner={corner} className="chrome-window-grip" />
      ))}
    </div>,
    document.body
  );
}

function PageWindow<K extends string>({
  name, mark, title, tabs, activeTab, onTab, actions, onClose, stack, onBack, children,
}: WindowProps<K>) {
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const canGoBack = !!stack && stack.length > 1 && !!onBack;

  // ONE close-request handler for Escape AND system back:
  // back-first — in-card ‹ depth pops before the window closes. usePageBack
  // reads it through a ref, so the inline identity is safe.
  usePageBack(() => {
    if (canGoBack) onBack!();
    else onClose();
  });

  // Modal: the app shell is fully covered, so it goes inert (counted — the
  // account card and mod window can stack). No Tab trap needed; inert IS the
  // trap. The popout document has #app-shell too (it nests under the root
  // layout) — inerting it there is harmless, since this card portals to
  // <body> outside the wrapper. The real no-op case is a shell-less
  // document (e.g. the jsdom tests).
  useEffect(() => acquireShellInert(), []);

  // Focus in on open, restore on close — floating's exact effect: keyed on
  // `panel` (a state ref), null until the portal mounts.
  useEffect(() => {
    if (!panel) return;
    const prev = document.activeElement as HTMLElement | null;
    if (!panel.contains(document.activeElement)) panel.focus();
    return () => { prev?.focus?.(); };
  }, [panel]);

  return createPortal(
    <div
      ref={setPanel}
      role="dialog"
      aria-modal="true"
      aria-label={name}
      tabIndex={-1}
      className="chrome-window chrome-window-page"
    >
      <WindowBand
        name={name}
        mark={mark}
        title={title}
        tabs={tabs}
        activeTab={activeTab}
        onTab={onTab}
        actions={actions}
        onBack={canGoBack ? onBack : undefined}
        onClose={onClose}
      />
      <div className="chrome-window-body no-scrollbar pb-safe">{children}</div>
    </div>,
    document.body
  );
}

function PanelWindow<K extends string>(props: WindowProps<K>) {
  const { name, mark, title, tabs, activeTab, onTab, actions, onClose, stack, onBack, popoutUrl, dock, loading, fill, children } = props;
  const kind = props.kind ?? "peek";
  // Settings › Behavior › Windows "slide in from": a TOP
  // panel comes down from the top of the pane and leaves the bottom — the
  // newest messages — clear (chrome.css [data-from="top"]).
  const fromSetting = useSetting("chatStyle_winFrom");
  const fromTop = (props.from ?? fromSetting) === "top";
  // Captured ONCE — the window opens in the active pane and STAYS with it
  // through pager swipes (pane membership; the pane's own inert
  // covers it when the user swipes away).
  const [target] = useState<HTMLElement | null>(() =>
    typeof document === "undefined" ? null : getActiveTarget());
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const canGoBack = !!stack && stack.length > 1 && !!onBack;

  // Exit mirrors entry: a close request arms `panel-out` and the
  // REAL close runs on its animationend. The reduced-motion CSS overrides
  // (globals.css) deliberately keep panel-seam-in/out as REAL (motionless)
  // animations rather than `animation: none`, precisely so animationend
  // still fires — the timer is a defensive backstop for any path where the
  // animation never runs anyway (an animation:none regression,
  // display:none ancestors, browser quirks), because Window must not read
  // matchMedia to find out. A second request while closing goes through
  // immediately: an impatient ✕✕ or double-back must never strand a zombie
  // window — but the FIRST click's own animationend can still land after
  // that immediate delivery (the CSS animation it started keeps running on
  // the still-mounted node), so deliverClose needs its own "already
  // delivered" guard on top of requestClose's — without it, an impatient
  // ✕✕ calls onClose once immediately and once more ~200ms later.
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const deliveredRef = useRef(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deliverClose = () => {
    if (closeTimerRef.current) { clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
    if (deliveredRef.current) return;
    deliveredRef.current = true;
    onClose();
  };
  const requestClose = () => {
    if (!target) { onClose(); return; } // fallback shapes close instantly
    if (closingRef.current) { deliverClose(); return; }
    closingRef.current = true;
    setClosing(true);
    closeTimerRef.current = setTimeout(deliverClose, PANEL_ANIM_BACKSTOP_MS);
  };
  useEffect(() => () => { if (closeTimerRef.current) clearTimeout(closeTimerRef.current); }, []);

  // ONE close-request handler for Escape AND system back, back-first —
  // page's exact contract, sheet's exact rationale (Window.tsx 5c-r).
  usePageBack(() => {
    if (canGoBack) onBack!();
    else requestClose();
  });

  // Timed auto-dismiss and the host's close handle, both through requestClose so the
  // exit animates.
  useAutoDismiss(panel, props.autoDismissMs, requestClose);
  useCloseHandle(props.closeRef, requestClose);

  // task = modal over the covered region only: siblings of the layer go
  // inert (counted); the composer sits OUTSIDE the body wrapper and stays
  // live — the substrate DM/terminal require. Fallback (no
  // target) covers the whole shell instead, page's contract.
  // A TOP window never does this: it leaves the newest messages showing ON
  // PURPOSE, and the clear strip is for reading and scrolling them. The strip
  // is live, so the window is not modal either.
  const modal = kind === "task" && !fromTop;
  useEffect(() => {
    if (!modal) return;
    return target ? acquireSiblingInert(target) : acquireShellInert();
  }, [modal, target]);

  // Focus in on open, restore on close — floating's exact effect, EXCEPT when
  // the user is mid-typing. "Chat interactions do not cost you the keyboard"
  // (keepFocus.ts) is enforced at every chat button — the username press
  // deliberately leaves focus in the composer — and a focus grab here would
  // defeat that one layer up: the panel would yank focus from the composer,
  // the phone keyboard would close, and the whole lifted layout (composer,
  // layer, panel) would drop ~300px while the panel was still entering. Both
  // kinds keep the carve-out: the composer is live under an open task window
  // BY DESIGN (the DM/terminal substrate), so a task must not cost the
  // keyboard either.
  // With no editable focused, the grab still runs — Escape-first flows and
  // screen readers keep their entry point.
  useEffect(() => {
    if (!panel) return;
    const prev = document.activeElement as HTMLElement | null;
    if (prev && isEditableEl(prev) && !panel.contains(prev)) return; // keyboard stays
    // preventScroll: at focus time the panel sits
    // translated 100% BELOW its layer — deliberately clipped out of view for
    // the seam-emerge entry — and asking the browser to reveal a
    // deliberately-hidden element is never right. It CAN scroll overflow:hidden
    // boxes (useViewportHeightVar's commit() documents exactly that for the
    // pinned root), which would leave the entry animating against a scroll
    // offset: the panel overshoots its rest position and drops back when the
    // offset clamps. On engines where the layer, root and body have no scroll
    // range a bare focus() scrolls nothing; preventScroll is correct either
    // way and costs nothing. A real phone's URL bar can give the root scroll
    // range that emulation does not; ?kbdebug's open recorder prints `scr` to
    // check on a device.
    if (!panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
    // Belt and braces for a browser that ignores preventScroll: the layer is a
    // CLIP, never a scroller — any scroll on it is this bug, and zeroing it is
    // a no-op in the healthy case. (The pinned root's equivalent is owned by
    // useViewportHeightVar's commit(), which zeroes it on every commit.)
    // eslint-disable-next-line react-hooks/immutability -- `target` is a DOM element handle, not React state to keep immutable: it lives in useState only so the capture happens ONCE at mount (pane membership). Writing scrollTop on it is the same category as the .focus() call above and shellInert's attribute writes
    if (target) target.scrollTop = 0;
    return () => { prev?.focus?.(); };
  }, [panel, target]);

  // Entry-height freeze: panel-seam-in is
  // translateY(100%) → 0, and a percentage translate resolves against the
  // panel's OWN height — so async content landing mid-entry (the user card's
  // profile fetch: a spinner-height panel, then a card ~100px taller ~70ms
  // later) resizes the content-fit peek and re-targets the slide's start
  // point mid-flight: one slide, then an instant second slide to the
  // corrected height. Freeze the height the animation started with; the
  // entry's own animationend (below) releases it, so growth after settle is
  // FOLLOWED by the content-growth effect further down: a slide
  // to the new fit instead of a pop. The composer's grown-state push keeps working while
  // frozen: bottom:0 rides the layer's edge, and a frozen height still translates
  // with it. The release REFUSES a panel that is already closing —
  // panel-seam-out reads the same percentage base, so releasing mid-exit
  // would re-create the stutter on the way out (unmount ends the freeze
  // regardless). The fallback shapes need none of this: sheet-in translates
  // by PIXELS and page does not slide, both immune by construction.
  //
  // This effect is also what marks the panel ENTERED (`data-entered`), on both
  // release paths and immediately on the skip path where there was nothing to
  // freeze. usePanelDrag reads it: a press mid-entry would re-target
  // panel-seam-in's percentage base exactly the way async content did — the
  // stutter this freeze exists to prevent — and `data-drag` would switch the
  // box to cap height half-way through the slide.
  const releaseEntryFreezeRef = useRef<(() => void) | null>(null);
  // The content-shrink easing's cancel (see the content-growth follow below).
  const cancelShrinkRef = useRef<(() => void) | null>(null);
  /* eslint-disable react-hooks/immutability -- `panel` is a DOM element handle, not React state to keep immutable: writing its inline height IS this effect's job, the same category as `.focus()` in the effect above and shellInert's attribute writes. It sits in useState only so these effects re-run when the portalled node mounts */
  useLayoutEffect(() => {
    if (!target || !panel) return;
    const h = panel.offsetHeight;
    if (h <= 0) { panel.dataset.entered = ""; return; } // hidden ancestor — nothing measurable to stabilize, and nothing to wait for
    panel.style.height = `${h}px`;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const release = () => {
      if (closingRef.current) return;
      if (timer) { clearTimeout(timer); timer = null; }
      panel.style.height = "";
      panel.dataset.entered = "";
      releaseEntryFreezeRef.current = null;
    };
    // Same defensive backstop as the exit's: a freeze must never outlive an
    // entry animation that never fires animationend.
    timer = setTimeout(release, PANEL_ANIM_BACKSTOP_MS);
    releaseEntryFreezeRef.current = release;
    return () => {
      if (timer) clearTimeout(timer);
      releaseEntryFreezeRef.current = null;
    };
  }, [panel, target]);
  // Fill flips (the chat TUI starts or leaves): a size the user pulled is let go, so the
  // stylesheet's answer — the full pane, or the usual size — takes over, eased by the
  // fillable panel's height transition (chrome.css). Nothing to do on the first render.
  const fillRef = useRef(fill);
  useLayoutEffect(() => {
    if (!panel || fillRef.current === fill) return;
    fillRef.current = fill;
    panel.style.height = "";
    delete panel.dataset.size;
  }, [panel, fill]);
  /* eslint-enable react-hooks/immutability */

  // The handle's gesture — see usePanelDrag.ts for the model.
  // `restTranslate` is shared with the lift-follow below: while a snap is in
  // flight the keyboard must retarget to where the DRAG is going, and a box
  // PARKED below contentFit rests wherever keeps its visible height.
  const restTranslate = useRef<() => number>(() => 0);
  const drag = usePanelDrag({
    panel, layer: target, kind, restTranslate, onDismiss: requestClose,
    // A gesture must never run against the entry freeze: an inline height
    // would beat the cap-box rule and lift the box off the composer. A press
    // before `data-entered` is ignored outright, so the normal entry has
    // already released by the time a gesture can start — this stays as the
    // guard for any path that marks the panel entered with a freeze still held.
    onStart: () => { releaseEntryFreezeRef.current?.(); cancelShrinkRef.current?.(); },
  });
  // A top panel's gesture: the handle SIZES it (usePanelPull.ts). Both hooks
  // always run — hook order — and the handle takes the one that fits.
  const pull = usePanelPull({
    panel, layer: target, onDismiss: requestClose,
    onStart: () => { releaseEntryFreezeRef.current?.(); cancelShrinkRef.current?.(); },
  });

  // Lift-follow: opening the keyboard with a window open must not jitter. The
  // ceiling — how much of this
  // layer the keyboard has put behind the chrome above it — is a token the
  // panel subtracts from its own bound (chrome.css, --pane-ceiling), and it
  // lands in ONE layout at the K commit; nothing about it transitions.
  // Transitioning the layer's `top` instead would be a layout property on the
  // main thread, re-resolving the panel's max-height every frame while the
  // lift itself (the chat panel's transform, the column's ramp) runs on the
  // compositor — the panel's top edge would be the sum of a compositor-smooth
  // term and a main-thread term, so every late frame would show as the edge
  // oscillating.
  //
  // So the jump becomes motion the FLIP way. useKeyboardLift announces each K
  // write on the lifted element (KB_LIFT_EVENT: before, then after; bubbling —
  // this panel is its DOM descendant, portalled into the pane's layer). The
  // panel reads its layout top on both sides, translates itself back by the
  // difference with the transition suppressed, then hands the property to the
  // stylesheet's `translate` transition, which eases it to 0 on the lift's own
  // token curve. The layout top is read FRACTIONALLY — the panel's rect against
  // the layer's, minus the panel's own in-flight translate: `offsetTop` rounds
  // to whole pixels, and on a fractional layer height that half-pixel
  // miss becomes a sub-pixel nudge the WRONG way on the close's first frame. The
  // lift's transform lives on an ancestor of both rects, so it cancels between
  // them, and both reads happen inside one task, so it has not advanced. A
  // commit that lands mid-flight (the settle correction) starts from the
  // CURRENT interpolated translate, so the retarget is exact and never
  // reverses.
  //
  // SHRINK (the ceiling came down): a bottom-anchored, capped panel would drop
  // its top to the ceiling and clip its own content in the same frame. Instead
  // `data-lifting` holds it top-anchored AT the ceiling and uncapped for the
  // transition's life (chrome.css): the box keeps its height and overhangs the
  // layer's bottom, where the layer clips it at the composer's edge — an edge
  // that is itself riding the lift on the compositor. Band and content stay
  // rigid while the composer covers the bottom; on transitionend the resting
  // rule takes over at the same clip edge and paints nothing new. While held,
  // a further shrink keeps the hold and a GROW (the keyboard leaving) drops it
  // BEFORE measuring, or the stale top anchor would be what "last" reads. A
  // grow from rest needs no hold: the resting box already overhangs by itself.
  //
  // Nothing here reads K, a rect, or a chrome token — only where the panel's
  // own box went, the one thing CSS cannot say about the frame before. The
  // backstop is the same defensive timer as the freeze's: reduced motion has
  // no transition, so no transitionend, so the hold would otherwise outlive
  // the (instant) motion.
  // The write vocabulary lives in panelFollow.ts, shared with the drag.
  useEffect(() => {
    if (!target || !panel) return;
    let first = 0;
    let backstop: ReturnType<typeof setTimeout> | null = null;
    const settle = () => {
      if (backstop) { clearTimeout(backstop); backstop = null; }
      delete panel.dataset.lifting;
      delete panel.dataset.liftFollow;
    };
    const onLift = (e: Event) => {
      const lifted = e.target as Node | null;
      if (!lifted || !lifted.contains(panel)) return; // some other host's lift
      const phase = (e as CustomEvent<KbLiftDetail>).detail?.phase;
      if (phase === "before") {
        first = layoutTop(panel, target);
        // From before the write until the follow ends, a fillable top window does not ease its
        // height (chrome.css `[data-lift-follow]`): the jump is one
        // layout change, eased only as this translate. The backstop lets go if nothing moves.
        panel.dataset.liftFollow = "";
        if (backstop) clearTimeout(backstop);
        backstop = setTimeout(settle, PANEL_ANIM_BACKSTOP_MS);
        return;
      }
      if (phase !== "after") return;
      let last = layoutTop(panel, target);
      if (Math.abs(last - first) < 0.01) return;      // this box did not move — leave any motion in flight alone
      if (panel.dataset.lifting !== undefined) {
        if (last < first) { delete panel.dataset.lifting; last = layoutTop(panel, target); } // grow while held: back to rest first
      } else if (last > first && panel.dataset.from !== "top") {
        // A top panel is already anchored at the ceiling — no hold to take.
        panel.dataset.lifting = "";                     // shrink: hold the box at the ceiling
        last = layoutTop(panel, target);
      }
      // `from` is where the box IS (its live translate plus the layout jump);
      // `to` is where it rests — 0, or the drag's pending detent while a
      // snap is in flight (usePanelDrag.ts).
      const rest = restTranslate.current();
      releaseTranslate(panel, currentTranslateY(panel) + (first - last), rest);
      // A PARKED box's clipped depth is measured against the cap, and the cap
      // is exactly what a ceiling change moves — so the body's scroll-reach
      // compensation has to travel with the box here too, on the same number
      // it just moved to. No gesture is involved on this path, so settle()
      // never runs and this is the only place it can be kept honest.
      setParkPad(panel, rest);
      if (backstop) clearTimeout(backstop);
      backstop = setTimeout(settle, PANEL_ANIM_BACKSTOP_MS);
    };
    const onTransitionEnd = (e: TransitionEvent) => {
      // Own translate only — transitionend bubbles, and the body's content
      // has transitions of its own.
      if (e.target !== panel || e.propertyName !== "translate") return;
      settle();
    };
    document.addEventListener(KB_LIFT_EVENT, onLift);
    panel.addEventListener("transitionend", onTransitionEnd);
    return () => {
      document.removeEventListener(KB_LIFT_EVENT, onLift);
      panel.removeEventListener("transitionend", onTransitionEnd);
      if (backstop) clearTimeout(backstop);
    };
  }, [panel, target]);

  // Content growth follows ("a content change while open
  // re-measures and animates to the new fit: growth always wins"). What moves
  // is the panel's TOP edge, and that is what this watches — its layer-
  // relative layout top, exactly the lift-follow's measure. A bottom-anchored
  // content-fit box whose content grows moves its top UP by the growth, and
  // the fix is the lift-follow's: translate the taller box back down by the
  // distance the top moved and release it to the stylesheet's transition; its
  // overhang below the composer is clipped by the layer, so the seam never
  // opens.
  //
  // Content growth is the box getting TALLER *and* its top RISING — both,
  // never one. A box bound to the layer (a task, the cap detent, a peek whose
  // content exceeds the cap) grows whenever the LAYER grows at the BOTTOM —
  // the composer losing a wrapped row — and its top has not moved at all; a
  // height-based follow would translate it down and ease it back, a bounce for an
  // edge that never went anywhere. And a content-fit box's top RISES whenever
  // the composer GAINS a row (the layer's bottom moves up under it) with its
  // height unchanged — that is the pane moving, and the panel moves with it
  // in the same frame like everything else in the pane; following it would
  // detach the panel's motion from the composer's. The layer is observed
  // alongside the panel so either kind of layer resize refreshes both
  // baselines. A keyboard commit moves the top too, but that motion is the
  // lift-follow's and the in-flight-translate guard below stands this down
  // for it. The top is read through layoutTop, which is immune to the
  // panel's own entry/exit transform — the baseline is taken while
  // panel-seam-in is still sliding.
  //
  // Observed, not announced — the growth is the tenant's (a card revealing mod
  // tools), and tenants owe no height stability. Stands down
  // while the translate is non-zero — in flight (the lift-follow already moved
  // this box; a second FLIP would double the motion) or a box PARKED below
  // contentFit (the cap box, whose translate is its position) — as well
  // as mid-gesture (the box is the cap box), under the keyboard's hold, and
  // while closing.
  //
  // The SHRINK mirror: the
  // top DROPS and the box got shorter. A translate cannot show that — the
  // shorter box would lift off the composer — so the height itself eases from
  // the old fit to the new one (heightTween.ts); the bottom stays on the
  // composer and only the top edge moves. A gesture cancels it (onStart).
  useEffect(() => {
    if (!target || !panel || typeof ResizeObserver === "undefined") return;
    let prevTop = layoutTop(panel, target);
    let prevH = panel.offsetHeight;
    const ro = new ResizeObserver(() => {
      const t = layoutTop(panel, target);
      const h = panel.offsetHeight;
      const moved = prevTop - t;
      const grew = h - prevH;
      const oldH = prevH;
      prevTop = t;
      prevH = h;
      if (panel.dataset.tween !== undefined) return; // our own shrink easing
      if (panel.dataset.drag !== undefined || panel.dataset.lifting !== undefined || closingRef.current) return;
      if (panel.dataset.entered === undefined) return; // the entry freeze owns the height
      if (Math.abs(currentTranslateY(panel)) > 0.5) return;
      // A TOP panel's content change moves its bottom edge, never its top:
      // ease the height itself, both ways (heightTween.ts).
      // A size the user chose (data-size) is theirs; a pull owns the height.
      if (panel.dataset.from === "top") {
        // Not a layer-bound box: a TASK window's height is the layer's or the
        // CSS's (chat mode eases it over 200 ms), never its content's — following it would tween every
        // frame of that ease against the ease itself.
        if (panel.dataset.kind === "task" || panel.dataset.fillable !== undefined) return;
        if (panel.dataset.size === undefined && panel.dataset.pull === undefined && Math.abs(grew) > 0.5) cancelShrinkRef.current = tweenHeight(panel, oldH, h);
        return;
      }
      // 0.5px: sub-pixel layout rounding is not growth. (The lift-follow's
      // 0.01 above answers a different question — whether a box moved at all.)
      if (moved > 0.5 && grew > 0.5) releaseTranslate(panel, moved, 0);
      else if (moved < -0.5 && grew < -0.5) cancelShrinkRef.current = tweenHeight(panel, oldH, h);
    });
    ro.observe(panel);
    ro.observe(target);
    return () => { ro.disconnect(); cancelShrinkRef.current?.(); };
  }, [panel, target]);

  const band = (
    <WindowBand
      name={name} mark={mark} title={title} tabs={tabs} activeTab={activeTab}
      onTab={onTab} actions={actions}
      onBack={canGoBack ? onBack : undefined}
      dock={dock}
      // A panel has no dragged box to size the new window from — that is the
      // one thing FloatingWindow's pop-out does that this cannot. Fall back to
      // the declared defaultSize, and let the browser choose when there is none.
      onPopout={
        popoutUrl
          ? () => {
              const d = props.defaultSize;
              window.open(
                popoutUrl,
                `bb-panel-${popoutUrl}`,
                d ? `popup=yes,width=${Math.round(d.w)},height=${Math.round(d.h)}` : "popup=yes"
              );
              requestClose();
            }
          : undefined
      }
      onClose={requestClose}
    />
  );

  // Fallback where no pane layer exists (community page, /mod, the popout
  // document): the pre-L1 full-viewport shapes, unchanged behaviour.
  if (!target) {
    return createPortal(
      kind === "task" ? (
        <div ref={setPanel} role="dialog" aria-modal="true" aria-label={name} tabIndex={-1}
          className="chrome-window chrome-window-page">
          {band}
          <div className="chrome-window-body no-scrollbar pb-safe">{loading ? <WindowLoading {...loading} /> : children}</div>
        </div>
      ) : (
        <div ref={setPanel} role="dialog" aria-modal="false" aria-label={name} tabIndex={-1}
          className="chrome-window chrome-window-sheet rounded-t-xl">
          {band}
          <div className="chrome-window-body no-scrollbar">{loading ? <WindowLoading {...loading} /> : children}</div>
        </div>
      ),
      document.body
    );
  }

  return createPortal(
    <div ref={setPanel} role="dialog" aria-modal={modal} aria-label={name} tabIndex={-1}
      data-kind={kind}
      data-from={fromTop ? "top" : undefined}
      data-fill={fill ? "" : undefined}
      data-fillable={fill !== undefined ? "" : undefined}
      data-closing={closing ? "" : undefined}
      // Guarded on `e.target === e.currentTarget` — animationend BUBBLES, so
      // a descendant's own animation ending (the card's spinner, an L3
      // shimmer skeleton) would otherwise be mistaken for this element's.
      // Which of the panel's OWN animations just ended is what `closing`
      // says: the armed EXIT's end delivers the close, and the ENTRY's end
      // releases the height freeze — never a close (treating it as one would
      // shut every window 200ms after it opened).
      onAnimationEnd={(e) => {
        if (e.target !== e.currentTarget) return;
        if (closing) deliverClose();
        else releaseEntryFreezeRef.current?.();
      }}
      className={`chrome-window chrome-window-panel ${fromTop ? "rounded-b-xl" : "rounded-t-xl"}`}>
      {/* The handle: grabber pill + band, ONE drag surface. The
          body below is never part of it — scrolling a list stays scrolling.
          Pointer handlers, not touch handlers: one code path for mouse, pen
          and touch, with implicit capture. */}
      <div className="chrome-window-grab" {...(fromTop ? pull : drag)}>
        {!fromTop && <div className="chrome-window-grabber" aria-hidden="true" />}
        {band}
      </div>
      <div className="chrome-window-body no-scrollbar">{loading ? <WindowLoading {...loading} /> : children}</div>
      {/* A top panel's pill sits on its BOTTOM edge — the edge nearest the
          thumb and the newest messages — and is a handle of its own. */}
      {fromTop && (
        <div className="chrome-window-foot" {...pull}>
          <div className="chrome-window-grabber" aria-hidden="true" />
        </div>
      )}
    </div>,
    target
  );
}

function DialogWindow<K extends string>({
  name, mark, title, tabs, activeTab, onTab, actions, onClose, width, children,
}: WindowProps<K>) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // Read through a ref so the focus effect below can be mount-only. Callers
  // pass inline `onClose` arrows (new identity every render), and with
  // [onClose] deps the effect re-ran on every parent re-render — each
  // re-run's cleanup restored focus OUTSIDE the dialog and re-focused the
  // shell, yanking focus off whatever field the user was typing in. Chat
  // parents re-render per incoming message, so on mobile the virtual
  // keyboard closed within seconds of tapping any input.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const prev = document.activeElement as HTMLElement | null;
    // Move focus into the dialog unless something inside already claimed it
    // (an autoFocus field) — Escape and the trap need focus to be within.
    if (!dialog.contains(document.activeElement)) dialog.focus();

    // Escape goes through the shared LIFO dismiss stack — a dialog over a
    // floating window must close ITSELF first; per-component listeners were
    // racing on listener-target order instead of stacking order.
    const popLayer = pushDismissLayer(() => onCloseRef.current());

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      // Selector matches are not all focusable: a display:none or zero-size
      // element still matches, but focus() on it silently no-ops — so an
      // invisible first/last breaks the wrap at that end. getClientRects()
      // is empty for exactly those, and stays non-empty for position:fixed
      // elements (whose offsetParent is null, the reason the commoner check
      // is wrong here).
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((el) => el.getClientRects().length > 0);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        e.preventDefault();
        return;
      }
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === dialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      popLayer();
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
    // Mount-only on purpose (see onCloseRef above): focus capture/restore
    // must happen on open/close, never on parent re-renders.
  }, []);

  const node = (
    <div className="chrome-scrim" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={name}
        tabIndex={-1}
        className="chrome-window chrome-window-dialog glass rounded-xl"
        style={width ? { maxWidth: width } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <WindowBand
          name={name}
          mark={mark}
          title={title}
          tabs={tabs}
          activeTab={activeTab}
          onTab={onTab}
          actions={actions}
          onClose={onClose}
        />
        <div className="chrome-window-body no-scrollbar">{children}</div>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}
