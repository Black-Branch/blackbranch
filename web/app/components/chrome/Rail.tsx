// web/app/components/chrome/Rail.tsx
"use client";

// Rail — sections go vertical when there are more than ~6 of them (past 7, use a
// sidebar). Same hook, vertical
// orientation, so ArrowUp / ArrowDown move and the horizontal arrows are left
// alone. The host lays it out with `RailLayout` (rail | content).
//
// activation: "manual" — Rail's panels can be expensive to select, not just to
// show (each fetches on mount), so arrowing down the list must move focus
// without firing a request per item before the viewer lands on the one they
// want. Enter/Space selects the focused item; a click still selects too.
//
// Groups and one level of nesting: an item's `group` draws a heading above the
// first item of that group; `depth: 1` indents it under the one before.
// `fold`: each group heading becomes a button that opens
// and closes its group, and a nested item shows only while its parent or a sibling is selected
// (lib/chrome/railFold.ts). Folded items are not rendered, so they leave the tab sequence too.
// `foldKey` remembers the open groups (localStorage); `expandAll` (a search is on) opens all.

import { Fragment, useMemo, useState } from "react";
import { useTabList, type TabItem } from "@/app/lib/chrome/useTabList";
import { openGroups, visibleRailItems, hasChildren } from "@/app/lib/chrome/railFold";
import { useLocalStorageString } from "@/app/lib/useClientState";

export type RailProps<K extends string> = {
  items: readonly TabItem<K>[];
  value: K;
  onChange: (key: K) => void;
  label: string;
  /** Groups open and close; nested items fold under their parent. */
  fold?: boolean;
  /** Where the open groups are remembered (with `fold`). */
  foldKey?: string;
  /** Show every item (a search is filtering the list). */
  expandAll?: boolean;
};

function RailTab<K extends string>({ t, props, parent }: { t: TabItem<K>; props: ReturnType<ReturnType<typeof useTabList<K>>["tabProps"]>; parent: boolean }) {
  return (
    <button {...props} className="chrome-tab" title={t.group ? `${t.group} · ${t.label}` : t.label}
      data-depth={t.depth ? String(t.depth) : undefined} data-parent={parent ? "" : undefined}>
      {t.icon && <span className="chrome-rail-icon" aria-hidden="true">{t.icon}</span>}
      <span className="chrome-tab-label" data-l={t.label}><span>{t.label}</span></span>
      {parent && <span className="chrome-rail-sub" aria-hidden="true">›</span>}
    </button>
  );
}

export function Rail<K extends string>({ items, value, onChange, label, fold = false, foldKey, expandAll = false }: RailProps<K>) {
  // Remembered open groups: read hydration-safe (the server renders none open but the selected one).
  const [raw, setRaw] = useLocalStorageString(foldKey ?? "bb_rail_fold");
  const [local, setLocal] = useState<string[]>([]);
  const stored = useMemo<string[]>(() => {
    if (!foldKey) return local;
    try { const v: unknown = JSON.parse(raw ?? "[]"); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; }
    catch { return []; }
  }, [foldKey, raw, local]);
  const open = openGroups(items, value, stored, expandAll);
  const shown = fold ? visibleRailItems(items, value, open, expandAll) : [...items];
  const { listProps, tabProps } = useTabList({
    items: shown, value, onChange, label, orientation: "vertical", activation: "manual",
  });
  const toggle = (g: string) => {
    const next = open.has(g) ? stored.filter((x) => x !== g) : [...stored, g];
    if (foldKey) setRaw(JSON.stringify(next));
    else setLocal(next);
  };
  // Every group's heading, even a folded one's (it is how the group opens again).
  const groups = fold ? [...new Set(items.map((t) => t.group).filter((g): g is string => !!g))] : [];
  return (
    <div {...listProps} className="chrome-rail" data-fold={fold ? "" : undefined}>
      {fold
        ? groups.map((g, gi) => {
          const mine = shown.filter((t) => t.group === g);
          const isOpen = open.has(g);
          return (
            <Fragment key={g}>
              <button type="button" className="chrome-rail-group chrome-rail-group-toggle" aria-expanded={isOpen}
                data-first={gi === 0 ? "" : undefined} onClick={() => toggle(g)}>
                <span>{g}</span><span aria-hidden="true" className="chrome-rail-caret">{isOpen ? "▾" : "▸"}</span>
              </button>
              {mine.map((t) => <RailTab key={t.key} t={t} props={tabProps(shown.indexOf(t))} parent={hasChildren(items, t.key)} />)}
            </Fragment>
          );
        })
        : shown.map((t, i) => (
          <Fragment key={t.key}>
            {/* A group's heading: presentation only — the tabs keep their own names, and the
                heading sits outside the tab sequence (aria-hidden, no tab stop). */}
            {t.group && t.group !== shown[i - 1]?.group && (
              <div className="chrome-rail-group" aria-hidden="true" data-first={i === 0 ? "" : undefined}>{t.group}</div>
            )}
            <RailTab t={t} props={tabProps(i)} parent={false} />
          </Fragment>
        ))}
    </div>
  );
}
