"use client";

// The mod page's scroll box, keyboard-aware. The shell is pinned, so this
// wrapper's h-full does not shrink with the on-screen keyboard; it must BE the
// scroll container that fits the visible viewport, or content past it is
// clipped. A scroll container compensates by HEIGHT (−K), not translation —
// translating a scroll box just clips its bottom instead of its top. One
// element, one inline write, once per keyboard open, like every other
// keyboard-inset consumer.
import { type ReactNode } from "react";
import { useKeyboardInset } from "@/app/lib/useKeyboardOpenDetection";

export default function ModPageShell({ children }: { children: ReactNode }) {
  const k = useKeyboardInset();
  return (
    <div
      className="h-full overflow-y-auto bg-canvas text-strong py-10 px-4"
      style={k > 0 ? { height: `calc(100% - ${k}px)` } : undefined}
    >
      {children}
    </div>
  );
}
