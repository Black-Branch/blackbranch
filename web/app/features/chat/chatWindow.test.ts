// /chat is the broadcaster's OWN chat window, not an OBS source.
//
// A window that force-scrolls to the bottom on every message and every resize
// and keeps only 60 rows makes reading anything older a fight with the feed.
// The window runs on the SAME engine as the site chat —
// useChatMessages (buffer, dedupe, history pagination, votes, deletes, purges)
// over useAnchoredChat (pause while scrolled up, return-to-live pill) — so
// scrolling up pauses, the pill counts what arrived, and the top of the list
// loads earlier history from the database instead of ending at a 60-row cap.
// The OBS browser source keeps its always-follow behaviour at /overlay/chat.
//
// Run: node --test app/features/chat/chatWindow.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { stripComments } from "../../lib/testSource.ts";
// Static, and BEFORE the component import: registers the resolver that lets a
// .tsx specifier load at all (iconRail.render.test.ts's header explains why).
import "../../lib/testTsx.ts";
const { default: ChatWindow } = await import("./ChatWindow.tsx");
const { BadgesProvider } = await import("../../lib/BadgesContext.tsx");

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "../../..");

function readWhole(rel: string, tailAnchor: RegExp): string {
  const src = readFileSync(join(webRoot, rel), "utf8");
  assert.match(src.slice(-400), tailAnchor,
    `${rel} did not end as expected — the read is truncated, and every assertion below it is vacuous`);
  return stripComments(src);
}

const WINDOW = "app/features/chat/ChatWindow.tsx";
const WINDOW_TAIL = /<\/div>\s*\)\s*;\s*}\s*$/;
const src = readWhole(WINDOW, WINDOW_TAIL);

// The gear + draggable panel live in the shared OverlaySettingsPanel.tsx,
// not ChatWindow.tsx — the /chat window and the OBS overlay share one gear.
const PANEL = "app/features/chat/OverlaySettingsPanel.tsx";
const PANEL_TAIL = /<\/>\s*\)\s*;\s*}\s*$/;
const panelSrc = readWhole(PANEL, PANEL_TAIL);

