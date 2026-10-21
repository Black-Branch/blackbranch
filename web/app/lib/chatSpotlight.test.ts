// The broadcaster's "highlight": click a message and it takes the
// highlight-card look (the 50-point product's design) for EVERYONE — the site
// chat, the popout, the /chat window and the OBS source — so the audience can
// see which message is being answered. One at a time; a second click on it
// clears it; only an admin account (is_admin, never a name) can set it.
//
// The pick travels as a `spotlight` frame (stream-api /chat/spotlight, the
// admin-gated web route in front of it) and replays on connect, so a reloaded
// OBS source paints it at once. This file pins the pure pieces, the wiring,
// and the rendered look.
//
// Run: node --test app/lib/chatSpotlight.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { stripComments } from "./testSource.ts";
import { spotlightClickAllowed, spotlightKeyOf } from "./chatSpotlight.ts";
import { STREAM_FRAME_TYPES } from "./wsFrames.ts";
import type { ChatMsg } from "./chatMsg.ts";
import "./testTsx.ts";
// Loaded at run time: the box's site build typechecks tests, and tools/ is not in a release.
type Literals = { loadConfig: () => { patterns: { name: string; re: string }[] }; countLiterals: (text: string, cfg: unknown) => number };
const { loadConfig, countLiterals } = (await import(new URL("../../../tools/check-owner-literals.mjs", import.meta.url).href)) as Literals;
const { default: ChatMessage } = await import("../features/chat/ChatMessage.tsx");
const { BadgesProvider } = await import("./BadgesContext.tsx");

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const read = (rel: string, tail: RegExp) => {
  const raw = readFileSync(join(app, rel), "utf8");
  assert.match(raw.slice(-300), tail, `${rel} did not end as expected — truncated read`);
  return stripComments(raw);
};

// ── the pure pieces ─────────────────────────────────────────────────────────

test("the key matches the buffer's platform:id identity, whatever type the id arrived as", () => {
  assert.equal(spotlightKeyOf({ platform: "twitch", messageId: "17" }), "twitch:17");
  assert.equal(spotlightKeyOf({ platform: "native", messageId: 4 }), "native:4");
  assert.equal(spotlightKeyOf(null), null);
});

test("a click on a control, a link, or a text selection is not a pick", () => {
  const doc = globalThis.document;
  const row = doc.createElement("div");
  row.innerHTML = '<span class="body">text</span><button>vote</button><a href="https://x">link</a><span data-chat-panel=""><i>panel</i></span><div class="row-actions"><b>bar padding</b></div>';
  const text = row.querySelector(".body")!;
  assert.equal(spotlightClickAllowed(text, ""), true);
  assert.equal(spotlightClickAllowed(row.querySelector("button")!, ""), false);
  assert.equal(spotlightClickAllowed(row.querySelector("a")!, ""), false);
  assert.equal(spotlightClickAllowed(row.querySelector("i")!, ""), false, "inside the settings panel / user card");
  assert.equal(spotlightClickAllowed(row.querySelector("b")!, ""), false, "the hover toolbar's own padding");
  assert.equal(spotlightClickAllowed(text, "some words"), false, "a drag-select ends in a click too");
  assert.equal(spotlightClickAllowed(null, ""), false);
});

// ── the wire ────────────────────────────────────────────────────────────────

test("`spotlight` is a registered frame (wsFrameContract.test.ts pins it against stream-api's broadcast)", () => {
  assert.ok(STREAM_FRAME_TYPES.includes("spotlight"));
});

test("the web route is gated on the ADMIN flag — never a name — and only fans the pick out", () => {
  const src = read("api/chat/spotlight/route.ts", /return Response\.json\(\{ spotlight \}\);\s*}\s*$/);
  assert.match(src, /const me = await requireAdmin\(\);\s*if \(!me\) return new Response\("Forbidden", \{ status: 403 \}\);/);
  assert.equal(countLiterals(src, loadConfig()), 0, "no owner hardcoding");
  assert.match(src, /streamApiFetch\("\/chat\/spotlight"/);
  assert.doesNotMatch(src, /pool\.query|INSERT|UPDATE/, "nothing persists — the pick is a moment, not a record");
  assert.match(src, /export async function POST\(/);
  assert.doesNotMatch(src, /export async function GET/, "clients learn the pick from the connect frame, not a fetch");
});

test("the hook keeps the pick and exposes it as a key; every consumer marks the matching row", () => {
  const hook = read("lib/useChatMessages.ts", /spotlightKey,\s*\};\s*}\s*$/);
  assert.match(hook, /data\.type === "spotlight"\) \{\s*setSpotlight\(data\.spotlight\);/);
  assert.match(hook, /const spotlightKey = spotlightKeyOf\(spotlight\);/);
  const sb = read("features/chat/ChatSidebar.tsx", /\);\s*}\s*$/);
  assert.match(sb, /spotlight=\{spotlightKey !== null && spotlightKey === chatKey\(msg\)\}/);
  assert.match(sb, /onSpotlight=\{isAdmin \? handleSpotlight : undefined\}/, "the site column: the admin only");
  const cw = read("features/chat/ChatWindow.tsx", /\);\s*}\s*$/);
  assert.match(cw, /spotlight=\{spotlightKey !== null && spotlightKey === chatKey\(msg\)\}/);
  assert.match(cw, /onSpotlight=\{me\.isAdmin \? handleSpotlight : undefined\}/, "the window: the admin only");
  const ov = read("features/chat/ChatOverlay.tsx", /\);\s*}\s*$/);
  assert.match(ov, /data\.type === "spotlight"\) \{\s*setSpotlight\(data\.spotlight\);/, "the OBS source shows it too");
  assert.match(ov, /spotlight=\{spotlightKey !== null && spotlightKey === `\$\{msg\.platform\}:\$\{msg\.id\}`\}/);
  assert.doesNotMatch(ov, /onSpotlight/, "nobody clicks on stream");
});

