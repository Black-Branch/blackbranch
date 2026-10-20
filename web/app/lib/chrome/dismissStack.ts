"use client";

// One Escape, one layer — the module-level LIFO dismiss stack.
//
// Before this, each dismissible surface picked its own listener target: Modal
// on `window`, the old floating shell on `document` + stopPropagation — and document
// fires before window on the bubble path, so a modal opened OVER a panel
// closed the PANEL on Escape. Listener target choice was silently deciding UI
// stacking order, and six popovers had no Escape at all.
//
// Layers push on open (mount order = stacking order) and pop on close;
// Escape dismisses exactly the top. The single listener is bubble-phase on
// purpose: element-level handlers (an input clearing itself, the emote
// autocomplete) get first claim and can stopPropagation to keep the key
// local. A handled Escape stops propagation so no legacy window listener can
// double-close.

import { useEffect, useRef } from "react";

// A WINDOW layer names its element (`el`): Escape closes the window that holds focus, not merely
// the newest one. A layer without an element (a popover,
// a dialog, a menu) sits above whatever it was opened over and still closes first.
type Layer = { close: () => void; el?: () => HTMLElement | null };

const stack: Layer[] = [];
let wired = false;

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== "Escape" || stack.length === 0) return;
  e.stopPropagation();
  const top = stack[stack.length - 1]!;
  if (!top.el) { top.close(); return; }
  const active = typeof document !== "undefined" ? document.activeElement : null;
  for (let i = stack.length - 1; i >= 0; i--) {
    const l = stack[i]!;
    if (!l.el) break;
    const el = l.el();
    if (el && active && el.contains(active)) { l.close(); return; }
  }
  top.close();
}

/**
 * Register a dismissible layer. Returns its unregister; call it when the
 * layer closes for ANY reason (Escape, click, programmatic), or the stack
 * keeps answering for a surface that is no longer on screen.
 */
export function pushDismissLayer(close: () => void, el?: () => HTMLElement | null): () => void {
  if (!wired) {
    document.addEventListener("keydown", onKeyDown);
    wired = true;
  }
  const layer: Layer = { close, el };
  stack.push(layer);
  return () => {
    const i = stack.indexOf(layer);
    if (i !== -1) stack.splice(i, 1);
  };
}

/** Dismiss the top layer — a system-back close request is the same request
 *  Escape makes (one "close request" concept). Returns
 *  false when nothing was open. */
export function dismissTop(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.close();
  return true;
}

/**
 * Hook form for popovers: registered while mounted (and `enabled`), popped
 * automatically. `onClose` is read through a ref so callers can pass inline
 * arrows without re-registering — re-registering would move the layer to the
 * top of the stack on every render.
 */
export function useEscapeDismiss(onClose: () => void, { enabled = true, el }: { enabled?: boolean; el?: () => HTMLElement | null } = {}) {
  const closeRef = useRef(onClose);
  const elRef = useRef(el);
  useEffect(() => { closeRef.current = onClose; elRef.current = el; });
  const isWindow = !!el;
  useEffect(() => {
    if (!enabled) return;
    return pushDismissLayer(() => closeRef.current(), isWindow ? () => elRef.current?.() ?? null : undefined);
  }, [enabled, isWindow]);
}
