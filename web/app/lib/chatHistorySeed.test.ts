// The chat never opens empty. Every page that mounts a chat
// reads the newest page of history on the SERVER and hands it down as
// `initialMessages`, so the rows are in the HTML before any script runs; the
// hook seeds its buffer from them (chatSeed.ts) and skips the mount-time fetch.
// One query serves both the /api/chat/history route and the
// pages — `loadChatHistory`, exported from the route module.
//
// Run: node --test app/lib/chatHistorySeed.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { stripComments } from "./testSource.ts";
import { CHAT_LIVE_CAP } from "./chatCaps.ts";
import type { ChatMsg } from "./chatMsg.ts";
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

test("the history route exports the query, and its GET is only the HTTP shape of it", () => {
  const src = read("api/chat/history/route.ts", /hasMore: rows\.length >= limit \};\s*}\s*$/);
  assert.match(src, /export async function loadChatHistory\(/);
  assert.match(src, /export async function historyViewer\(\)/);
  assert.match(src, /export async function latestChatHistory\(viewer: HistoryViewer, limit: number\)/);
  assert.match(src, /loadChatHistory\(\{ before: Date\.now\(\), limit, viewer \}\)/, "the newest page = now, back `limit` rows");
  assert.match(src, /return Response\.json\(await loadChatHistory\(\{ before, limit, cursor, viewer \}\)\);/);
  // The mod-transparency rule moved with the viewer, not away from it.
  assert.match(src, /isMod = !!\(modRows\[0\]\?\.is_mod \|\| modRows\[0\]\?\.is_admin\);/);
});

test("every page that mounts a chat reads the newest page on the server, capped like the live buffer", () => {
  const pages: [string, RegExp, RegExp][] = [
    ["chat/page.tsx", /\/>;\s*}\s*$/, /<ChatWindow scaleFactor=\{scaleFactor\} initialMessages=\{messages\}/],
    ["(main)/page.tsx", /\);\s*}\s*$/, /initialMessages=\{messages\}/],
    ["popout/page.tsx", /\);\s*}\s*$/, /initialMessages=\{messages\}/],
    ["overlay/chat/page.tsx", /\/>;\s*}\s*$/, /<ChatOverlay scaleFactor=\{scaleFactor\} initialMessages=\{messages\}/],
  ];
  for (const [rel, tail, mount] of pages) {
    const src = read(rel, tail);
    assert.match(src, /import \{ (?:historyViewer, )?latestChatHistory \} from "@\/app\/api\/chat\/history\/route"/, rel);
    if (rel.startsWith("overlay/")) {
      // The OBS source keeps its own smaller cap (it never scrolls up).
      assert.match(src, /latestChatHistory\([^)]*, CHAT_OVERLAY_CAP\)/, `${rel}: the newest page, exactly the overlay cap`);
      assert.match(src, mount, `${rel}: the rows reach the chat`);
      continue;
    }
    // `[^)]*` between the parens also proves no `Date.now()` sits in the call:
    // the clock is read inside latestChatHistory, never in a component's render
    // (react-hooks/purity). The main page reads the clock elsewhere for its
    // module-level caches, so a file-wide "no Date.now" would be the wrong bound.
    assert.match(src, /latestChatHistory\([^)]*, CHAT_LIVE_CAP\)/, `${rel}: the newest page, exactly the live cap`);
    assert.match(src, mount, `${rel}: the rows reach the chat`);
  }
  assert.equal(CHAT_LIVE_CAP, 80);
});

test("the OBS source seeds its own buffer and MERGES the socket's history frame over it", () => {
  const src = read("features/chat/ChatOverlay.tsx", /<\/>\s*\)\s*;\s*}\s*$/);
  assert.match(src, /useState<ChatMsg\[\]>\(\(\) => seedOverlayRows\(initialMessages\)\)/,
    "the buffer's FIRST state is the seed");
  assert.doesNotMatch(src, /data\.type === "history"\) setMessages\(\(data\.messages as ChatMsg\[\]\)\.filter/,
    "a history frame that REPLACED the buffer would wipe the seed — stream-api's buffer is empty after a restart");
  assert.match(src, /data\.type === "history"\) \{\s*setMessages\(\(prev\) => mergeOverlayHistory\(prev, data\.messages\)\);/);
  assert.match(src, /const emotes = useEmotes\(initialEmotes\);/);
  assert.match(src, /\{initialMessages && initialMessages\.length > 0 && <ScrollBottomBeforeHydration \/>\}/);
});

