"use client";

import { useState } from "react";
import { ContextMenu, MenuItem } from "./ContextMenu";
import { msgMenuItems, type MsgMenuCtx } from "./msgMenuItems";

// ─── The ⋯ menu (desktop, and the toolbar's ⋯ by keyboard) ───────────────────
// The items come from msgMenuItems, the same list the phone's long-press sheet shows.

export function MsgContextMenu({ x, y, onClose, ...ctx }: MsgMenuCtx & { x: number; y: number; onClose: () => void }) {
  // The item whose confirm text is showing (its second tap runs it).
  const [armed, setArmed] = useState<string | null>(null);

  return (
    <ContextMenu x={x} y={y} onClose={onClose} className="glyph-text">
      {msgMenuItems(ctx, "sent").map((item) => (
        <MenuItem
          key={item.id}
          className={item.danger ? "text-rose-400! hover:bg-rose-500/10!" : ""}
          onClick={() => {
            if (item.confirm && armed !== item.id) { setArmed(item.id); return; }
            item.run();
            onClose();
          }}
        >
          <span aria-hidden="true" className="flex shrink-0">{item.icon}</span>
          {armed === item.id && item.confirm ? item.confirm : item.label}
        </MenuItem>
      ))}
    </ContextMenu>
  );
}
