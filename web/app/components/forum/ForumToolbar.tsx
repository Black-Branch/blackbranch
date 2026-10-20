"use client";

import { useRef, useState, type ReactNode } from "react";
import { CHAT_FONT } from "@/app/lib/chatFont";
import { useOutsideClick } from "@/app/lib/useOutsideClick";
import type { PostSort } from "@/app/lib/matrixForum";
import { MagnifyingGlass, Plus } from "@phosphor-icons/react/dist/ssr";

// The forum's "Sort · Search · New Post" row, shared by the Matrix pane's
// ForumView and the Forums tab (which puts its room chips in `leading`). Pure
// over `sort`/`query`; the callers own persistence (mx-forum-sort).

const SORT_LABELS: Record<PostSort, string> = {
  active: "Recently Active",
  new: "Date Posted",
  top: "Top Voted",
};

export function ForumToolbar({
  sort,
  onSort,
  query,
  onQuery,
  tight,
  onNewPost,
  leading,
  hint = null,
}: {
  sort: PostSort;
  onSort: (s: PostSort) => void;
  query: string;
  onQuery: (q: string) => void;
  /** Narrow pane: the sort label and the search field collapse to icons. */
  tight: boolean;
  onNewPost: () => void;
  /** Rendered first in the row (the Forums tab's room chips). */
  leading?: ReactNode;
  /** A one-line status under the row ("Sign in to vote"). */
  hint?: string | null;
}) {
  const [sortOpen, setSortOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false); // tight: search collapsed by default
  const sortRef = useRef<HTMLDivElement>(null);
  useOutsideClick(sortRef, () => setSortOpen(false), { enabled: sortOpen, escape: true });

  // Tight panes show the search as a toggle so the New Post button always fits.
  const showSearchField = !tight || searchOpen;

  return (
    <>
      <div className="flex items-center gap-2 px-3 py-2 shrink-0 min-w-0">
        {leading}
        {/* Sort dropdown */}
        <div className="relative shrink-0" ref={sortRef}>
          <button
            type="button"
            onClick={() => setSortOpen((o) => !o)}
            title="Sort posts"
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 bg-surface-1 border border-edge text-body-dim hover:bg-surface-2 transition-colors"
            style={{ fontSize: "var(--text-chat-md)" }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h13M3 12h9M3 18h5M17 7v12m0 0 3-3m-3 3-3-3" />
            </svg>
            {!tight && <span className="font-medium whitespace-nowrap">{SORT_LABELS[sort]}</span>}
            <span className="text-muted">▾</span>
          </button>
          {sortOpen && (
            <div className="absolute left-0 top-full mt-1 z-(--z-panel-menu) w-56 glass rounded-lg overflow-hidden py-1">
              <div className="px-3 pt-1 pb-0.5 uppercase tracking-wider font-semibold text-muted" style={{ fontSize: "var(--text-chat-xs)" }}>
                Sort By
              </div>
              {(Object.keys(SORT_LABELS) as PostSort[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => { onSort(k); setSortOpen(false); }}
                  className="w-full text-left px-3 py-1.5 hover:bg-surface-2 transition-colors flex gap-2 items-center"
                >
                  <span className="w-3 shrink-0 text-accent">{sort === k ? "✓" : ""}</span>
                  <span className="text-body" style={{ fontSize: CHAT_FONT }}>{SORT_LABELS[k]}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Search — full field when open, icon button when collapsed */}
        {showSearchField ? (
          <div className="flex-1 min-w-0 flex items-center gap-2 rounded-lg bg-surface-1 border border-edge px-3 py-2 focus-within:border-edge-strong transition-colors">
            <MagnifyingGlass size={14} weight="bold" className="text-muted shrink-0" />
            <input
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              autoFocus={tight}
              placeholder="Search posts…"
              className="bg-transparent outline-none flex-1 min-w-0 text-body placeholder:text-muted"
              style={{ fontSize: CHAT_FONT }}
            />
            {tight && (
              <button
                type="button"
                onClick={() => { onQuery(""); setSearchOpen(false); }}
                className="text-muted hover:text-body shrink-0 text-sm"
                title="Close search"
              >
                ✕
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="flex-1 min-w-0" />
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              title="Search posts"
              className="shrink-0 flex items-center justify-center rounded-lg p-2 bg-surface-1 border border-edge text-secondary hover:text-body transition-colors"
            >
              <MagnifyingGlass size={16} weight="bold" />
            </button>
          </>
        )}

        {/* New Post */}
        <button
          type="button"
          onClick={onNewPost}
          title="New post"
          className={`shrink-0 flex items-center justify-center gap-1.5 rounded-lg font-medium text-strong bg-[#5865f2] hover:bg-[#4f5bd5] transition-colors ${
            tight ? "p-2" : "px-3 py-2"
          }`}
          style={{ fontSize: "var(--text-chat-md)" }}
        >
          <Plus size={tight ? 16 : 14} weight="bold" />
          {!tight && "New Post"}
        </button>
      </div>
      {hint && <p role="status" className="px-3 pb-1 text-xs text-accent">{hint}</p>}
    </>
  );
}
