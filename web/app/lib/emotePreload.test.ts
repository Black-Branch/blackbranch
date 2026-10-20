// Emotes are on the page before any script runs. The seeded
// rows (chatHistorySeed.test.ts) render their emote <img>s at SSR, so the
// browser's preload scanner fetches the images from the HTML itself; the page
// inlines only the manifest slice those rows use (emoteSubset.ts), and every
// server-rendered <img> carries the baseline rung the client's hydration
// render also carries (emoteSubset.test.ts pins the rung).
//
// Run: node --test app/lib/emotePreload.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { stripComments } from "./testSource.ts";
import type { ChatMsg } from "./chatMsg.ts";
import type { EmoteMap } from "./emoteMap.ts";
import "./testTsx.ts";
const { default: ChatWindow } = await import("../features/chat/ChatWindow.tsx");
const { BadgesProvider } = await import("./BadgesContext.tsx");

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const read = (rel: string, tail: RegExp) => {
  const raw = readFileSync(join(app, rel), "utf8");
  assert.match(raw.slice(-300), tail, `${rel} did not end as expected — truncated read`);
  return stripComments(raw);
};

test("a seeded window renders the emote as an <img> in the HTML, at the baseline rung", () => {
  const seed: ChatMsg[] = [
    { id: 1, platform: "twitch", username: "Bram42", message: "KEKW that was good", isMod: false, isVip: false, isMember: false, ts: 1000 },
  ];
  const emotes: EmoteMap = { KEKW: { url: "https://cdn.7tv.app/emote/abc/3x.webp", zeroWidth: false, ar: 1.2 } };
  const html = renderToStaticMarkup(
    createElement(BadgesProvider, null, createElement(ChatWindow, { scaleFactor: 1.5, initialMessages: seed, initialEmotes: emotes }))
  );
  assert.match(html, /<img src="https:\/\/cdn\.7tv\.app\/emote\/abc\/2x\.webp" crossorigin="anonymous" alt="KEKW"/,
    "the emote is an image in the server HTML, at the 2x baseline the client's hydration render also picks, in the shared CORS mode");
  // React hoists a preload for a high-priority image; it must carry the image's CORS mode too, or
  // the preloaded copy is one the <img> cannot use.
  assert.match(html, /<link rel="preload" as="image" href="https:\/\/cdn\.7tv\.app\/emote\/abc\/2x\.webp" crossorigin=""/);
  assert.match(html, /fetchpriority="high"/i, "the seeded emote keeps its high fetch priority — the preload scanner honours it");
  assert.match(html, /that was good/);
});

test("without the inlined slice the same row renders its emote as text (the client fills it in later)", () => {
  const seed: ChatMsg[] = [
    { id: 1, platform: "twitch", username: "Bram42", message: "KEKW that was good", isMod: false, isVip: false, isMember: false, ts: 1000 },
  ];
  const html = renderToStaticMarkup(
    createElement(BadgesProvider, null, createElement(ChatWindow, { scaleFactor: 1.5, initialMessages: seed }))
  );
  assert.doesNotMatch(html, /<img src="https:\/\/cdn\.7tv\.app/);
  assert.match(html, /KEKW that was good/);
});

test("the renderer sizes to the display only after hydration — the server and the hydration render agree", () => {
  const src = read("lib/renderText.tsx", /\)\s*;\s*}\s*$/);
  assert.match(src, /const hydrated = useClientValue\(isHydrated, false\);/);
  assert.match(src, /hydrated \? rightSizeEmoteUrl\(src, h, bornHydrated \? undefined : baselineEmoteUrl\(src\)\) : baselineEmoteUrl\(src\)/,
    "the hydration render must carry the server's baseline, and a server-rendered row must offer it as the URL to keep");
  assert.match(src, /const isHydrated = \(\) => true;/, "a module-level getter: useSyncExternalStore needs a stable snapshot function");
});

test("useEmotes merges the inlined slice UNDER the cached/fresh manifest", () => {
  const src = read("lib/useEmotes.ts", /\}, \[base, initial\]\);\s*}\s*$/);
  assert.match(src, /export function useEmotes\(initial\?: EmoteMap\): EmoteMap/);
  assert.match(src, /const base = fresh \?\? cached;/);
  assert.match(src, /return \{ \.\.\.initial, \.\.\.base \};/, "the manifest wins per name; the slice only fills what a stale cache lacks");
});

test("every page that seeds rows inlines their emote slice, from the manifest the emotes route already caches", () => {
  const pages: [string, RegExp][] = [
    ["chat/page.tsx", /\/>;\s*}\s*$/],
    ["(main)/page.tsx", /\);\s*}\s*$/],
    ["popout/page.tsx", /\);\s*}\s*$/],
    ["overlay/chat/page.tsx", /\/>;\s*}\s*$/],
  ];
  for (const [rel, tail] of pages) {
    const src = read(rel, tail);
    assert.match(src, /import \{ manifestWithin \} from "@\/app\/api\/emotes\/route"/, rel);
    assert.match(src, /import \{ emotesUsedBy \} from "@\/app\/lib\/emoteSubset"/, rel);
    assert.match(src, /emotesUsedBy\([^,]*\.map\(\(m\) => m\.message\), /, `${rel}: the slice is cut from the seeded rows' text`);
    assert.match(src, /manifestWithin\(\)\.catch\(\(\) => \(\{\}\)\)/, `${rel}: a manifest failure OR a cold rebuild costs the slice, never the page`);
    assert.match(src, /initialEmotes=\{initialEmotes\}/, `${rel}: the slice reaches the chat`);
  }
});

test("a cold manifest cannot hold a page: the wait is bounded and races the rebuild", () => {
  const src = read("api/emotes/route.ts", /return Response\.json\(body, \{ status \}\);\s*}\s*$/);
  assert.match(src, /export function manifestWithin\(ms = 1500\): Promise<EmoteMap>/);
  assert.match(src, /Promise\.race\(\[getManifest\(\)\.finally\(\(\) => clearTimeout\(timer\)\), late\]\)/);
});

test("the slice travels with the rows: StreamView, PopoutView, the sidebar and the window", () => {
  const sv = read("components/StreamView.tsx", /ssr: false \}\);\s*$/);
  assert.match(sv, /initialMessages=\{initialMessages\} initialEmotes=\{initialEmotes\}/);
  const pv = read("components/PopoutView.tsx", /\);\s*}\s*$/);
  assert.match(pv, /initialMessages=\{initialMessages\} initialEmotes=\{initialEmotes\} \/>/);
  const sb = read("features/chat/ChatSidebar.tsx", /\);\s*}\s*$/);
  assert.match(sb, /const emotes = useEmotes\(initialEmotes\);/);
  const cw = read("features/chat/ChatWindow.tsx", /\);\s*}\s*$/);
  assert.match(cw, /const emotes = useEmotes\(initialEmotes\);/);
});
