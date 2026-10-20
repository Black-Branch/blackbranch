// web/app/components/chrome/Segmented.tsx
"use client";

// Segmented — the "views" tier: the same content shown another way (source
// switch, Emoji / Emotes, split / single). Equal-width segments (Apple HIG),
// a thumb that moves by transform only: width is 1/n of the track and the
// translate is n × 100%, so nothing is measured.

import type { CSSProperties } from "react";
import { useTabList, type TabItem } from "@/app/lib/chrome/useTabList";

export type SegmentedProps<K extends string> = {
  items: readonly TabItem<K>[];
  value: K;
  onChange: (key: K) => void;
  label: string;
};

export function Segmented<K extends string>({ items, value, onChange, label }: SegmentedProps<K>) {
  const { active, listProps, tabProps } = useTabList({ items, value, onChange, label });
  const style = { "--chrome-n": Math.max(1, items.length), "--chrome-i": active } as CSSProperties;
  return (
    <div {...listProps} className="chrome-segmented" style={style}>
      <span aria-hidden className="chrome-thumb" />
      {items.map((t, i) => (
        <button key={t.key} {...tabProps(i)} className="chrome-tab">
          <span className="chrome-tab-label" data-l={t.label}><span>{t.label}</span></span>
        </button>
      ))}
    </div>
  );
}
