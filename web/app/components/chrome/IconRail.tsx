"use client";

// IconRail — the "modes" tier for the video panel: every item is an icon whose
// colour is its STATE (data-tone: off / available / live); the selected item
// expands in place to its word, its current option after " · ", and — when
// the mode has options — a caret that opens that mode's dropdown. Same hook
// as every other skin; the caret is a sibling button, not a tab, so arrow
// keys move between modes and never land on it.
import type { ReactNode } from "react";
import { CaretDown } from "@phosphor-icons/react/dist/ssr";
import { useTabList } from "@/app/lib/chrome/useTabList";

export type IconRailItem<K extends string> = {
  key: K;
  label: string;
  icon: ReactNode;
  tone: "off" | "available" | "live";
  /** Shown after " · " on the active item only. */
  detail?: string | null;
  /** Active item gets a caret that calls onMenu(key). */
  hasMenu?: boolean;
};

export type IconRailProps<K extends string> = {
  items: readonly IconRailItem<K>[];
  /** null = folded: nothing selected, every item an icon. */
  value: K | null;
  onChange: (key: K) => void;
  label: string;
  onMenu?: (key: K) => void;
  menuOpen?: boolean;
};

export function IconRail<K extends string>({ items, value, onChange, label, onMenu, menuOpen = false }: IconRailProps<K>) {
  // An `off` item has nothing behind it (grey = nothing there), so it
  // is inert rather than a selection that mounts an empty player — UNLESS it
  // is already the active mode (Live can go dark while it stays selected; the
  // viewer isn't picking it, they're already on it, and re-selecting the
  // current mode is a no-op regardless). Guarded on the way INTO the hook
  // because both routes to a selection run through here — the click in
  // tabProps and manual activation's Enter/Space — and a guard on the
  // button's onClick alone would leave the keyboard able to do it.
  const pick = (key: K) => { if (items.find((t) => t.key === key)?.tone !== "off" || key === value) onChange(key); };
  // Manual activation (the hook's own header rule: selection that is expensive
  // must not fire on Arrow). Selecting a mode here mounts a cross-origin embed;
  // with the default "auto", arrowing across the rail mounted one per keypress.
  const { active, listProps, tabProps } = useTabList({ items, value, onChange: pick, label, activation: "manual" });
  return (
    <div {...listProps} className="chrome-iconrail">
      {items.map((t, i) => {
        const on = i === active;
        return (
          <div key={t.key} className="chrome-iconrail-item" data-active={on ? "" : undefined}>
            <button
              {...tabProps(i)}
              // aria-disabled, not `disabled`: an inert mode stays focusable and
              // stays in the rail's arrow order, it just does not select. What
              // makes it do nothing is `pick` above, not this attribute. Never
              // on the SELECTED item though — the viewer is already on it, so
              // announcing it as disabled would be a lie a screen reader user
              // could act on (aria-selected + aria-disabled must not co-occur);
              // the tone still reads as grey via data-tone either way.
              aria-disabled={(t.tone === "off" && !on) || undefined}
              className="chrome-tab"
              data-tone={t.tone}
              title={t.label}
              aria-label={on ? undefined : t.label}
            >
              <span className="chrome-iconrail-icon" aria-hidden="true">{t.icon}</span>
              {on && <span className="chrome-tab-label" data-l={t.label}><span>{t.label}</span></span>}
              {on && t.detail && <span className="chrome-iconrail-detail">· {t.detail}</span>}
            </button>
            {on && t.hasMenu && onMenu && (
              <button
                type="button"
                className="chrome-iconrail-caret"
                aria-label={`${t.label} options`}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => onMenu(t.key)}
              >
                {/* An icon, not the ▾ text glyph it was: at the rail's font
                    size the glyph rendered ~10px and k could neither see nor
                    hit it. The button's own hit area is chrome.css's. */}
                <CaretDown size={12} weight="bold" aria-hidden="true" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
