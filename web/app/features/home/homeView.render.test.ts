import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "../../lib/testTsx.ts";
// The install values a build would inline, set BEFORE HomeView loads (installValues.ts reads them
// once). An install WITH a VOD playlist and its own Home lines; homeView.unconfigured.render.test.ts
// is the fresh install without them.
process.env.INSTALL_VALUES = JSON.stringify({
  "site.name": "Example Stream",
  "site.homeHeading": "Example heading",
  "site.homeIntro": "Example intro line.",
  "platform.youtube.vodPlaylist": "PLexampleexampleexample",
});
const { HomeView } = await import("./HomeView.tsx");
const { homeWidgets } = await import("./homeLayout.ts");
const HOME_WIDGETS = homeWidgets({ vods: true });

// The clock is the payload's own generatedAt (12:00Z below) — HomeView never reads Date.now().
const noop = () => {};
const base = {
  loading: false, error: false, active: false, variant: "grid" as const, selectedVodId: null,
  onPickVod: noop, onWatchCommunity: noop, onOpenNews: noop,
};
const data = {
  status: { live: false, viewers: null, community: null },
  lastStream: { startedAt: "2026-09-25T01:18:00.000Z", endedAt: "2026-09-25T09:00:00.000Z" },
  news: [
    { id: "n1", feedId: 1, feedTitle: "Feed", guid: "g1", title: "A headline", link: "https://x/1", summary: null, imageUrl: "https://img/1.jpg", publishedAt: "2026-09-25T11:00:00.000Z" },
    { id: "n2", feedId: 1, feedTitle: "Feed", guid: "g2", title: "No picture", link: null, summary: null, imageUrl: null, publishedAt: null },
  ],
  vods: [{ id: "v1", title: "Last night's replay", duration: "8:55:00", when: "1d ago" }],
  threads: [{ roomId: "!c", roomName: "Content", eventId: "$e", title: "Stream lead-up videos", replyCount: 1, lastTs: Date.parse("2026-09-25T11:30:00.000Z") }],
  boards: null,
  platforms: [],
  generatedAt: "2026-09-25T12:00:00.000Z",
};
const html = (p: Partial<Parameters<typeof HomeView>[0]>) =>
  renderToStaticMarkup(createElement(HomeView, { ...base, data, signedIn: false, ...p }));
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("signed out: the pitch header, the sign-in column with its list and the marks of the platforms set up, and NO explainer line anywhere", () => {
  const out = html({ signedIn: false, data: { ...data, platforms: ["kick", "twitch", "patreon"] } as never });
  assert.match(out, /<h2 class="text-lg font-semibold text-strong">Example heading<\/h2><p class="text-sm text-secondary">Example intro line\.<\/p>/);
  assert.match(out, /href="\/auth\/signin"/);
  assert.match(out, /Sign in or create an account/);
  for (const line of ["End-to-end encrypted DMs and private channels", "Full cross-platform integration", "Fully customizable"]) {
    assert.match(out, new RegExp(esc(line)), line);
  }
  // The marks are the install's own, in the column's order — never one it has not set up.
  const marks = [...out.matchAll(/title="([A-Za-z]+)" class="inline-flex"/g)].map((m) => m[1]);
  assert.deepEqual(marks, ["Twitch", "Kick", "Patreon"]);
  assert.doesNotMatch(out, /text-blue-300/);
  assert.doesNotMatch(out, /Your card|this could be you/i);
});

test("no platform set up (or a body that does not say): no integration line and no marks — the rest of the list stays", () => {
  for (const platforms of [[], undefined, null]) {
    const out = html({ signedIn: false, data: { ...data, platforms } as never });
    assert.match(out, /End-to-end encrypted DMs and private channels/, "vacuity: the list rendered");
    assert.doesNotMatch(out, /Full cross-platform integration|data-home-marks/, JSON.stringify(platforms));
  }
});

test("the retired over-explaining phrases never come back", () => {
  const out = html({ signedIn: false });
  for (const s of ["Ad free", "Private data", "E2EE DMs and channels", "readable without an account", "One chat identity", "One account, linked", "What you get", "Encrypted direct messages", "Welcome to site.test", "Whether Casey is live", "Click one to", "Chat with everyone here", "Pick how your name looks"]) {
    assert.doesNotMatch(out, new RegExp(esc(s)), s);
  }
});

test("signed in: no header, no sign-in column (the card column is separate)", () => {
  const out = html({ signedIn: true });
  assert.doesNotMatch(out, /Example heading|<header/);
  assert.doesNotMatch(out, /href="\/auth\/signin"/);
});

