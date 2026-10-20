"use client";

// The ONE tab-list hook. Every skin in app/components/chrome/ (Sections,
// Segmented, Chips, Rail) is a thin render over this: roving tabindex, arrow /
// Home / End keys (tabListKeys.ts), aria roles and — opt-in — the tab ⇄ panel
// id pairing. A skin that needs different behaviour changes this file, not
// itself, so the strips never drift into separate keyboard models.
//
// Activation (WAI-ARIA "Tabs" pattern — automatic vs. manual activation):
// "auto" (default) moves focus AND selection together on Arrow/Home/End —
// right when showing a panel is cheap. "manual" moves focus only; Enter or
// Space on the focused tab selects it. Manual is for a tab list whose
// selection is expensive — Rail's bot panels each fetch on mount, so
// arrowing through them must not fire a request per tab passed on the way.
//
// `value: null` is "nothing selected" — the collapsed dock, whose tabs open a
// pane that is currently closed. No tab is aria-selected then; `active` is −1
// and everything that needs a REAL index (the roving tabindex, the keyboard's
// starting point) falls back to the first tab, so the strip stays reachable.

import { useCallback, useId, useReducer, useRef, type KeyboardEvent, type ReactNode } from "react";
import { activeIndex, moveIndex, type Orientation } from "./tabListKeys.ts";

export type TabItem<K extends string = string> = {
  key: K;
  label: string;
  /** Unseen-activity dot beside the label (Sections). */
  dot?: boolean;
  /** Show a ✕ on this tab while it is active; Sections calls `onClose(key)` (Sections). */
  closable?: boolean;
  /** Optional icon (Rail shows it; in the compact rail it replaces the label). */
  icon?: ReactNode;
  /** Rail: the group this item heads into — a small heading is drawn above the first item of each
   *  group (a thin rule in the compact rail). */
  group?: string;
  /** Rail: 1 = nested under the item before it (indented). */
  depth?: 0 | 1;
};

export type UseTabListArgs<K extends string> = {
  items: readonly TabItem<K>[];
  /** null = nothing selected (a collapsed dock): no tab is aria-selected; focus falls to the first. */
  value: K | null;
  onChange: (key: K) => void;
  /** aria-label for the tablist — say what the sections ARE ("Mod panel sections"). */
  label: string;
  orientation?: Orientation;
  /** "auto" (default): Arrow/Home/End move focus AND selection. "manual":
   *  they move focus only; Enter/Space selects the focused tab. See the file
   *  header for which tier needs which. */
  activation?: "auto" | "manual";
  /** Emit `aria-controls` (paired with `panelProps`'s id) — opt-in because
   *  most consumers render no panel element, and a dangling `aria-controls`
   *  is worse than none at all. */
  panels?: boolean;
};

export function useTabList<K extends string>({
  items, value, onChange, label, orientation = "horizontal", activation = "auto", panels = false,
}: UseTabListArgs<K>) {
  const id = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const keys = items.map((t) => t.key);
  // -1 when nothing is selected (value null). Everything that needs a REAL
  // index (roving tabindex, the keyboard's "from") starts from `anchor`.
  const active = value === null ? -1 : activeIndex(keys, value);
  const anchor = Math.max(0, active);

  // Manual activation only: which tab has DOM focus, independent of which is
  // selected — read only when `activation === "manual"`, so its value is
  // irrelevant (and never written) in "auto" mode, where focus always IS the
  // selection. Lives in a ref so moving focus never depends on a parent
  // re-render; `bump` forces just this hook's own render so the roving
  // tabIndex it drives comes out right on the next paint.
  const focusedRef = useRef(anchor);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const focused = activation === "manual" ? focusedRef.current : anchor;

  const moveFocusTo = useCallback((i: number) => {
    focusedRef.current = i;
    refs.current[i]?.focus();
    bump();
  }, []);

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLElement>) => {
    const from = activation === "manual" ? focusedRef.current : anchor;
    const to = moveIndex(from, e.key, items.length, orientation);
    if (to !== null) {
      e.preventDefault();
      if (activation === "manual") {
        moveFocusTo(to);
      } else {
        onChange(items[to]!.key);
        refs.current[to]?.focus();
      }
      return;
    }
    if (activation === "manual" && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      onChange(items[focusedRef.current]!.key);
    }
  }, [anchor, items, onChange, orientation, activation, moveFocusTo]);

  const listProps = {
    role: "tablist" as const,
    "aria-label": label,
    "aria-orientation": orientation,
    onKeyDown,
  };

  const tabProps = (i: number) => {
    const item = items[i]!;
    return {
      role: "tab" as const,
      type: "button" as const,
      id: `${id}-tab-${i}`,
      "aria-selected": i === active,
      ...(panels ? { "aria-controls": `${id}-panel-${i}` } : {}),
      tabIndex: i === focused ? 0 : -1,
      ref: (el: HTMLButtonElement | null) => { refs.current[i] = el; },
      onClick: () => {
        if (activation === "manual") { focusedRef.current = i; bump(); }
        onChange(item.key);
      },
    };
  };

  const panelProps = (key: K) => {
    const found = keys.indexOf(key);
    const i = found >= 0 ? found : anchor;
    return {
      role: "tabpanel" as const,
      id: `${id}-panel-${i}`,
      "aria-labelledby": `${id}-tab-${i}`,
    };
  };

  return { active, listProps, tabProps, panelProps };
}
