// Source scan: StreamView applies the visit rule once on mount, from the
// server's isLive, through the existing fold/panel paths — and the live edge
// now unfolds the chat as well as the player. (StreamView has no mount
// harness — it needs the status poll, the players and the chat feature.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../lib/testSource.ts";

const view = stripComments(readFileSync(join(process.cwd(), "app/components/StreamView.tsx"), "utf8"));
const sidebar = stripComments(readFileSync(join(process.cwd(), "app/features/chat/ChatSidebar.tsx"), "utf8"));

test("the first paint is already the visit's shape: nothing stored seeds from isLive, on the server and the client alike", () => {
  // The pinned `const folded = parsePlayerMode(storedMode) === "none";` stays; `storedMode` is now the seeded read.
  assert.match(view, /const \[storedModeRaw, setStoredMode\] = useLocalStorageString\(PLAYER_MODE_KEY\);/);
  assert.match(view, /const storedMode = storedModeRaw \?\? \(isLive \? null : "none"\);/);
  assert.match(view, /const folded = parsePlayerMode\(storedMode\) === "none";/);
  assert.match(view, /usePanelResize\(\{ rootRef, narrow, defaultMode: isLive \? "normal" : "chatFolded" \}\)/);
});

test("the visit rule runs once, BEFORE paint, from the server's isLive and the seeded modes, and applies every part", () => {
  assert.match(view, /useLayoutEffect\(\(\) => \{\s*if \(visitRan\.current\) return;/);
  // Both stored modes are read from STORAGE, not the hook: in the hydration
  // commit useSyncExternalStore still answers with the server snapshot (null →
  // the seeded "none"), so a hook-read rule would see "already folded" and leave
  // a stored unfolded player open on an offline desktop visit.
  assert.match(view, /const v = foldForVisit\(\{ live: isLive, narrow: narrowViewportNow\(\), storedPlayerMode: lsGet\(PLAYER_MODE_KEY\) \?\? storedMode, storedPanelMode: lsGet\("panelMode"\) \?\? \(isLive \? null : "chatFolded"\) \}\);/);
  // A fold applied before paint has nothing to animate, so no armFold: the player is simply never mounted.
  assert.match(view, /if \(v\.player === "fold"\) setStoredMode\("none"\);/);
  assert.doesNotMatch(view, /if \(v\.player === "fold"\) \{ armFold\(\);/);
  assert.match(view, /else if \(v\.player === "unfold"\) setStoredMode\(modeForTab\(isLive \? "live" : offlineTab\)\);/);
  assert.match(view, /if \(v\.chat !== null\) applyMode\(v\.chat\);/);
  assert.match(view, /if \(v\.openHome\) \{\s*if \(!narrowViewportNow\(\)\) setDockTabRaw\(writeDockTab\("home"\)\);\s*window\.dispatchEvent\(new Event\(OPEN_HOME_EVENT\)\);\s*\}/);
  // Once: a ref guard at the top and honest deps at the bottom; the pinned live-edge line untouched.
  assert.match(view, /if \(visitRan\.current\) return;\s*visitRan\.current = true;\s*const v = foldForVisit\(/);
  assert.match(view, /\}, \[isLive, storedMode, setStoredMode, applyMode, setDockTabRaw, offlineTab\]\);/);
  assert.match(view, /if \(folded && live && !prevLiveRef\.current\) setStoredMode\(modeForTab\(tab\)\);/);
});

test("the live edge unfolds the chat on desktop and opens Live on the phone", () => {
  assert.match(view, /if \(live && !prevLiveChatRef\.current\) \{\s*if \(!narrow && panelMode === "chatFolded"\) applyMode\("normal"\);\s*window\.dispatchEvent\(new Event\(OPEN_LIVE_EVENT\)\);\s*\}/);
  assert.match(view, /prevLiveChatRef\.current = live;/);
  assert.match(view, /\{ ssr: false \}\);\s*$/); // END anchor
});

test("picking a VOD from a folded player pulls it down — on a phone too, where the row could otherwise only highlight", () => {
  assert.match(view, /const pickVod = \(v: Vod\) => \{\s*setSelectedVod\(v\);\s*setTab\("replay"\);\s*if \(folded\) setStoredMode\(modeForTab\("replay"\)\);\s*\};/);
});

test("the phone pane answers both events, and only on a phone", () => {
  // A LAYOUT effect: StreamView dispatches OPEN_HOME_EVENT from its own
  // layout effect, and a child's layout effects run before the parent's while
  // a child's PASSIVE effects run after — a passive listener here misses the
  // mount-time dispatch and the phone opens on Live.
  assert.match(sidebar, /useLayoutEffect\(\(\) => \{\s*const onOpenHome = /);
  assert.match(sidebar, /window\.addEventListener\(OPEN_HOME_EVENT, onOpenHome\)/);
  assert.match(sidebar, /const onOpenHome = \(\) => \{ if \(narrowViewportNow\(\)\) selectPaneRef\.current\("home"\); \};/);
  assert.match(sidebar, /useEffect\(\(\) => \{ selectPaneRef\.current = selectPane; \}\);/, "the latest-value ref is written in an effect, never during render");
  assert.match(sidebar, /window\.addEventListener\(OPEN_LIVE_EVENT, onOpenLive\)/);
  assert.match(sidebar, /const onOpenLive = \(\) => \{ if \(narrowViewportNow\(\)\) selectPaneRef\.current\("live"\); \};/);
  assert.match(sidebar, /window\.removeEventListener\(OPEN_HOME_EVENT, onOpenHome\)/);
  assert.match(sidebar, /window\.removeEventListener\(OPEN_LIVE_EVENT, onOpenLive\)/);
});

test("each host arms Home once under its OWN flag — a narrow first load must not spend the dock's arm", () => {
  const dock = stripComments(readFileSync(join(process.cwd(), "app/components/BottomDock/index.tsx"), "utf8"));
  assert.match(dock, /useLocalStorageString\(armFlagKey\("home", "dock"\)\)/);
  assert.match(sidebar, /useLocalStorageString\(armFlagKey\("home", "chat"\)\)/);
});
