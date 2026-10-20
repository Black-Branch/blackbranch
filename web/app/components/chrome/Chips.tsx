// web/app/components/chrome/Chips.tsx
"use client";

// Chips — the "filters" tier: narrow a list without leaving it. Scrolls under a
// fade, never wraps. `onItemMouseDown` exists for ONE reason: the emote picker
// keeps its search box focused across a category change (keepFocus), and
// that is a mousedown concern the skin cannot know about.

import type { MouseEvent } from "react";
import { useTabList, type TabItem } from "@/app/lib/chrome/useTabList";

export type ChipsProps<K extends string> = {
  items: readonly TabItem<K>[];
  value: K;
  onChange: (key: K) => void;
  label: string;
  onItemMouseDown?: (e: MouseEvent<HTMLButtonElement>) => void;
};

export function Chips<K extends string>({ items, value, onChange, label, onItemMouseDown }: ChipsProps<K>) {
  const { listProps, tabProps } = useTabList({ items, value, onChange, label });
  return (
    <div {...listProps} className="chrome-chips">
      {items.map((t, i) => (
        <button key={t.key} {...tabProps(i)} onMouseDown={onItemMouseDown} className="chrome-tab">
          <span className="chrome-tab-label" data-l={t.label}><span>{t.label}</span></span>
        </button>
      ))}
    </div>
  );
}
