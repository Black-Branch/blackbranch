"use client";

import React, { useEffect, useRef } from "react";
import { emoteCrossOrigin, lowerResEmoteUrl } from "@/app/lib/emoteRes";

type Props = {
  matches: Array<[string, string | null]>; // [name, url | null] — null url = mention
  selected: number;
  onSelect: (name: string) => void;
  onChangeSelected: (i: number) => void;
  isMention?: boolean;
  /** Required, not defaulted: three consumers, two mountable at once (chat
   *  sidebar beside the Matrix panel) — a shared id would collide and the
   *  composer's aria-activedescendant would resolve to whichever won
   *  (typeaheadCombobox.test.ts). Option ids are `${listboxId}-opt-${i}`. */
  listboxId: string;
};

export function EmoteCompletionList({ matches, selected, onSelect, onChangeSelected, isMention, listboxId }: Props) {
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    btnRefs.current[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (matches.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 mb-1 glass rounded-lg overflow-hidden z-50" style={{ width: "clamp(160px, 40%, 240px)" }}>
      <div id={listboxId} role="listbox" className="flex flex-col max-h-56 overflow-y-auto no-scrollbar">
        {matches.map(([name, url], i) => (
          <button
            key={name}
            type="button"
            role="option"
            id={`${listboxId}-opt-${i}`}
            aria-selected={i === selected}
            ref={(el) => { btnRefs.current[i] = el; }}
            onMouseEnter={() => onChangeSelected(i)}
            onMouseDown={(e) => { e.preventDefault(); onSelect(name); }}
            className={`emote-cv flex items-center gap-2.5 px-2.5 py-1.5 text-left shrink-0 transition-colors ${
              i === selected
                ? "bg-surface-3 text-strong"
                : "text-body-dim hover:bg-surface-2"
            }`}
          >
            {isMention || !url ? (
              <span className="text-secondary text-xs shrink-0 w-8 text-center">@</span>
            ) : (
              <img
                src={lowerResEmoteUrl(url)}
                crossOrigin={emoteCrossOrigin(url)}
                alt={name}
                loading="lazy"
                decoding="async"
                className="h-8 w-10 object-contain flex-shrink-0"
              />
            )}
            <span className="text-sm truncate">{name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
