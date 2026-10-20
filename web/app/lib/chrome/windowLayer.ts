import { useSyncExternalStore } from "react";
// The window-layer registry. Panes register
// the element a panel window portals into — the pane's body-region layer, an
// absolutely-positioned clipped overlay whose bottom edge IS the composer's
// top — or the AutomodHoldBar's when that mod-only row sits between the body
// wrapper and the composer (ChatSidebar's live pane); either way the
// composer is never covered (flex construction; see WindowLayerTarget). The
// active pane decides
// where a `presentation="panel"` window OPENS; the window captures that
// element once at mount and stays with its pane through pager swipes.
//
// Module-level store on purpose (the dismissStack house pattern): no
// provider, no context, node-testable without React. Consumers:
// WindowLayerTarget registers, ChatSidebar reports the active pane,
// Window.tsx's PanelWindow resolves.

const targets = new Map<string, HTMLElement>();
let active: string | null = null;

export function registerPaneTarget(pane: string, el: HTMLElement): () => void {
  targets.set(pane, el);
  return () => {
    // StrictMode mounts twice: the FIRST mount's cleanup runs after the
    // second mount registered — evicting blindly would leave the pane
    // targetless with a live layer in the DOM. Only the current claimant
    // may clear the pane.
    if (targets.get(pane) === el) targets.delete(pane);
  };
}

export function setActivePane(pane: string | null): void {
  active = pane;
}

export function getActiveTarget(): HTMLElement | null {
  return (active != null && targets.get(active)) || null;
}

let openWindows = 0;
const openListeners = new Set<() => void>();

/** @test-only wipes registry, active pane and the open-window count between node tests. */
export function _resetWindowLayerForTests(): void {
  targets.clear();
  active = null;
  openWindows = 0;
  openListeners.clear();
}

// ── Open windows ─────────────────────────────────────────────────────────────
// How many Windows (every presentation — the dispatcher registers) are mounted
// right now. A Window mounts only while open, so mount = open. Popovers are
// NOT windows and never count: the composer's own emote picker must not stand
// the composer's reveal down.
const notifyOpen = () => { for (const l of openListeners) l(); };

/** Called by Window on mount; the returned function un-registers on unmount. */
export function registerOpenWindow(): () => void {
  openWindows++;
  notifyOpen();
  return () => { openWindows = Math.max(0, openWindows - 1); notifyOpen(); };
}
function subscribeOpenWindows(listener: () => void): () => void {
  openListeners.add(listener);
  return () => { openListeners.delete(listener); };
}
/** Is any Window open? Re-renders the caller when that changes. */
export function useAnyWindowOpen(): boolean {
  return useSyncExternalStore(subscribeOpenWindows, () => openWindows > 0, () => false);
}
