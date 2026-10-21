// The chat panel's top Bar — Live / Matrix (+ mobile content tabs) as
// Sections in a band, the compact toggle leading, split / + / community
// trailing. Replaces chatTabBarLayering.test.ts (its subject, the unlayered
// `.chat-tabbar` position/z-index rules, is gone: chrome.css is layered).
// Run: node --test app/features/chat/chatTabBar.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments, stripCssComments } from "../../lib/testSource.ts";

const read = (...p: string[]) => stripComments(readFileSync(join(process.cwd(), ...p), "utf8"));

test("the tab bar is a band Bar; Live/Matrix/content tabs are ONE Sections; the keyboard fold occludes, not hides", () => {
  const src = read("app", "features", "chat", "ChatTabBar.tsx");
  assert.match(src, /import \{ Bar, BarButton, Panes, Sections, type TabItem \} from "@\/app\/components\/chrome"/);
  assert.match(src, /<Bar\s+slot="top"\s+name="chat-top"\s+band\s+overlay=\{compactOverlay\}\s+occluded=\{foldForKeyboard\}/);
  assert.match(src, /const foldForKeyboard = keyboardOpen && !compactOverlay;/, "never fold the desktop overlay");
  assert.match(src, /<Sections[^>]*label="Chat sections"[^>]*onClose=\{/, "the ✕ on a content tab closes it");
  assert.match(src, /split \?[\s\S]{0,80}<Panes/, "split view renders pane headers, not the retired expander buttons");
  assert.doesNotMatch(src, /flex-1 font-medium text-body-dim hover:text-strong transition-colors inline-flex/, "the old expander skin is gone");
  assert.doesNotMatch(src, /chat-tabbar|chat-tab-btn|collapse-row|min-h-9|peer-hover|role="tab"|aria-current/, "the old skin is gone");
  // Mobile compact DOES hide the bar for real (the reveal-swipe brings it
  // back).
  assert.match(src, /mobileHidden: boolean;/, "the mobileHidden prop is gone from the bar's contract");
  assert.match(src, /hidden=\{mobileHidden\}/, "mobileHidden no longer reaches Bar's own hidden prop");
  // The toggle itself is still reachable on mobile —
  // wired, and never conditioned away from narrow — because once the bar is
  // revealed (by a swipe, the linger, or the flip itself) it is still the tap
  // exit back to normal view.
  assert.match(src, /onClick=\{onToggleCompact\}/, "the bar's compact toggle is wired");
  assert.doesNotMatch(src, /!narrow && onToggleCompact|onToggleCompact && !narrow/, "the compact toggle must exist on mobile too — it is the only way back, reachable once revealed");
  assert.match(src, /\/>\s*\);\s*\}\s*$/, "vacuity anchor");
});

test("pager plumbing: progress reaches Sections, and a click delegates to the pager — latching Matrix BEFORE the approach", () => {
  // `progress` is the Sections binding; the bar is the only thing that can
  // hand it over, so a silently-dropped prop would leave the cap animating
  // from the committed tab while a finger dragged the row — two motions where
  // there should be one.
  const src = read("app", "features", "chat", "ChatTabBar.tsx");
  assert.match(src, /<Sections[^>]*progress=\{progress\}/, "progress is not passed through to Sections");
  // The delegation, and the one thing that must NOT wait for the settle: a
  // CLICK into Matrix latches `matrixOpened` up front so the pane is real
  // while it slides in. A swipe that only approaches must never latch — that
  // guard lives in ChatSidebar's row (chatPager.test.ts pins it there).
  assert.match(
    src,
    /if \(requestPane\) \{\s*if \(k === "matrix"\) setMatrixOpened\(true\);\s*requestPane\(k\);\s*return;\s*\}/,
    "the pager delegation is gone, or a click into Matrix no longer latches before the smooth approach",
  );
  // …and the direct path survives underneath it, for every host that has no
  // pager (desktop, split, the popout): dropping it would strand those clicks.
  // It is the HOST's `selectPane`, handed down — never a copy of the commit
  // body here (a copy would make "one spelling of open-a-pane" false).
  assert.match(src, /\}\s*selectPane\(k\);\s*\};/, "the pager-less click path no longer calls the host's selectPane");
  assert.doesNotMatch(src, /setContentTab\(null\); setTab\(/, "the commit body was re-spelled in the bar again");
});

