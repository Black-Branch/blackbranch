"use client";

import { useCallback, useRef, useState } from "react";
import { Plus } from "@phosphor-icons/react/dist/ssr";
import { Window } from "@/app/components/chrome";
import { keepFocus } from "@/app/lib/keepFocus";
import { useOutsideClick } from "@/app/lib/useOutsideClick";
import type { EmoteMap } from "@/app/lib/useEmotes";
import type { ReactionAgg } from "@/app/lib/matrixReactions";
import { ReactionKey } from "./ReactionPicker";
import type { MsgMenuItem } from "./msgMenuItems";

export type MessageSheetView = { kind: "actions" } | { kind: "reactions"; key: string };

// The phone's long-press sheet: ONE surface per gesture. Actions: the quick reactions + ＋ on
// top, every action below as a 48 px row. Reactions: who reacted, one tab per pile. Long-press is
// touch-only, so there is no floating form — the desktop keeps its hover toolbar and ⋯ menu.
export function MessageSheet({
  open, onClose, view, quickReactions, activeKeys, onReact, onMore, items, reactions, nameOf, emotes,
}: {
  open: boolean;
  onClose: () => void;
  view: MessageSheetView;
  /** Empty = no quick row (a message nobody received). */
  quickReactions: string[];
  activeKeys?: Set<string>;
  onReact: (key: string) => void;
  /** ＋: the full reaction picker. */
  onMore: () => void;
  items: MsgMenuItem[];
  reactions: ReactionAgg[];
  nameOf: (userId: string) => string;
  emotes?: EmoteMap;
}) {
  if (!open) return null;
  return view.kind === "reactions" ? (
    <ReactionsSheet onClose={onClose} startKey={view.key} reactions={reactions} nameOf={nameOf} emotes={emotes} />
  ) : (
    <ActionsSheet onClose={onClose} quickReactions={quickReactions} activeKeys={activeKeys} onReact={onReact}
      onMore={onMore} items={items} emotes={emotes} />
  );
}

/** A press outside the sheet closes it, like any sheet. The ref is the Window's own dialog, found
 *  from inside, so its band (grabber, ✕) counts as inside. Mouse only: a scroll that starts on the
 *  chat behind is not a dismissal, and a tap synthesises the mousedown. */
function useSheetDismiss(onClose: () => void) {
  const dialog = useRef<HTMLElement | null>(null);
  const bodyRef = useCallback((el: HTMLDivElement | null) => {
    dialog.current = el?.closest<HTMLElement>('[role="dialog"]') ?? el;
  }, []);
  useOutsideClick(dialog, onClose, { touch: false });
  return bodyRef;
}

function ActionsSheet({
  onClose, quickReactions, activeKeys, onReact, onMore, items, emotes,
}: {
  onClose: () => void; quickReactions: string[]; activeKeys?: Set<string>; onReact: (key: string) => void;
  onMore: () => void; items: MsgMenuItem[]; emotes?: EmoteMap;
}) {
  const bodyRef = useSheetDismiss(onClose);
  const [armed, setArmed] = useState<string | null>(null);
  return (
    <Window presentation="panel" kind="peek" name="Message actions" onClose={onClose}>
      <div ref={bodyRef} className="pb-2">
        {quickReactions.length > 0 && (
          <div data-sheet-quick="" className="flex items-center gap-2 px-3 pt-1 pb-2">
            {quickReactions.map((k) => (
              <button key={k} type="button" aria-label={`React with ${k}`} onMouseDown={keepFocus}
                onClick={() => { onReact(k); onClose(); }}
                className={`flex-1 h-12 flex items-center justify-center rounded-full transition-colors ${
                  activeKeys?.has(k) ? "bg-accent/25" : "bg-surface-2 hover:bg-surface-3"}`}>
                <ReactionKey k={k} emotes={emotes} size="1.5rem" />
              </button>
            ))}
            <button type="button" aria-label="More reactions" onMouseDown={keepFocus} onClick={onMore}
              className="flex-1 h-12 flex items-center justify-center rounded-full bg-surface-2 hover:bg-surface-3 text-body-dim transition-colors">
              <Plus size={20} weight="bold" />
            </button>
          </div>
        )}
        <div className="mx-3 rounded-lg overflow-hidden bg-surface-1">
          {items.filter((i) => i.id !== "react").map((item) => (
            <button key={item.id} type="button" data-sheet-item="" onMouseDown={keepFocus}
              onClick={() => {
                if (item.confirm && armed !== item.id) { setArmed(item.id); return; }
                item.run();
                onClose();
              }}
              className={`w-full h-12 px-4 flex items-center gap-3 text-left text-sm transition-colors hover:bg-surface-2 ${
                item.danger ? "text-rose-400" : "text-body"}`}>
              <span aria-hidden="true" className="flex shrink-0 opacity-80">{item.icon}</span>
              {armed === item.id && item.confirm ? item.confirm : item.label}
            </button>
          ))}
        </div>
      </div>
    </Window>
  );
}

function ReactionsSheet({
  onClose, startKey, reactions, nameOf, emotes,
}: {
  onClose: () => void; startKey: string; reactions: ReactionAgg[]; nameOf: (userId: string) => string; emotes?: EmoteMap;
}) {
  const bodyRef = useSheetDismiss(onClose);
  const [key, setKey] = useState(startKey);
  const pile = reactions.find((r) => r.key === key) ?? reactions[0];
  return (
    <Window presentation="panel" kind="peek" name="Reactions" title="Reactions" onClose={onClose}>
      <div ref={bodyRef} className="pb-2">
        <div className="flex gap-1.5 px-3 pb-2 overflow-x-auto no-scrollbar">
          {reactions.map((r) => (
            <button key={r.key} type="button" data-reaction-tab={r.key} aria-pressed={r.key === pile?.key}
              onMouseDown={keepFocus} onClick={() => setKey(r.key)}
              className={`shrink-0 h-9 px-3 flex items-center gap-1.5 rounded-full border text-sm transition-colors ${
                r.key === pile?.key ? "bg-accent/20 border-accent/50 text-heading" : "bg-surface-1 border-edge text-body-dim"}`}>
              <ReactionKey k={r.key} emotes={emotes} size="1.1rem" mxc={r.mxc} />
              <span className="tabular-nums">{r.count}</span>
            </button>
          ))}
        </div>
        <ul className="mx-3">
          {(pile?.senders ?? []).map((id) => (
            <li key={id} data-reactor="" className="h-12 flex items-center text-sm text-body truncate">{nameOf(id)}</li>
          ))}
        </ul>
      </div>
    </Window>
  );
}
