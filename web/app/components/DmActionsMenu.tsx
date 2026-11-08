"use client";

// A conversation's own menu (client polish Task 20; k's item 11): Pin / Unpin, Close (hide it from
// the list until they write again — Discord's X) and Leave (leave the conversation; the other person
// sees that you left), the last behind a confirm. ONE menu for the two places that open it: a DM row's
// long-press / right-click in the Community list, and the DM window's "More" button. Block stays
// where the request puts it (the DM window's Accept · Decline · Block).

import { useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useOutsideClick } from "@/app/lib/useOutsideClick";
import { clampToViewport } from "@/app/lib/userCardLayout";
import type { DmActions } from "@/app/lib/dmConversations";

const W = 244;


export function DmActionsMenu({ name, actions, x, y, onDismiss, anchorRef }: {
  /** The person, as the list shows them. */
  name: string;
  actions: DmActions;
  x: number;
  y: number;
  onDismiss: () => void;
  /** The control that opened the menu (outside the menu's DOM): a press on it is not an outside click. */
  anchorRef?: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useOutsideClick(anchorRef ? [ref, anchorRef] : ref, onDismiss, { escape: true });
  if (typeof document === "undefined") return null;

  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    setFailed(false);
    void fn().then(onDismiss, (e: unknown) => {
      console.warn("[dm] conversation action failed:", e);
      setBusy(false);
      setFailed(true);
    });
  };

  const left = clampToViewport(x, W, window.innerWidth);
  const top = Math.max(8, Math.min(y, window.innerHeight - 200));
  const item = "w-full text-left px-2 py-2 rounded-md text-sm transition-colors disabled:opacity-50";

  return createPortal(
    <div ref={ref} role="menu" aria-label={`Conversation with ${name}`} data-dm-actions=""
      className="fixed z-(--z-menu) glass rounded-xl overflow-hidden p-2" style={{ left, top, width: W }}>
      {confirming ? (
        <div className="flex flex-col gap-2 p-1" data-dm-leave-confirm="">
          <p className="text-sm text-body">Leave your conversation with {name}? They will see that you left.</p>
          <div className="flex items-center gap-2">
            <button type="button" role="menuitem" disabled={busy} onClick={() => run(actions.onLeave)}
              className="h-8 rounded-md px-3 text-sm font-semibold bg-rose-500/20 text-rose-300 hover:bg-rose-500/30 disabled:opacity-50">
              Leave
            </button>
            <button type="button" role="menuitem" disabled={busy} onClick={() => setConfirming(false)}
              className="h-8 rounded-md px-3 text-sm text-secondary hover:bg-surface-1 disabled:opacity-50">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <button type="button" role="menuitem" disabled={busy} onClick={() => run(() => actions.onPin(!actions.pinned))}
            className={`${item} text-body-dim hover:bg-surface-1`}>
            {actions.pinned ? "Unpin conversation" : "Pin conversation"}
          </button>
          <button type="button" role="menuitem" disabled={busy} onClick={() => run(actions.onHide)}
            className={`${item} text-body-dim hover:bg-surface-1`}>
            <span className="block">Close conversation</span>
            <span className="block text-2xs text-muted">Hidden until they write again.</span>
          </button>
          <button type="button" role="menuitem" disabled={busy} onClick={() => setConfirming(true)}
            className={`${item} text-rose-300 hover:bg-surface-1`}>
            Leave conversation
          </button>
        </>
      )}
      {failed && <p role="alert" className="px-2 pt-1 text-2xs text-red-300">Couldn&apos;t do that. Try again.</p>}
    </div>,
    document.body,
  );
}