test("the compact toggle stays reachable while folded — FoldedTabControl is Sections in floating density", () => {
  const pill = read("app", "components", "FoldedTabControl.tsx");
  // BarButton is the universal bar button style.
  assert.match(pill, /import \{ BarButton, Sections, type TabItem \} from "@\/app\/components\/chrome"/);
  assert.match(pill, /<Sections[^>]*density="floating"/);
  assert.match(pill, /data-folded-ctl/, "the off-switch hook is a data attribute, not a chrome class");
  assert.doesNotMatch(pill, /chat-folded-ctl|bg-surface-4 text-strong/, "the pill skin is gone");
  assert.match(pill, /onClick=\{onToggleCompact\}/, "the pill's compact toggle is wired, not merely named");
  assert.match(pill, /<\/div>\s*\);\s*\}\s*$/, "vacuity anchor");
  const sidebar = read("app", "features", "chat", "ChatSidebar.tsx");
  assert.match(sidebar, /<FoldedTabControl[\s\S]*?onToggleCompact=\{onToggleCompact\}[\s\S]*?\/>/);
});

test("the fold setting and the folded-pill inset key on [data-bar], not on a chrome class", () => {
  // stripCssComments from the shared helper, NOT a local block-comment regex —
  // sixteen diverging private copies is how this last went wrong, and
  // testSource.test.ts refuses a new one anywhere under app/.
  const css = stripCssComments(readFileSync(join(process.cwd(), "app", "globals.css"), "utf8"));
  assert.match(css, /\.chat-tabbar-hidden \[data-bar="chat-top"\]\s*\{\s*display:\s*none !important;\s*\}/);
  // "Floating controls when folded" setting removed (settings reorg part 1,
  // task 3) — the pill now always shows while folded, so its off-switch rule
  // is gone. The pill itself ([data-folded-ctl]) stays.
  assert.doesNotMatch(css, /\.folded-ctl-off/, "the removed setting's off-switch rule must not survive");
  assert.doesNotMatch(css, /\.chat-tabbar(?!-hidden)/, "no .chat-tabbar rule survives");
  assert.doesNotMatch(css, /\.chat-folded-ctl/);
});

test("the console's button sits in the trailing lane before the fold arrow, under Settings › Behavior › Terminal › Terminal button, only when the install has a console", () => {
  const src = read("app/features/chat", "ChatTabBar.tsx");
  assert.match(src, /import \{ CHAT_CONSOLE \} from "@\/app\/lib\/plugins\/chat"/);
  assert.match(src, /import \{ useSetting \} from "@\/app\/lib\/useSetting"/);
  // On by default: an unset setting (null) shows it; only an explicit "0" hides it — and never
  // without a console to toggle.
  assert.match(src, /const termSetting = useSetting\("chatStyle_termButton"\);\s*const termButton = !!CHAT_CONSOLE && termSetting !== "0";/);
  const btn = /\{termButton && CHAT_CONSOLE && \(\s*<BarButton icon=\{<CHAT_CONSOLE\.button\.Icon size=\{13\} weight="bold" \/>\} label=\{CHAT_CONSOLE\.button\.label\} onClick=\{CHAT_CONSOLE\.toggle\} \/>\s*\)\}/.exec(src);
  assert.ok(btn, "the button, a BarButton like its neighbours");
  const fold = src.indexOf("{onFoldChat && (");
  assert.ok(fold > 0 && btn!.index < fold, "before the fold arrow, next to the fold button");
  assert.match(src, /const hasTrailing =\s*\(!split && narrow && unarmedTabs\.length > 0\) \|\| \(!split && splitAvailable\) \|\| !!onToggleFull \|\| !!onFoldChat \|\| termButton;/,
    "the lane exists when the button is the only thing in it");
  const reg = read("app/lib", "settingsRegistry.ts");
  assert.match(reg, /termButton: E\(\{ ls: "chatStyle_termButton", prePaint: false, deviceLocal: true, behavior: true,\s*serialize: ser1, parse: bool1,/);
  assert.match(reg, /control: \{ kind: "toggle", label: "Terminal button" \}/);
  assert.match(reg, /termButton:\s+true,/, "on by default");
  assert.match(src, /\/>\s*\);\s*\}\s*$/, "vacuity anchor");
});
