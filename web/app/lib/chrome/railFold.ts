// Which rail items show when a Rail folds. Pure, so it is
// tested without a DOM. A group folds under its heading; a nested item (depth 1) folds under the
// place it is nested in. The selected place's group is always open, and so are its parent's
// children; `expandAll` (a search is on) opens everything.

export type FoldItem = { key: string; group?: string; depth?: 0 | 1 };

/** The parent (nearest depth-0 item before it) of every nested item, by key. */
function parents(items: readonly FoldItem[]): Map<string, string> {
  const out = new Map<string, string>();
  let parent: string | null = null;
  for (const it of items) {
    if (it.depth === 1) { if (parent) out.set(it.key, parent); }
    else parent = it.key;
  }
  return out;
}

/** The groups shown open: the stored open set plus the selected place's group. */
export function openGroups(items: readonly FoldItem[], value: string | null, stored: readonly string[], expandAll = false): Set<string> {
  const open = new Set(stored);
  if (expandAll) for (const it of items) if (it.group) open.add(it.group);
  const sel = items.find((it) => it.key === value);
  if (sel?.group) open.add(sel.group);
  return open;
}

/** The items to render, in order. */
export function visibleRailItems<T extends FoldItem>(items: readonly T[], value: string | null, open: ReadonlySet<string>, expandAll = false): T[] {
  if (expandAll) return [...items];
  const parentOf = parents(items);
  const selParent = value ? (parentOf.get(value) ?? value) : null;
  return items.filter((it) => {
    if (it.group && !open.has(it.group)) return false;
    if (it.depth === 1) return parentOf.get(it.key) === selParent;
    return true;
  });
}

/** Whether an item has nested items under it (the rail draws a marker beside it). */
export function hasChildren(items: readonly FoldItem[], key: string): boolean {
  const i = items.findIndex((it) => it.key === key);
  return i >= 0 && items[i]!.depth !== 1 && items[i + 1]?.depth === 1;
}
