"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

// A small floating menu that CANNOT be clipped: portal at <body>, fixed
// against the trigger's rect. Both tab rows (dock + chat bar) are
// overflow-x-auto, so a + picker rendered absolutely INSIDE the row would open
// below the row's edge and be clipped invisible, reading as "the + does
// nothing" (the same failure class ComposerPopover solves).

// Generic in the key type so a caller with a union of keys (the tab registry's
// SiteTabKey) gets it back unwidened — a `string` here would push an `as`
// cast into every picker, which is precisely where a mistyped key would slip
// past the compiler.
export function FloatingPicker<K extends string>({
  anchorRef, open, onClose, items, onPick, align = "left",
}: {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  items: readonly { key: K; label: string }[];
  onPick: (key: K) => void;
  /** Which menu edge hugs the trigger — pick whichever keeps it onscreen. */
  align?: "left" | "right";
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const a = anchorRef.current;
      if (!a) return;
      const r = a.getBoundingClientRect();
      const menuW = menuRef.current?.offsetWidth ?? 112;
      const raw = align === "right" ? r.right - menuW : r.left;
      // Clamp into the viewport either way.
      const left = Math.min(Math.max(raw, 8), window.innerWidth - menuW - 8);
      setBox({ left, top: r.bottom + 4 });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("orientationchange", place);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("orientationchange", place);
      setBox(null);
    };
  }, [open, anchorRef, align, items.length]);

  // Outside press closes. The portal breaks contains() from the trigger's
  // tree, so check BOTH the menu and the anchor explicitly.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, onClose, anchorRef]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={menuRef}
      className="fixed flex flex-col glass rounded-lg overflow-hidden min-w-32"
      style={{ zIndex: "var(--z-float)", left: box?.left ?? -9999, top: box?.top ?? -9999 }}
    >
      {items.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => { onPick(t.key); onClose(); }}
          className="w-full px-4 py-2.5 text-left text-sm text-body hover:bg-surface-2 transition-colors"
        >
          {t.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
