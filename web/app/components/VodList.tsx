"use client";

import { Play } from "@phosphor-icons/react/dist/ssr";
import { CHAT_FONT, CHAT_FONT_XS } from "@/app/lib/chatFont";
import { type Vod } from "@/app/lib/vods";

// The list of past broadcasts, rendered bare: both hosts (the in-player "VODs"
// tab and the bottom dock) already name the pane and provide the surface, so
// chrome here would make it read as a separate panel.
//
// Curation is the YouTube "LIVE VODs" playlist; this renders what getVods() scraped.
// Thumbnails are skipped on purpose — every VOD uses the same channel art, so
// a compact title + duration + recency row reads better. Clicking a row hands
// the VOD up to StreamView, which swaps the player to it.
export default function VodList({
  vods,
  activeId,
  onPick,
}: {
  vods: Vod[];
  activeId: string | null;
  onPick: (v: Vod) => void;
}) {
  return (
    <div className="absolute inset-0 overflow-y-auto no-scrollbar">
      <ul className="divide-y divide-edge">
        {vods.map((v) => {
          const active = v.id === activeId;
          return (
            <li key={v.id}>
              <button
                onClick={() => onPick(v)}
                className={`group flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                  active ? "bg-surface-2" : "hover:bg-surface-1"
                }`}
              >
                <Play
                  size={14}
                  weight="fill"
                  className={`shrink-0 ${active ? "text-accent" : "text-muted group-hover:text-body-dim"}`}
                />
                {/* Row typography = the News list's (chat scale + strong-ink
                    treatment), so the dock's tabs read as one surface rather
                    than two components that happened to land there. */}
                <div className="min-w-0 flex-1">
                  <p
                    className={`truncate leading-snug font-medium ${active ? "text-strong" : "text-strong/90 group-hover:text-strong"}`}
                    style={{ fontSize: CHAT_FONT }}
                  >
                    {v.title || "Untitled broadcast"}
                  </p>
                  <div className="mt-0.5 flex items-center gap-2 text-strong/40" style={{ fontSize: CHAT_FONT_XS }}>
                    {v.duration && <span className="tabular-nums">{v.duration}</span>}
                    {v.duration && v.when && <span aria-hidden>·</span>}
                    {v.when && <span>{v.when}</span>}
                  </div>
                </div>
                {active && (
                  <span className="shrink-0 font-medium text-accent" style={{ fontSize: CHAT_FONT_XS }}>
                    Now playing
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
