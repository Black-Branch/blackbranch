"use client";

// The active mode's dropdown: ONLY that mode's options, plain names, the
// current one checked. Anchored
// under the rail by its parent (absolute, top-full). Dismissal goes through
// the shared dismiss stack (useOutsideClick → dismissStack.ts, the same hook
// ContextMenu uses): a press outside the menu AND its anchor closes it (a
// press on the caret is the caret's toggle, not a dismiss, or every open
// would close itself on the same click), and Escape closes only the TOP
// layer of the stack — a hand-rolled `document` keydown listener fires for
// every open surface at once, so with another dismissable surface open on
// top, one Escape would close both. Menu semantics, not a tablist:
// check-chrome's role rule is about tabs, and these are choices inside one
// tab.
import { useRef, type RefObject } from "react";
import { useOutsideClick } from "@/app/lib/useOutsideClick";
import PlatformIcon from "./PlatformIcon";
import type { ModeOption } from "@/app/lib/playerMode";

export function StreamModeMenu({ options, onPick, onClose, anchorRef }: {
  options: ModeOption[];
  onPick: (key: string) => void;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClick([ref, anchorRef], onClose, { escape: true });
  return (
    <div ref={ref} role="menu" className="absolute left-0 top-full mt-1 z-30 min-w-[11rem] rounded-lg border border-edge-strong bg-raised p-1 shadow-xl">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="menuitemradio"
          aria-checked={o.checked}
          onClick={() => { onPick(o.key); onClose(); }}
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-left transition-colors ${
            o.checked ? "bg-surface-3 text-strong" : "text-body-dim hover:bg-surface-2 hover:text-strong"
          }`}
        >
          {o.platform && <PlatformIcon platform={o.platform} size="0.9em" />}
          <span className="flex-1">{o.label}</span>
          {o.checked && <span aria-hidden="true" className="text-[#7dd9a8]">✓</span>}
        </button>
      ))}
    </div>
  );
}
