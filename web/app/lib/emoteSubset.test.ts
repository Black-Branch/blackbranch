// Emotes are on the page before any script runs: preloaded, so they load
// immediately. The server page renders the
// seeded rows WITH their emote <img>s, so the browser's preload scanner
// fetches them from the HTML itself — but the full manifest is ~130 KB
// (over a thousand emotes), too much to inline on every load. The
// page inlines only the emotes those rows use: a superset of whatever the
// renderer resolves, because the renderer can only match a name that appears
// verbatim in the text (lineTokens, the adjacent-emote split, the mixed
// split — all substring matches).
//
// Run: node --test app/lib/emoteSubset.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { emotesUsedBy } from "./emoteSubset.ts";
import { baselineEmoteUrl } from "./emoteRes.ts";
import type { EmoteMap } from "./emoteMap.ts";

const manifest: EmoteMap = {
  KEKW: { url: "https://cdn.7tv.app/emote/a/2x.webp", zeroWidth: false, ar: 1 },
  Kappa: { url: "https://static-cdn.jtvnw.net/emoticons/v2/25/static/dark/3.0", zeroWidth: false, ar: 1 },
  peepoClap: { url: "https://cdn.7tv.app/emote/b/2x.webp", zeroWidth: false },
  RainTime: { url: "https://cdn.7tv.app/emote/c/2x.webp", zeroWidth: true },
};

test("only the emotes the rows name, with their full info", () => {
  const out = emotesUsedBy(["hello KEKW", "KappaRainTime stacked", "no emotes here"], manifest);
  assert.deepEqual(Object.keys(out).sort(), ["Kappa", "KEKW", "RainTime"].sort());
  assert.deepEqual(out.KEKW, manifest.KEKW, "the entry travels whole — ar and zeroWidth included");
});

test("a name inside a longer word still counts (the renderer's splits are substring matches)", () => {
  const out = emotesUsedBy(["KEKWKappa", "xpeepoClapx"], manifest);
  assert.deepEqual(Object.keys(out).sort(), ["Kappa", "KEKW", "peepoClap"].sort());
});

test("case matters, exactly as it does for the renderer", () => {
  assert.deepEqual(emotesUsedBy(["kekw"], manifest), {});
});

test("nothing to render, nothing inlined", () => {
  assert.deepEqual(emotesUsedBy([], manifest), {});
  assert.deepEqual(emotesUsedBy(["KEKW"], {}), {});
});

// The server cannot know the display, so a server-rendered <img> carries the
// crisp 2x baseline rung — and the client's FIRST (hydration) render carries
// the same, or every emote would be a hydration mismatch. After hydration the
// row KEEPS that baseline whenever it already covers the display (EmoteImg's
// keep rule), so the bytes the HTML fetched are the bytes chat keeps.
test("the baseline rung: every provider holds 2x (Twitch's manifest 3.0 steps to 2.0)", () => {
  assert.equal(baselineEmoteUrl("https://cdn.7tv.app/emote/a/3x.webp"), "https://cdn.7tv.app/emote/a/2x.webp");
  assert.equal(baselineEmoteUrl("https://cdn.7tv.app/emote/a/2x.webp"), "https://cdn.7tv.app/emote/a/2x.webp");
  assert.equal(baselineEmoteUrl("https://static-cdn.jtvnw.net/emoticons/v2/25/static/dark/3.0"), "https://static-cdn.jtvnw.net/emoticons/v2/25/static/dark/2.0");
  assert.equal(baselineEmoteUrl("https://cdn.frankerfacez.com/emote/1/4"), "https://cdn.frankerfacez.com/emote/1/2");
  assert.equal(baselineEmoteUrl("https://cdn.betterttv.net/emote/x/3x"), "https://cdn.betterttv.net/emote/x/2x");
});
