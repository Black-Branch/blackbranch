// The server-rendered first frame of the tab (no effects run, no fetch yet):
// it must read as loading, never as three failures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "../../lib/testTsx.ts";
// An install WITH a VOD playlist, so the VODs card exists (installValues.ts reads this once). With no
// body yet there is no News card: it shows only once a feed has items (homeLayout.ts) — four widgets.
process.env.INSTALL_VALUES = JSON.stringify({ "site.name": "Example Stream", "platform.youtube.vodPlaylist": "PLexampleexampleexample" });
const { HomeTab } = await import("./HomeTab.tsx");
const { HomeView } = await import("./HomeView.tsx");
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../lib/testSource.ts";
const readSrc = (rel: string) => stripComments(readFileSync(join(process.cwd(), rel), "utf8"));

const noop = () => {};

test("the SSR frame of HomeTab says Loading four times (one per widget; News waits for a body with items) and Couldn't-load zero times", () => {
  const out = renderToStaticMarkup(createElement(HomeTab, {
    active: false, signedIn: false, variant: "grid", selectedVodId: null,
    onPickVod: noop, onWatchCommunity: noop, onOpenNews: noop,
  }));
  assert.equal((out.match(/Loading/g) ?? []).length, 4);
  assert.equal((out.match(/Couldn/g) ?? []).length, 0);
});

test("no body AND a failed fetch is the one state that reads as a failure everywhere", () => {
  const out = renderToStaticMarkup(createElement(HomeView, {
    data: null, loading: false, error: true, active: false, signedIn: true, variant: "grid", selectedVodId: null,
    onPickVod: noop, onWatchCommunity: noop, onOpenNews: noop,
  }));
  assert.equal((out.match(/Couldn/g) ?? []).length, 4);
  assert.equal((out.match(/Loading/g) ?? []).length, 0);
});

test("with the server's body the SSR frame IS the page — zero Loading, the headline in the HTML", () => {
  const out = renderToStaticMarkup(createElement(HomeTab, {
    active: false, signedIn: false, variant: "grid", selectedVodId: null,
    onPickVod: noop, onWatchCommunity: noop, onOpenNews: noop,
    initial: { status: { live: false, viewers: null, community: null }, lastStream: null, news: [{ id: "n1", feedId: 1, feedTitle: "Feed", guid: "g1", title: "A headline", link: "https://x/1", summary: null, imageUrl: null, publishedAt: null }], vods: [], threads: [], boards: null, platforms: [], generatedAt: "2026-09-26T08:00:00.000Z" },
  }));
  assert.equal((out.match(/Loading/g) ?? []).length, 0);
  assert.match(out, /A headline/);
});

test("the server body travels page → StreamView → both hosts → HomeTab, waited on briefly", () => {
  const page = readSrc("app/(main)/page.tsx");
  assert.match(page, /const homeP = getHomePayloadWithin\(1500\);/);
  assert.match(page, /homeInitial=\{home\}/);
  const sv = readSrc("app/components/StreamView.tsx");
  assert.equal((sv.match(/homeInitial=\{homeInitial\}/g) ?? []).length, 2, "dock AND sidebar");
  assert.match(readSrc("app/components/BottomDock/index.tsx"), /initial=\{homeInitial\}/);
  assert.match(readSrc("app/features/chat/ChatSidebar.tsx"), /initial=\{homeInitial \?\? null\}/);
  assert.match(page, /\}\s*$/); // END anchor (StreamView ends in a dynamic() call, not a brace)
});
