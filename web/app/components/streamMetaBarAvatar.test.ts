// The meta bar's names and counts. The fallback avatar (no streamer picture) shows the initials of
// THIS install's streamer — or of the site when no streamer name is set — never two letters written
// into the component. On an install whose streamer name IS the site name (a streamer's own site, the
// common case) the title says that name once, and a follower count nobody knows is left out rather
// than drawn as "— followers".
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/components/streamMetaBarAvatar.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "../lib/testTsx.ts";
import { initials } from "../lib/streamView.ts";

const src = readFileSync(new URL("./StreamMetaBar.tsx", import.meta.url), "utf8");
const { StreamMetaBar } = await import("./StreamMetaBar.tsx");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };

/** The bar's two text lines, as a person reads them (tags dropped, entities decoded). */
function bar(site: string, props: { streamerName: string; followerCount: number | null; live?: boolean; liveViewers?: number | null }) {
  process.env.INSTALL_VALUES = JSON.stringify({ "site.name": site });
  const html = renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router as never }, createElement(StreamMetaBar, {
    overlay: false, hidden: false, live: props.live ?? false, community: null, communities: [], onPickCommunity: () => {},
    tab: "live", streamerAvatar: null, streamerName: props.streamerName, pfpFailed: false, setPfpFailed: () => {},
    streamTitle: "", selectedVod: null, followerCount: props.followerCount, liveViewers: props.liveViewers ?? null,
    subscribeLabel: "subscribe", openSupport: () => {}, donateUrl: null, subscribeUrl: null,
  })));
  // Each piece is its own box spaced by margin, so a tag boundary reads as a space.
  const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  const title = html.match(/<div class="font-semibold leading-tight truncate text-heading"[^>]*>([\s\S]*?)<\/div>/)?.[1];
  const line = html.match(/<div class="mt-0\.5 text-xs text-secondary whitespace-nowrap truncate">([\s\S]*?)<\/div>/)?.[1];
  assert.ok(title !== undefined && line !== undefined, "the bar's title and channel line were found");
  return { title: text(title), line: text(line) };
}

test("equal names → one: the streamer's name and the site's name match (any case) → the title says it once", () => {
  assert.equal(bar("Test Streamer", { streamerName: "Test Streamer", followerCount: 12 }).title, "Test Streamer");
  assert.equal(bar("Test Streamer", { streamerName: "test streamer", followerCount: 12 }).title, "Test Streamer");
  assert.equal(bar("Test Streamer", { streamerName: " Test Streamer ", followerCount: 12 }).title, "Test Streamer");
});

test("different names: both, as before; no streamer name: the site's alone", () => {
  assert.equal(bar("Example Site", { streamerName: "Casey Rivers", followerCount: 12 }).title, "Casey Rivers · Example Site");
  assert.equal(bar("Example Site", { streamerName: "", followerCount: 12 }).title, "Example Site");
});

test("null followers → no 'followers': an unknown count is left out, not drawn as a dash", () => {
  assert.equal(bar("Test Streamer", { streamerName: "Test Streamer", followerCount: null }).line, "Test Streamer");
  assert.equal(bar("Test Streamer", { streamerName: "Test Streamer", followerCount: null, live: true, liveViewers: 7 }).line,
    "Test Streamer · 7 watching");
  assert.equal(bar("Test Streamer", { streamerName: "Test Streamer", followerCount: 40 }).line, "Test Streamer · 40 followers");
  assert.equal(bar("Test Streamer", { streamerName: "Test Streamer", followerCount: 0 }).line, "Test Streamer · 0 followers", "zero is a count");
});

test("retry: a count that arrives after a failed fetch adds the segment; restart: a fresh mount reads the same", () => {
  assert.doesNotMatch(bar("Test Streamer", { streamerName: "Test Streamer", followerCount: null }).line, /followers/);
  assert.match(bar("Test Streamer", { streamerName: "Test Streamer", followerCount: 40 }).line, /· 40 followers$/);
  const first = bar("Test Streamer", { streamerName: "Test Streamer", followerCount: null });
  const again = bar("Test Streamer", { streamerName: "Test Streamer", followerCount: null });
  assert.deepEqual(again, first);
});

test("the fallback circle shows the streamer's initials, else the site's", () => {
  // The circle after the streamer-picture branch: its only child is the initials expression.
  const fallback = src.match(/ref=\{\(img\) => checkImgFailed\(img, \(\) => setPfpFailed\(true\)\)\} onError=\{\(\) => setPfpFailed\(true\)\} \/>\n {10}\) : \(\n {12}<div [^>]*>\n {14}([^\n]*)\n {12}<\/div>/)?.[1];
  assert.equal(fallback, "{initials(streamerName || siteName())}");
  assert.equal(initials("Casey Rivers"), "CR");
  assert.equal(initials("Example Stream"), "ES");
  assert.match(src, /\n\}\s*$/, "vacuity: the component file was read to its end");
});
