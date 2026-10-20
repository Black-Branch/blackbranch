import type { Vod } from "@/app/lib/vods";

// Three rows with YouTube's own still for the video id — no API
// call, no scrape; i.ytimg.com serves mqdefault (320×180) for any public
// video. The row count is the bound. On a phone (below `md`) the first row
// alone shows, full width, under the title "Last stream" — `md:`
// classes, never a viewport hook: the body is server-rendered and the phone's
// first paint must already be its shape.
export function VodsWidget({ vods, loading, selectedVodId, onPickVod }: {
  vods: Vod[] | null;
  loading: boolean;
  selectedVodId: string | null;
  onPickVod: (v: Vod) => void;
}) {
  if (vods === null) return <p>{loading ? "Loading…" : "Couldn't load right now."}</p>;
  if (vods.length === 0) return <p className="text-muted">Nothing yet</p>;
  return (
    <ul className="flex flex-col gap-2">
      {vods.map((v, i) => (
        <li key={v.id} className={i === 0 ? "min-w-0" : "min-w-0 hidden md:block"}>
          <button
            type="button"
            onClick={() => onPickVod(v)}
            className={`flex text-left w-full min-w-0 hover:text-strong ${
              i === 0 ? "flex-col gap-1.5 md:flex-row md:gap-2.5" : "gap-2.5"
            } ${v.id === selectedVodId ? "text-strong" : ""}`}
          >
            <img
              src={`https://i.ytimg.com/vi/${encodeURIComponent(v.id)}/mqdefault.jpg`}
              alt=""
              aria-hidden
              loading="lazy"
              className={`object-cover rounded shrink-0 bg-surface-3 ${
                i === 0 ? "w-full aspect-video md:w-16 md:h-9 md:aspect-auto" : "w-16 h-9"
              }`}
            />
            <span className="min-w-0 flex-1">
              <span className="block line-clamp-2">{v.title}</span>
              <span className="block text-xs text-muted">
                {[v.duration, v.when].filter(Boolean).join(" · ")}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
