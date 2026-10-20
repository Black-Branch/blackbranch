// The /chat window's own look, and one site-wide fix. The window is
// see-through (chatWindow.test.ts), so:
//   1. every username carries the chat shadow — the <button> a name is
//      rendered in resets text-shadow in browsers' form-control styles, so a
//      plain or font-only name would sit flat (site-wide, for everyone)
//   2. emotes are shadowed in the window (the site excludes them on purpose)
//   3. the highlight card's fill is softer in the window (a variable, so the
//      site's card is unchanged)
//   4. a halo on everything — two more FORMS of the Shadow setting, so the
//      window's gear tunes it and its toggle switches all of it off; no
//      shadow here is outside the shadow controls
//   5. the hover bar is glass, through the one glass switch
//
// Run: node --test app/lib/chatWindowLook.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments, stripCssComments } from "./testSource.ts";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
const cssRaw = read("app", "globals.css");
assert.match(cssRaw.slice(-300), /\}\s*$/, "globals.css read whole");
const CSS = stripCssComments(cssRaw).replace(/\s+/g, " ");
const MSG = stripComments(read("app", "features", "chat", "ChatMessage.tsx"));
assert.match(MSG.slice(-200), /\)\s*;?\s*\}\s*\)\s*;?\s*$/, "ChatMessage.tsx read whole");

test("1. a username button inherits the row's shadow — plain and font-only names included", () => {
  assert.match(CSS, /\.chat-msg-header > button, \.chat-msg-row > button\[data-reply-jump\] \{ text-shadow: inherit; \}/);
  // The rule must sit OUTSIDE the .chat-window scope: the bug is everywhere.
  assert.doesNotMatch(CSS, /\.chat-window[^{]*\.chat-msg-header > button/);
});

test("2. emotes take the shadow filter in the window only", () => {
  assert.match(CSS, /\.chat-window \.chat-msg-body \.chat-emote-el \{ filter: var\(--chat-shadow-filter\); \}/);
  // The site's own rule still leaves emotes out (S-12).
  const site = /\.chat-msg-body \.chat-pfp, \.chat-msg-body \.chat-badges \{ filter: var\(--chat-shadow-filter\); \}/.exec(CSS)?.[0];
  assert.ok(site, "the site's filter rule changed shape");
  assert.doesNotMatch(site, /emote/);
});

test("3. the highlight card's fill is a variable — softer in the window, unchanged on the site", () => {
  assert.match(CSS, /\.chat-hl-card \{[^}]*45%\), var\(--chat-card-base\);/);
  assert.doesNotMatch(MSG, /rgba\(12, 16, 28/, "the literal moved to globals.css");
  assert.match(CSS, /:root \{[^}]*--chat-card-base: rgba\(12, 16, 28, 0\.88\);/, "the site keeps the fill it had");
  assert.match(CSS, /\.chat-window \{[^}]*--chat-card-base: rgba\(46, 52, 76, 0\.6\);/, "the window's is lighter and more open");
});

test("4. the window's halo is a form of the Shadow setting — appended, and never a literal of the window's own", () => {
  assert.match(CSS, /\.chat-window \.chat-msg-row, \.chat-window \.chat-msg-body \{ text-shadow: var\(--chat-shadow\), var\(--chat-shadow-halo\); \}/);
  // Pictures take the tight filter form only — no halo form (it would re-run
  // on every frame of every animated picture).
  assert.match(CSS, /\.chat-window \.chat-msg-body \.chat-pfp, \.chat-window \.chat-msg-body \.chat-badges, \.chat-window \.chat-msg-body \.chat-emote-el \{ filter: var\(--chat-shadow-filter\); \}/);
  // A shadow value written inside the window's scope is one the Shadow toggle
  // and sliders cannot reach — which was the bug.
  const scoped = [...CSS.matchAll(/\.chat-window[^{}]*\{([^}]*)\}/g)];
  assert.ok(scoped.length >= 4, "the .chat-window rules changed shape");
  for (const [rule, body] of scoped) {
    for (const decl of (body ?? "").split(";")) {
      const [prop = "", value = ""] = decl.split(/:([^]*)/).map((x) => x.trim());
      if (!/^(text-shadow|box-shadow|filter)$|halo|shadow/.test(prop)) continue;
      // Only the setting's own forms may appear — no radius, colour or
      // drop-shadow() written here.
      assert.match(value, /^(var\(--chat-shadow[\w-]*\)[\s,]*)+$/,
        `a shadow literal inside the window's scope: ${rule}`);
    }
  }
  assert.doesNotMatch(CSS, /--chat-window-halo/);
  // Site rules untouched: the site's text-shadow stays the setting alone.
  assert.match(CSS, /\.chat-msg-row, \.chat-msg-body \{ text-shadow: var\(--chat-shadow\); \}/);
});

