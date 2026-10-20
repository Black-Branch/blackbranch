"use client";

import { useState } from "react";
import { ContextMenu, MenuItem } from "./ContextMenu";
import { dispatchClaimable } from "@/app/lib/claimableEvent";
import {
  modBanAtOnce, modPurge, lastTimeoutMins, timeoutLabel, banTargetOf, type ModTargetMsg, type ModResult,
} from "@/app/lib/modQuickActions";

// ─── The MOD ⋯ menu on a message — live chat AND the mod panel's Chat history ───────
//
// The second tier behind the message toolbar on both pointer types. It holds
// only the mod quick actions (reply/votes/copy live on the toolbar), which is
// why ChatMessage renders the ⋯ only when a mod handler is present.
//
// With a `msg`, the menu times out (the remembered length), bans and purges the sender, opens the
// message's details and opens the mod panel on them — the SAME component on a live row and a Chat
// history row, its actions from app/lib/modQuickActions.ts (shared with the user card).
//
// Time out and Ban act AT ONCE and offer an Undo (app/lib/modUndo.ts, drawn by ModUndoToast)
// instead of asking first. Purge and Delete keep one confirm: a removed message cannot be put back
// (a platform deletion is final), so there is nothing an Undo could restore. A confirm arm changes
// the visible label (a title-only arm reads as broken on phones); closing the menu resets every
// arm. `inModPanel` drops "Open in mod panel" where it would open the panel it is already in.
export function MessageContextMenu({
  x, y, onPin, onDelete, msg, onDetails, onResult, onReport, onClose, inModPanel = false,
}: {
  x: number; y: number;
  onPin?: () => void;
  onDelete?: () => void;
  /** The message, for the sender actions. Without it the menu is pin + delete only. */
  msg?: ModTargetMsg;
  /** Opens the message's details (the user card on the message). */
  onDetails?: () => void;
  /** Told how a sender action went (a failure's reason). */
  onResult?: (text: string) => void;
  /** Report this message to the mods — offered to every signed-in viewer, not only mods. */
  onReport?: () => void;
  onClose: () => void;
  /** Shown inside the mod panel (its Chat history): no "Open in mod panel". */
  inModPanel?: boolean;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [armed, setArmed] = useState<"purge" | null>(null);
  const mins = lastTimeoutMins();
  const target = msg ? banTargetOf(msg) : null;
  const run = (label: string, p: Promise<ModResult>) => {
    onClose();
    void p.then((r) => { if (!r.ok) onResult?.(r.error); else if (label) onResult?.(`${label}: done.`); });
  };
  return (
    <ContextMenu x={x} y={y} onClose={onClose} minWidth={200}>
      {onPin && (
        <MenuItem onClick={() => { onPin(); onClose(); }}>
          <span>📌</span> Pin
        </MenuItem>
      )}
      {onDetails && (
        <MenuItem onClick={() => { onDetails(); onClose(); }}>
          <span>🔎</span> Details
        </MenuItem>
      )}
      {msg && target && (
        <>
          {/* At once: the toast says it is done and offers Undo, so no second message here. */}
          <MenuItem onClick={() => run("", modBanAtOnce(msg, mins))}>
            <span>⏱</span> Time out {timeoutLabel(mins)}
          </MenuItem>
          <MenuItem
            className="text-red-300! hover:bg-red-900/30!"
            onClick={() => { if (armed !== "purge") { setArmed("purge"); return; } run("Purge 24h", modPurge(msg)); }}
          >
            <span>🧹</span> {armed === "purge" ? "Confirm purge (24h)?" : "Purge last 24h"}
          </MenuItem>
          <MenuItem className="text-red-300! hover:bg-red-900/30!" onClick={() => run("", modBanAtOnce(msg))}>
            <span>🔨</span> Ban
          </MenuItem>
          {!inModPanel && (
            <MenuItem onClick={() => { onClose(); dispatchClaimable("bb:open-modpanel", { target: msg.matrixId ?? msg.canonicalId ?? "" }); }}>
              <span>🛡</span> Open in mod panel
            </MenuItem>
          )}
        </>
      )}
      {onReport && (
        <MenuItem onClick={() => { onClose(); onReport(); }}>
          <span>🚩</span> Report
        </MenuItem>
      )}
      {onDelete && (
        <MenuItem
          className="text-red-300! hover:bg-red-900/30! border-t border-edge"
          // Two-step, like MsgContextMenu: a mod delete removes a viewer's
          // message everywhere. The arm changes the VISIBLE label.
          onClick={() => {
            if (!confirmDelete) { setConfirmDelete(true); return; }
            onDelete();
            onClose();
          }}
        >
          <span>🗑</span> {confirmDelete ? "Confirm delete?" : "Delete (mod)"}
        </MenuItem>
      )}
    </ContextMenu>
  );
}
