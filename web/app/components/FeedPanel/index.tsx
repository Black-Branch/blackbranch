"use client";

import { CHAT_FONT, CHAT_FONT_XS } from "@/app/lib/chatFont";
import { useEffect, useRef, useState } from "react";
import { Plus, ArrowLeft, ArrowSquareOut, MagnifyingGlass, X } from "@phosphor-icons/react/dist/ssr";
import { useRssFeed, type RssItem } from "@/app/lib/useRssFeed";
import { useContentSuggestion } from "@/app/lib/useContentSuggestion";
import { getJson } from "@/app/lib/http";
import { shortWhen } from "@/app/lib/textFormat";

// The RSS news feed. Renders a horizontal ticker (short) or a thumbnail list (tall);
// the host decides which via `view`. On desktop it's the News tab of the bottom
// dock (BottomDock); on mobile it's the "News" tab in the chat panel
// (ChatSidebar). Clicking an item opens an in-panel reader with optional full-article
// extraction. Text matches the chat font size; icons are Phosphor (browser-stable).

const FONT = CHAT_FONT;
const META_FONT = CHAT_FONT_XS;

export default function FeedPanel({ view, active, openStory = null, onStoryConsumed }: {
  view: "ticker" | "list";
  active: boolean;
  /** A story a host asks the reader to open (Home's headline); consumed once. */
  openStory?: RssItem | null;
  onStoryConsumed?: () => void;
}) {
  // Ticket #7: search lives in the LIST view only. The ticker is a passive crawl
  // with nowhere to put a field, so its query is pinned empty — otherwise a term
  // typed in the list would silently filter the ticker in the other host too.
  const [query, setQuery] = useState("");
  const searching = view === "list";
  const { items, loading, error } = useRssFeed(active, searching ? query : "");
  const suggest = useContentSuggestion();
  const [reading, setReading] = useState<RssItem | null>(null);
  // The handoff from Home: consume once, microtask-deferred (the
  // ForumsTab pattern keeps the setters out of the synchronous effect pass).
  // The reader renders in either view, so a short dock still opens the story.
  useEffect(() => {
    if (!openStory) return;
    Promise.resolve().then(() => { setReading(openStory); onStoryConsumed?.(); });
  }, [openStory, onStoryConsumed]);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {reading ? (
        <Reader item={reading} onBack={() => setReading(null)} suggest={suggest} />
      ) : view === "ticker" ? (
        <Ticker items={items} loading={loading} error={error} active={active} />
      ) : (
        <FeedList
          items={items}
          loading={loading}
          error={error}
          suggest={suggest}
          onRead={setReading}
          query={query}
          onQuery={setQuery}
        />
      )}
    </div>
  );
}

