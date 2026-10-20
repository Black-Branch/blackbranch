"use client";
// The gear + draggable settings panel shared by the /chat window and the OBS
// overlay. Gear: hidden until the pointer is over the
// chat (works in OBS's Interact window); on touch, a tap shows it for 3s.
// The panel drags with pointer events, so mouse, pen and touch all work.
//
// `data-chat-panel=""` on the panel matches ChatWindow.tsx's document-level
// keydown guard (`t?.closest("[data-chat-panel]")`) and chatSpotlight.ts's
// NOT_A_PICK list — both exclude the panel by this attribute, and a panel with
// no marker would silently re-open both: PgUp/Home/End typed into a slider
// would scroll the feed underneath it.
import { useEffect, useRef, useState } from "react";
import { GearSix } from "@phosphor-icons/react/dist/ssr";
import ChatPrefs from "@/app/components/ChatSettings";

const PANEL_W = 300;

export function OverlaySettingsPanel({
  page,
  scaleFactor = 1,
  onShowTimestampsChange,
  onShowMatrixNameChange,
}: {
  page: "window" | "obs";
  scaleFactor?: number;
  /** ChatWindow uses these (the hydrated event fires once per load; live
   *  changes come through the panel's props). ChatOverlay does not pass them. */
  onShowTimestampsChange?: (v: boolean) => void;
  onShowMatrixNameChange?: (v: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [touchShown, setTouchShown] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const hideTimer = useRef<number | null>(null);

  // A tap anywhere on the page (touch only) reveals the gear for 3s.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "touch") {
        setTouchShown(true);
        if (hideTimer.current) window.clearTimeout(hideTimer.current);
        hideTimer.current = window.setTimeout(() => setTouchShown(false), 3000);
      }
    };
    window.addEventListener("pointerdown", onDown);
    return () => { window.removeEventListener("pointerdown", onDown); if (hideTimer.current) window.clearTimeout(hideTimer.current); };
  }, []);

  function toggle() {
    setOpen((v) => {
      if (!v && !pos) setPos({ x: Math.max(8, window.innerWidth - PANEL_W - 14), y: 44 });
      return !v;
    });
  }

  return (
    <>
      <div
        className="overlay-gear fixed top-2 right-2 z-(--z-popout)"
        data-shown={open || touchShown ? "" : undefined}
        style={{ transform: `scale(${1 / scaleFactor})`, transformOrigin: "top right" }}
      >
        <button onClick={toggle} aria-label="Chat settings"
          className="w-7 h-7 flex items-center justify-center rounded-md bg-scrim-heavy text-strong/85 hover:text-strong">
          <GearSix size={16} weight="bold" />
        </button>
      </div>
      {open && pos && (
        <div
          data-chat-panel=""
          className="fixed z-[calc(var(--z-popout)_+_1)] max-h-[80vh] flex flex-col rounded-lg overflow-hidden border border-edge shadow-2xl bg-[#0c101c]/95 text-strong"
          style={{ left: pos.x, top: pos.y, width: PANEL_W * scaleFactor, transform: `scale(${1 / scaleFactor})`, transformOrigin: "top left" }}
        >
          <div
            className="flex items-center justify-between px-3 py-2 border-b border-edge shrink-0 cursor-grab active:cursor-grabbing select-none touch-none"
            onPointerDown={(e) => {
              if ((e.target as Element).closest("button")) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d || d.id !== e.pointerId) return;
              const dx = e.clientX - d.x, dy = e.clientY - d.y;
              drag.current = { id: d.id, x: e.clientX, y: e.clientY };
              setPos((p) => ({ x: (p?.x ?? 0) + dx, y: (p?.y ?? 0) + dy }));
            }}
            onPointerUp={() => { drag.current = null; }}
            onPointerCancel={() => { drag.current = null; }}
          >
            <span className="text-xs text-secondary uppercase tracking-wide font-semibold">Chat settings ⠿</span>
            <button onClick={() => setOpen(false)} aria-label="Close chat settings" className="text-secondary hover:text-strong text-base leading-none px-1">✕</button>
          </div>
          <div className="flex-1 overflow-y-auto overscroll-contain no-scrollbar p-3 min-h-0">
            <ChatPrefs
              overlayPage={page}
              onShowTimestampsChange={onShowTimestampsChange}
              onShowMatrixNameChange={onShowMatrixNameChange}
            />
          </div>
        </div>
      )}
    </>
  );
}