test("5. the hover bar is glass through the glass switch — everywhere, the window included", () => {
  assert.match(CSS, /\.row-actions \{[^}]*background: var\(--glass-bg\);[^}]*backdrop-filter: var\(--glass-filter\);/);
});

test("6. the pinned card's text keeps clear of the window's gear — by a corner float, not by narrowing every line", () => {
  assert.match(CSS, /\.chat-window \.pin-row \.chat-msg-body::before \{ content: ""; float: right; width: max\(0px, calc\(27px - 0\.375rem\)\); height: max\(0px, calc\(27px - 0\.25rem\)\); \}/);
  assert.doesNotMatch(CSS, /(?<!\.chat-tabbar-hidden )\.chat-window \.pin-row \{ padding-right/, "a row-wide reservation is back");
  // The folded-tab-bar class sits on <html> and its own .pin-row rule would
  // change the padding the float's arithmetic assumes.
  assert.match(CSS, /\.chat-tabbar-hidden \.chat-window \.pin-row \{ padding-right: 0\.75rem; \}/);
  const banner = stripComments(read("app", "components", "PinnedBanner.tsx"));
  assert.match(banner, /className="pin-row flex items-start gap-2 px-3 py-1\.5"/, "the row padding the arithmetic assumes");
  assert.match(banner, /className="absolute top-0 left-0 right-0 z-10 p-1\.5 /, "…and the card inset");
  // The terms that 28px comes from: a w-7 gear, 0.5rem in, counter-scaled by
  // the factor the root font size carries. The gear itself lives in the
  // shared OverlaySettingsPanel (one copy for the window and the OBS
  // overlay); ChatWindow.tsx keeps only the ?scale= sizing.
  const win = stripComments(read("app", "features", "chat", "ChatWindow.tsx"));
  assert.match(win, /document\.documentElement\.style\.fontSize = `\$\{scaleFactor \* 16\}px`;/);
  const panel = stripComments(read("app", "features", "chat", "OverlaySettingsPanel.tsx"));
  assert.match(panel, /className="overlay-gear fixed top-2 right-2 z-\(--z-popout\)"/);
  assert.match(panel, /style=\{\{ transform: `scale\(\$\{1 \/ scaleFactor\}\)`, transformOrigin: "top right" \}\}/);
  const gear = /<button(?:(?!<\/button>)[\s\S])*?aria-label="Chat settings"(?:(?!<\/button>)[\s\S])*?<\/button>/.exec(panel)?.[0] ?? "";
  assert.match(gear, /\bw-7 h-7\b/, "the gear changed size — the 27px terms in globals.css are derived from it");
});

test("the scope class is on the window's root and nowhere else", () => {
  const win = stripComments(read("app", "features", "chat", "ChatWindow.tsx"));
  assert.match(win, /className="chat-window relative h-screen/);
  for (const f of ["ChatSidebar.tsx", "ChatOverlay.tsx"]) {
    assert.doesNotMatch(stripComments(read("app", "features", "chat", f)), /chat-window/, `${f} must not opt in`);
  }
});
