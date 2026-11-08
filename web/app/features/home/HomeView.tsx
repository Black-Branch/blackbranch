import type { HomePayload, HomeNewsItem } from "@/app/lib/homePayload";
import type { Vod } from "@/app/lib/vods";
import { homeHeader, homeWidgets, type HomeWidgetDef } from "./homeLayout";
import { vodPlaylist } from "@/app/lib/vodPlaylist";
import { Widget } from "./widgets/Widget";
import { StatusWidget } from "./widgets/StatusWidget";
import { ThreadsWidget } from "./widgets/ThreadsWidget";
import { NewsWidget } from "./widgets/NewsWidget";
import { VodsWidget } from "./widgets/VodsWidget";
import { BoardsWidget } from "./widgets/BoardsWidget";
import { SignInColumn } from "./SignInColumn";
import { SignedInColumn } from "./SignUpSteps";

// The Home page, pure over its props. `grid` is the offline page:
// a column on the left (sign-in when signed out; the own card when
// signed in) and the widgets on the right: the status card across the top,
// the three lists beneath it, in HOME_WIDGETS order. `compact` (desktop live,
// under the player) is the same widget grid without the column: it wraps to
// the pane's width and scrolls down, rather than lining every panel up on one
// horizontal axis that ignores the page dimensions.
/** The body as this page reads it: `platforms` is the sign-in column's marks — the platforms this
 *  install has set up (ids as PlatformIcon names them), listed by the server. A body without it
 *  shows no marks. */
type HomeBody = HomePayload & { platforms?: readonly string[] | null };

export type HomeViewProps = {
  data: HomePayload | null;
  loading: boolean;
  error: boolean;
  /** The host's "this pane is on screen" — the signed-in column asks its progress only then. */
  active: boolean;
  signedIn: boolean;
  variant: "grid" | "compact";
  selectedVodId: string | null;
  onPickVod: (v: Vod) => void;
  onWatchCommunity: () => void;
  onOpenNews: (item: HomeNewsItem) => void;
};

export function HomeView({
  data, loading, error, active, signedIn, variant, selectedVodId, onPickVod, onWatchCommunity, onOpenNews,
}: HomeViewProps) {
  // "Now" is the moment the server built the body (at most 60s ago), not
  // Date.now(): a render must be pure (react-hooks/purity), and a label that is
  // a minute stale is invisible next to the poll that refreshes it.
  const now = data ? Date.parse(data.generatedAt) : 0;
  // "Not asked yet" is loading, not failure: the server render and the first
  // client frame have no body and no error, and three "couldn't load" lines
  // there would be the front door's first words. A null KEY
  // inside a body is the only per-widget failure; no body + error is the
  // page-wide one.
  const pending = data === null && !error;
  const compact = variant === "compact";

  const body = (def: HomeWidgetDef) => {
    switch (def.id) {
      case "status":
        return <StatusWidget status={data?.status ?? null} lastStream={data?.lastStream ?? null} loading={pending || loading} onWatchCommunity={onWatchCommunity} nowMs={now} />;
      case "threads":
        return <ThreadsWidget threads={data?.threads ?? null} loading={pending || loading} nowMs={now} />;
      case "news":
        return <NewsWidget news={data?.news ?? null} loading={pending || loading} onOpenNews={onOpenNews} nowMs={now} />;
      case "vods":
        return <VodsWidget vods={data?.vods ?? null} loading={pending || loading} selectedVodId={selectedVodId} onPickVod={onPickVod} />;
      case "boards":
        return <BoardsWidget boards={data?.boards ?? null} loading={pending || loading} live={data?.status?.live ?? false} signedIn={signedIn} hidden={data?.leaderboard?.hidden} />;
    }
  };

  // The Leaderboard draws its own header (its title is the face it shows).
  // News shows once a feed has items: no feed (or a feed that never answered) is no card.
  const defs = homeWidgets({ vods: vodPlaylist() !== null, news: (data?.news?.length ?? 0) > 0, boards: data?.leaderboard?.on !== false });
  const widget = (def: HomeWidgetDef) => (
    <Widget key={def.id} def={def} header={def.id === "boards" ? null : undefined}>{body(def)}</Widget>
  );

  // auto-fit: a column only where 17rem fits, so an open chat gives two
  // readable columns and a phone one — no viewport breakpoint decides it
  // (a fixed lg:grid-cols-3 would keep three columns inside a pane the chat
  // had narrowed to ~180px each). min(17rem,100%): a track is never wider than its
  // cell, or a pane under ~616px would scroll sideways. auto-rows-min: a panel is
  // as tall as its content, never stretched to its neighbour's.
  // The status card (`full`) sits on its own row ABOVE this grid, not inside it:
  // a col-span-full item spans every track, which keeps auto-fit's empty tracks
  // alive — two lists on a wide pane sat at 17rem beside blank columns (#237).
  const lists = (
    <div className="flex flex-col gap-3 min-w-0">
      {defs.filter((d) => d.full).map(widget)}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(17rem,100%),1fr))] gap-3 min-w-0 auto-rows-min">
        {defs.filter((d) => !d.full).map(widget)}
      </div>
    </div>
  );

  if (compact) {
    return <div className="h-full overflow-y-auto p-3">{lists}</div>;
  }

  const header = homeHeader();
  // The card column forms only where the PANE has room for the card (300px at
  // most) + the gap (12px) + one 17rem widget: 300 + 12 + 272 = 584px = 36.5rem.
  // A viewport breakpoint (`md:`) cannot answer that — the chat beside Home takes
  // its own width, so a 900px window with the chat open left the widgets 200px
  // and they squished (#237). The scroller is the size container (a container
  // query cannot match its own container, so the grid is its child). Below the
  // threshold the card stacks on top and every widget takes the full width.
  // homeView.render.test.ts derives 36.5rem from these terms.
  return (
    <div className="h-full overflow-y-auto p-3 md:p-4 @container">
      {!signedIn && (
        <header className="mb-3">
          <h2 className="text-lg font-semibold text-strong">{header.heading}</h2>
          <p className="text-sm text-secondary">{header.intro}</p>
        </header>
      )}
      {error && data !== null && <p className="text-xs text-muted mb-2">Showing the last answer; a refresh failed.</p>}
      <div className="grid gap-3 grid-cols-1 @[36.5rem]:grid-cols-[minmax(240px,300px)_1fr]">
        {signedIn
          ? <div data-home-left="card" className="min-w-0"><SignedInColumn active={active} /></div>
          : <SignInColumn platforms={(data as HomeBody | null)?.platforms ?? null} />}
        {lists}
      </div>
    </div>
  );
}
