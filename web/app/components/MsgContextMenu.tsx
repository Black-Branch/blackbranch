"use client";

import { useState } from "react";
import { ContextMenu, MenuItem } from "./ContextMenu";

// ─── Touch context menu (shared) ─────────────────────────────────────────────

export function MsgContextMenu({
  x, y, onReact, onReply, onThread, onMention, onEdit, onCopy, onCopyLink, onPin, pinned, onDelete, onClose,
}: {
  x: number; y: number;
  onReact?: () => void;
  onReply?: () => void;
  onThread?: () => void;
  /** Insert "@name" into the composer (the row's tap target is the member
   *  card, so this menu is where that shortcut lives). */
  onMention?: () => void;
  onEdit?: () => void;
  onCopy: () => void;
  onCopyLink?: () => void;
  onPin?: () => void;
  pinned?: boolean;
  onDelete?: () => void;
  onClose: () => void;
}) {
  // Two-step inline confirm for destructive delete (no window.confirm — a native
  // dialog would freeze the Chrome-extension automation path).
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <ContextMenu x={x} y={y} onClose={onClose} className="glyph-text">
      {onReact && (
        <MenuItem onClick={() => { onReact(); onClose(); }}>
          <span>😊</span> React
        </MenuItem>
      )}
      {onReply && (
        <MenuItem onClick={() => { onReply(); onClose(); }}>
          <span>↩</span> Reply
        </MenuItem>
      )}
      {onThread && (
        <MenuItem onClick={() => { onThread(); onClose(); }}>
          <span>🧵</span> Reply in thread
        </MenuItem>
      )}
      {onMention && (
        <MenuItem onClick={() => { onMention(); onClose(); }}>
          <span>@</span> Mention
        </MenuItem>
      )}
      {onEdit && (
        <MenuItem onClick={() => { onEdit(); onClose(); }}>
          <span>✎</span> Edit
        </MenuItem>
      )}
      <MenuItem onClick={() => { onCopy(); onClose(); }}>
        <span>⎘</span> Copy text
      </MenuItem>
      {onCopyLink && (
        <MenuItem onClick={() => { onCopyLink(); onClose(); }}>
          <span>🔗</span> Copy link
        </MenuItem>
      )}
      {onPin && (
        <MenuItem onClick={() => { onPin(); onClose(); }}>
          <span>📌</span> {pinned ? "Unpin message" : "Pin message"}
        </MenuItem>
      )}
      {onDelete && (
        <MenuItem
          className="text-rose-400! hover:bg-rose-500/10!"
          onClick={() => {
            if (!confirmDelete) { setConfirmDelete(true); return; }
            onDelete();
            onClose();
          }}
        >
          <span>🗑</span> {confirmDelete ? "Confirm delete?" : "Delete"}
        </MenuItem>
      )}
    </ContextMenu>
  );
}
