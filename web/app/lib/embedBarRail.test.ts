// The video panel's top bar is the mode RAIL, and folding is a real state.
//
// Source scans, because the failures being pinned are structural: a widget
// re-appearing in the bar, a mount condition going missing, a persisted key
// stopping being read. Comments are stripped first — this file and the bar's
// own header both NAME the things that must be gone (OFFLINE, the LIVE pill,
// StreamTimerIndicator), and a header sentence is not a mount. Each scan ends
// with an anchor on the END of the file, so a truncated read cannot make a
// negative assertion vacuous.
//
// Run: node --test --experimental-strip-types app/lib/embedBarRail.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./testSource.ts";

const read = (p: string) => stripComments(readFileSync(new URL(p, import.meta.url), "utf8"));
const bar = read("../components/StreamEmbedBar.tsx");
const view = read("../components/StreamView.tsx");

test("the top bar is wordmark · IconRail · cluster; the removed things are gone", () => {
  // BarButton comes through the same import.
  assert.match(bar, /import \{ Bar, BarButton, IconRail \} from "@\/app\/components\/chrome"/);
  assert.match(bar, /<IconRail/);
  assert.doesNotMatch(bar, /StreamTimerIndicator/);
  assert.doesNotMatch(bar, /OFFLINE/);
  assert.doesNotMatch(bar, /animate-pulse|>LIVE</);
  assert.doesNotMatch(bar, /onJumpToLive|Jump to live/);
  assert.doesNotMatch(bar, /communitySources|setCommunityPlatform|display_name/);
  assert.doesNotMatch(bar, /<svg/);            // the theatre glyph is a Phosphor icon now
  // The fold arrow is a BarButton now — its accessible name comes through
  // `label`, which BarButton (BarButton.tsx) maps straight onto aria-label.
  assert.match(bar, /label=\{folded \? "Unfold player" : "Fold player"\}/);
  assert.match(bar, /\}\s*$/);
});

test("the rail's items are derived, not hand-built: one per rail mode (built-ins + registered fallbacks), tone from railTone", () => {
  assert.match(bar, /railModes\(fallbackIds\)\.map\(/);
  assert.match(bar, /tone: tones\[m\] \?\? "off"/);
  assert.match(bar, /hasMenu: modeHasMenu\(m, \{ communityPlatforms:/);
  assert.match(bar, /<StreamModeMenu/);
  // Only the sources that are on (the Stream tab's embed switches), and no menu over one left.
  assert.match(bar, /liveOptions\(liveSource, liveOn\)/);
  assert.match(bar, /menuOpen && active === "live" && liveOn\.length > 1 &&/);
  assert.match(bar, /modeHasMenu\(m, \{ communityPlatforms: communityPlatforms\.length, liveSources: liveOn\.length \}\)/);
  // Community's dropdown is the platform dots' capability, not a new one: the
  // featured streamer's YouTube-vs-Twitch choice has to survive the widget.
  assert.match(bar, /communityOptions\(communityPlatforms, communityPlatform\)/);
  // …and it opens under the SAME condition modeHasMenu gives the caret. `menuFor`
  // outlives a change in the featured streamer, so a menu opened over two
  // platforms would otherwise stay open, one-row and inert, when the poll drops
  // to one.
  assert.match(bar, /menuOpen && active === "community" && communityPlatforms\.length > 1 &&/);
  // The rail is CONTROLLED by the derived mode: without `value`, useTabList's
  // selection would drift from the tab the going-live edge or a fold just moved.
  assert.match(bar, /<IconRail[\s\S]{0,200}\bvalue=\{active\}/);
});

test("fold = player_mode 'none': player and bottom bar unmount, the top bar stays", () => {
  assert.match(view, /useLocalStorageString\(PLAYER_MODE_KEY\)/);
  assert.match(view, /const folded = parsePlayerMode\(storedMode\) === "none";/);
  // The player does not unmount in the same commit as the fold —
  // it collapses over a transition and stays mounted until that transition
  // ends. The REGION is unconditional (an element that remounts on unfold has
  // no prior value to transition FROM); the player is what comes and goes, from
  // inside it. foldAnimation.test.ts pins that nesting and
  // usePlayerFold.render.test.ts runs the lifecycle.
  assert.match(view, /<div\s+className="player-fold-region"[\s\S]{0,200}\{\(!folded \|\| playerMounted\) && \(\s*<StreamPlayerArea/);
  assert.match(view, /\{!folded && \(\s*<StreamMetaBar/);
  assert.match(view, /playerPanelClass\(\{ folded, fallbackClass: currentFallback\?\.panelClass \?\? null, fillMode \}\)/, "the folded class comes from the helper, which KEEPS the mode class (playerPanelClass.test.ts)");
  // A folded frame is exactly its top bar, so that bar must stay IN FLOW —
  // theatre/compact's `overlay: true` would make it absolute over an empty
  // frame. Overridden here, never inside barVisibility.
  assert.match(view, /const bars: BarVisibility = folded\s*\?\s*\{ overlay: false, topHidden: false, bottomHidden: false, barsInFlow: true \}/);
  // The phone's drag-up is the fold, not the column collapse.
  assert.match(view, /onToggleFull=\{narrow \? toggleFold : \(\) => applyMode\(panelMode === "full" \? "normal" : "full"\)\}/);
  assert.match(view, /isFull=\{narrow \? folded : panelMode === "full"\}/);
  // The streamer going live unfolds.
  assert.match(view, /if \(folded && live && !prevLiveRef\.current\) setStoredMode\(modeForTab\(tab\)\);/);
  assert.match(view, /\}\);\s*$/);
});

test("the timer is kept, parked, and mounted nowhere in production", () => {
  const timer = readFileSync(new URL("../components/StreamTimerIndicator.tsx", import.meta.url), "utf8");
  assert.match(timer, /@parked/);
  assert.doesNotMatch(bar + view, /StreamTimerIndicator/);
});

test("the rail's wrapper is the width-pressure container: the rail's @container tiers (chrome.css) query THIS box", () => {
  // `@container` makes the wrapper a size container; `flex-1` is what gives a
  // contained flex item its width at all — inline-size containment zeroes its
  // content contribution, so without it the wrapper (and so the container the
  // rail measures against) would be 0px wide. A container query cannot match
  // its own container, which is why this lives on the wrapper and not on
  // .chrome-iconrail itself.
  // Read as class TOKENS, wherever they sit in the list: `@container` exactly (a named
  // `@container/x` is another container) and `flex-1`.
  const wrapperClasses = /<div ref=\{railRef\} className="([^"]*)"/.exec(bar)?.[1]?.split(/\s+/) ?? [];
  assert.ok(wrapperClasses.includes("@container"), `the rail wrapper is a size container: ${wrapperClasses.join(" ")}`);
  assert.ok(wrapperClasses.includes("flex-1"), `the rail wrapper has a width: ${wrapperClasses.join(" ")}`);
  // …and precisely because it is flex-1 (spanning the empty bar), the menu's
  // outside-click anchor is the RAIL's own box inside it, never the wrapper:
  // anchored to the wrapper, a press in the empty stretch kept the menu open.
  assert.match(bar, /<div ref=\{railAnchorRef\} className="flex items-center min-w-0">\s*<IconRail/, "the rail has its own anchor box");
  assert.equal((bar.match(/anchorRef=\{railAnchorRef\}/g) ?? []).length, 2, "both menus anchor to the rail box");
  assert.doesNotMatch(bar, /anchorRef=\{railRef\}/, "no menu anchors to the container");
  assert.match(bar, /\}\s*$/);
});

