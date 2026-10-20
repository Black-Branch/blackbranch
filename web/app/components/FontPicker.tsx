"use client";

import { useState, useEffect, useRef, useCallback, useMemo, useId } from "react";
import { createPortal } from "react-dom";
import { useOutsideClick } from "../lib/useOutsideClick";
import { FONTS } from "../lib/settingsRegistry";
import { FONT_GROUPS } from "../lib/settingsFonts";
import { FIELD } from "./SettingsControls";

const GENERIC_VALS = new Set(["inherit", "system-ui, sans-serif", "Georgia, serif", "ui-monospace, monospace"]);

export function FontPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const listboxId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  // The menu is portaled to <body> (below), so it's not inside `ref` — keep a
  // separate ref so the outside-click handler doesn't treat menu clicks as outside.
  const menuRef = useRef<HTMLDivElement>(null);
  // Menu placement computed against the viewport so it never flips off-screen
  // or gets clipped by the scrollable settings panel (fixed positioning).
  const [menu, setMenu] = useState<{ left: number; width: number; top?: number; bottom?: number; maxHeight: number }>();

  // Grouped: Default first, then each group
  // in FONT_GROUPS order, alphabetical inside it. ‹ › and the arrow keys walk
  // this same order; group headings are drawn between runs, not as options.
  const sortedOpts = useMemo(
    () => [...FONTS].sort((a, b) =>
      FONT_GROUPS.indexOf(a.group) - FONT_GROUPS.indexOf(b.group) || a.label.localeCompare(b.label)),
    [],
  );

  const place = useCallback(() => {
    const btn = btnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const gap = 4;        // space between button and menu
    const margin = 8;     // keep clear of the viewport edges
    const spaceBelow = window.innerHeight - r.bottom - gap - margin;
    const spaceAbove = r.top - gap - margin;
    // Prefer dropping down; flip up only when below is too cramped and above has more room.
    const dropUp = spaceBelow < 180 && spaceAbove > spaceBelow;
    setMenu({
      left: r.left,
      width: r.width,
      maxHeight: Math.max(120, Math.floor(dropUp ? spaceAbove : spaceBelow)),
      ...(dropUp
        ? { bottom: window.innerHeight - r.top + gap }
        : { top: r.bottom + gap }),
    });
  }, []);

  // Outside press closes (trigger row + portaled menu both count as inside).
  const outsideRefs = useMemo(() => [ref, menuRef], []);
  const closeMenu = useCallback(() => setOpen(false), []);
  useOutsideClick(outsideRefs, closeMenu, { enabled: open });

  useEffect(() => {
    if (!open) return;
    place();
    const reposition = () => place();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, place]);

  const current = FONTS.find(f => f.value === value) ?? FONTS[0]!;
  // Keyboard/listbox semantics (this was the one control with no keyboard
  // path): trigger is a combobox-style button; Arrow keys move an active
  // option, Enter/Space commits, Escape closes and returns focus.
  const curIdx = Math.max(0, sortedOpts.findIndex(f => f.value === value));
  const [activeIdx, setActiveIdx] = useState(curIdx);
  const step = useCallback((delta: number) => {
    const nextIdx = (curIdx + delta + sortedOpts.length) % sortedOpts.length;
    onChange(sortedOpts[nextIdx]!.value);
  }, [curIdx, onChange, sortedOpts]);

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ")) {
      e.preventDefault(); setActiveIdx(curIdx); setOpen(true); return;
    }
    if (!open) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, sortedOpts.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const f = sortedOpts[activeIdx]; if (f) onChange(f.value);
      setOpen(false);
    }
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false); btnRef.current?.focus(); }
  };
  return (
    <div ref={ref} className="flex-1 min-w-0 relative flex items-center gap-1">
      <button
        type="button"
        onClick={() => step(-1)}
        aria-label="Previous font"
        className="grid place-items-center w-6 h-6 shrink-0 rounded-md text-muted hover:text-body hover:bg-surface-2 transition-colors"
      >
        ‹
      </button>
      <div className="flex-1 min-w-0 relative">
        <button
          ref={btnRef}
          type="button"
          onClick={() => setOpen(o => !o)}
          onKeyDown={onTriggerKeyDown}
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-haspopup="listbox"
          className={`${FIELD} w-full px-2 text-xs text-left flex items-center justify-between gap-1 hover:bg-surface-3 transition-colors`}
          style={{ fontFamily: !GENERIC_VALS.has(current.value) ? current.value : undefined }}
        >
          <span className="truncate">{current.label}</span>
          <span className="text-muted shrink-0">{open ? "▴" : "▾"}</span>
        </button>
        {open && menu && typeof document !== "undefined" && createPortal(
          <div
            ref={menuRef}
            id={listboxId}
            role="listbox"
            className="fixed glass rounded-lg z-(--z-top) overflow-hidden"
            style={{ left: menu.left, width: menu.width, top: menu.top, bottom: menu.bottom }}
          >
            <div className="flex flex-col overflow-y-auto no-scrollbar" style={{ maxHeight: menu.maxHeight }}>
              {sortedOpts.map((f, i) => (
                <div key={f.value} className="contents">
                {f.group !== "Default" && f.group !== sortedOpts[i - 1]?.group && (
                  <div role="presentation" className="px-3 pt-2 pb-0.5 text-3xs font-semibold uppercase tracking-wide text-muted">
                    {f.group}
                  </div>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={f.value === value}
                  onMouseDown={e => { e.preventDefault(); e.stopPropagation(); onChange(f.value); setOpen(false); }}
                  onMouseEnter={() => setActiveIdx(i)}
                  className={`px-3 py-1.5 text-xs text-left shrink-0 transition-colors ${
                    f.value === value ? "bg-surface-3 text-strong"
                    : i === activeIdx && open ? "bg-surface-2 text-heading"
                    : "text-body-dim hover:bg-surface-2"
                  }`}
                  style={{ fontFamily: !GENERIC_VALS.has(f.value) ? f.value : undefined }}
                >
                  {f.label}
                </button>
                </div>
              ))}
            </div>
          </div>,
          document.body
        )}
      </div>
      <button
        type="button"
        onClick={() => step(1)}
        aria-label="Next font"
        className="grid place-items-center w-6 h-6 shrink-0 rounded-md text-muted hover:text-body hover:bg-surface-2 transition-colors"
      >
        ›
      </button>
    </div>
  );
}