test("status: offline reads the last stream in plain words; live reads LIVE and the count; community reads the name", () => {
  assert.match(html({}), /Offline/);
  assert.match(html({}), /Last stream ended 3h ago · ran 7h 42m/);
  const live = html({ data: { ...data, status: { live: true, viewers: 41, community: null } } });
  assert.match(live, /LIVE now/);
  assert.match(live, /41 watching/);
  const com = html({ data: { ...data, status: { live: false, viewers: null, community: { name: "cleo", avatarUrl: null } } } });
  assert.match(com, /cleo<\/span> is live/); // the name wears its own span
  assert.match(com, />Watch</);
});

test("empty lists and a dead loader are words, never a blank box", () => {
  const empty = html({ data: { ...data, news: [], vods: [] } });
  // The VODs card says Nothing yet; the News card is not there at all (no feed has given it items).
  assert.equal((empty.match(/Nothing yet/g) ?? []).length, 1);
  assert.doesNotMatch(empty, /data-widget="news"/);
  const dead = html({ data: { ...data, status: null, lastStream: null } });
  assert.match(dead, /Couldn(&#x27;|')t load right now/); // renderToStaticMarkup escapes the apostrophe
  const none = html({ data: null, loading: true });
  assert.match(none, /Loading/);
});

test("News: a card only once a feed has items — none for an install with no feed, nor for a feed that did not answer", () => {
  assert.match(html({}), /data-widget="news"/, "vacuity: items → the card is there");
  assert.match(html({}), /A headline/);
  for (const news of [[], null]) {
    const out = html({ data: { ...data, news } as never });
    assert.doesNotMatch(out, /data-widget="news"|>News</, JSON.stringify(news));
    assert.match(out, /data-widget="threads"/, "the rest of the grid stays");
  }
});

test("no money and no radio on Home", () => {
  const out = html({ signedIn: true });
  // "Earned points" (the install's own word) is the Leaderboard's earn-only face (never a money
  // board) — the word alone is not money; buying it would be.
  assert.doesNotMatch(out, /Donate|Subscribe|Buy points|Get points|Buy Qorm|Get Qorm|\$|Radio/);
  assert.match(out, /Earned points/);
});

test("compact: no column, same widgets in the same order", () => {
  const out = html({ variant: "compact", signedIn: false });
  assert.doesNotMatch(out, /Example heading|<header/);
  assert.doesNotMatch(out, /data-home-left/);
  const order = HOME_WIDGETS.map((w) => out.indexOf(`data-widget="${w.id}"`));
  assert.ok(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1]!)), `widgets out of order: ${order}`);
});

test("compact (live, under the player) wraps the panels to the page like offline Home — never one sideways row of full-height panels that ignores the page's dimensions", () => {
  const live = html({ variant: "compact", signedIn: true });
  const offline = html({ signedIn: true });
  assert.doesNotMatch(live, /overflow-x-auto/, "a sideways-scrolling row is back");
  assert.doesNotMatch(live, /class="h-full flex /, "a flex row stretches every panel to the row's full height");
  const grid = (out: string) => out.match(/<div class="(grid grid-cols-\[repeat\(auto-fit[^"]*)">/)?.[1];
  assert.ok(grid(offline), "offline widget grid renders");
  assert.equal(grid(live), grid(offline), "live uses the SAME wrapping grid as offline");
  assert.ok(grid(live)!.split(/\s+/).includes("auto-rows-min"), "each panel only as tall as its content");
  assert.match(live, /<div class="h-full overflow-y-auto[^"]*">/, "the pane scrolls down, not sideways");
  for (const w of HOME_WIDGETS) {
    const cls = (out: string) => out.match(new RegExp(`<section data-widget="${w.id}" class="([^"]*)"`))?.[1];
    assert.equal(cls(live), cls(offline), `${w.id}: a live panel wears the offline panel's classes`);
  }
});

test("grid (offline) panels keep overflow-hidden and no fixed width — the grid track sizes them", () => {
  const out = html({ signedIn: true });
  for (const w of HOME_WIDGETS) {
    const cls = out.match(new RegExp(`<section data-widget="${w.id}" class="([^"]*)"`))![1]!.split(/\s+/);
    assert.ok(cls.includes("overflow-hidden") && !cls.includes("w-80"), `${w.id} grid classes`);
  }
});