test("the rows travel: StreamView and PopoutView forward them, the sidebar and the window seed the hook", () => {
  const sv = read("components/StreamView.tsx", /ssr: false \}\);\s*$/);
  assert.match(sv, /initialMessages=\{initialMessages\}/);
  const pv = read("components/PopoutView.tsx", /\);\s*}\s*$/);
  assert.match(pv, /isPopout initialMessages=\{initialMessages\}/);
  const sb = read("features/chat/ChatSidebar.tsx", /\);\s*}\s*$/);
  assert.match(sb, /useChatMessages\(\{[^}]*initialMessages,\s*\}\)/);
  const cw = read("features/chat/ChatWindow.tsx", /\);\s*}\s*$/);
  assert.match(cw, /useChatMessages\(\{[^}]*initialMessages,\s*\}\)/);
});

test("the hook seeds from the page and skips the fetch it replaced — unless a mod keeps struck-out copies", () => {
  const src = read("lib/useChatMessages.ts", /spotlightKey,\s*\};\s*}\s*$/);
  assert.match(src, /rows: seedMessages\(initialMessages, st, CHAT_LIVE_CAP\)/,
    "the buffer's FIRST state is the seed — not an empty list corrected in an effect");
  assert.match(src, /useState<ChatMsg\[\]>\(seed\.rows\)/);
  assert.match(src, /const altOrdinalRef = useRef\(seed\.st\);/, "the live path continues the seed's stripe ordinal");
  assert.match(src, /seeded: \(initialMessages\?\.length \?\? 0\) > 0/,
    "an EMPTY seed (a page whose history read failed) keeps the client fetch");
  assert.match(src, /if \(seededRef\.current && !modShowsDeleted\) return;/);
  assert.match(src, /if \(initialFetchedRef\.current\) return;\s*initialFetchedRef\.current = true;/, "at most one fetch per mount");
  assert.match(src, /const messagesRef = useRef<ChatMsg\[\]>\(messages\);/, "the sync read starts on the seed too");
});

test("the seeded window renders its rows into the HTML, then snaps the scroller to the bottom before hydration", () => {
  const seed: ChatMsg[] = [
    { id: 1, platform: "twitch", username: "Bram42", message: "first row here", isMod: false, isVip: false, isMember: false, ts: 1000 },
    { id: 2, platform: "native", username: "helperbot", message: "second row here", isMod: true, isVip: false, isMember: false, ts: 2000 },
  ];
  const html = renderToStaticMarkup(
    createElement(BadgesProvider, null, createElement(ChatWindow, { scaleFactor: 1.5, initialMessages: seed }))
  );
  assert.match(html, /first row here/);
  assert.match(html, /second row here/);
  assert.doesNotMatch(html, /Connecting to chat…/, "a seeded feed is not empty, so no empty state");
  // The snap script sits IMMEDIATELY after the scroller (it targets its
  // previous element sibling) and before the pin banner / pill layer.
  const scrollerEnd = html.indexOf("</div><script>");
  assert.ok(scrollerEnd !== -1, "no inline script right after a closing div");
  assert.match(html, /<script>\(function\(\)\{var s=document\.currentScript,e=s&&s\.previousElementSibling;if\(e\)e\.scrollTop=e\.scrollHeight;\}\)\(\)<\/script>/);
  assert.ok(html.indexOf("second row here") < scrollerEnd, "the rows are inside the element the script snaps");
});

test("an unseeded window still says connecting (the fetch path is intact)", () => {
  const html = renderToStaticMarkup(
    createElement(BadgesProvider, null, createElement(ChatWindow, { scaleFactor: 1.5 }))
  );
  assert.match(html, /Connecting to chat…/);
  assert.doesNotMatch(html, /previousElementSibling/, "…and nothing to snap: the script is emitted only with rows");
});