function Ticker({ items, loading, error, active }: { items: RssItem[]; loading: boolean; error: boolean; active: boolean }) {
  const run = items.slice(0, 30);
  // Speed proportional to item count so px/sec stays constant; a slow newsroom crawl.
  const tickerDur = Math.max(90, run.length * 12);
  const hasItems = run.length > 0;
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [onScreen, setOnScreen] = useState(true);
  // The crawl is an infinite animation on a mounted-through-fades element, so it
  // must be fenced BOTH ways: `active` covers the opacity-0 fade (StreamView keeps
  // the panel mounted at feedView "hidden", and an invisible element still
  // intersects), the observer covers scroll-away and the width-0 community-mode
  // collapse (where the zero-area edge case makes isIntersecting unreliable —
  // hence the explicit width check).
  useEffect(() => {
    if (!hasItems) return;
    const el = trackRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => {
      setOnScreen(!!entry && entry.isIntersecting && entry.boundingClientRect.width > 0);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasItems]);
  // No inline "News" label — the ticker only renders under the dock's tab row
  // now (mobile hosts the list view only), and the open tab already says News.
  return (
    <div className="feed-ticker flex-1 min-h-0 flex items-center px-2 gap-2">
      <div className="flex-1 min-w-0 overflow-hidden">
        {!run.length ? (
          <span className="text-strong/40" style={{ fontSize: FONT }}>
            {error ? "Feed unavailable" : loading ? "Loading…" : "No items yet"}
          </span>
        ) : (
          <div
            ref={trackRef}
            className={`feed-ticker-track${active && onScreen ? "" : " feed-ticker-paused"}`}
            style={{ ["--feed-ticker-dur"]: `${tickerDur}s`, fontSize: FONT } as React.CSSProperties}
          >
            {[...run, ...run].map((it, i) => (
              <a
                key={`${it.id}-${i}`}
                href={it.link ?? "#"}
                target="_blank"
                rel="noopener noreferrer"
                className="text-strong/80 hover:text-strong whitespace-nowrap mr-8"
              >
                <span className="inline-block w-1 h-1 rounded-full bg-surface-5 align-middle mr-1.5" />
                {it.title}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FeedList({
  items,
  loading,
  error,
  suggest,
  onRead,
  query,
  onQuery,
}: {
  items: RssItem[];
  loading: boolean;
  error: boolean;
  suggest: ReturnType<typeof useContentSuggestion>;
  onRead: (it: RssItem) => void;
  query: string;
  onQuery: (q: string) => void;
}) {
  // No "News Feed" header row — both hosts (the dock's News tab, the mobile
  // chat panel's News tab) already name this panel in a tab, so the header
  // only made the list read as a separate panel inside the space.
  const searching = query.trim().length > 0;
  return (
    <>
      <div className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 border-b border-edge">
        <MagnifyingGlass size={13} weight="bold" className="shrink-0 text-strong/40" />
        <input
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search headlines and sources"
          // A form control, so NOT keepFocus — it takes focus itself, and on a
          // phone that is the point: tapping it should raise the keyboard.
          className="flex-1 min-w-0 bg-transparent outline-none text-strong/85 placeholder:text-strong/35"
          style={{ fontSize: FONT }}
        />
        {searching && (
          <button
            type="button"
            onClick={() => onQuery("")}
            aria-label="Clear search"
            className="shrink-0 text-strong/40 hover:text-strong"
          >
            <X size={13} weight="bold" />
          </button>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar">
        {!items.length ? (
          <div className="p-3 text-strong/40" style={{ fontSize: FONT }}>
            {error
              ? "Feed unavailable."
              : loading
                ? "Loading…"
                : searching
                  ? `No matches for “${query.trim()}”.`
                  : "No items yet."}
          </div>
        ) : (
          <ul>
            {items.map((it) => (
              <li key={it.id} className="border-b border-edge last:border-0">
                <div className="flex gap-2.5 px-2.5 py-2 hover:bg-surface-1">
                  {it.imageUrl && (
                    <img
                      src={it.imageUrl}
                      alt=""
                      aria-hidden
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      className="w-16 h-16 object-cover rounded shrink-0 bg-surface-1 cursor-pointer"
                      onClick={() => onRead(it)}
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = "none";
                      }}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={() => onRead(it)}
                      className="block text-left font-medium text-strong/90 hover:text-strong line-clamp-2"
                      style={{ fontSize: FONT }}
                    >
                      {it.title}
                    </button>
                    <div className="mt-1 flex items-center gap-2 text-strong/40" style={{ fontSize: META_FONT }}>
                      <span className="truncate">{it.feedTitle}</span>
                      {it.publishedAt && <span aria-hidden>·</span>}
                      <span className="shrink-0">{shortWhen(it.publishedAt)}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => suggest.suggest(it)}
                    disabled={!suggest.canSuggest}
                    title={suggest.canSuggest ? "Suggest in the Content forum" : "Sign in to suggest"}
                    className="self-start shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded font-medium border border-edge text-strong/70 hover:bg-surface-3 hover:text-strong disabled:opacity-40"
                    style={{ fontSize: META_FONT }}
                  >
                    <Plus size={12} weight="bold" /> Suggest
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

// In-panel reader — the item's summary plus an optional server-extracted full
// article (Readability). Paywalled/JS-only pages fall back to the summary + an
// archive.is link. No new tab for the read itself.
function Reader({
  item,
  onBack,
  suggest,
}: {
  item: RssItem;
  onBack: () => void;
  suggest: ReturnType<typeof useContentSuggestion>;
}) {
  const [full, setFull] = useState<{ byline: string | null; html: string } | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [fullError, setFullError] = useState(false);
  const archiveUrl = item.link ? `https://archive.ph/newest/${item.link}` : null;

  const loadFull = async () => {
    if (!item.link || loadingFull) return;
    setLoadingFull(true);
    setFullError(false);
    try {
      const data = await getJson<{ html?: string; byline?: string | null }>(
        `/api/rss/article?url=${encodeURIComponent(item.link)}`,
      );
      if (data.html) setFull({ byline: data.byline ?? null, html: data.html });
      else setFullError(true);
    } catch {
      setFullError(true);
    } finally {
      setLoadingFull(false);
    }
  };

  const linkBtn = "inline-flex items-center gap-1 px-2.5 py-1 rounded border border-edge-strong text-strong/70 hover:bg-surface-3 hover:text-strong";

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-2.5 py-1 shrink-0 border-b border-edge">
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1 font-medium text-strong/60 hover:text-strong" style={{ fontSize: META_FONT }}>
          <ArrowLeft size={13} weight="bold" /> Back
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar px-3 py-2.5">
        {item.imageUrl && (
          <img
            src={item.imageUrl}
            alt=""
            aria-hidden
            referrerPolicy="no-referrer"
            className="w-full max-h-52 object-cover rounded mb-2.5 bg-surface-1"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        )}
        <div className="font-semibold text-strong/90" style={{ fontSize: "var(--text-chat-lg)", lineHeight: 1.3 }}>
          {item.title}
        </div>
        <div className="mt-1 text-strong/40" style={{ fontSize: META_FONT }}>
          {item.feedTitle}
          {item.publishedAt ? ` · ${shortWhen(item.publishedAt)}` : ""}
          {full?.byline ? ` · ${full.byline}` : ""}
        </div>

        {full ? (
          <div
            className="feed-article mt-2.5 text-strong/80"
            style={{ fontSize: FONT, lineHeight: 1.6 }}
            dangerouslySetInnerHTML={{ __html: full.html }}
          />
        ) : (
          <>
            {item.summary && (
              <p className="mt-2.5 text-strong/75 whitespace-pre-line" style={{ fontSize: FONT, lineHeight: 1.55 }}>
                {item.summary}
              </p>
            )}
            {item.link && (
              <button type="button" onClick={loadFull} disabled={loadingFull} className={`${linkBtn} mt-3 disabled:opacity-50`} style={{ fontSize: META_FONT }}>
                {loadingFull ? "Loading…" : "Read full article"}
              </button>
            )}
            {fullError && (
              <div className="mt-2 text-strong/40" style={{ fontSize: META_FONT }}>
                Couldn&apos;t extract this one (paywall or scripted page).{" "}
                {archiveUrl && (
                  <a href={archiveUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-strong">
                    Try archive.is ↗
                  </a>
                )}
              </div>
            )}
          </>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2" style={{ fontSize: META_FONT }}>
          {item.link && (
            <a href={item.link} target="_blank" rel="noopener noreferrer" className={linkBtn}>
              Open original <ArrowSquareOut size={12} weight="bold" />
            </a>
          )}
          {archiveUrl && (
            <a href={archiveUrl} target="_blank" rel="noopener noreferrer" className={linkBtn}>
              archive.is <ArrowSquareOut size={12} weight="bold" />
            </a>
          )}
          <button
            type="button"
            onClick={() => suggest.suggest(item)}
            disabled={!suggest.canSuggest}
            title={suggest.canSuggest ? "Suggest in the Content forum" : "Sign in to suggest"}
            className={`${linkBtn} disabled:opacity-40`}
          >
            <Plus size={12} weight="bold" /> Suggest
          </button>
        </div>
      </div>
    </div>
  );
}