test("Active threads: title, reply count, room, and a button per row", () => {
  const out = html({ signedIn: true });
  assert.match(out, /Active threads/);
  assert.match(out, /Stream lead-up videos/);
  assert.match(out, /1 reply/);
  assert.match(out, /Content/);
});

test("news rows carry the feed's picture, or an empty block of the same size so titles line up", () => {
  const out = html({});
  assert.match(out, /<img[^>]+src="https:\/\/img\/1\.jpg"/);
  assert.match(out, /data-thumb="none"/);
  assert.match(out, /Feed · 1h ago/);
});

test("VOD rows carry YouTube's own thumbnail — no API, no scrape", () => {
  assert.match(html({}), /<img[^>]+src="https:\/\/i\.ytimg\.com\/vi\/v1\/mqdefault\.jpg"/);
});

test("columns form only where they have 17rem of room — never a breakpoint-forced third column", () => {
  const out = html({});
  // min(17rem,100%): a track never wider than the cell, or a pane under ~616px
  // (a 900px window with the default chat) scrolled SIDEWAYS.
  assert.match(out, /grid-cols-\[repeat\(auto-fit,minmax\(min\(17rem,100%\),1fr\)\)\]/);
  assert.doesNotMatch(out, /lg:grid-cols-|lg:col-span/);
});

// ── #237: the page reflows with the PANE, never squishes ────────────────────────────────────
// jsdom has no layout engine, so these read the rendered classes and evaluate the CSS rules they
// declare at a pane width (the real-browser measurement at 1600/1200/900/600/390 is the look run on
// the throwaway pair). The terms are the ones the layout is built from: the card column at most
// 300px (min 240), a 12px gap (gap-3), a widget never under 17rem.
const REM = 16, GAP = 12, CARD_MAX = 300, WIDGET_MIN = 17 * REM;
const outerClasses = (out: string) => out.match(/<div class="(grid gap-3 [^"]*)">/)?.[1]?.split(/\s+/) ?? null;
/** What the declared rules give at a pane content width `w` (px): does the card column form, and how
 *  many widget columns the auto-fit list grid makes for `lists` list widgets, and how wide each is. */
function columnsAt(out: string, w: number, lists: number): { card: boolean; widgetCols: number; widgetW: number } {
  const outer = outerClasses(out);
  assert.ok(outer, "the outer grid renders");
  const two = outer!.find((c) => c.endsWith(":grid-cols-[minmax(240px,300px)_1fr]"));
  assert.ok(two, "the outer grid has a two-column rule");
  // A container query (@[Nrem]:) answers to the PANE; a viewport prefix (md:) cannot be evaluated
  // from the pane at all — that was the squish: the viewport said "two columns" while the chat had
  // left the pane 544px wide, so the widgets got the leftover 200px.
  const m = two!.match(/^@\[(\d+(?:\.\d+)?)rem\]:/);
  assert.ok(m, `the card column must be decided by the pane (a container query), not the viewport: ${two}`);
  const card = w >= Number(m![1]) * REM;
  const rest = card ? w - CARD_MAX - GAP : w;
  // auto-fit collapses empty tracks, so the lists share the row — but only when nothing spans every
  // track (a col-span-full item keeps the empty tracks alive).
  assert.doesNotMatch(out, /col-span-full/, "a full-span item inside the auto-fit grid keeps its empty tracks");
  const tracks = Math.max(1, Math.floor((rest + GAP) / (WIDGET_MIN + GAP)));
  const widgetCols = Math.min(tracks, lists);
  return { card, widgetCols, widgetW: Math.floor((rest - GAP * (widgetCols - 1)) / widgetCols) };
}

