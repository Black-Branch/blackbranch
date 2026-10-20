"use client";

// The DOM half of the window layer: a
// clipped, absolutely-positioned overlay a pane renders INSIDE its body
// wrapper — the `relative flex-1` element whose bottom edge is the
// composer's top, or the AutomodHoldBar's when that mod-only row is present
// between the body wrapper and the composer (ChatSidebar's live pane) —
// either way the composer itself is never covered. Panel windows portal in
// here; the overflow clip is what
// makes the entry motion EMERGE from the composer seam instead of sliding
// over the viewport. pointer-events: none — the layer itself must never
// eat a tap meant for the messages under it; the window re-enables its own.

import { useEffect, useRef } from "react";
import { registerPaneTarget } from "@/app/lib/chrome/windowLayer";

export function WindowLayerTarget({ pane }: { pane: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    return registerPaneTarget(pane, ref.current);
  }, [pane]);
  // NOTHING here measures the keyboard. The ceiling — how much of this
  // layer the keyboard has put behind the chrome above it — is a calc() in
  // chrome.css over three registered tokens (--kb-lift, --pane-ceiling-rise,
  // --pane-chrome-above), declared on this element as --pane-ceiling and
  // subtracted by the panel inside it. A distance measured in JS at the K
  // commit is a SNAPSHOT, and the chat's top bar hides by animating its own
  // margin over 200ms, so the number would be stale before it was applied —
  // a bounce at the top of the range, and a gap under the video panel when
  // the tab bar is closed. The bar's height is itself `--chrome-top-h` =
  // `--tab-size + 22px` — a USER SETTING — so no measured constant could
  // survive a chat-size change either.
  // Keep the arithmetic in CSS, where it recomputes itself. And this box
  // itself never moves or resizes for the keyboard: a ceiling change is one
  // layout jump of the PANEL, which PanelWindow eases as a compositor
  // translate (the lift-follow, Window.tsx) — the layer has nothing to animate.
  return <div ref={ref} data-window-layer={pane} className="chrome-window-layer" />;
}
