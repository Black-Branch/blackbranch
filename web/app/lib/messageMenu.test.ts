// ONE message menu, opened by holding.
//
// The requirements:
//   • tapping a message must not show the hover options, and holding must not
//     show two menus — the desktop hover options are the mobile menu, opened
//     by holding down;
//   • tapping a message must not open the keyboard unless Reply is tapped, and
//     tapping or holding a message must not close an open keyboard.
//
// ─── WHY THESE ARE ONE BUG ──────────────────────────────────────────────────
// A reveal of `.group:hover > .row-actions { display: flex }` with NO gate on
// pointer type: a touch device cannot express "not hovering": mobile browsers
// apply :hover on tap and hold it until you tap elsewhere. So one tap opens the
// toolbar, and a long press opens the toolbar (the same touch hovered) AND the
// context menu (the timer fired) — two tiers of menu.
//
// And the keyboard opening is the SAME bug, which is not obvious from the
// wording. At 390x844x3 the toolbar's box begins 28.9px ABOVE its own row's
// top edge — entirely inside the message above it — and all five buttons
// hit-test there, at 22–27px wide against a 44px guideline. So: tap message A
// → A's invisible toolbar appears over message B → the next tap on B lands on
// A's Reply button → ChatInput focuses the composer → keyboard. Nothing about
// the keyboard is broken; the tap really is a Reply press. Keeping the keyboard
// from CLOSING (keepFocus) does not cover it.
//
// ─── THE INVARIANT ──────────────────────────────────────────────────────────
// Not "use this class name". It is:
//   1. hover reveals the toolbar ONLY where hover exists;
//   2. touch reveals THE SAME toolbar, only on a deliberate long press;
//   3. no second, richer menu opens straight from a gesture — the fuller menu is
//      reached from the toolbar's ⋯, on both pointer types;
//   4. no control on the toolbar costs you the soft keyboard.
// Every one of these regresses invisibly: the markup keeps saying what the
// author meant.
//
// Run: node --test app/lib/messageMenu.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments, stripCssComments } from "./testSource.ts";

const read = (...p: string[]) => stripComments(readFileSync(join(process.cwd(), ...p), "utf8"));
const CSS = stripCssComments(readFileSync(join(process.cwd(), "app", "globals.css"), "utf8"));

const CHAT = ["app", "features", "chat", "ChatMessage.tsx"] as const;
const MATRIX = ["app", "components", "MatrixMessageRow.tsx"] as const;
const ROWS = [CHAT, MATRIX];

/**
 * The full source of the `<div>` element containing `marker` — walks back to its
 * opening tag and forward to its matching close. Neither toolbar nests a <div>,
 * so a plain depth count over `<div`/`</div>` is exact; a nested one would only
 * ever return MORE than the toolbar, which fails these tests loudly rather than
 * quietly passing.
 */
function elementAround(src: string, marker: string): string {
  const i = src.indexOf(marker);
  assert.ok(i >= 0, `marker not found: ${marker}`);
  const start = src.lastIndexOf("<div", i);
  assert.ok(start >= 0, `no opening <div> before: ${marker}`);
  let depth = 0;
  for (let j = start; j < src.length; j++) {
    if (src.startsWith("<div", j)) depth++;
    else if (src.startsWith("</div>", j)) {
      depth--;
      if (depth === 0) return src.slice(start, j + 6);
    }
  }
  assert.fail(`unterminated <div> around: ${marker}`);
}

const toolbar = (p: readonly string[]) => elementAround(read(...p), 'className="row-actions');

