"use client";

// RailLayout — the two-column frame a `Rail` sits inside: the rail on the
// left, content on the right (`.chrome-rail-layout` in chrome.css). Its own
// component, not a class string a feature file writes itself — a mod section
// once did exactly that, which is the one place a
// chrome class name leaked outside app/components/chrome/.

import { useState, type ReactNode } from "react";

// `compactHeading` names the active section above the content. It shows only
// when the rail has collapsed to icons (a narrow container — chrome.css), where
// the rail no longer spells the section's name. The host must declare the size
// container on this layout's PARENT: a container query cannot match its own
// container, so a container declared here could never re-grid the layout.
// `fill`: take the rest of a fixed-frame window body, each column
// scrolling on its own (chrome.css `.chrome-rail-layout[data-fill]`).
// `compact="picker"`: on a narrow container the rail
// folds into a drop-down at the top instead of icons — a button naming the open place
// (`pickerLabel`) opens the full labelled list, and the content gets the whole width. It closes
// when `current` (the open place's key) changes. The picker button is the one heading there, so
// the compact heading is not drawn and a card title marked `data-repeats-place` hides.
export function RailLayout({ rail, compactHeading, fill, compact = "icons", pickerLabel, current, children }: {
  rail: ReactNode;
  compactHeading?: ReactNode;
  fill?: boolean;
  compact?: "icons" | "picker";
  pickerLabel?: ReactNode;
  current?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(current);
  if (current !== seen) { setSeen(current); setOpen(false); }
  const picker = compact === "picker";
  return (
    <div className="chrome-rail-layout" data-fill={fill ? "" : undefined} data-compact={picker ? "picker" : undefined} data-open={picker && open ? "" : undefined}>
      {picker && (
        <button type="button" className="chrome-rail-picker" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className="chrome-rail-picker-label">{pickerLabel}</span>
          <span aria-hidden="true">{open ? "▴" : "▾"}</span>
        </button>
      )}
      {rail}
      <div className="min-w-0">
        {!picker && compactHeading && <div className="chrome-rail-compact-heading">{compactHeading}</div>}
        {children}
      </div>
    </div>
  );
}