test("the admin flag reaches the site column from the server render (StreamView, PopoutView, both pages)", () => {
  const sv = read("components/StreamView.tsx", /ssr: false \}\);\s*$/);
  assert.match(sv, /isAdmin=\{isAdmin\}/);
  const pv = read("components/PopoutView.tsx", /\);\s*}\s*$/);
  assert.match(pv, /isAdmin=\{isAdmin\}/);
  const main = read("(main)/page.tsx", /\);\s*}\s*$/);
  assert.match(main, /isAdmin=\{userCtx\.is_admin\}/);
  const pop = read("popout/page.tsx", /\);\s*}\s*$/);
  assert.match(pop, /isAdmin=\{userMeta\.is_admin\}/);
  const cw = read("features/chat/ChatWindow.tsx", /\);\s*}\s*$/);
  assert.match(cw, /isAdmin: !!d\.isAdmin,/, "the window reads it from /api/me like its mod flag");
});

test("the toggle: a click on the picked row clears, on another row picks it", () => {
  const src = read("lib/useChatSpotlight.ts", /\}, \[current\]\);\s*}\s*$/);
  assert.match(src, /spotlight: current !== null && current === spotlightKeyOf\(\{ platform: msg\.platform, messageId: msg\.id \}\)\s*\? null\s*: \{ platform: msg\.platform, messageId: msg\.id \}/);
  assert.match(src, /postJson\("\/api\/chat\/spotlight"/);
});

// ── the look ────────────────────────────────────────────────────────────────

const msg: ChatMsg = {
  id: 17, platform: "twitch", username: "Bram42", message: "which one",
  isMod: false, isVip: false, isMember: false, ts: 1000,
};
const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(BadgesProvider, null, createElement(ChatMessage, { msg, emotes: {}, ...props })));

test("a picked row wears the highlight card as an overlay layer, header intact", () => {
  const html = render({ spotlight: true });
  assert.match(html, /class="chat-hl-card"/, "the card layer");
  assert.match(html, /--hl-c:var\(--pc-twitch/, "its accent is the platform colour");
  assert.match(html, /data-spot=""/, "a spotlight (not a paid highlight) can be hidden by the viewer");
  assert.match(html, /Bram42/, "the header stays — exactly like a chat message, just with the highlight");
  assert.match(html, /which one/);
});

test("an ordinary row has none of it", () => {
  const html = render({});
  assert.doesNotMatch(html, /chat-hl-card/);
  assert.doesNotMatch(html, /data-spot/);
});

test("a paid highlight shows the card and cannot be hidden by the spotlight switch", () => {
  const html = render({ msg: { ...msg, system: "highlight" } });
  assert.match(html, /class="chat-hl-card"/);
  assert.doesNotMatch(html, /data-spot/);
});

// Chat rows don't shift at all. The card must not change the
// row's box — no margin, padding or rounding classes on the row itself.
test("a highlight never changes the row's own geometry", () => {
  const plain = render({});
  const picked = render({ spotlight: true });
  const rowAttrs = (h: string) => /<div[^>]*chat-msg-row[^>]*>/.exec(h)![0];
  assert.doesNotMatch(rowAttrs(picked), /padding-bottom|mx-1|my-1|rounded-lg/);
  assert.equal(/padding-top:[^;"]*/.exec(rowAttrs(picked))![0], /padding-top:[^;"]*/.exec(rowAttrs(plain))![0]);
});

// The accent became var(--pc-x, #hex) with the platform-colour switch; a hex
// alpha appended to it ("var(...)2b") is invalid CSS and the browser drops the
// whole declaration — that is how the card and the event tint vanished.
test("no colour var ever gets a hex alpha suffix appended", () => {
  const src = readFileSync(join(here, "..", "features", "chat", "ChatMessage.tsx"), "utf8");
  assert.match(src.slice(-200), /\}\s*\)\s*;?\s*$/, "ChatMessage.tsx read whole");
  assert.doesNotMatch(src, /\$\{(indicatorColor|platformColor)\}[0-9a-fA-F]{2}/);
});

test("the row explains itself to the one account that can click it", () => {
  const can = render({ onSpotlight: () => {} });
  assert.match(can, /title="Click to highlight this message for everyone"/);
  assert.match(can, /cursor-pointer/);
  const picked = render({ onSpotlight: () => {}, spotlight: true });
  assert.match(picked, /title="Click again to clear the highlight"/);
  const cannot = render({});
  assert.doesNotMatch(cannot, /Click to highlight/);
});
