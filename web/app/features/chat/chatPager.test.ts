// The outer pager's wiring in ChatSidebar: on narrow the
// chat panel's middle becomes ONE horizontal scroll-snap row whose children are
// `[live, matrix, …armed content tabs]`, driven by usePanePager; desktop and
// split keep the pair-plus-siblings DOM.
//
// ── Why this file is a SOURCE SCAN, and what covers the rest ──────────────────
// The chat feature has no full-mount precedent and cannot cheaply grow one:
// ChatSidebar needs the Matrix client context, a live WebSocket and a
// `next/dynamic` chunk before it renders a single row. Three cheaper options
// were weighed and rejected:
//   1. Extracting the row into a small presentational component to render in
//      isolation. Rejected: the row carries the registry's literal per-key
//      render guards, and tabRegistry.test.ts's census pins those to
//      ChatSidebar.tsx by path — moving them splits a one-file contract to buy
//      a partial fixture.
//   2. Mounting ChatTabBar (which would exercise the click-latch for real).
//      Blocked by the harness, not by the component: testTsx.ts's resolver
//      handles "@/…" and relative specifiers but has no directory/index
//      resolution, and ChatTabBar imports the chrome BARREL
//      (`@/app/components/chrome`). Teaching the resolver `<dir>/index` is a
//      small, additive change — worth doing when a mount is actually needed.
//   3. Asserting the row's behaviour through a rebuilt copy of it. Rejected on
//      the standing rule (testDom.ts's header): a hand-rebuilt tree asserts
//      against a copy, which is how every line can be present and correct while
//      the behaviour is wrong.
// The pager's BEHAVIOUR is proven against a real DOM one layer down:
// usePanePager.render.test.ts mounts a real scroller and pins that a settle
// commits, that an approach does not, that teardown closes hot state out, and
// that an external activeKey change re-syncs silently. What only this file can
// see is the wiring: that ChatSidebar hands that hook the right keys, forks the
// middle on it, and keeps the mount guards literal.
//
// Run: node --test app/features/chat/chatPager.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../lib/testSource.ts";

const read = (...p: string[]) => stripComments(readFileSync(join(process.cwd(), ...p), "utf8"));

const SIDEBAR = read("app", "features", "chat", "ChatSidebar.tsx");
const TABBAR = read("app", "features", "chat", "ChatTabBar.tsx");
const REGISTRY = readFileSync(join(process.cwd(), "app", "lib", "tabRegistry.ts"), "utf8");