test("the window runs on the site chat's engine, not a private reducer", () => {
  assert.match(src, /import \{ useChatMessages \} from "@\/app\/lib\/useChatMessages"/);
  assert.match(src, /= useChatMessages\(\{/);
  assert.doesNotMatch(src, /useChatSocket/, "the socket is the hook's — a second subscriber would double-handle every frame");
  assert.doesNotMatch(src, /MAX_MESSAGES/, "no row cap of its own — the hook keeps scrollback while paused");
  assert.doesNotMatch(src, /\.scrollTop\s*=\s*[\w.]+\.scrollHeight/,
    "no force-scroll of its own — the anchor engine asserts the bottom only while anchored");
  assert.doesNotMatch(src, /new ResizeObserver/, "no resize re-pin of its own, for the same reason");
});

test("scrolling up pauses; the paused pill returns to live", () => {
  // handleScroll still runs FIRST and unconditionally; the second call only drops
  // a reply preview the list has moved out from under.
  assert.match(src, /onScroll=\{\(\) => \{ handleScroll\(\); dismissPreview\(\); \}\}/, "the scroller feeds the anchor engine (and history loading near the top)");
  assert.match(src, /anchored \? "\[overflow-anchor:none\]" : "\[overflow-anchor:auto\]"/,
    "native scroll anchoring off while following, on while reading (image loads above the fold)");
  // ⑤ Behavior: the count is what the viewer will SEE (hidden people/bots excluded).
  assert.match(src, /\{!anchored && <PausedPill queued=\{Math\.max\(0, shownAll\.length - shown\.length\)\} onClick=\{anchorToBottom\} \/>\}/);
  assert.match(src, /import \{ PausedPill \} from "@\/app\/components\/PausedPill"/);
});

test("history like the site: the loader row, and PgUp/PgDn/Home/End move the feed", () => {
  assert.match(src, /\{loadingHistory && \([\s\S]{0,200}?Loading earlier messages…/);
  assert.match(src, /import \{ chatScrollKey, scrollChatByKey \} from "@\/app\/lib\/chatScrollKeys"/);
  // No composer in the window, so the keys are read on the document: the
  // browser would otherwise page the (unscrollable) document, not the feed.
  assert.match(src, /document\.addEventListener\("keydown", onKey\)/);
  assert.match(src, /chatScrollKey\(e\.key, \{ textEmpty: true, modified: e\.ctrlKey \|\| e\.metaKey \|\| e\.altKey \|\| e\.shiftKey \}\)/);
  assert.match(src, /scrollChatByKey\(el, k, anchorToBottom, pause\)/, "the engine's pause rides along — a key without it is snapped back");
});

test("the pinned message, the vote, the mod delete and the user card — the site's behaviours", () => {
  assert.match(src, /= useChatPin\(\)/);
  assert.match(src, /<PinnedBanner/);
  assert.match(src, /onVote=\{me\.signedIn && !row\.isOwn && !row\.isOwnStream \? handleVote : undefined\}/);
  assert.match(src, /onPin=\{me\.signedIn && me\.isMod \? handlePin : undefined\}/);
  assert.match(src, /onModDelete=\{me\.isMod \? handleDelete : undefined\}/);
  assert.match(src, /onUsernameClick=\{openCard\}/, "anyone can open a user card, as on the site");
  // The banner pads the scroller from outside `items` — re-snap in the same paint.
  assert.match(src, /useLayoutEffect\(\(\) => \{\s*reassertBottom\(\);\s*\}, \[pinHeight, pin\?\.id, dismissedPinId, reassertBottom\]\)/);
});

test("a dropped socket is visible — after it was up at least once", () => {
  // The site gates its pill on `messages.length > 0`; the window's initial DB
  // fill races the socket open, so that gate flashes on a fresh load. The
  // window remembers whether the socket was EVER up, as the OBS source does.
  assert.match(src, /const \[everConnected, setEverConnected\] = useState\(false\);/);
  assert.match(src, /if \(connected && !everConnected\) setEverConnected\(true\);/,
    "derived during render (React's storing-previous-render pattern), never in an effect");
  const gated = src.match(/\{everConnected && !connected &&[\s\S]{0,400}/)?.[0] ?? "";
  assert.ok(gated, "the reconnect pill must be gated on a drop AFTER an open");
  assert.match(gated, /Reconnecting to chat/);
  assert.match(gated, /role="status"/, "a blip is context, not an interruption — never role=alert");
});

// The window may run in a browser with a transparency mod, so its canvas must
// be see-through like the OBS source's — the browser supplies the background,
// not the page.
test("its canvas is transparent, like the OBS source: the host browser paints the background", () => {
  assert.doesNotMatch(src, /linear-gradient\(to bottom, var\(--bg-chat-start\), var\(--bg-chat-end\)\)/,
    "no panel gradient — an opaque page defeats a transparent browser window");
  assert.match(src, /document\.body\.style\.background = "transparent";\s*document\.documentElement\.style\.backgroundColor = "transparent";/,
    "both html and body cleared, exactly as ChatOverlay does (globals.css paints html opaque)");
  assert.match(src, /className="chat-window relative h-screen w-screen overflow-hidden flex flex-col text-body bg-transparent overlay-host"/,
    "`chat-window` scopes the window-only look in globals.css (chatWindowLook.test.ts); overlay-host is the shared gear's hover anchor");
  assert.match(src, /document\.documentElement\.style\.fontSize = `\$\{scaleFactor \* 16\}px`/,
    "?scale= still sizes the whole window through the root font-size");
});

test("renders: the feed, the empty state, the gear — and no pill before anything happened", () => {
  const html = renderToStaticMarkup(
    createElement(BadgesProvider, null, createElement(ChatWindow, { scaleFactor: 1.5 }))
  );
  assert.match(html, /role="log"/);
  assert.match(html, /aria-label="Live chat messages"/);
  assert.match(html, /overflow-x-clip/, "the feed clips sideways like every other chat scroller");
  assert.match(html, /Connecting to chat…/, "first load says connecting, not empty");
  // The gear is the shared OverlaySettingsPanel now, not an inline copy.
  assert.match(src, /<OverlaySettingsPanel page="window"/);
  assert.doesNotMatch(html, /Reconnecting to chat/);
  assert.doesNotMatch(html, /Chat paused/);
});

// The window's settings panel must reach the window: the gear + panel live in
// the shared OverlaySettingsPanel, so the two onShow*Change props flow
// ChatWindow → OverlaySettingsPanel → ChatPrefs — both hops are pinned.
test("the panel's row toggles change the rows now, and the own colour is the account's", () => {
  assert.match(src, /<OverlaySettingsPanel page="window"\s+scaleFactor=\{scaleFactor\}\s+onShowTimestampsChange=\{setShowTimestamps\}\s+onShowMatrixNameChange=\{setShowMatrixName\}\s*\/>/,
    "the hydrated event fires once per load — live changes come through the panel's props");
  assert.match(panelSrc, /onShowTimestampsChange,\s*onShowMatrixNameChange,/, "OverlaySettingsPanel accepts the two window-only callbacks");
  assert.match(panelSrc, /<ChatPrefs\s+overlayPage=\{page\}\s+onShowTimestampsChange=\{onShowTimestampsChange\}\s+onShowMatrixNameChange=\{onShowMatrixNameChange\}\s*\/>/,
    "…and forwards them straight to ChatPrefs, alongside overlayPage");
  // An "ov:" copy of your colour seeded once would never refresh. The window
  // reads the SITE's key live and refreshes it from the account (chatWindowOwnColor.render.test.ts).
  assert.match(src, /const \[ownColor, setOwnColorLs\] = useLocalStorageString\("chatUsernameColor"\);/);
  assert.match(src, /getJson<\{ color\?: string \| null \}>\("\/api\/me\/color"\)/);
  assert.doesNotMatch(src, /settingGet\("chatUsernameColor"\)/);
});

test("the document keys leave the settings panel and the user card alone", () => {
  assert.match(src, /if \(t\?\.closest\("\[data-chat-panel\]"\)\) return;/);
  // The panel itself lives in OverlaySettingsPanel.tsx — ChatWindow.tsx
  // marks only the user card; the shared panel carries its own copy.
  assert.equal((src.match(/data-chat-panel=""/g) ?? []).length, 1, "the card is marked");
  assert.equal((panelSrc.match(/data-chat-panel=""/g) ?? []).length, 1, "the shared panel is marked, so it still keys those keys off the guard above");
  assert.match(panelSrc, /aria-label="Close chat settings"/);
});
