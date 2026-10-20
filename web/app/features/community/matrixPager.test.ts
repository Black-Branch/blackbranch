// The INNER pager's wiring in MatrixView's UnifiedLayout. The Matrix pane nests
// its own snap scroller (mode 1, touch only): the three single-panel views
// become ONE horizontal snap row — directory | timeline | members — nested
// inside the outer pager's Matrix pane, so the path chat → community home →
// channel → user list → news is one continuous swipe.
//
// ── Why this file is a SOURCE SCAN, and what covers the rest ──────────────────
// The same reasoning as chatPager.test.ts one layer out, for a harder host:
// UnifiedLayout needs a live MatrixClient (matrix-js-sdk + RustCrypto), a
// container-width measurement and a synced room list before it renders a single
// pane, and no test in this feature mounts it — `railUserButton.test.ts` is
// itself a source scan for the same reason. Rebuilding the row by hand to
// assert against would break the standing rule (testDom.ts's header): a
// hand-rebuilt tree asserts against a COPY, which is how every line can be
// present and correct while the behaviour is wrong.
// What IS covered elsewhere, so this file does not have to fake it:
//   · the pane derivations (key set, active pane, the thread-yield) are pure and
//     node-tested exhaustively over all 96 resolver states — app/lib/
//     matrixLayout.test.ts;
//   · the pager's BEHAVIOUR (a settle commits, an approach does not, teardown
//     closes hot state out, an external activeKey change re-syncs silently) is
//     proven against a real DOM in app/lib/chrome/usePanePager.render.test.ts;
//   · the swipe itself needs a real browser at phone width; no unit test drives it.
// What only this file can see is the WIRING: that UnifiedLayout hands the hook
// the right keys, builds the row from keyed slots, commits to the FLAGS, and
// leaves the resolver and every existing flag writer alone.
//
// Run: node --test app/features/community/matrixPager.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../lib/testSource.ts";

const read = (...p: string[]) => stripComments(readFileSync(join(process.cwd(), ...p), "utf8"));

const VIEW = read("app", "features", "community", "MatrixView.tsx");
const VISIBILITY = read("app", "lib", "matrixVisibility.ts");
const TIMELINE = read("app", "features", "community", "Timeline.tsx");
const THREAD = read("app", "features", "community", "ThreadPanel.tsx");