test("the pager owns the middle only on narrow AND unsplit — off it, the pair wrapper is the one that was already there", () => {
  assert.match(SIDEBAR, /const pagerOn = !!narrow && !split;/,
    "the pager's enable term is gone or has changed shape");
  // `!split` is load-bearing, not defensive. narrow is <768px and split
  // needs a >=640px panel, so the two OVERLAP in a 640–767px band (a landscape
  // phone, a small tablet): without the term the pager would take the middle
  // there and the split pair would never render.
  assert.match(
    SIDEBAR,
    /ref=\{pagerScrollerRef\}\s*className=\{\s*pagerOn\s*\?\s*"flex flex-1 min-h-0 overflow-x-auto overflow-y-hidden snap-x snap-mandatory overscroll-x-contain no-scrollbar"\s*:\s*`flex flex-1 min-h-0 \$\{contentTab !== null \? "hidden" : ""\}`/,
    "the middle's two skins are gone or changed — check overscroll-x-contain (a rubber-band must not become a history nav), overflow-y-hidden (each pane owns its own vertical scroll), and the pair wrapper's content-tab cover",
  );
  // Exactly one snap row in the file: off the pager the middle must render no
  // pager DOM at all.
  assert.equal((SIDEBAR.match(/snap-x/g) ?? []).length, 1, "more than one snap row, or none");
  assert.match(SIDEBAR, /matrixVisible \? "flex flex-col flex-1 min-h-0 min-w-0" : "hidden"/,
    "the non-pager skin lost the matrix column's own visibility logic");
});

test("the middle is ONE element in TWO skins — a second element here remounts the column and eats a draft", () => {
  // The defect this file exists to keep fixed. React reconciles by
  // position AND shape: `pagerOn ? <div…> : <div…>` where one side is a keyed
  // child LIST and the other is static children is a SHAPE change, so the whole
  // column unmounted on every flip — and `narrow`/`split` both flip in normal
  // use (rotating a phone across 767px; toggling split in the 640–767px band).
  // A remount throws away a half-typed ChatInput draft and MatrixView's list
  // anchor, state that survived pre-5d because these were className swaps.
  assert.doesNotMatch(SIDEBAR, /\{pagerOn \? \(/,
    "the middle forks into two elements again — that is a remount on every rotation");
  // The two heavy children keep stable, MATCHING keys across the flip. There is
  // deliberately only ONE spelling of each (one element, two skins), so they
  // cannot drift apart the way two branches could.
  assert.equal((SIDEBAR.match(/key="live"/g) ?? []).length, 1,
    "the live column's key is gone (or duplicated) — without it the draft dies on rotation");
  assert.equal((SIDEBAR.match(/key="matrix"/g) ?? []).length, 1,
    "the matrix pane's key is gone (or duplicated) — without it MatrixView remounts on rotation");
  assert.match(SIDEBAR, /key="divider"/, "the split divider lost its key");
  // The depth invariant: under the pager the live column IS the pane slot.
  // Wrapping it in a pane div on one side of the flip and not the other puts an
  // extra tree level under the container on one side, and every key below it
  // then reconciles against a different parent — a remount by another route.
  assert.match(SIDEBAR, /pagerOn\s*\?\s*`\$\{PANE_SLOT\} relative`/,
    "the live column no longer wears the pane slot itself — check for a wrapper around it");
  assert.equal((SIDEBAR.match(/PANE_SLOT/g) ?? []).length, 5,
    "the pane-slot geometry has a new (or lost a) wearer — there are exactly four slots (leading, live, matrix, rest) plus the const");
  // The container's first child is the live column, unwrapped.
  assert.equal((SIDEBAR.match(/\{liveColumnEl\}/g) ?? []).length, 1,
    "the live column is rendered from more than one place — only one can be the reconciled slot");
});

test("ONE ordered key list feeds both the bar's items and the row's children — order equality by construction", () => {
  // Two parallel arrays kept in step by hand is the failure this shape exists
  // to make impossible: a fractional `progress` is an index into the BAR's
  // items and is read as an index into the ROW's panes, so a single element of
  // drift points the indicator at the wrong tab for the whole gesture.
  assert.match(
    SIDEBAR,
    /const paneKeys: ChatTabKey\[\] = \[\s*\.\.\.leadingTabs\.map\(\(t\) => t\.key\), "live", "matrix", \.\.\.restTabs\.map\(\(t\) => t\.key\),\s*\];/,
    "paneKeys is no longer leading · live · matrix · rest in that one order (Home leads)",
  );
  // The bar derives its own row from the SAME prop, in the SAME order.
  assert.match(
    TABBAR,
    /leadingTabs\.map\(\(t\) => \(\{ key: t\.key[^]{0,120}\{ key: "live",[^]{0,120}\{ key: "matrix",[^]{0,200}restTabs\.map\(\(t\) => \(\{ key: t\.key/,
    "ChatTabBar's items no longer read leading · live · matrix · rest in that order (Home leads)",
  );
  // Both lists are handed the same `contentTabs` value.
  assert.match(SIDEBAR, /contentTabs=\{contentTabs\}/, "the bar is fed a different list than the row");
});

test("the panes are native scroll-snap slots: one pane per swipe, geometry held whether or not the content is mounted", () => {
  assert.match(
    SIDEBAR,
    /const PANE_SLOT = "w-full shrink-0 snap-start snap-always flex flex-col min-h-0 min-w-0";/,
    "a pane slot lost its width or its snap stop — snap-always is what makes every settle adjacent",
  );
  // The geometry is on the SLOT, not on any content, so an unmounted content
  // pane is still a pane-width spacer and the scroller never shifts under a
  // gesture. The content panes are mapped, so a newly armed tab gets one too.
  assert.match(SIDEBAR, /pagerOn && restTabs\.map\(\(\{ key: k \}\) => \(\s*<div key=\{k\} inert=\{k !== activePane\} className=\{`\$\{PANE_SLOT\} relative`\}>/,
    "the content panes are no longer one mapped slot per armed tab — an unmounted slot would collapse the row");
});

test("inert is a REST state — the committed pane, never a mid-gesture value, and never off the pager", () => {
  // `activePane` is committed state (contentTab ?? tab), so it does not move
  // until a settle: no inert churn mid-gesture, and no occluded-but-focusable
  // pane at rest (the a11y class of bug this pre-answers). Off the pager every
  // term is `false`, so React writes no attribute at all — the pair wrapper's
  // hidden columns must not become inert as a side effect of 5d.
  assert.match(SIDEBAR, /const activePane: ChatTabKey = contentTab \?\? tab;/);
  assert.match(SIDEBAR, /inert=\{pagerOn && activePane !== "live"\}/, "the live pane's inert term changed");
  assert.match(SIDEBAR, /inert=\{pagerOn && activePane !== "matrix"\}/, "the matrix pane's inert term changed");
  assert.match(SIDEBAR, /inert=\{k !== activePane\}/, "the content panes' inert term changed");
  assert.doesNotMatch(SIDEBAR, /inert=\{[^}]*(?:pagerProgress|paneMounted)/,
    "inert is being driven off the live gesture — that churns the tree on every frame of a pan");
});

test("the Matrix slot latches on a COMMIT or a click, never on an approach", () => {
  // The whole embedded client (matrix-js-sdk + RustCrypto) hangs off this
  // latch. A swipe that merely passes Matrix on its way to News must not start
  // it — so the slot reads the latch and nothing in the middle sets it.
  assert.match(SIDEBAR, /\{matrixOpened \? matrixPanelEl : null\}/,
    "the Matrix slot no longer gates on the matrixOpened latch");
  // Isolate the middle: from the scroller ref to the FoldedTabControl below it.
  const midAt = SIDEBAR.indexOf("ref={pagerScrollerRef}");
  const midEnd = SIDEBAR.indexOf("<FoldedTabControl", midAt);
  assert.ok(midAt !== -1 && midEnd > midAt, "could not isolate the middle");
  assert.ok(!SIDEBAR.slice(midAt, midEnd).includes("setMatrixOpened"),
    "the pager row sets the Matrix latch itself — an approach would start the client");
  // The two paths that legitimately DO latch: a settle (selectPane, which the
  // hook calls through onCommit) and a click (ChatTabBar's delegation).
  assert.match(SIDEBAR, /if \(k === "matrix"\) \{ setContentTab\(null\); setTab\("matrix"\); setMatrixOpened\(true\); return; \}/,
    "selectPane no longer latches Matrix on commit");
  assert.match(TABBAR, /if \(requestPane\) \{\s*if \(k === "matrix"\) setMatrixOpened\(true\);/,
    "a click into Matrix no longer latches before the smooth approach — the pane would slide in empty");
});

test("there is ONE spelling of open-a-pane: the bar is handed selectPane, it does not carry a copy", () => {
  // A bar that re-spells the commit body for its pager-less path makes two
  // copies of "open a pane" — exactly the drift a single commit path prevents.
  assert.match(SIDEBAR, /selectPane=\{selectPane\}/, "the bar is no longer handed the host's commit function");
  assert.match(TABBAR, /selectPane: \(k: ChatTabKey\) => void;/, "the prop is gone from the bar's contract");
  assert.match(TABBAR, /\}\s*selectPane\(k\);\s*\};/, "the bar's fall-through no longer calls selectPane");
  assert.doesNotMatch(TABBAR, /setContentTab\(null\); setTab\(/,
    "the bar carries a second copy of the commit body again");
});

test("every content pane keeps a literal per-key guard, now widened by the approach-mount window", () => {
  // The registry contract's two halves, both literal (tabRegistry.ts): the
  // at-rest guard in the desktop/split branch and the pager row's own. The
  // pager term is `paneMounted(key)` — active always, plus anything within one
  // pane of a live motion — so a passing-through pane mounts transiently and
  // an at-rest one stays dead.
  for (const key of ["news", "vods"]) {
    assert.ok(SIDEBAR.includes(`{k === "${key}" && paneMounted("${key}") && ${key}PaneEl}`),
      `the pager row's ${key} guard is gone or is no longer literal`);
    assert.ok(SIDEBAR.includes(`{!pagerOn && contentTab === "${key}" && ${key}PaneEl}`),
      `the at-rest ${key} guard is gone, or lost its !pagerOn term (a second mount of the same pane while the row already holds one)`);
  }
  // One element per pane, so neither branch can drift from the other and no
  // pane body has a second, unguarded mount point.
  for (const tag of ["<FeedPanel", "<VodList", "<MatrixPanel"]) {
    assert.equal((SIDEBAR.match(new RegExp(tag, "g")) ?? []).length, 1,
      `${tag} has more than one mount point — each one needs its own guard`);
  }
  // The live column, and so every ref inside it, is built exactly once.
  for (const ref of ["ref={liveColRef}", "ref={scrollRef}", "ref={composerRef}"]) {
    assert.equal((SIDEBAR.match(new RegExp(ref.replace(/[{}]/g, "\\$&"), "g")) ?? []).length, 1,
      `${ref} appears twice — the two branches are rendering two live columns`);
  }
  assert.match(SIDEBAR, /pagerOn\s*\?\s*`\$\{PANE_SLOT\} relative`\s*:\s*liveVisible/,
    "the live column applies `liveVisible` under the pager — it would blank the live pane for the whole swipe back from Matrix");
});

test("the hook is wired to the committed state, and the bar is driven only while the pager owns motion", () => {
  assert.match(
    SIDEBAR,
    /usePanePager<ChatTabKey>\(\{\s*keys: paneKeys, activeKey: activePane, enabled: pagerOn,\s*onCommit: selectPane,\s*\}\)/,
    "the pager hook's wiring changed — keys/activeKey/enabled/onCommit are its whole contract (and NO onHotChange: pager motion must not touch the bar)",
  );
  assert.match(SIDEBAR, /progress=\{pagerProgress\}/, "the band no longer tracks a finger");
  assert.match(SIDEBAR, /requestPane=\{pagerOn \? requestPane : undefined\}/,
    "requestPane must be handed over ONLY while the pager owns motion — off it the bar keeps its own direct commit path");
});

test("the registry's mount contract carries the widened rule", () => {
  // Amended WITH the code that consumes it, never after.
  assert.match(REGISTRY, /Registry contract: a tab's content renders while it is the ACTIVE tab, OR/);
  assert.match(REGISTRY, /within ONE pane of the viewport[\s\S]{0,4}\(approach-mount\)/);
  assert.match(REGISTRY, /An APPROACH never latches/);
  assert.match(REGISTRY, /spacer/, "the contract no longer says unmounted slots hold their geometry");
});

test("the compact bar's phone-browser reveal is scroll-direction driven, never pager-motion driven", () => {
  // The pager must not touch the bar AT ALL — a pager-motion reveal
  // re-appears (and flickers) the bar on every pane swipe. `onHotChange`
  // appearing anywhere in this file again means someone re-coupled them.
  assert.doesNotMatch(SIDEBAR, /onHotChange/,
    "pager motion is driving the bar again — a reveal between pages is not allowed");
  // `!!compact`, not bare `compact` — `compact` is optional on this
  // component's props, and ChatTabBar's `mobileHidden` is a REQUIRED
  // boolean, so a leaked `boolean | undefined` here is a tsc red, not just a
  // wrong reveal.
  assert.match(SIDEBAR, /const mobileCompactHidden = pagerOn && !!compact && !barLingerHold;/,
    "the mobile-hide expression changed shape, or dropped its pagerOn/!! terms");
  // The hide must never outrun the reveal. `pagerOn`
  // (not bare `narrow`) is load-bearing — in the 640–767px band narrow and
  // split overlap, and a bare-narrow term would hide the bar where the
  // reveal machinery (gated on the same `barRevealEnabled`) never runs,
  // stranding a compact viewer with an untappable toggle until rotate/reload.
  assert.doesNotMatch(SIDEBAR, /const mobileCompactHidden = !!compact && !!narrow/,
    "the old bare-narrow expression reappeared — it strands compact in the 640-767px split band");
  assert.match(SIDEBAR, /const barRevealEnabled = pagerOn && !!compact;/,
    "the reveal machinery's gate no longer mirrors the hide's — the hide can then outrun the reveal");
  // (+ `composerReplaced`: the bar folds while the chat TUI has the window.)
  assert.match(SIDEBAR, /mobileHidden=\{mobileCompactHidden \|\| composerReplaced\}/,
    "ChatTabBar is no longer handed the mobile-hide boolean");
  assert.match(TABBAR, /mobileHidden: boolean;/, "the prop is gone from the bar's contract");
  assert.match(TABBAR, /hidden=\{mobileHidden\}/, "mobileHidden no longer reaches Bar's own hidden prop");
  // The three reveal triggers, each pinned:
  // (1) scroll direction — the pure accumulator wired up:reveal / down:hide,
  // fed from ONE capture-phase scroll listener on the aside (scroll doesn't
  // bubble; capture descends to every pane's scroller).
  assert.match(SIDEBAR, /createBarScrollReveal\(\{ up: reveal, down: hide \}\)/,
    "the scroll-direction machine is unwired (or its up/down emits swapped)");
  assert.match(SIDEBAR, /addEventListener\("scroll", onScroll, \{ capture: true, passive: true \}\)/,
    "the capture-phase scroll listener is gone — no pane scroll can reach the reveal machine");
  // (2) the no-scroll downward drag (≥24px with no scroll event this touch) —
  // the stranding guard for a pane too short to scroll / already at its top.
  assert.match(SIDEBAR, /if \(sawScroll \|\| revealedThisTouch \|\| touchStartY === null\) return;/,
    "the no-scroll drag fallback lost its guards");
  assert.match(SIDEBAR, /y - touchStartY >= 24/,
    "the no-scroll drag fallback's 24px threshold is gone");
  // (3) scroll-down hides IMMEDIATELY (clear the pending auto-hide first —
  // a stale timer must not resurrect a hide the user just asked for).
  assert.match(SIDEBAR,
    /const hide = \(\) => \{\s*deafUntilTs = performance\.now\(\) \+ 350;\s*if \(barLingerTimerRef\.current !== null\) \{ clearTimeout\(barLingerTimerRef\.current\); barLingerTimerRef\.current = null; \}\s*setBarLingerHold\(false\);\s*\};/,
    "hide no longer deafens + clears the pending auto-hide before dropping the hold");
  // (4) the hover reveal: a vertical monitor
  // runs this same stacked layout with a MOUSE — a non-touch pointer within
  // 48px of the panel top must reveal, or the bar has no mouse support at
  // all there. Touch pointers are excluded (a drag near the top must not
  // double as a reveal — the scroll/drag triggers own touch).
  assert.match(SIDEBAR, /if \(e\.pointerType === "touch"\) return;\s*markInput\(\);\s*if \(hoverRaf\) return;/,
    "the hover reveal lost its touch-exclusion, its input mark, or its rAF throttle");
  assert.match(SIDEBAR, /clientY - r\.top <= 48/,
    "the hover reveal's 48px top strip is gone");
  assert.match(SIDEBAR, /addEventListener\("pointermove", onPointerMove, \{ passive: true \}\)/,
    "the hover reveal's pointermove listener is unwired");
  // (5) the machine hears USER scrolling only — panes scroll THEMSELVES
  // (chat bottom-lock writes down on every message; the inert Matrix
  // timeline's backfill compensates up), and unguarded that would cycle the
  // bar against the auto-hide. Both guards are load-bearing.
  assert.match(SIDEBAR, /if \(t\.closest\("\[inert\]"\)\) return;/,
    "the inert-pane scroll guard is gone — a backfilling hidden pane can reveal the bar out of nowhere");
  assert.match(SIDEBAR, /if \(performance\.now\(\) - lastInputTs > 400\) return;/,
    "the user-input recency guard is gone — the chat bottom-lock's own writes will hide a revealed bar under live chat");
  // (6) every flip deafens the machine for 350ms and voids the current
  // run — the bar's own layout shift echoes through the bottom-lock as an
  // opposite-direction scroll WITHIN the input-recency window, and unguarded
  // that is a sustained reveal/hide oscillator.
  assert.match(SIDEBAR, /if \(performance\.now\(\) < deafUntilTs\) \{ machine\.reset\(\); return; \}/,
    "the post-flip deafness guard is gone — the bar's own layout shift will oscillate it through the bottom-lock");
  // (No reveal at all while the keyboard is up under a top window.)
  assert.match(SIDEBAR, /const reveal = \(\) => \{ if \(topWindowUnderKeyboard\(el\)\) return; deafUntilTs = performance\.now\(\) \+ 350; setBarLingerHold\(true\); armBarLingerTimer\(\); \};/,
    "reveal no longer deafens the machine to its own aftershock");
  assert.match(SIDEBAR, /let deafUntilTs = performance\.now\(\) \+ 350;/,
    "the attach moment (entering compact — itself a layout shift) no longer starts deaf");
});

test("the compact-flip reveal is a render-time adjust (never a yank); the auto-hide is ONE shared BAR_AUTO_HIDE_MS timer", () => {
  // The flip reveal must land in the SAME render as the trigger — a
  // synchronous setState during render, not inside any effect (a layout one
  // included; react-hooks/set-state-in-effect refuses that for the same
  // cascading-render reason this guards against for real: an effect still
  // runs after a hidden frame has already committed once).
  // The previous-value tracker is STATE, never a ref — react-hooks/refs
  // refuses reading or writing `.current` during render, so a ref-based
  // edge-detect (LinkPreview.tsx's `prevUrl` shape) is the only legal form.
  assert.match(
    SIDEBAR,
    /if \(prevCompact !== compact\) \{\s*setPrevCompact\(compact\);\s*if \(!barLingerHold\) setBarLingerHold\(true\);\s*\}/,
    "the compact-flip reveal is no longer a render-time adjust",
  );
  // ONE duration source: the shared constant, imported from the machine's
  // module (which pins its value) — never a second inline literal that can
  // drift.
  assert.equal((SIDEBAR.match(/\}, BAR_AUTO_HIDE_MS\);/g) ?? []).length, 1,
    "the auto-hide timer no longer uses the one shared BAR_AUTO_HIDE_MS constant");
  assert.doesNotMatch(SIDEBAR, /\}, 1200\);|\}, 2000\);/,
    "an inline duration literal crept back in beside the shared constant");
  // The compact-flip ARMING effect skips its MOUNT render — no toggle has
  // been tapped on page load, so it must not schedule a pointless hide-timer
  // before a real trigger fires. Exactly one such guard now (the pager-hot
  // one died with the pager-motion reveal).
  assert.equal(
    (SIDEBAR.match(/if \(!\w+MountedRef\.current\) \{ \w+MountedRef\.current = true; return; \}/g) ?? []).length,
    1,
    "the compact-flip mount-skip guard is gone (or a second arming effect appeared)",
  );
  // The compact flip re-arms the same shared drop from a plain effect — the
  // reveal already landed above, in the render body, so this one only ever
  // schedules the delayed setTimeout (never a synchronous setState itself,
  // which is what keeps it clear of react-hooks/set-state-in-effect).
  assert.match(
    SIDEBAR,
    /useEffect\(\(\) => \{\s*if \(!compactMountedRef\.current\) \{ compactMountedRef\.current = true; return; \}\s*armBarLingerTimer\(\);\s*\}, \[compact, armBarLingerTimer\]\);/,
    "the compact-flip arm is no longer a plain effect keyed on [compact, armBarLingerTimer]",
  );
  // Never leave an armed timer past teardown.
  assert.match(
    SIDEBAR,
    /useEffect\(\(\) => \{\s*return \(\) => \{\s*if \(barLingerTimerRef\.current !== null\) clearTimeout\(barLingerTimerRef\.current\);\s*\};\s*\}, \[\]\);/,
    "the shared linger timer is no longer cleared on unmount",
  );
});

test("the pager: `.chat-scroll-layer` trades the both-axes overscroll-contain for overscroll-y-contain, so a horizontal pan chains into the pager", () => {
  // Per CSS spec, `overflow-x-clip` with
  // `overflow-y-auto` computes overflow-x to `hidden`, so this element IS a
  // horizontal scroll container; `overscroll-behavior-x: contain` blocks
  // scroll-CHAINING on that axis even with zero scrollable range. The bare
  // `overscroll-contain` utility sets BOTH axes, so it would silently eat every
  // horizontal pan starting over chat content: the layer neither scrolls (not
  // user-scrollable) nor chains to the pager row above it — the pan dies.
  // `overscroll-y-contain` keeps the vertical containment this class exists
  // for (stop chat overscroll chaining into the page) while freeing the
  // horizontal axis to chain. `overflow-x-clip` stays untouched (the
  // boosted-sticker sideways-drift fix); only chaining changes, the layer
  // is still not user-scrollable horizontally.
  assert.match(
    SIDEBAR,
    /chat-scroll-layer flex-1 overflow-y-auto overflow-x-clip overscroll-y-contain pt-1 pb-2 no-scrollbar/,
    "the chat-scroll-layer class string changed shape — re-check overflow-x-clip (no sideways drag) and overscroll-y-contain (the pager's pan) are both still there",
  );
  // The bare, both-axes utility must be gone from the whole file. Token-
  // boundary matched so `overscroll-x-contain` (the outer pager row's own,
  // correct, axis-scoped class two skins up) and `overscroll-y-contain` do
  // not fool the assertion — neither contains "overscroll-contain" as a
  // standalone token.
  assert.doesNotMatch(
    SIDEBAR,
    /(?:^|[\s"'`])overscroll-contain(?:[\s"'`]|$)/,
    "a bare, both-axes `overscroll-contain` reappeared in ChatSidebar.tsx — on a pane-internal scroller it silently eats the pager's horizontal pan (clip+auto computes to hidden, and contain blocks chaining even with no scrollable range)",
  );
});

test("vacuity anchor — the sidebar was read whole", () => {
  // Every negative assertion above is a claim about the WHOLE file; a truncated
  // read would make each of them pass over a hole.
  assert.match(SIDEBAR, /<\/aside>\s*\);\s*\}\s*$/, "vacuity anchor");
  assert.match(TABBAR, /\/>\s*\);\s*\}\s*$/, "vacuity anchor");
});

test("Home leads: paneKeys puts the leading content tabs BEFORE live/matrix, and the bar splits the same way", () => {
  assert.match(SIDEBAR, /const \{ leading: leadingTabs, rest: restTabs \} = splitLeading\(contentTabs\);/);
  assert.match(SIDEBAR, /const paneKeys: ChatTabKey\[\] = \[\s*\.\.\.leadingTabs\.map\(\(t\) => t\.key\), "live", "matrix", \.\.\.restTabs\.map\(\(t\) => t\.key\),\s*\];/);
  // The DOM order must match: the leading map renders above the live column.
  const leadingAt = SIDEBAR.indexOf("pagerOn && leadingTabs.map(");
  const liveAt = SIDEBAR.indexOf("{liveColumnEl}");
  const restAt = SIDEBAR.indexOf("pagerOn && restTabs.map(");
  assert.ok(leadingAt > 0 && leadingAt < liveAt && liveAt < restAt, `order: leading ${leadingAt}, live ${liveAt}, rest ${restAt}`);
  assert.match(TABBAR, /const \{ leading: leadingTabs, rest: restTabs \} = splitLeading\(contentTabs\);/);
  assert.match(TABBAR, /\.\.\.\(narrow \? leadingTabs\.map[\s\S]{0,200}\{ key: "live", label: "Live"/);
  assert.match(SIDEBAR, /home: !isPopout,/, "the popout renders no Home");
  assert.match(REGISTRY, /leading\?: true;/);
});