test("the hover reveal is gated to pointers that HAVE hover", () => {
  // The whole of ticket 13 in one rule. Ungated, a tap opens the toolbar.
  const gate = CSS.match(/@media \(hover: hover\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.ok(gate, "no @media (hover: hover) block — the hover reveal is ungated again");
  assert.match(gate, /\.group:hover > \.row-actions \{[\s\S]*?display: flex/,
    "the hover reveal moved out of the (hover: hover) gate — a tap opens it again");
  assert.match(gate, /@starting-style \{\s*\.group:hover > \.row-actions \{ opacity: 0; \}/,
    "the entry ramp did not move into the gate with its rule");

  // And nowhere else: a second ungated copy would defeat the gate entirely.
  const ungated = CSS.replace(/@media \(hover: hover\) \{[\s\S]*?\n\}/g, "");
  assert.doesNotMatch(ungated, /\.group:hover > \.row-actions \{[\s\S]*?display: flex/,
    "a SECOND, ungated hover reveal exists — touch gets the toolbar on tap again");
});

test("touch reveals the same toolbar, and only when it is opened", () => {
  // Match INSIDE one rule body ([^}]*), not across the file. A lazy
  // `\{[\s\S]*?display: flex` passes even with the reveal renamed away: the
  // span walks out of the rule and finds a `display: flex` belonging to
  // something else entirely.
  const reveals = [...CSS.matchAll(/\.row-actions\[data-open\] \{([^}]*)\}/g)].map((m) => m[1] ?? "");
  assert.ok(reveals.some((r) => /display: flex/.test(r) && /opacity: 1/.test(r)),
    "no [data-open] reveal — a long press has nothing to show");
  // Still display-driven, so a closed toolbar is not painted at 80 rows. That is
  // P1's invariant (rowActions.test.ts) and this must not quietly undo it.
  assert.match(CSS, /@starting-style \{\s*\.row-actions\[data-open\] \{ opacity: 0; \}/,
    "the touch reveal has no entry ramp — it snaps in");
});

test("a fingertip gets a fingertip-sized target", () => {
  // 22–27px measured. These were a mouse affordance that touch reached by
  // accident; now they are the primary mobile control.
  const coarse = CSS.match(/@media \(pointer: coarse\) \{\s*\.row-actions button \{([\s\S]*?)\}/)?.[1] ?? "";
  assert.ok(coarse, "no coarse-pointer sizing for the toolbar's buttons");
  for (const prop of ["min-width", "min-height"]) {
    const v = coarse.match(new RegExp(`${prop}: (\\d+)px`))?.[1];
    assert.ok(v && Number(v) >= 40, `${prop} is ${v ?? "unset"} — under the 40px floor`);
  }
});

test("a long press opens the TOOLBAR, never a menu of its own", () => {
  // This is the "remove the tap-hold options" half. If a row ever again wires
  // its long press straight to a context menu, mobile has two menus again.
  for (const p of ROWS) {
    const src = read(...p);
    assert.match(src, /const handleLongPress = useCallback\(\(\) => \{ claimExclusive\(owner\); setBarOpen\(true\); \}, \[owner\]\)/,
      `${p.join("/")}'s long press no longer just claims and opens the toolbar`);
    assert.doesNotMatch(src, /handleLongPress[\s\S]{0,80}setCtxMenu/,
      `${p.join("/")}'s long press opens a context menu directly again — that is the second tier`);
  }
});

test("the toolbar reflects the open flag, and an outside press closes it", () => {
  for (const p of ROWS) {
    const bar = toolbar(p);
    assert.match(bar, /data-open=\{barOpen \|\| undefined\}/,
      `${p.join("/")}'s toolbar does not carry data-open — the CSS reveal cannot fire`);
    assert.match(bar, /ref=\{barRef\}/, `${p.join("/")}'s toolbar has no ref for the outside-click`);
    // NOT a blanket close on the container: voting is repeatable and
    // toggleable, so the menu must survive an up- or downvote. Only the
    // ONE-SHOT actions close.
    assert.doesNotMatch(bar, /onClick=\{closeBar\}/,
      `${p.join("/")}'s toolbar dismisses on ANY action again — a vote would close it`);

    // The container itself, not only its buttons. Between six 40px targets
    // there is `px-1.5 py-0.5` of padding and `gap-0.5` of dead space that
    // belongs to this div, and a press on a non-focusable element blurs the
    // composer just as surely as a button does — a tap-hold on a message
    // while the keyboard is open would close the keyboard.
    assert.match(bar, /onMouseDown=\{keepFocus\}/,
      `${p.join("/")}'s toolbar CONTAINER has no keepFocus — its padding and gaps drop the keyboard`);

    const src = read(...p);
    assert.match(src, /useOutsideClick\(barRef, closeBar, \{ enabled: barOpen/,
      `${p.join("/")} does not close the toolbar on an outside press`);
    // `enabled` matters at scale: 80 mounted rows each holding a document
    // listener is the kind of thing that only shows up on a phone.
    assert.doesNotMatch(src, /useOutsideClick\(barRef, closeBar\)/,
      `${p.join("/")} attaches the outside-click listener unconditionally, at every row`);
  }
});

test("COPY survived the collapse — on the chat toolbar itself", () => {
  // Copy lives ON the toolbar, and the ⋯ menu holds only the mod quick actions
  // (pin/delete) — so the ⋯ is mod-gated, and copy-a-message must be on the
  // bar or phones lose it entirely.
  const bar = toolbar(CHAT);
  assert.match(bar, /copyText\(msg\.message\); closeBar\(\)/,
    "chat's toolbar lost its copy button — copy-a-message is gone from every pointer");
  assert.match(bar, /title="More"/, "chat's toolbar lost its ⋯ — pin/delete are unreachable for mods");
  assert.match(bar, /setCtxMenu\(\{ x: r\.left, y: r\.bottom \}\)/,
    "chat's ⋯ no longer anchors the menu to the button");
  assert.match(read(...CHAT), /<MessageContextMenu/, "the mod menu is gone entirely");
  // Matrix already shipped this pattern; it is what made "one toolbar, two
  // pointer types" achievable rather than aspirational. Its ⋯ still carries
  // copy for everyone — Matrix rows have no copy button on the bar.
  assert.match(toolbar(MATRIX), /title="More"/, "the Matrix toolbar lost its ⋯");
});

test("no control on either toolbar costs you the soft keyboard", () => {
  // The Matrix toolbar keeps the keyboard too, like chat's: the rule covers
  // the whole chat surface. Every button, not most: the one that is missed is
  // the one that gets pressed.
  for (const p of ROWS) {
    const bar = toolbar(p);
    const buttons = bar.split("<button").slice(1);
    assert.ok(buttons.length >= 3, `${p.join("/")}: only ${buttons.length} buttons found — check the slice`);
    for (const b of buttons) {
      const title = b.match(/title=[{"]`?([^"`}]*)/)?.[1] ?? "(untitled)";
      assert.match(b, /onMouseDown=\{keepFocus\}/,
        `${p.join("/")}'s "${title}" button has no keepFocus — pressing it drops the keyboard`);
    }
  }
});

test("CHROME: focus is RESTORED when the browser drops it mid-press", () => {
  // The actual cause, measured with ?pressdebug=1:
  //   3298ms blur        on textarea.chat-input-field  active=body   vv.h=581
  //   3299ms focusout    on textarea  → -              active=body   vv.h=581
  //   3302ms contextmenu on span
  //   3328ms vv.resize   h=891   ← keyboard closes AFTER the blur
  // touchstart→blur is 488ms: Chrome's OWN ~500ms long-press threshold. The
  // relatedTarget is NULL, so nothing stole focus and there was no mousedown to
  // cancel — which is why keepFocus/contextmenu-shaped fixes cannot help.
  // The keyboard follows focus, so restoring it inside the ~30ms before the IME
  // tears down is the only thing that can work.
  const src = read("app", "lib", "useLongPress.ts");
  assert.match(src, /const armFocusGuard = useCallback/, "the focus guard is gone — Chrome drops the keyboard again");
  // ARMED AT TOUCHSTART, not from the long-press timer. Chrome's blur
  // lands at 203ms, 207ms or 488ms on the SAME device; arming from our 350ms
  // timer would win the 488ms race and silently lose both 200ms ones. Racing a
  // threshold that moves is not a fix, it is a coin toss.
  assert.match(src, /armFocusGuard\(\);\s*\n\s*timerRef\.current = setTimeout/,
    "the focus guard is armed from the timer again — it will lose whenever Chrome blurs before 350ms");
  assert.doesNotMatch(src, /armFocusGuard\(\);\s*\n\s*onLongPress/,
    "the guard arms inside the timer callback — too late on a fast threshold");
  // Scoped to Chrome's exact signature and to ONE guard, because a broader
  // restore has collateral damage: after selecting a message the composer
  // stops expanding, send-to loses its default, and its first press does nothing.
  //   • relatedTarget NULL is Chrome's spontaneous drop (`focusout → -`). A blur
  //     caused by the user moving focus somewhere real NAMES that element, and
  //     stealing focus back from it is what would eat the first tap.
  //   • each arm must not install a listener and overwrite disarmRef, orphaning
  //     the previous one to survive on its own backstop and keep grabbing focus.
  assert.match(src, /if \(e\.relatedTarget !== null\) return;/,
    "the guard fires on ANY blur — it will fight a deliberate focus move and eat the press");
  assert.match(src, /disarmRef\.current\?\.\(\);/,
    "arming no longer disarms the previous guard — orphaned listeners keep pulling focus");
  const backstop = Number(src.match(/setTimeout\(disarm, (\d+)\)/)?.[1] ?? 0);
  assert.ok(backstop > 0 && backstop <= 1500,
    `the backstop is ${backstop}ms — far too long for something that can take focus`);

  for (const fn of ["end", "abort"])
    assert.match(src, new RegExp(`const ${fn} = useCallback\\(([\\s\\S]{0,220}?)disarmFocusGuard\\(\\)`),
      `${fn}() does not disarm the focus guard — it would outlive its gesture`);
  // Synchronously inside focusout, or the IME has already torn down and the
  // keyboard closes and reopens instead of never moving.
  assert.match(src, /addEventListener\("focusout", restore, \{ capture: true \}\)/,
    "the restore no longer hooks focusout in the capture phase");
  // BOTH call sites — the synchronous one and the next-task retry. Asserting
  // "matches somewhere" passed a mutation that stripped preventScroll from the
  // first one, because the retry still matched.
  const focusCalls = src.match(/el\.focus\(/g) ?? [];
  const guarded = src.match(/el\.focus\(\{ preventScroll: true \}\)/g) ?? [];
  assert.equal(guarded.length, focusCalls.length,
    `${focusCalls.length - guarded.length} refocus call(s) lack preventScroll — they yank the chat list`);
  assert.ok(focusCalls.length >= 2, "the next-task retry is gone — a focus() during focusout dispatch can be ignored");
  // Only text fields hold a keyboard, and the guard must let go: a deliberate
  // tap elsewhere a moment later has to be able to take focus for good.
  assert.match(src, /el\.tagName !== "INPUT" && el\.tagName !== "TEXTAREA"/,
    "the restore is no longer limited to text fields");
  assert.match(src, /done = true;\s*\n\s*document\.removeEventListener\("focusout"/,
    "the restore never disarms — it would fight every later blur");
});

test("exactly ONE row menu open, by construction", () => {
  // Only one message may be selected at a time.
  //
  // This CANNOT be left to dismissal events: useOutsideClick does not listen
  // on touchstart (that would break scrolling), and a long press deliberately
  // swallows its own touchend, so opening row B produces no signal that row A
  // could close on. "One at a time" is an invariant — the opener announces,
  // everyone else closes — so it holds regardless of which gesture, browser or
  // pointer opened the menu.
  const reg = read("app", "lib", "exclusiveOpen.ts");
  assert.match(reg, /export function claimExclusive/, "the exclusivity registry is gone");
  // Subscribe only while open, or ~80 mounted rows each hold a listener.
  assert.match(reg, /if \(!open\) return;[\s\S]{0,200}subscribers\.add/,
    "rows subscribe even while closed — that is a listener per message");
  // Iterating a live Set while listeners remove themselves from it skips entries.
  assert.match(reg, /for \(const notify of \[\.\.\.subscribers\]\)/,
    "claimExclusive iterates the live Set — a self-removing listener would be skipped");
  // Stable identity WITHOUT touching a ref during render (react-hooks/refs).
  assert.match(reg, /useState\(\(\) => Symbol\(/,
    "the owner token is not a lazily-initialised useState — a ref read during render is unsafe under concurrent rendering");

  for (const p of ROWS) {
    const src = read(...p);
    assert.match(src, /const owner = useExclusiveOpen\(barOpen, closeBar\)/,
      `${p.join("/")} does not participate in the one-at-a-time registry`);
    // Claim BEFORE opening, or the opener closes itself.
    assert.match(src, /claimExclusive\(owner\); setBarOpen\(true\)/,
      `${p.join("/")} opens before it claims — ordering matters here`);
  }
});

test("nothing holds focus for a keyboard that is already down", () => {
  // After the user closes the keyboard by hand, tapping another message must
  // not open it again.
  //
  // Measured with ?pressdebug=1: dismissing the keyboard by hand does NOT blur
  // the composer. After `vv.resize h=891` the very next tap still reports
  // `active=textarea.chat-input-field`. Chrome hides the IME and leaves DOM
  // focus alone — so "a text field is focused" is NOT "a keyboard is open", and
  // a focus-holding path would keep an invisible keyboard alive for the
  // next gesture to re-summon.
  //
  // The keepFocus rule is "chat interactions must not COST you the keyboard". It
  // says nothing about one the user has deliberately put away.
  const kf = read("app", "lib", "keepFocus.ts");
  assert.match(kf, /import \{ isKeyboardOpen \}/, "keepFocus no longer consults the shared keyboard truth");
  // BOTH exports: the row body (coarse) and the controls.
  assert.equal((kf.match(/isKeyboardOpen\(\)/g) ?? []).length, 2,
    "one of keepFocus/keepFocusCoarse still holds focus with the keyboard down");
  // keepFocus must stay UNCONDITIONAL on a fine pointer — there is no keyboard
  // to reason about and preventing focus theft is what keeps the desktop caret.
  // The query is the shared Q_POINTER_COARSE constant, not a literal —
  // one spelling per device question (deviceQueries.ts). What is being pinned
  // is the coarse GATE, not the string it is spelled with.
  assert.match(kf, /matchMedia\(Q_POINTER_COARSE\)\.matches\s*\n?\s*&& !isKeyboardOpen\(\)\) return;/,
    "keepFocus dropped its coarse gate — desktop would stop holding the caret");

  // The long-press focus restore needs the same gate, or holding a message with
  // the keyboard down would summon one.
  // useLongPress reads the flag off <html> instead of importing the keyboard
  // hook: it is a GENERIC gesture hook and must not depend on the app shell —
  // and the import also broke its node render test, which loads it directly.
  const lp = read("app", "lib", "useLongPress.ts");
  assert.doesNotMatch(lp, /from "\.\/useViewportHeightVar"/,
    "useLongPress imports the app's keyboard hook again — that is a layering inversion and breaks its render test");
  assert.match(lp, /classList\.contains\("kb-open"\)\) return;[\s\S]{0,200}document\.activeElement/,
    "restoreFocus runs with the keyboard down — a long press would re-open it");
  // ONE writer of that class, so the flag cannot drift from the module state.
  const vh = read("app", "lib", "useViewportHeightVar.ts");
  assert.equal((vh.match(/classList\.toggle\(KB_OPEN_CLASS/g) ?? []).length, 1,
    "the kb-open class is written from more than one place — it must follow publishKb alone");
});

test("CHROME: the long press suppresses its own contextmenu, coarse only", () => {
  // In Chrome, a tap-and-hold with the keyboard open must not close the
  // keyboard (Firefox does not have the problem).
  // Chrome-Android raises `contextmenu` when a press passes its long-press
  // threshold, and running the default action tears down the composer's focus.
  // Firefox Android does not — hence the browser split.
  //
  // `.touch-no-select` does NOT cover it: user-select/-webkit-touch-callout
  // suppress selection and the iOS callout, not the event.
  const src = read("app", "lib", "useLongPress.ts");
  assert.match(src, /onContextMenu: contextMenu/,
    "useLongPress no longer returns onContextMenu — Chrome's native long-press menu is back");
  assert.match(src, /matchMedia\(Q_POINTER_COARSE\)\.matches/,
    "the contextmenu suppression is not gated on a coarse pointer");
  // COARSE ONLY. A chat row has no menu of its own on desktop, so suppressing
  // right-click there would remove copy/inspect from every desktop user.
  const fn = /const contextMenu = useCallback\(([\s\S]*?)\n  \}, \[\]\);/.exec(src)?.[1] ?? "";
  assert.ok(fn, "contextMenu handler not found");
  assert.match(fn, /if \(!window\.matchMedia[\s\S]*?\) return;[\s\S]*?preventDefault/,
    "the fine-pointer early return is gone — desktop right-click would be swallowed");

  // It rides with the gesture, so both rows get it from the spread rather than
  // each remembering to wire it.
  for (const p of ROWS) assert.match(read(...p), /\{\.\.\.longPress\}/,
    `${p.join("/")} no longer spreads the long-press handlers — it would miss onContextMenu`);
});

test("the downvote fade dims the message, NOT the toolbar", () => {
  // A downvoted message's hover controls must be as solid as an upvoted one's.
  // `opacity` on the row applies to the whole subtree and a child cannot undo
  // it, so the toolbar would fade with the message; upvoted rows sit at
  // opacity 1, hence the asymmetry.
  const src = read(...CHAT);
  assert.doesNotMatch(src, /opacity: msg\.deleted \? undefined : downvoteOpacity/,
    "the fade is back on the ROW — opacity groups the whole subtree and takes the toolbar with it");
  assert.match(src, /data-dim=/, "the row no longer publishes data-dim");
  assert.match(src, /"--row-dim": downvoteOpacity/, "the row no longer publishes --row-dim");

  const rule = CSS.match(/\.chat-msg-row\[data-dim\] > ([^{]*)\{([^}]*)\}/);
  assert.ok(rule, "no [data-dim] child rule — nothing consumes --row-dim");
  assert.match(rule[1] ?? "", /:not\(\.row-actions\)/,
    "the toolbar is not excluded from the dim");
  // The sticker-boost button drives its own reveal with opacity utilities; an
  // unlayered rule here would silently beat them.
  assert.match(rule[1] ?? "", /:not\(button\)/,
    "the boost button is not excluded — its opacity-based reveal would be overridden");
  assert.match(rule[2] ?? "", /opacity: var\(--row-dim/, "the rule does not apply --row-dim");
  // The transition has to follow the property it animates.
  assert.match(rule[2] ?? "", /transition: opacity/, "the fade became a jump — no transition on the dimmed children");
});

test("a long-pressed row reads as selected, and stays so through a scroll", () => {
  // A tap-and-held message is highlighted as selected and stays selected even
  // while scrolling, until tapped away or something else is interacted with.
  const src = read(...CHAT);
  assert.match(src, /const rowBg = selected \|\| barOpen/,
    "a long-pressed row no longer takes the selected treatment");
  // The event-row tint is an INLINE style, so it beats rowBg's class; without
  // barOpen in its guard an event row would show no selection at all.
  assert.match(src, /isEventRow && !highlightLook && !selected && !barOpen/,
    "the event-row tint would paint over the selection on system rows");
  // The paid-highlight card fill is inline for the same reason (its accent is
  // the platform color) — it must yield to selection the same way, or a
  // long-pressed highlight card would show no selection at all.
  assert.match(src, /highlightLook && !selected && !barOpen/,
    "the highlight card fill would paint over the selection");
  // Surviving a scroll is `touch: false` on the outside-click, NOT the absence
  // of a scroll listener (checking for the listener's absence passes while the
  // device still dismisses on every flick).
  // useOutsideClick's touchstart fires on the FIRST TOUCH of a scroll, before the
  // browser knows it is a scroll. mousedown is the right signal on touch too: a
  // tap synthesises one, a scroll does not.
  for (const p of ROWS)
    assert.match(read(...p), /useOutsideClick\(barRef, closeBar, \{ enabled: barOpen, escape: true, touch: false \}\)/,
      `${p.join("/")} closes the row menu on touchstart — every scroll dismisses it`);
});

test("a vote leaves the menu open; a one-shot action closes it", () => {
  const chat = read(...CHAT);
  // Vote handlers must NOT close — they are toggles the user may repeat.
  for (const m of chat.match(/onClick=\{\(\) => onVote\([^}]*\}/g) ?? [])
    assert.doesNotMatch(m, /closeBar/, "voting closes the menu — it must stay open");
  assert.ok((chat.match(/onClick=\{\(\) => onVote\(/g) ?? []).length === 2, "expected both vote buttons");
  // Reply / copy / ⋯ are one-shot: they hand off, so they dismiss. (Pin and
  // delete live in the ⋯ menu — the menu's items dismiss through their own
  // onClose.)
  // ⋯'s dismiss is CONDITIONAL: a keyboard activation (click
  // detail 0) holds the bar instead, because the context menu returns focus to
  // this button on close and a display:none target silently refuses focus —
  // contextMenuKeyboard.test.ts owns that half; the pointer flow still
  // dismisses, which is what this test pins.
  for (const re of [/onReply\(msg\); closeBar\(\)/, /copyText\(msg\.message\); closeBar\(\)/,
                    /setCtxMenu\(\{ x: r\.left[\s\S]{0,160}if \(e\.detail === 0\) setBarOpen\(true\); else closeBar\(\)/])
    assert.match(chat, re, `a one-shot action no longer dismisses the menu: ${re}`);
  // Matrix: reactions are the repeatable ones there.
  const mx = read(...MATRIX);
  assert.doesNotMatch(mx, /toggleReaction\(k\); saveRecentReaction\(k\); closeBar/,
    "reacting closes the Matrix menu — reactions are toggles, same as votes");
  for (const re of [/onReply\(ev\); closeBar\(\)/, /onOpenThread\?\.\(ev\); closeBar\(\)/])
    assert.match(mx, re, `a one-shot Matrix action no longer dismisses the menu: ${re}`);
});

test("and neither does tapping the message body itself", () => {
  // Coarse-only, or desktop drag-selection dies with it (keepFocus.ts).
  for (const p of ROWS) {
    assert.match(read(...p), /onMouseDown=\{keepFocusCoarse\}/,
      `${p.join("/")}'s row does not hold focus on tap — the biggest target on screen drops the keyboard`);
  }
});