test("the hook is wired to the pure derivations — keys/activeKey/enabled/onCommit are its whole contract", () => {
  assert.match(
    VIEW,
    /const \{ scrollerRef: mxScrollerRef \} = usePanePager<MatrixPaneKey>\(\{\s*keys: mxPaneKeys, activeKey: mxActivePane, enabled: mxPagerOn, onCommit: commitMatrixPane,\s*\}\)/,
    "the inner pager hook's wiring changed — keys/activeKey/enabled/onCommit are its whole contract",
  );
  // Each term comes from the tested pure helper, never from a second inline
  // copy of the rule: that is what keeps matrixLayout.test.ts's 96-state sweep
  // a statement about THIS row.
  assert.match(VIEW, /const mxPagerOn = matrixPagerEnabled\(mode, mxCoarse, vis\);/,
    "the enable term is no longer the pure helper — an inline copy is a second authority");
  // `mxCoarse` reads the house Q_POINTER_COARSE query
  // through the house client-value pattern (useClientValue) — the same
  // pattern PwaInstallNudge.tsx and keepFocus.ts already use for this exact
  // query, never a hand-spelled matchMedia string (check-device-queries.mjs
  // forbids that everywhere but deviceQueries.ts itself).
  assert.match(
    VIEW,
    /const mxCoarse = useClientValue\(\(\) => window\.matchMedia\?\.\(Q_POINTER_COARSE\)\?\.matches === true, false\);/,
    "the coarse-pointer read changed shape — it must stay the house useClientValue + Q_POINTER_COARSE pattern",
  );
  assert.match(VIEW, /import \{ useClientValue \} from "@\/app\/lib\/useClientState";/,
    "MatrixView no longer imports the house client-value hook");
  assert.match(VIEW, /import \{ Q_POINTER_COARSE \} from "@\/app\/lib\/deviceQueries";/,
    "MatrixView no longer imports the canonical coarse-pointer query");
  assert.match(VIEW, /const mxPaneKeys = matrixPaneKeys\(!!selected\);/,
    "the key set is no longer derived from the helper");
  assert.match(VIEW, /const mxActivePane = matrixActivePane\(vis\);/,
    "the active pane is no longer derived from the helper");
  // …and all three read the SAME resolver output object, so the row and the
  // panel it renders cannot be answering different questions.
  assert.match(VIEW, /const vis = resolveVisibility\(\{/,
    "the resolver's output is no longer captured as one value the derivations share");
  assert.match(
    VIEW,
    /const \{ showDirectory, showTimeline, showMembers, showThread, showThreadsList \} = vis;/,
    "the existing visibility flags no longer come off that same object",
  );
});

test("the enable term is mode-1-only, TOUCH-ONLY, AND yields to the thread region", () => {
  // Spelled in the helper, pinned here because the row's whole yield depends on
  // it: threads take the full panel in an overlay swap and stay OUT of the
  // pager, modes 2/3 show the panels side by side, and a fine pointer never
  // gets the pager — a desktop unsplit panel (mode 1 on a mouse) would carry a
  // live, invisible snap row that a trackpad pan or shift+wheel could page.
  assert.match(
    VISIBILITY,
    /export function matrixPagerEnabled\(mode: number, coarse: boolean, vis: Visibility\): boolean \{\s*return mode === 1 && coarse && !vis\.showThread && !vis\.showThreadsList;\s*\}/,
    "the enable rule changed — mode 1 only, touch (coarse) only, and it must stand down for a thread or the threads list",
  );
});

test("onCommit writes the FLAGS, all three of them, on every pane", () => {
  // The flags stay the source of truth (`resolveVisibility` is untouched), so a
  // settle has to leave them in exactly the state the tapped/dragged pane
  // means. Writing only one of the pair is the silent bug: committing
  // "timeline" while `membersOpen` stays true resolves straight back to
  // members, and the row would spring back under the finger.
  assert.match(
    VIEW,
    /const commitMatrixPane = useCallback\(\(k: MatrixPaneKey\) => \{\s*if \(k === "directory"\) \{ setDirectoryOpen\(true\); setMembersOpen\(false\); return; \}\s*if \(k === "timeline"\) \{ setDirectoryOpen\(false\); setMembersOpen\(false\); return; \}\s*setDirectoryOpen\(false\); setMembersOpen\(true\);\s*\}, \[\]\);/,
    "the commit's three flag-writes changed — each pane must set BOTH directoryOpen and membersOpen",
  );
});

test("the wrapper is ONE PERMANENT element in TWO SKINS — display:contents is load-bearing, not cosmetic", () => {
  // `mode` comes from
  // this component's OWN container width, so it flips 1↔2 whenever the panel is
  // resized — dragging ChatSidebar's split divider across 680px flips it
  // repeatedly, MID-DRAG. A wrapper that came and went (or a ternary between
  // two ELEMENTS: React reconciles by position AND shape) would change the
  // timeline's parent on each flip and remount it every time, losing the
  // composer draft it holds. `display: contents` gives a stable parent while
  // adding no box: off the pager the children stay flex items of the root, in
  // the same DOM order, so modes 2/3 render exactly as they would without it.
  assert.match(
    VIEW,
    /<div\s*ref=\{mxScrollerRef\}\s*className=\{\s*mxPagerOn\s*\?\s*"flex flex-1 min-h-0 overflow-x-auto overflow-y-hidden snap-x snap-mandatory no-scrollbar"\s*:\s*"contents"\s*\}\s*>/,
    "the wrapper's two skins changed — it must stay ONE element with a className swap (never a ternary between two elements), and the off-pager skin must be `contents` or modes 2/3 gain a stray flex box",
  );
  // Exactly one wearer of the ref, and the ref is handed over unconditionally
  // (every hook effect is enabled-guarded, so off the pager it is inert).
  assert.equal((VIEW.match(/ref=\{mxScrollerRef\}/g) ?? []).length, 1,
    "the scroller ref is on a different number of elements — the wrapper must be the only one, always rendered");
  // A second element carrying the pager skin would be the forked shape again.
  assert.doesNotMatch(VIEW, /\{mxPagerOn \? \(\s*<div\s*ref=\{mxScrollerRef\}/,
    "the wrapper forks into two elements again — that is a remount on every mode flip");
  // UNCONDITIONAL, and the root's FIRST child. "Permanent" is the whole
  // property: a wrapper behind ANY guard — `{x && <div ref=…` included — is
  // one that can come and go, and every child under it remounts when it does.
  // Pinning it as the element that opens immediately after the root div's own
  // `>` is what makes that unfakeable: there is no expression in between to
  // hide a condition in.
  assert.match(VIEW, /\} as React\.CSSProperties\}\s*>\s*<div\s*ref=\{mxScrollerRef\}/,
    "the wrapper is no longer the root's unconditional first child — check for a guard in front of it, or an element that moved above it");
});

test("the inner row does NOT contain its overscroll — edge-chaining is the feature", () => {
  // The one class that must NEVER appear on this row. `overscroll-x-contain`
  // is correct on the OUTER row (ChatSidebar: a rubber-band there would become
  // a history nav) and would be a BUG here: it stops the scroll chaining that
  // carries a fresh swipe off members' right edge on to news, and off
  // directory's left edge back to live. That chaining IS the continuous
  // swipe, and it is delivered by the browser's per-gesture scroll-target
  // selection with zero handoff code — containment would silently delete it.
  const rowAt = VIEW.indexOf("ref={mxScrollerRef}");
  const rowEnd = VIEW.indexOf(">", VIEW.indexOf("no-scrollbar", rowAt));
  assert.ok(rowAt !== -1 && rowEnd > rowAt, "could not isolate the inner row's opening tag");
  assert.ok(
    !VIEW.slice(rowAt, rowEnd).includes("overscroll"),
    "the inner row contains its overscroll — that deletes the edge-chaining into the outer pager (members → news, directory → live), which is the whole point of nesting the scrollers",
  );
  // Exactly one snap row in this file: off the pager the mode-1 branch must
  // render no pager DOM at all, and modes 2/3 none ever.
  assert.equal((VIEW.match(/snap-x/g) ?? []).length, 1, "more than one snap row in MatrixView, or none");
});

test("the panes are native scroll-snap slots, and the row is built from KEYED ones", () => {
  assert.match(
    VIEW,
    /const MX_PANE_SLOT = "w-full shrink-0 snap-start snap-always flex min-h-0 min-w-0";/,
    "a pane slot lost its width or its snap stop — snap-always is what makes every settle adjacent",
  );
  // One const + exactly three wearers. A fourth slot (or a lost one) means the
  // row's children and matrixPaneKeys() have parted company, and `progress` —
  // a fractional index into the KEY list read as an index into the ROW — would
  // point at the wrong pane for a whole gesture.
  assert.equal((VIEW.match(/MX_PANE_SLOT/g) ?? []).length, 4,
    "the pane-slot geometry has a new (or lost a) wearer — there are exactly three slots plus the const");
  // Keyed child slots, in the key list's order (React reconciles by position
  // AND shape, and the directory/members ones fork on the mode). The
  // directory/members slots also wear `relative` — they are the positioning box
  // for their own WindowLayerTarget (windowLayerTarget.render.test.ts pins that
  // half); this test owns the key + inert terms.
  assert.match(VIEW, /<div key="directory" inert=\{mxActivePane !== "directory"\} className=\{`\$\{MX_PANE_SLOT\} relative`\}>/,
    "the directory slot lost its key or its inert term");
  assert.match(VIEW, /<div key="members" inert=\{mxActivePane !== "members"\} className=\{`\$\{MX_PANE_SLOT\} relative`\}>/,
    "the members slot lost its key or its inert term");
  // Slot order = key order = journey order (directory left, members right).
  const iDir = VIEW.indexOf('key="directory"');
  const iTl = VIEW.indexOf('key="timeline"');
  const iMem = VIEW.indexOf('key="members"');
  assert.ok(iDir !== -1 && iDir < iTl && iTl < iMem,
    "the row's slots are out of journey order — a swipe would run the wrong way");
  // The directory pane is the rail AND the channel column together: the same
  // content as the mode-1 drawer.
  assert.match(VIEW, /className=\{`\$\{MX_PANE_SLOT\} relative`\}>\s*\{railEl\}\s*\{channelColEl\}/,
    "the directory pane no longer holds the rail and the channel column together");
  // Timeline and members contribute a PANE only with a room selected — the same
  // condition matrixPaneKeys() applies, so the row and the key list agree on
  // how many panes exist. (The timeline does it through its className: it is
  // always in the tree, but wears `contents` — no box, no pane — when there is
  // nothing to show.)
  assert.match(VIEW, /className=\{mxPagerOn && selected \? MX_PANE_SLOT : "contents"\}/,
    "the timeline slot no longer drops to `contents` without a selection — it would add an empty fourth pane the key list does not know about");
  assert.match(VIEW, /selected && \(\s*<div key="members"/, "the members slot lost its selected guard");
  // Nothing ELSE inside the wrapper may become a pane. The two other
  // children are the empty-centre branch and the thread region, and both are
  // impossible while the pager is on — mode 1 with no selection resolves to the
  // DIRECTORY (so `showTimeline && !selected` is false), and `mxPagerOn`
  // requires no thread and no threads list (so `showRightThread` is false).
  // These are the guards that make that true; if either changes shape, the row
  // can silently grow a pane the pager's arithmetic cannot see.
  assert.match(VIEW, /\{showTimeline && !selected && \(/,
    "the empty-centre guard changed — under the pager it must stay unreachable");
  assert.match(VIEW, /\{showRightThread && selected && \(\(\) => \{/,
    "the thread region's guard changed — under the pager it must stay unreachable");
});

test("the TIMELINE is the stable child — same key, same position, same depth in both skins", () => {
  // The one child that must not remount on a mode flip: it holds the scroll
  // anchor and a half-typed composer draft. Both skins live on the SAME div —
  // `contents` off the pager adds no tree level, so `mxTimelineEl` is a flex
  // item of the root exactly as it would be without the pager, and the pane
  // slot on it adds none either.
  assert.match(
    VIEW,
    /<div\s*key="timeline"\s*inert=\{mxPagerOn && mxActivePane !== "timeline"\}\s*className=\{mxPagerOn && selected \? MX_PANE_SLOT : "contents"\}\s*>\s*\{\(mxPagerOn \|\| showTimeline\) && mxTimelineEl\}\s*<\/div>/,
    "the timeline slot is no longer ONE element with a key, an enabled-guarded inert and a className swap — any fork here remounts the timeline on every split-divider drag across 680px",
  );
  // It must not be conditionally rendered: a `{x && <div key="timeline"` would
  // be the wrapper problem one level down.
  assert.doesNotMatch(VIEW, /&& \(?\s*<div\s*key="timeline"/,
    "the timeline slot became conditional — it has to be present in every render to keep its identity");
  // Its content gate mounts it under the pager regardless of showTimeline
  // (all panes live alongside), and falls back to the resolver off the pager.
  assert.equal((VIEW.match(/\(mxPagerOn \|\| showTimeline\) && mxTimelineEl/g) ?? []).length, 1,
    "the timeline's content gate changed — under the pager it stays mounted alongside; off it the resolver still decides");
});

test("inert is a REST state — read off the committed pane, never off the live gesture", () => {
  // `mxActivePane` is derived from the FLAGS (committed state), so it does not
  // move until a settle: no inert churn mid-gesture, and no
  // occluded-but-focusable pane at rest. Driving it from `progress` or
  // `mounted` would re-introduce exactly that churn.
  assert.doesNotMatch(VIEW, /inert=\{[^}]*(?:progress|mounted)/,
    "inert is being driven off the live gesture — that churns the tree on every frame of a pan");
  // Three inert terms, all the same at-rest comparison. The directory and
  // members slots exist ONLY under the pager, so their term needs no guard;
  // the timeline slot is permanent, so its term MUST carry `mxPagerOn &&`
  // or the mode-2/3 timeline would be inert whenever the flags happen to point
  // elsewhere — an unfocusable, screen-reader-invisible timeline on desktop.
  assert.equal((VIEW.match(/inert=\{mxActivePane !== "/g) ?? []).length, 2,
    "the directory/members inert terms changed, or one gained a guard it does not need");
  assert.equal((VIEW.match(/inert=\{mxPagerOn && mxActivePane !== "timeline"\}/g) ?? []).length, 1,
    "the permanent timeline slot lost its mxPagerOn guard — off the pager it would go inert on desktop");
  assert.equal((VIEW.match(/inert=/g) ?? []).length, 3,
    "an inert attribute appeared outside the three pane slots");
});

test("the resolver stays the AUTHORITY — the derivations only read it", () => {
  // The pager does not touch resolveVisibility: its mode-1 precedence is the
  // one place that decides which panel shows, and the three pager exports are
  // pure functions OF its output. A derivation that started deciding for
  // itself would put the row and the rendered panel out of step.
  assert.match(
    VISIBILITY,
    /showDirectory = !hasSelected \|\| directoryOpen;\s*showThread = !showDirectory && hasThreadEvent;/,
    "the resolver's mode-1 precedence changed — the pager must not touch it",
  );
  assert.match(VISIBILITY, /export function matrixActivePane\(vis: Visibility\): MatrixPaneKey \{/,
    "matrixActivePane no longer takes the resolver's output");
  assert.match(VISIBILITY, /export function matrixPaneKeys\(hasSelected: boolean\): MatrixPaneKey\[\] \{\s*return hasSelected \? \["directory", "timeline", "members"\] : \["directory"\];\s*\}/,
    "the key set changed — order is journey order, and the no-selection case must narrow to one pane");
});

test("every existing flag writer is untouched — the sync effect turns their writes into scroll", () => {
  // The pager adds a writer; it replaces none. openRoom's mode-1 collapse,
  // the timeline's back arrow and the members header's ← all still write the
  // flags directly, and usePanePager's external-sync effect converts each into
  // an instant snap. Rewriting any of them to call the pager instead would put
  // a second spelling of "open a pane" in the file.
  assert.match(VIEW, /if \(collapse && mode === 1\) \{\s*setDirectoryOpen\(false\);\s*setMembersOpen\(false\);\s*\}/,
    "openRoom's mode-1 collapse changed — it must keep writing the flags");
  assert.equal((VIEW.match(/onBack=\{mode === 1 \? \(\) => setDirectoryOpen\(true\) : undefined\}/g) ?? []).length, 2,
    "the timeline's mode-1 back arrow changed (ForumView + MatrixTimeline are the two)");
  assert.match(VIEW, /onClick=\{\(\) => setMembersOpen\(false\)\}/,
    "the members header's back button no longer writes the flag");
  // The pager is handed no requestPane consumer here: there is no inner tab
  // bar, so a click path would be a second, unpinned commit route.
  assert.doesNotMatch(VIEW, /requestPane/,
    "a requestPane consumer appeared — the inner row has no tab bar, so this needs its own pin");
});

test("ONE spelling of each pane body — two render positions, never two copies", () => {
  // A pane that exists in both the pager and the non-pager branch must be ONE
  // element referenced from each position, or the two copies drift. Both are
  // hoisted (`mxTimelineEl`, `mxMembersEl`).
  // The timeline is spelled TWICE — its definition and its single, permanent
  // slot; the stable wrapper leaves it no second position to drift from.
  assert.equal((VIEW.match(/mxTimelineEl/g) ?? []).length, 2,
    "the timeline element is spelled a different number of times (1 definition + the ONE permanent slot)");
  // Members still forks on the mode, so it keeps two
  // positions plus its definition — and the two are mutually exclusive by
  // construction: one is the `mxPagerOn` branch, the other the `mode === 1`
  // fall-through of the SAME ternary, so neither needs a !mxPagerOn guard.
  assert.equal((VIEW.match(/mxMembersEl/g) ?? []).length, 3,
    "the mode-1 members element is spelled a different number of times (1 definition + the pager slot + the yielded position)");
  assert.match(VIEW, /\{mxPagerOn \? \(\s*selected && \(\s*<div key="members"[^]*?\) : mode === 1 \? \(\s*showMembers && mxMembersEl\s*\) : \(/,
    "the members region is no longer ONE ternary (pager · yielded mode 1 · modes 2/3) — two independent guards here can both fire and mount MemberList twice");
  // One element per heavy child, so no pane body has a second, unguarded mount.
  for (const tag of ["<MatrixTimeline", "<ForumView", "<SpacesRail", "<ChannelColumn"]) {
    assert.equal((VIEW.match(new RegExp(tag, "g")) ?? []).length, 1,
      `${tag} has more than one mount point — each one would need its own guard`);
  }
  // MemberList is deliberately two: the mode-1 full panel (its own back bar)
  // and the modes-2/3 slide-in (a ✕ header). Different markup, not a copy.
  assert.equal((VIEW.match(/<MemberList/g) ?? []).length, 2,
    "the member list's mount count changed — mode 1 and modes 2/3 render genuinely different headers");
  // The timeline keeps its per-room keyed remount INSIDE the row (the slide).
  assert.match(VIEW, /const mxTimelineEl = selected \? \(\s*<div key=\{selected\.roomId\} className="flex-1 flex flex-col min-w-0 panel-slide-in">/,
    "the timeline lost its per-room key or its panel-slide-in — the room-switch slide is deliberate and travels into the row");
});

test("sibling ORDER inside the wrapper is the modes-2/3 layout — the thread region must sit between timeline and members", () => {
  // Off the pager the wrapper is `display: contents`, so these five children
  // ARE the root's flex row, left to right. Get the order wrong and modes 2/3
  // break visibly: with the thread region outside (or after) the members
  // region, an open thread would render to the RIGHT of the member list
  // instead of taking the slot before it. This pins that document order.
  const at = (needle: string) => {
    const i = VIEW.indexOf(needle);
    assert.notEqual(i, -1, `could not locate ${needle}`);
    return i;
  };
  const wrapper = at("ref={mxScrollerRef}");
  const directory = at("{mxPagerOn ? (");
  const timeline = at('key="timeline"');
  const empty = at("{showTimeline && !selected &&");
  const thread = at("{showRightThread && selected &&");
  const members = at("ref={memOuterRef}");
  assert.ok(
    wrapper < directory && directory < timeline && timeline < empty && empty < thread && thread < members,
    "the wrapper's children are out of order — directory · timeline · empty-centre · thread · members is the modes-2/3 layout itself",
  );
  // …and the wrapper CLOSES right after the members region, before the modals:
  // a snap-scroller child is the last thing an AddSpaceModal should be.
  assert.match(VIEW, /<\/>\s*\)\}\s*<\/div>\s*\{addSpaceOpen && client && \(/,
    "the wrapper no longer closes between the members region and the modals — either the modals are inside the scroller, or the members region has fallen outside it");
});

test("the empty-centre states keep their own rule: modes 2/3 only, never a pane", () => {
  // In mode 1 `showTimeline` is false whenever nothing is selected (the
  // resolver falls back to the directory), so this branch renders in modes 2/3
  // only. It is a SIBLING of the pane slots inside the wrapper, which is why
  // the guard above matters: if
  // it could fire under the pager it would become an unaccounted-for pane.
  assert.match(VIEW, /\{showTimeline && !selected && \(/,
    "the empty-centre branch changed shape or moved");
  assert.match(VIEW, /Sign in to join the community\./, "the signed-out CTA is gone");
  // It is not wearing a pane slot, and never gained one.
  const emptyAt = VIEW.indexOf("{showTimeline && !selected &&");
  const emptyEnd = VIEW.indexOf("{showRightThread", emptyAt);
  assert.ok(emptyEnd > emptyAt, "could not isolate the empty-centre branch");
  assert.ok(!VIEW.slice(emptyAt, emptyEnd).includes("MX_PANE_SLOT"),
    "the empty-centre branch became a pane — the pager's key list does not know about it");
});

test("the pager: MatrixTimeline's scroller trades the both-axes overscroll-contain for overscroll-y-contain, so a horizontal pan chains into the mode-1 pager row", () => {
  // MatrixTimeline (rendered as `mxTimelineEl`'s non-forum branch) sits inside
  // the mode-1 Matrix pager row (`mxScrollerRef`'s MX_PANE_SLOT), same as
  // ChatSidebar's `.chat-scroll-layer` sits inside the outer pager — see
  // chatPager.test.ts for the full CSS-spec mechanism (clip/auto axis
  // computation + overscroll-behavior chaining). The bare `overscroll-contain`
  // utility silently eats every horizontal pan starting over a Matrix room's
  // messages: it neither scrolls there nor chains out to the pager.
  // `overscroll-y-contain` keeps the vertical containment this scroller
  // exists for (stop the timeline's own overscroll chaining into the page)
  // while freeing the horizontal axis to chain.
  assert.match(
    TIMELINE,
    /flex-1 overflow-y-auto overscroll-y-contain py-1 no-scrollbar/,
    "MatrixTimeline's scroll-layer class string changed shape — re-check overscroll-y-contain is still there",
  );
  // Token-boundary matched so `overscroll-y-contain` does not fool the
  // assertion (it does not contain "overscroll-contain" as a standalone token).
  assert.doesNotMatch(
    TIMELINE,
    /(?:^|[\s"'`])overscroll-contain(?:[\s"'`]|$)/,
    "a bare, both-axes `overscroll-contain` reappeared in Timeline.tsx — inside the mode-1 pager row it silently eats the pager's horizontal pan (clip/auto-computed hidden axes still block chaining with zero scrollable range)",
  );
});

test("ThreadPanel's scroller trades the both-axes overscroll-contain for overscroll-y-contain, so a mobile pan over the thread body chains into the OUTER pager", () => {
  // A thread panel is one pane of ChatSidebar's OUTER row on mobile — the
  // Matrix INNER pager stands down while a thread is open (matrixPagerEnabled
  // yields on showThread/showThreadsList), so there is no inner snap row here
  // to chain into. Same both-axes mechanism as Timeline.tsx's scroller:
  // `overflow-y-auto` with no `overflow-x` set computes the x-axis to `auto`
  // too, so a bare, both-axes `overscroll-contain` blocks the outer pager's
  // horizontal chaining even at zero horizontal range — pans on the thread's
  // header (outside this scroller) would page the outer row, pans on the body
  // would not.
  assert.match(
    THREAD,
    /flex-1 overflow-y-auto overscroll-y-contain py-1 no-scrollbar/,
    "ThreadPanel's scroll-layer class string changed shape — re-check overscroll-y-contain is still there",
  );
  assert.doesNotMatch(
    THREAD,
    /(?:^|[\s"'`])overscroll-contain(?:[\s"'`]|$)/,
    "a bare, both-axes `overscroll-contain` reappeared in ThreadPanel.tsx — it silently eats the outer pager's horizontal pan over the thread body",
  );
});

test("vacuity anchor — MatrixView and the resolver were both read whole", () => {
  // Every negative assertion above ("no overscroll", "no requestPane", "no
  // inert outside the row") is a claim about the WHOLE file; a truncated read
  // would make each of them pass over a hole.
  assert.match(VIEW, /return <UnifiedLayout pageChrome \/>;\s*\}\s*$/, "vacuity anchor");
  assert.match(VISIBILITY, /return mode === 1 && coarse && !vis\.showThread && !vis\.showThreadsList;\s*\}\s*$/,
    "vacuity anchor");
  assert.match(TIMELINE, /<\/div>\s*\);\s*\}\s*$/, "vacuity anchor");
  assert.match(THREAD, /<\/div>\s*\);\s*\}\s*$/, "vacuity anchor");
});
