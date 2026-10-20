"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useOutsideClick } from "@/app/lib/useOutsideClick";
import { keepFocus } from "@/app/lib/keepFocus";
import { clampIntoSpan, visibleViewport } from "@/app/lib/visibleViewport";

// Shared long-press/right-click menu shell: a portal, outside-click close, and
// measured viewport clamping. It measures the real menu size, flips above the
// press point when it would spill off the bottom, and hard-clamps into the
// viewport, which matters for long-press menus on mobile. Callers render their
// rows as children; MenuItem is the standard row.

export function ContextMenu({
  x,
  y,
  onClose,
  children,
  minWidth = 160,
  className = "",
}: {
  x: number;
  y: number;
  onClose: () => void;
  children: ReactNode;
  minWidth?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y + 8 });

  // escape:true matches the row toolbar one level up, which passes it to the
  // same hook.
  useOutsideClick(ref, onClose, { escape: true });

  // Keyboard path in and out (contextMenuKeyboard.test.ts). Focus moves into
  // the menu only when the opener held visible focus — true for a keyboard
  // activation, false for taps and mouse clicks. A long-press menu that stole
  // focus would blur the composer and drop the soft keyboard, which keepFocus
  // exists to prevent. On close, focus returns to the opener (the callers keep
  // it mounted for this — see their ⋯ handlers).
  const openerRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const opener = document.activeElement;
    if (!(opener instanceof HTMLElement) || !opener.matches(":focus-visible")) return;
    openerRef.current = opener;
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    return () => openerRef.current?.focus({ preventScroll: true });
  }, []);

  // ARIA menu pattern: the menu is ONE stop, arrows move within it, and Tab
  // does not cycle — it closes (nothing follows a portal at body end, so a
  // native Tab would walk off the document into browser chrome).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Tab") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    e.preventDefault();
    // -1 when focus sits on no item yet; ArrowDown then lands on the first,
    // ArrowUp on the last — the modular arithmetic covers it without a branch.
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "Home" ? 0 :
      e.key === "End" ? items.length - 1 :
      e.key === "ArrowDown" ? (at + 1) % items.length :
      (at - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  // Re-measure every render ON PURPOSE (a row's label can change size, e.g. a
  // two-step delete confirm — a dep list of [x, y] would miss that); the
  // setPos equality guard is what prevents an update loop.
  //
  // Clamped against the VISIBLE viewport, not `window.inner*`: the soft
  // keyboard stays up through a long press, so a layout-viewport clamp would
  // push a menu opened on a bottom-row message behind the keyboard. The
  // arithmetic is identical where the two viewports coincide.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- no dep array ON PURPOSE (see above): a row's label can change size without x/y changing, so the [x, y] the rule suggests would miss the re-measure. The setPos equality guard, not the dep list, is what stops the update loop
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const vp = visibleViewport();
    const r = el.getBoundingClientRect();
    const left = clampIntoSpan(x, r.width, vp.left, vp.width);
    let top = y + 8;
    if (top + r.height > vp.top + vp.height - 8) top = y - r.height - 8; // flip above the point
    top = clampIntoSpan(top, r.height, vp.top, vp.height); // hard clamp
    setPos((p) => (p.left === left && p.top === top ? p : { left, top }));
  });

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-orientation="vertical"
      onKeyDown={onKeyDown}
      className={`fixed z-(--z-menu) glass rounded-lg overflow-hidden ${className}`}
      style={{ left: pos.left, top: pos.top, minWidth }}
    >
      {children}
    </div>,
    document.body
  );
}

export function MenuItem({
  onClick,
  children,
  className = "",
}: {
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  // keepFocus covers both consumers, MessageContextMenu (live chat) and
  // MsgContextMenu (Matrix/forum), and every row on both is safe with it:
  // Edit hands the message to the composer and focuses it itself
  // (useMatrixEditComposer.ts), and Reply in thread opens a panel whose
  // composer does not autofocus, so neither competes for focus and both are
  // better off with the keyboard already up.
  return (
    <button
      type="button"
      role="menuitem"
      // -1: the ARIA menu is a single tab stop with arrows inside; tabbable
      // items in a portal at body end would make Tab a trap.
      tabIndex={-1}
      className={`w-full px-4 py-2.5 text-left text-sm text-body hover:bg-surface-2 flex items-center gap-2 transition-colors ${className}`}
      onClick={onClick}
      onMouseDown={keepFocus}
    >
      {children}
    </button>
  );
}
