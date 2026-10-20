import type { HomeNewsItem } from "@/app/lib/homePayload";
import { agoLabel } from "@/app/lib/relativeTime";

// Four rows with the feed's picture. A row without one gets an
// empty block of the same size so the titles line up; a picture that fails to
// load hides itself in place (visibility, not display — the box stays). The
// row count is the bound: the widget never grows with data. A click hands the
// whole item to the host, which opens the News tab on it.
export function NewsWidget({ news, loading, onOpenNews, nowMs }: {
  news: HomeNewsItem[] | null;
  loading: boolean;
  onOpenNews: (item: HomeNewsItem) => void;
  nowMs: number;
}) {
  if (news === null) return <p>{loading ? "Loading…" : "Couldn't load right now."}</p>;
  if (news.length === 0) return <p className="text-muted">Nothing yet</p>;
  return (
    <ul className="flex flex-col gap-2">
      {news.map((n) => (
        <li key={n.id} className="min-w-0">
          <button type="button" onClick={() => onOpenNews(n)} className="flex gap-2.5 text-left w-full min-w-0 hover:text-strong">
            {n.imageUrl ? (
              <img
                src={n.imageUrl}
                alt=""
                aria-hidden
                loading="lazy"
                referrerPolicy="no-referrer"
                className="w-16 h-12 object-cover rounded shrink-0 bg-surface-3"
                onError={(e) => { e.currentTarget.style.visibility = "hidden"; }}
              />
            ) : (
              <span data-thumb="none" className="w-16 h-12 rounded shrink-0 bg-surface-3" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block line-clamp-2">{n.title}</span>
              <span className="block text-xs text-muted truncate">
                {n.feedTitle}{n.publishedAt ? ` · ${agoLabel(n.publishedAt, nowMs)}` : ""}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