test("#237: the card column forms only where the card AND one 17rem widget fit beside it — the pane decides, never the viewport", () => {
  for (const signedIn of [false, true]) {
    const out = html({ signedIn });
    assert.match(out, /<div class="h-full overflow-y-auto p-3 md:p-4 @container">/, "the scroller is the size container");
    const two = outerClasses(out)!.find((c) => c.endsWith(":grid-cols-[minmax(240px,300px)_1fr]"));
    // Derived, not eyeballed: 300 (card) + 12 (gap) + 272 (17rem widget) = 584px = 36.5rem.
    assert.equal(two, `@[${(CARD_MAX + GAP + WIDGET_MIN) / REM}rem]:grid-cols-[minmax(240px,300px)_1fr]`);
    assert.doesNotMatch(out, /md:grid-cols-\[minmax/, "no viewport breakpoint decides the card column");
  }
});

test("#237: the grid column count at three pane widths — wide: card + three; mid: card + one; narrow: stacked, every card full width — and no widget ever under 17rem", () => {
  const out = html({});
  const lists = HOME_WIDGETS.filter((d) => !d.full).length; // vods, threads, boards, news
  assert.equal(lists, 4, "vacuity: the fixture shows four list widgets");
  // 1600 window, chat folded (pane content 1244) · 1200 with the chat open (844) · 900 with it open (544).
  assert.deepEqual(columnsAt(out, 1244, lists), { card: true, widgetCols: 3, widgetW: 302 });
  assert.deepEqual(columnsAt(out, 844, lists), { card: true, widgetCols: 1, widgetW: 532 });
  assert.deepEqual(columnsAt(out, 544, lists), { card: false, widgetCols: 1, widgetW: 544 });
  // A wide pane with two lists: they share the row instead of sitting beside empty tracks.
  assert.deepEqual(columnsAt(out, 1244, 2), { card: true, widgetCols: 2, widgetW: 460 });
  for (let w = 300; w <= 2400; w += 4) {
    const c = columnsAt(out, w, lists);
    assert.ok(c.widgetW >= Math.min(WIDGET_MIN, w), `pane ${w}: a widget squished to ${c.widgetW}px`);
  }
});

test("#237: the status card sits on its own row above the list grid, not inside it", () => {
  for (const variant of ["grid", "compact"] as const) {
    const out = html({ variant });
    const status = out.indexOf('data-widget="status"');
    const grid = out.indexOf('<div class="grid grid-cols-[repeat(auto-fit');
    assert.ok(status >= 0 && grid > status, `${variant}: status (${status}) comes before the list grid (${grid})`);
    assert.doesNotMatch(out, /col-span-full/, `${variant}: nothing spans the auto-fit tracks`);
    for (const d of HOME_WIDGETS.filter((x) => !x.full)) {
      assert.ok(out.indexOf(`data-widget="${d.id}"`) > grid, `${variant}: ${d.id} is inside the list grid`);
    }
  }
});

const layoutShape = (out: string) => [...out.matchAll(/<div class="((?:h-full overflow-y-auto|grid )[^"]*)"/g)].map((m) => m[1]);

test("#237 restart: the first frame after a reload (no body yet) and a remembered body wear the same layout", () => {
  const first = layoutShape(html({ data: null, loading: true, signedIn: true }));
  assert.ok(first.length >= 3, `vacuity: the scroller, the outer grid and the list grid: ${first}`);
  assert.deepEqual(layoutShape(html({ signedIn: true })), first);
});

test("#237 retry: a failed refresh that keeps the last body keeps the same layout", () => {
  const retry = html({ error: true });
  assert.match(retry, /a refresh failed/, "vacuity: the retry state rendered");
  assert.deepEqual(layoutShape(retry), layoutShape(html({})));
});

test("the widget order: what's going on → VODs → threads → leaderboard → news", () => {
  assert.deepEqual(HOME_WIDGETS.map((w) => w.id), ["status", "vods", "threads", "boards", "news"]);
});

test("on a phone the VODs widget is 'Last stream' with one full-width row; the desktop keeps three rows", () => {
  const out = html({ data: { ...data, vods: [
    { id: "v1", title: "Last night's replay", duration: "8:55:00", when: "1d ago" },
    { id: "v2", title: "Two nights ago", duration: "7:00:00", when: "2d ago" },
    { id: "v3", title: "Three nights ago", duration: "6:00:00", when: "3d ago" },
  ] } });
  assert.match(out, /<span class="md:hidden">Last stream<\/span><span class="hidden md:inline">Latest VODs<\/span>/);
  assert.match(out, /<li class="min-w-0"><button[^>]*class="[^"]*flex-col[^"]*md:flex-row/);
  assert.match(out, /<img[^>]+src="https:\/\/i\.ytimg\.com\/vi\/v1\/mqdefault\.jpg"[^>]+class="[^"]*w-full aspect-video[^"]*md:w-16 md:h-9/);
  assert.equal((out.match(/<li class="min-w-0 hidden md:block">/g) ?? []).length, 2, "rows 2–3 are desktop-only");
});

test("one VOD or none on a phone: no hidden rows, and 'Nothing yet' when the list is empty", () => {
  assert.doesNotMatch(html({}), /hidden md:block/);
  assert.match(html({ data: { ...data, vods: [] } }), /Nothing yet/);
});
