import { installValue } from "@/app/lib/installValues";
import { siteName } from "@/app/lib/siteName";

// The fixed default arrangement. Every block is a widget with an id,
// a title and, for the status card, `full`, so a later Customise mode can move/resize/hide
// them without rebuilding the page. No explainer lines: a page
// designed to be clear on its face needs none.
type HomeWidgetId = "status" | "threads" | "news" | "vods" | "boards";

export type HomeWidgetDef = {
  id: HomeWidgetId;
  title: string;
  /** The title below `md` (the phone): the VODs widget is "Last stream" there. */
  narrowTitle?: string;
  /** Across the whole grid (the status card). */
  full?: true;
};

// The order: what's going on → VODs → threads → leaderboard → news.
// The Leaderboard's on-screen title is the face it shows; "Leaderboard" is its
// name for a later Customise mode.
const HOME_WIDGETS: readonly HomeWidgetDef[] = [
  { id: "status", title: "What's going on", full: true },
  { id: "vods", title: "Latest VODs", narrowTitle: "Last stream" },
  { id: "threads", title: "Active threads" },
  { id: "boards", title: "Leaderboard" },
  { id: "news", title: "News" },
];

/** The widgets this install shows: the VODs card exists only when the install has a VOD
 *  playlist (platform.youtube.vodPlaylist) — otherwise neither "Latest VODs" nor, on a phone,
 *  "Last stream" appears. The News card exists only once a feed has given it something to show
 *  (`news`): an install with no feed has no News card at all, never an empty one. */
export function homeWidgets({ vods, news = true }: { vods: boolean; news?: boolean }): readonly HomeWidgetDef[] {
  return HOME_WIDGETS.filter((w) => (w.id !== "vods" || vods) && (w.id !== "news" || news));
}

/** The signed-out header's two lines: the install's own (site.homeHeading / site.homeIntro,
 *  install values) or neutral copy. */
export function homeHeader(): { heading: string; intro: string } {
  return {
    heading: installValue("site.homeHeading") || siteName(),
    intro: installValue("site.homeIntro") || "A live stream and its community, backed by Matrix.",
  };
}
