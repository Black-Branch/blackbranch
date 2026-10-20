// A fresh install's Home: no VOD playlist, no Home heading or intro set. Its own file because
// installValues.ts reads the build values once per process — homeView.render.test.ts is the
// install that HAS them.
// Run: node --test app/features/home/homeView.unconfigured.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "../../lib/testTsx.ts";
process.env.INSTALL_VALUES = JSON.stringify({ "site.name": "Example Stream" });
const { HomeView } = await import("./HomeView.tsx");
const { vodPlaylist } = await import("../../lib/vodPlaylist.ts");
const { getVods } = await import("../../lib/vods.ts");

const noop = () => {};
// A payload that DOES carry VODs: whatever reaches the page, an install without a playlist has
// no VODs card to put them in.
const data = {
  status: { live: false, viewers: null, community: null },
  lastStream: null,
  news: [],
  vods: [{ id: "abcdefghijk", title: "Somebody else's broadcast", duration: "8:55:00", when: "1d ago" }],
  threads: [],
  boards: null,
  generatedAt: "2026-10-09T12:00:00.000Z",
};
const render = (variant: "grid" | "compact", signedIn: boolean) =>
  renderToStaticMarkup(createElement(HomeView, {
    data, loading: false, error: false, active: false, signedIn, variant, selectedVodId: null,
    onPickVod: noop, onWatchCommunity: noop, onOpenNews: noop,
  }));

test("no playlist: no VODs card on Home — not 'Latest VODs', not the phone's 'Last stream' — in either layout", () => {
  for (const variant of ["grid", "compact"] as const) {
    for (const signedIn of [false, true]) {
      const out = render(variant, signedIn);
      // Not vacuous: the rest of the grid rendered (status, threads, boards, news).
      assert.equal((out.match(/data-widget="/g) ?? []).length, 4, `${variant}/${signedIn}: four widgets`);
      assert.match(out, /data-widget="status"/);
      assert.doesNotMatch(out, /data-widget="vods"/);
      assert.doesNotMatch(out, /Latest VODs|>Last stream<|i\.ytimg\.com|Somebody else/);
    }
  }
});

test("no Home heading or intro set: the site name and a neutral line, nothing of another install's", () => {
  const out = render("grid", false);
  assert.match(out, /<header class="mb-3"><h2 class="text-lg font-semibold text-strong">Example Stream<\/h2><p class="text-sm text-secondary">A live stream and its community, backed by Matrix\.<\/p><\/header>/);
  assert.doesNotMatch(out, /Open-Borders|Decentralized community/);
});

test("vodPlaylist: unset, blank and 'none' (any case) mean no playlist; anything else is the id", () => {
  assert.equal(vodPlaylist(), null, "this build has none");
  for (const raw of ["", "  ", "none", "NONE", " None "]) assert.equal(vodPlaylist(raw), null, JSON.stringify(raw));
  assert.equal(vodPlaylist(" PLabc123 "), "PLabc123");
});

test("getVods with no playlist answers [] without calling YouTube", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("no network in tests"); }) as typeof fetch;
  try {
    assert.deepEqual(await getVods(), []);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
