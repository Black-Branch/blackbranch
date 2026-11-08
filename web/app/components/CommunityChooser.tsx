"use client";

// The viewer's choice among the community streamers live now (ADR 0134: "the viewer chooses").
// Shown on the player's bottom bar only with more than one entry; each by picture and name, our own
// countdown marked "Scheduled". The pick lives in StreamView; this only reports it. The menu opens
// UPWARD — it belongs to the bottom bar — and dismisses through the shared stack, like
// StreamModeMenu.
import { useRef, useState, type RefObject } from "react";
import { CaretUp, UsersThree } from "@phosphor-icons/react/dist/ssr";
import { useOutsideClick } from "@/app/lib/useOutsideClick";
import { initials, type CommunityStatus } from "@/app/lib/streamView";
import { avatarStyle } from "@/app/lib/avatarSize";

type Entry = Pick<CommunityStatus, "key" | "display_name" | "avatar_url" | "scheduled">;
// A community's picture beside its one-line name: the avatar scale's sm step.
const CHOOSER_PIC = avatarStyle("sm");

function Menu({ communities, shownKey, onPick, onClose, anchorRef }: {
  communities: readonly Entry[];
  shownKey: string | null;
  onPick: (key: string) => void;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClick([ref, anchorRef], onClose, { escape: true });
  return (
    <div ref={ref} role="menu" aria-label="Watch" className="absolute right-0 bottom-full mb-1 z-30 w-[14rem] max-w-[calc(100vw-2rem)] rounded-lg border border-edge-strong bg-raised p-1 shadow-xl">
      {communities.map((c) => {
        const checked = c.key === shownKey;
        return (
          <button
            key={c.key}
            type="button"
            role="menuitemradio"
            aria-checked={checked}
            onClick={() => { onPick(c.key); onClose(); }}
            className={`flex w-full min-h-[44px] items-center gap-2 rounded-md px-2 py-1.5 text-xs text-left transition-colors ${
              checked ? "bg-surface-3 text-strong" : "text-body-dim hover:bg-surface-2 hover:text-strong"
            }`}
          >
            {c.avatar_url ? (
              <img src={c.avatar_url} alt="" className="avatar" style={CHOOSER_PIC} />
            ) : (
              <span aria-hidden="true" className="avatar bg-surface-3 flex items-center justify-center font-bold select-none" style={CHOOSER_PIC}>
                {initials(c.display_name)}
              </span>
            )}
            <span className="flex-1 min-w-0 truncate">{c.display_name}</span>
            {c.scheduled && <span className="shrink-0 rounded px-1 bg-surface-2 text-secondary">Scheduled</span>}
            {checked && <span aria-hidden="true" className="text-[#7dd9a8]">✓</span>}
          </button>
        );
      })}
    </div>
  );
}

export function CommunityChooser({ communities, shownKey, onPick }: {
  communities: readonly Entry[];
  shownKey: string | null;
  onPick: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  if (communities.length < 2) return null;
  return (
    <div className="relative shrink-0">
      <button
        ref={anchorRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Choose who to watch (${communities.length} streams)`}
        title="Choose who to watch"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 h-[28px] rounded-full px-2 bg-surface-2 text-body-dim hover:text-strong hover:bg-surface-3 text-xs font-semibold money-hit"
      >
        <UsersThree size={13} weight="bold" />
        <span>{communities.length}</span>
        <CaretUp size={10} weight="bold" />
      </button>
      {open && (
        <Menu communities={communities} shownKey={shownKey} onPick={onPick} onClose={() => setOpen(false)} anchorRef={anchorRef} />
      )}
    </div>
  );
}
