// Composer bar layout guards.
//
// These are static source checks rather than behavioural tests because what
// changed is WHERE controls live, not what they do — and the failure mode of a
// regression is purely visual, so nothing else would catch it.
//
// The arrangement being pinned:
//
//   [pfp] [send-to] │ type a message…            ☺  ⋮ │ [send]
//    UserMenu  SendToButton      ChatComposerField      submit
//                                     emote ↗   ↖ trailing
//
// Run: node --test app/lib/composerLayout.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments, stripCssComments } from "./testSource.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(join(webRoot, p), "utf8");

/**
 * Strip comments before any positional scan. This is not hypothetical caution:
 * the first version of the ordering test below failed because
 * ChatComposerField's doc comment mentions `chat-emote-btn-on` several lines
 * ABOVE the `{trailing}` slot, so indexOf found the prose, not the button.
 * Same trap the wsFrames contract guard documents.
 */
const readCode = (p: string) => stripComments(read(p));

// ── The row's shape ──────────────────────────────────────────────────────────

test("every control in the row shares ONE size and skin", () => {
  // The defect this exists to prevent: each control arriving with its own
  // sizing system — `chatFontCalc(1.8)`, `h-7 w-7`, `self-stretch px-3`,
  // `px-1.5 self-stretch`, `1.9em` — gives four diameters in one row (the
  // attach button smaller than send-to). One module owns it.
  for (const f of [
    "app/components/SendToButton.tsx",
    "app/components/ComposerToolsPopover.tsx",
    "app/components/MatrixInput.tsx",
  ]) {
    // Asserts ctlBox is APPLIED, not merely imported. Matching the bare name
    // would pass against the import line alone.
    assert.match(readCode(f), /style=\{(?:\{[^}]*)?\.\.\.ctlBox|style=\{ctlBox\}/,
      `${f} must apply the shared control size, not just import it`);
  }
  // DERIVED, not a measured multiplier. An eyeballed `chatFontCalc(1.8)`
  // runs ~6px short of the field's real single-line height at the default
  // chat size — so the buttons would never quite match the box beside them,
  // and clamping the collapsed field to that value would squeeze its text.
  const ctl = readCode("app/lib/composerControls.ts");
  assert.match(ctl, /CTL_SIZE = "var\(--composer-ctl\)"/,
    "the diameter must come from the derived token, not a hand-picked multiplier");
  assert.doesNotMatch(ctl, /chatFontCalc\(1\.8\)/, "the eyeballed multiplier must be gone");
  const css = read("app/globals.css");
  assert.match(css, /--composer-line: calc\(var\(--chat-font-size[^)]*\) \* 1\.25\)/,
    "the line box must use the field's own leading-tight");
  assert.match(css, /--composer-ctl:\s+calc\(var\(--composer-line\) \+ 0\.5rem \+ 2px\)/,
    "plus the field's own py-1 and border — same terms, so they cannot disagree");
});

test("exactly ONE control in the row is filled — the send button", () => {
  // That is what makes it read as the primary action instead of one button among
  // five. Secondary controls are outlined.
  const ctl = readCode("app/lib/composerControls.ts");
  assert.match(ctl, /bg-surface-2 border-edge text-secondary/,
    "the shared skin must be an OUTLINE, not a fill");
  const input = readCode("app/features/chat/ChatInput.tsx");
  const send = input.slice(input.indexOf('type="submit"'));
  assert.match(send, /backgroundColor: sendBtnColor/, "send is the filled one");
  assert.match(send, /rounded-full/);
});

test("the tools button is OUTSIDE the typing field", () => {
  // The tools button is outside the input bar, not inside it. Not just
  // cosmetic — inside, the field would have to reserve right-hand padding for
  // it (a four-way `has-tools` padding matrix in globals.css).
  const field = readCode("app/components/ChatComposerField.tsx");
  assert.doesNotMatch(field, /ComposerToolsPopover|trailing/,
    "the field must no longer host the tools control at all");

  const input = readCode("app/features/chat/ChatInput.tsx");
  const toolsAt = input.indexOf("<ComposerToolsPopover");
  const fieldAt = input.indexOf("<ChatComposerField");
  const sendAt = input.indexOf('type="submit"');
  assert.ok(toolsAt !== -1 && fieldAt !== -1, "both must be siblings in the row");
  // + on the right side. It pairs with send — the two controls that act on
  // the OUTGOING message sit together at the end of the row.
  assert.ok(fieldAt < toolsAt, "the tools button follows the field, not leads it");
  assert.ok(toolsAt < sendAt, "and sits just before send");
});

test('the tools trigger is a "+"', () => {
  // "+" is the familiar "attach something to this message" affordance when it
  // is a leading control, and a poll, a spend and a sticker are all exactly
  // that.
  const pop = readCode("app/components/ComposerToolsPopover.tsx");
  assert.match(pop, /<Plus /, "the trigger should be Plus (+)");
  assert.doesNotMatch(pop, /DotsThreeVertical|Sparkle/, "the superseded icons must be gone");
});

test("the field's right inset is now ONE rule, not a four-way matrix", () => {
  // The payoff of moving the tools button out: only the emote button lives inside
  // the box, so the padding has one switch instead of `has-tools` ×
  // `chat-emote-btn-on`.
  const css = read("app/globals.css");
  assert.match(css, /\.chat-emote-btn-on \.chat-input-field \{ padding-right: 2\.4rem; \}/);
  assert.doesNotMatch(css, /\.has-tools|\.tools-collapsed/,
    "the has-tools / tools-collapsed SELECTORS must be gone with the button");
});

test("the field reads as a WELL against raised controls", () => {
  // Both at surface-2 made the row one undifferentiated grey slab.
  const field = readCode("app/components/ChatComposerField.tsx");
  assert.match(field, /bg-surface-1/, "the field sits a step deeper than the row");
  assert.match(field, /rounded-full/, "and is a pill");
});

// ── Popovers ────────────────────────────────────────────────────────────────

test("composer popovers are portalled, so no ancestor can clip them", () => {
  // The composer sits inside a chat column that is `overflow: hidden`, so a
  // menu taller than the space above the field would be CUT OFF from the top —
  // taking the emote search box with it. Measuring-and-shrinking is a
  // workaround for being in the wrong box; a portal is the fix.
  const pop = readCode("app/components/ComposerPopover.tsx");
  assert.match(pop, /createPortal\(/, "must render at <body>");
  assert.match(pop, /visualViewport/, "and size itself against the KEYBOARD-AWARE viewport");
  assert.match(pop, /translateY\(-100%\)/,
    "anchored by its bottom edge, so a short menu hugs its trigger and a tall one grows up");
  assert.doesNotMatch(pop, /innerHeight/,
    "innerHeight counts the area behind the keyboard on iOS — client coords only");

  for (const f of ["app/components/EmotePicker.tsx", "app/components/ComposerToolsPopover.tsx"]) {
    assert.match(readCode(f), /ComposerPopover/, `${f} must use the portal`);
    assert.doesNotMatch(readCode(f), /absolute bottom-full/,
      `${f} must not position itself inside the clipping column any more`);
    assert.doesNotMatch(readCode(f), /z-50/,
      `${f} must not carry its own stacking guess — the portal owns z-index`);
  }
});

test("a popover mounts its children in the first commit, and hides by opacity", () => {
  // `!box → return null` would withhold the children for one commit, so a
  // child's MOUNT EFFECT runs against a ref that is still null and fails
  // silently: EmotePicker's `searchRef.current?.focus()` no-ops (opening the
  // sticker menu leaves focus on <body> — not the search box, not the
  // composer), and SupportPanel's scroll-to-newest no-ops (a reopened thread
  // sits at the OLDEST line). Only the discrete-event path inverts the order
  // that way, which is why it can read as correct — and every real open is a
  // click.
  //
  // The two halves are pinned separately because fixing ONLY the first LOOKS
  // like a fix — the ref goes non-null — while focus stays broken: a
  // `visibility: hidden` node cannot take focus.
  const pop = readCode("app/components/ComposerPopover.tsx");

  const earlyReturns = pop.match(/if \([^)]*\) return null;/g) ?? [];
  assert.deepEqual(earlyReturns, ['if (typeof document === "undefined") return null;'],
    "the ONLY early return may be the SSR guard — anything gated on `box` costs the children a commit");

  assert.match(pop, /opacity: 0/,
    "an unplaced popover is laid out but not painted");
  for (const hidden of [/visibility: ["']hidden["']/, /display: ["']none["']/]) {
    assert.doesNotMatch(pop, hidden,
      "must not hide with visibility/display — a hidden node cannot take focus, which is the bug");
  }

  assert.match(readCode("app/components/EmotePicker.tsx"), /searchRef\.current\?\.focus\(\)/,
    "the picker still focuses its search box on open");
});

test("a portalled popover is watched by a ref INSIDE it, or every tap reads as outside", () => {
  // On a phone, the + menu must select when a row is tapped.
  //
  // `useOutsideClick` decides inside/outside with `ref.current.contains(target)`,
  // which walks the DOM. A portal puts the menu under <body>, so a ref on the
  // wrapper that holds it in the REACT tree contains nothing of it. Every press
  // on a row would therefore be an outside press.
  //
  // Why only mobile: ComposerPopover stops `mousedown`, so the document listener
  // never fires for a mouse. The hook ALSO listens for `touchstart`, which
  // nothing stops — the menu would unmount before the tap became a click, so no
  // row would ever receive it. The class of bug is invisible in a desktop
  // browser and in any headless run that synthesises mouse events.
  //
  // Pinned as a rule rather than a patch, because it bites the next portalled
  // popover exactly the same way.
  const pop = readCode("app/components/ComposerPopover.tsx");
  const portalAt = pop.indexOf("createPortal(");
  assert.notEqual(portalAt, -1, "ComposerPopover no longer portals");
  const portal = pop.slice(portalAt);
  // Both offsets are measured from `portal`, not from 0. An end offset searched
  // from the start of the FILE lands before the start of the slice and yields an
  // empty string — an assertion that then fails on correct code.
  const rootAt = portal.indexOf("ref={innerRef}");
  assert.notEqual(rootAt, -1,
    "innerRef must be ATTACHED, not merely accepted — a prop that goes nowhere " +
    "leaves the caller's containment check passing and still broken");
  assert.ok(rootAt < portal.indexOf("{children}"),
    "innerRef belongs on the portal root, above the children");

  for (const f of ["app/components/ComposerToolsPopover.tsx", "app/components/EmotePicker.tsx"]) {
    const src = readCode(f);
    if (!/useOutsideClick\(/.test(src)) continue;   // nothing to dismiss, nothing to get wrong
    const call = src.match(/useOutsideClick\(\s*(\[[^\]]*\]|[A-Za-z_$][\w$]*)/);
    const args = call?.[1];
    assert.ok(args, `${f}: useOutsideClick call not in a shape this guard can read`);
    const watched = args.match(/[A-Za-z_$][\w$]*/g) ?? [];

    const open = src.indexOf("<ComposerPopover");
    const close = src.indexOf("</ComposerPopover>", open);
    assert.ok(open !== -1 && close > open, `${f}: could not bound the popover element`);
    const tag = src.slice(open, src.indexOf(">", open));
    const inside = src.slice(open, close);

    // Contained = handed back as the portal root (innerRef), or attached to
    // something the popover actually renders. Either proves DOM ancestry.
    const contained = watched.filter(
      (r) => new RegExp(`innerRef=\\{${r}\\}`).test(tag) || new RegExp(`\\bref=\\{${r}\\}`).test(inside),
    );
    assert.ok(
      contained.length > 0,
      `${f}: useOutsideClick watches [${watched.join(", ")}], none of which live inside the ` +
      `portal — presses on the menu will read as outside and dismiss it before they land`,
    );
  }
});

// ── Behaviour while composing ───────────────────────────────────────────────

test("exactly the excepted controls survive while composing", () => {
  const input = readCode("app/features/chat/ChatInput.tsx");
  const field = readCode("app/components/ChatComposerField.tsx");

  // Focus AND text, not text alone: a draft you have clicked away from must
  // hand its space back to the chat instead of sitting there several lines
  // tall, and clicking back in with text expands it again.
  assert.match(input, /const composing = focused && input\.trim\(\)\.length > 0;/,
    "expansion must require focus AND text");
  assert.match(input, /onFocus=\{\(\) => setFocused\(true\)\}/, "focus must be tracked");
  assert.match(input, /onBlur=\{\(\) => setFocused\(false\)\}/, "and released on blur");
  assert.match(input, /collapsed=\{composing\}/, "the tools control folds");
  // The destination folds first. (The terminal's `>_` lives on the chat's top bar —
  // ChatTabBar.tsx, chatTakeover.test.ts.)
  assert.match(input, /composer-collapsible[\s\S]{0,300}?<SendToButton/, "the destination folds");
  assert.doesNotMatch(input, /aria-label="Terminal"/, "the terminal button left the chat box");

  assert.doesNotMatch(field, /composer-collapsible/,
    "nothing inside the field folds — the emote button is on the exception list");
  assert.doesNotMatch(input, /composer-collapsible[^>]*>\s*<UserMenu/, "the pfp never folds");
});

test("the collapse is animated and honours reduced motion", () => {
  const css = read("app/globals.css");
  const block = css.slice(css.indexOf(".composer-collapsible"));
  assert.match(block, /transition:[\s\S]{0,160}?max-width/,
    "max-width, not width — an auto-width control does not transition");
  assert.match(block, /pointer-events: none/, "a mid-fade control must not eat a tap");
  assert.match(css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)", css.indexOf(".composer-collapsible"))).slice(0, 220),
    /composer-collapsible \{ transition: none/, "instant under reduced motion");
});

test("both ends of the row carry the destination once send-to folds away", () => {
  // The destination folds while composing, so for the length of a message the
  // row would otherwise say NOTHING about where it is going — the exact failure
  // cross-window scoping exists to stop, one layer up.
  // The FIELD carries it too, and both consumers read one `composerAccent`
  // call — the precedence itself is pinned in sendDestination.test.ts,
  // including that it is computed exactly once.
  const input = readCode("app/features/chat/ChatInput.tsx");
  assert.match(input, /const accent = composerAccent\(/);
  assert.match(input, /sendBtnColor = accent \?\?/, "the send button lost the signal");
  assert.match(input, /accentColor=\{accent\}/, "the field lost the signal");
});

// ── Keyboard ────────────────────────────────────────────────────────────────

// A COUNT per file, not "at least one match" (R-17). The old assertion would
// have passed with six of ChatMessage's seven controls still dropping the
// keyboard — one lucky match anywhere in a file said nothing about the rest of
// it. Update a number here when you add or remove a control; that is the point.
const KEEP_FOCUS_SITES: Array<[string, number]> = [
  // The composer row itself.
  ["app/components/SendToButton.tsx", 4],         // send-to + its menu's items + the bound face + the help-desk indicator (shown only while support is live)
  ["app/components/ComposerToolsPopover.tsx", 1],
  ["app/components/ChatComposerField.tsx", 2],    // emote button + the refusal note's ✕ (U1 rework)
  ["app/components/MatrixInput.tsx", 2],          // attach + send (R-11)
  // The message row and everything that hangs off it.
  // The 9th is the row toolbar's own CONTAINER, not a button: its padding and
  // inter-button gaps are tappable surface, and a press on a non-focusable
  // element still blurs the composer (a tap-hold on a message while the
  // keyboard is open would close the keyboard).
  ["app/features/chat/ChatMessage.tsx", 8],       // name · ▲ · ▼ · ↩ · ⎘ · ⋯ · ⚡ · the bar itself (📌/🗑 live in the ⋯ menu)
  // The Matrix timeline's row — the whole community client — hangs off the
  // message row too: all five of its toolbar controls must hold the keyboard,
  // as ChatMessage's equivalents do. A census with a hole in it reads exactly
  // like a census without one.
  ["app/components/MatrixMessageRow.tsx", 7],     // recent-react · 🙂 · ↩ · thread · ⋯ · the bar itself · "(edited)" (⑥)
  ["app/features/chat/ChatInput.tsx", 4],         // reply-clear ✕ + send (R-11) + the failed-line Retry and ✕; the terminal `>_` moved to the top bar (4a follow-up)
  ["app/features/chat/SpendChip.tsx", 1],         // ✕ only — Top up deliberately does NOT (carve-out #2, pinned below)
  ["app/features/chat/StickerBoostPopover.tsx", 3],
  ["app/components/PollCard.tsx", 4],             // vote + extend/end/cancel
  ["app/components/ContextMenu.tsx", 1],          // shared MenuItem — covers both menus
  ["app/components/EmotePicker.tsx", 1],          // provider filters (chrome Chips, onItemMouseDown)
  ["app/components/RedactedText.tsx", 1],         // tap-to-open redacted bars
  ["app/lib/renderText.tsx", 1],                  // copy-full-link
];

test("chat interactions never steal focus from the composer", () => {
  for (const [f, n] of KEEP_FOCUS_SITES) {
    // The lookahead keeps `keepFocusCoarse` — the row-body variant, pinned in
    // its own test below — out of the per-control count. `on(?:Item)?MouseDown`
    // also catches the chrome `Chips` indirection (EmotePicker's provider
    // filters): the skin forwards its own `onMouseDown` from a prop named
    // `onItemMouseDown`, so the literal `onMouseDown={keepFocus}` pairing does
    // not live in the same file as the button — only the prop assignment
    // does, and that is still the real site.
    const hits = readCode(f).match(/on(?:Item)?MouseDown[=:] ?\{?keepFocus(?![A-Za-z])/g) ?? [];
    assert.equal(hits.length, n,
      `${f}: expected ${n} keepFocus sites, found ${hits.length} — a control that ` +
      `drops the soft keyboard mid-conversation`);
  }
});

test("the message row keeps the keyboard on a body tap, coarse pointers only", () => {
  // The row is a plain div, so the biggest target in chat — the message text —
  // blurs the composer with no button involved. It has to be the COARSE variant:
  // a bare preventDefault here would take desktop drag-selection with it, which
  // globals.css deliberately keeps (`.touch-no-select` is `pointer: coarse`).
  const row = readCode("app/features/chat/ChatMessage.tsx");
  assert.match(row, /onMouseDown=\{keepFocusCoarse\}/, "the row body lost its keepFocus");
  const helper = readCode("app/lib/keepFocus.ts");
  // The query is the shared Q_POINTER_COARSE constant now (deviceQueries.ts);
  // the GATE is what this pins, not the spelling.
  assert.match(helper, /matchMedia\(Q_POINTER_COARSE\)\.matches/,
    "keepFocusCoarse must gate on the pointer, or it kills desktop selection");
});

test("the store carve-out stays a carve-out", () => {
  // "Top up" REPLACES the view; holding the keyboard there parks it on top of
  // the store. This is the exhibit for the second carve-out in keepFocus.ts, so
  // it is pinned rather than left to be helpfully "fixed" later — dropping the
  // affordance here would otherwise be a silent regression.
  const chip = readCode("app/features/chat/SpendChip.tsx");
  const at = chip.indexOf("bb:open-store");
  assert.ok(at > 0, "the Top up button moved — re-point this pin");
  // A window on BOTH sides: a prop added above the onClick would slip past a
  // forward-only slice, and that is exactly how a carve-out gets "fixed".
  const topUp = chip.slice(at - 200, at + 300);
  assert.ok(!/onMouseDown=\{keepFocus\}/.test(topUp),
    "the Top up button must NOT keep focus — it opens a full panel");
});


// ── Matrix parity ───────────────────────────────────────────────────────────

test("the Matrix composer behaves like the live-chat one", () => {
  const mx = readCode("app/components/MatrixInput.tsx");
  assert.match(mx, /const composing = focused && value\.trim\(\)\.length > 0;/, "same expand rule");
  assert.match(mx, /composer-collapsible[\s\S]{0,400}?data-collapsed=\{composing/,
    "attach folds while composing");
  assert.match(mx, /ctlClass\(false\)[\s\S]{0,200}?style=\{ctlBox\}/,
    "attach uses the shared size and skin");
  assert.match(mx, /gap: "var\(--composer-gap\)"/, "and the same row gap token");
});

// ── Growing and shrinking ────────────────────────────────────────────────────

test("a collapsed control gives back its GAP, not just its width", () => {
  // The space between a button and the pfp must equal the space between the
  // expanded input and the pfp while typing. A flex row separates every PAIR
  // of children, so a control at max-width:0 still costs the gap on each side
  // of it — one whole gap of dead space stranded per folded button, which the
  // field would never reclaim.
  const css = read("app/globals.css");
  assert.match(css, /--composer-gap:/, "the gap must be a token, not a literal in two places");
  assert.match(css, /margin-inline-end: calc\(var\(--composer-gap\) \* -1\)/,
    "a collapsed control must cancel exactly one gap");
  const input = readCode("app/features/chat/ChatInput.tsx");
  assert.match(input, /gap: "var\(--composer-gap\)"/,
    "and the row must use that same token, or the cancellation is the wrong size");
});

test("the pill relaxes when the field grows to several lines", () => {
  // A 999px radius curves inward across a multi-line box and clips the first and
  // last characters of the top and bottom rows.
  const css = read("app/globals.css");
  assert.match(css, /\.chat-input-field \{\s*border-radius: 999px;/, "one line = a pill");
  assert.match(css, /\.chat-input-field\.is-expanded \{ border-radius: 1rem; \}/,
    "grown = a rounded rectangle, so the curve stops eating letters");
  assert.match(css, /transition:[\s\S]{0,200}?border-radius/, "and it animates between them");

  const field = readCode("app/components/ChatComposerField.tsx");
  assert.match(field, /expanded \? " is-expanded" : ""/, "driven by the expanded flag");
});

test("the field collapses vertically when you click away", () => {
  // Otherwise a five-line draft keeps eating the chat while you read.
  const field = readCode("app/components/ChatComposerField.tsx");
  assert.match(field, /maxHeight: expanded \? `calc\(\$\{CHAT_FONT\} \* 7\)` : CTL_SIZE/,
    "collapsed height is the control diameter, so the field lines up with the buttons");
  const css = read("app/globals.css");
  assert.match(css, /transition:[\s\S]{0,200}?max-height/, "and the shrink is animated");
});

// ── The placeholder must not be able to resize the field ─────────────────────
//
// At 390px "Send a message…" would wrap to two lines, push the field past its
// collapsed ceiling and make `overflow-y: auto` paint a scrollbar beside an
// EMPTY field.
//
// The cause is that a textarea's placeholder is real content for
// `fieldSizing: content` and wraps like any other text. ::placeholder cannot be
// told otherwise — per spec it only takes the ::first-line properties, so
// `white-space`/`text-overflow` do not apply — and the textarea itself cannot be
// `nowrap` without breaking every genuine multi-line draft.

test("the placeholder cannot change the field's height at any width", () => {
  const field = readCode("app/components/ChatComposerField.tsx");
  // (a) No native placeholder attribute — that is the thing that wrapped.
  assert.doesNotMatch(field, /placeholder=\{placeholder\}/,
    "the native placeholder is back; it wraps and re-grows the field at narrow widths");
  // (b) It is rendered as an absolutely-positioned overlay, so it contributes
  //     nothing to `fieldSizing: content` whatever it says or how narrow it gets.
  assert.match(field, /chat-input-placeholder[^"]*absolute[^"]*inset-0/,
    "the overlay must be absolutely positioned or it feeds content sizing again");
  // (c) …and it truncates rather than wrapping.
  assert.match(field, /chat-input-placeholder[^"]*truncate/,
    "the overlay must truncate — that is the whole reason it is not ::placeholder");
  // (d) Only while EMPTY, or it would sit on top of the user's text.
  // The refusal note (U1 rework) takes the placeholder's place: the same gate,
  // and also an absolute overlay — the note must not grow the field either.
  assert.match(field, /\{!value && !note && placeholder &&/,
    "the overlay must be gated on an empty field");
  assert.match(field, /\{!value && note &&/, "the note shows only in an empty field");
  assert.match(field, /data-refusal-note[\s\S]{0,120}className="absolute inset-y-0/,
    "the note is an absolutely-positioned overlay, like the placeholder");
});

test("dropping the native placeholder keeps the field's accessible name", () => {
  // The placeholder WAS the accname (neither caller passes a label), so removing
  // it without replacement would have quietly unlabelled the app's main input.
  const field = readCode("app/components/ChatComposerField.tsx");
  assert.match(field, /aria-label=\{placeholder\}/,
    "the textarea lost its accessible name along with the native placeholder");
  assert.match(field, /aria-hidden="true"/,
    "the overlay must be hidden from the a11y tree, or the name is announced twice");
});

test("the input scrolls only when it can actually overflow", () => {
  // No scrollbar in the input — but it cannot go unconditionally:
  // a real draft past the expanded 7-line ceiling still has to scroll. Collapsed,
  // the field holds one line, so `auto` there could ONLY ever produce the
  // phantom bar.
  const field = readCode("app/components/ChatComposerField.tsx");
  assert.match(field, /overflowY: expanded \? "auto" : "hidden"/,
    "collapsed must be hidden and expanded must still scroll");
});

test("the overlaid placeholder shares the field's right inset", () => {
  // Otherwise the ellipsis is computed against the full width and the text
  // slides under the emote button before it ever truncates.
  const css = read("app/globals.css");
  assert.match(css, /\.chat-emote-btn-on \.chat-input-placeholder \{ padding-right: 2\.4rem; \}/,
    "the overlay's inset must track the field's");
  // Both rules carry the SAME value — a dual-maintenance pair, so pin it.
  const field = css.match(/\.chat-emote-btn-on \.chat-input-field \{ padding-right: ([^;]+); \}/);
  const ph = css.match(/\.chat-emote-btn-on \.chat-input-placeholder \{ padding-right: ([^;]+); \}/);
  assert.ok(field && ph, "one of the two inset rules is missing");
  assert.equal(ph![1], field![1], "the field and its placeholder drifted apart");
});

test("a grown composer says so — data-chrome-grow, keyed off the FIELD, so both composers grow their Bar", () => {
  // A class-based version would only ever apply to live chat (the
  // Matrix composers' <form> lives in Timeline/ThreadPanel while the expanded
  // state lives inside MatrixInput). The field itself carries the grow flag,
  // so there is nothing to plumb and nothing to forget — for either.
  // Through the shared stripper, like every other CSS read in the suite: an
  // unstripped file lets a rule that only exists in a COMMENT satisfy the match.
  const chrome = stripCssComments(readFileSync(join(process.cwd(), "app", "components", "chrome", "chrome.css"), "utf8"));
  assert.match(chrome, /\.chrome-bar-bottom:has\(\[data-chrome-grow\]\)\s*\{[^}]*height:\s*auto/);
  const field = readCode("app/components/ChatComposerField.tsx");
  assert.match(field, /data-chrome-grow=\{expanded \|\| undefined\}/, "the field flags its own growth");
  // Every in-flow row above the live composer's main row flags growth too — and
  // the flag is pinned on that row's OWN element. A regex that merely finds the
  // row's text somewhere near a `data-chrome-grow` passes while the attribute
  // sits on a different row entirely.
  const input = readCode("app/features/chat/ChatInput.tsx");
  const REPLY_BANNER = 'className="flex items-center gap-2 px-2 py-1 bg-surface-1 border border-edge rounded mb-1"';
  for (const row of [
    /role="alert"[^>]*data-chrome-grow|data-chrome-grow[^>]*role="alert"/,
    new RegExp(`<div ${REPLY_BANNER}[^>]*data-chrome-grow|data-chrome-grow[^>]*${REPLY_BANNER}`),
  ]) {
    assert.match(input, row, "a status/reply row lost its grow flag — it would overflow a 48px bar");
  }
  assert.equal((input.match(/data-chrome-grow/g) ?? []).length, 5, "sendError, failed-line retry, notice, slow-mode, reply banner");
  assert.match(readCode("app/features/chat/SpendChip.tsx"), /data-chrome-grow/, "the spend chip is an in-flow row");
});

test("every composer is a bottom Bar — five mount points, one primitive", () => {
  // The live and Matrix input bars must sit identically. One primitive:
  // live chat's wrapper (signed in / signed-out CTA / banned), Timeline,
  // ThreadPanel.
  const sidebar = readCode("app/features/chat/ChatSidebar.tsx");
  assert.match(sidebar, /<Bar\s+slot="bottom"\s+name="chat-bottom"/);
  // …and all THREE live branches are inside it. Rendering the Bar while one
  // branch stayed outside is the drift this whole task deletes, and a match
  // anywhere in the file cannot tell the two apart — so cut the element out and
  // look in it.
  const at = sidebar.search(/<Bar\s+slot="bottom"\s+name="chat-bottom"/);
  // The element's own closing `/>` is at the Bar's indentation; every nested
  // self-closing tag inside it is indented deeper, so this cannot end early.
  // The indentation is DERIVED from the match, not spelled as a literal: if
  // the Bar's indentation changes, a hard-coded needle would silently match a
  // `/>` hundreds of lines LATER — every assertion below still passing, over a
  // slice that is most of the file. A derived indent cannot go vacuous that way.
  const indent = " ".repeat(at - (sidebar.lastIndexOf("\n", at) + 1));
  const end = sidebar.indexOf(`\n${indent}/>`, at);
  assert.ok(at !== -1 && end > at, "could not isolate the chat-bottom Bar element");
  const bar = sidebar.slice(at, end);
  for (const branch of ["<ChatInput", "Sign in to chat", "You are banned from chat."]) {
    assert.ok(bar.includes(branch), `${branch} is not inside the chat-bottom Bar`);
  }
  for (const f of ["app/features/community/Timeline.tsx", "app/features/community/ThreadPanel.tsx"]) {
    assert.match(readCode(f), /<Bar\s+slot="bottom"\s+name="mx-composer"/, `${f} must render a bottom Bar`);
    assert.doesNotMatch(readCode(f), /composer-shell|p-2 border-t border-edge shrink-0/, `${f} must not re-inline the shell`);
  }
  assert.doesNotMatch(readCode("app/features/chat/ChatInput.tsx"), /composer-shell/);
  assert.doesNotMatch(read("app/globals.css"), /composer-shell/, "the shell class is gone from globals.css");
});

test("both panels' bottom bars are the SAME token tall — a height, not a floor", () => {
  // A floor (rather than a height) is what would let the meta bar open a
  // second row under the composer's baseline. One token, one height, applied
  // by Bar (chrome.css).
  // stripCssComments, NOT a local block-comment regex: every test file strips
  // through the one shared helper (testSource.test.ts refuses a private copy
  // anywhere under app/ — diverging copies are how stripping goes wrong).
  const chrome = stripCssComments(readFileSync(join(process.cwd(), "app", "components", "chrome", "chrome.css"), "utf8"));
  assert.match(chrome, /\.chrome-bar-bottom\s*\{[^}]*height:\s*var\(--chrome-bottom-h\)/);
  assert.doesNotMatch(chrome, /min-height/);
  assert.doesNotMatch(read("app/globals.css"), /--bottom-bar-h/, "the old floor token is gone — the alias too");
  assert.match(readCode("app/components/StreamMetaBar.tsx"), /<Bar\s+slot="bottom"/);
});

test("the focused field has ONE crisp edge, not a ring over a border", () => {
  // A 1px ring is a box-shadow just outside a 1px border in a near-identical
  // colour — two soft edges stacked, which reads as thick and blurry.
  const field = readCode("app/components/ChatComposerField.tsx");
  assert.doesNotMatch(field, /focus:ring/, "no ring — the border carries focus");
  assert.match(field, /focus:border-edge-bright/, "brightened one step instead");
});

// ONE MECHANISM, EVERY PLATFORM — no per-browser branch, no early return.
//
// A Chromium-PWA branch that opted into `virtualKeyboard.overlaysContent` and
// let the compositor drive the shell via `env(keyboard-inset-height)` would
// return BEFORE `start()`, so an installed PWA would run none of the
// prediction, none of the discrete commit and none of the transition — and
// keyboard work would never reach installed-app users. Its justification
// (env() is compositor-published, so nothing arrives late) does not apply:
// we do not follow the keyboard per frame at all, so a late signal costs
// nothing.
test("there is no per-platform keyboard branch, and nothing returns before start()", () => {
  const hook = readCode("app/lib/useViewportHeightVar.ts");

  assert.doesNotMatch(hook, /overlaysContent\s*=\s*true/,
    "something opted back into the VirtualKeyboard overlay tier. That silently bypasses the " +
    "whole measuring path in an installed PWA, and per spec it also overrides the " +
    "interactive-widget meta");
  assert.doesNotMatch(hook, /geometrychange/,
    "the env()/geometrychange tier is back alongside the measuring path");

  // The ?kbdebug readout deliberately PRINTS `display-mode: standalone` — that
  // reading is exactly what shows which code path a device is running. So the
  // invariant is "no standalone check in the MEASURING path", not "nowhere in
  // the file"; the diagnostics block is excised first, and both of its markers
  // are asserted so that silently scanning everything cannot pass. Same idiom
  // as the window.innerHeight guard below.
  const dbgAt = hook.indexOf("let dbgTimer");
  const dbgEnd = hook.indexOf("const stopDbg");
  assert.ok(dbgAt !== -1 && dbgEnd !== -1 && dbgAt < dbgEnd,
    "the diagnostics block moved — re-anchor this excision");
  const measuring = hook.slice(0, dbgAt) + hook.slice(dbgEnd);
  assert.doesNotMatch(measuring, /display-mode: standalone/,
    "a PWA-only gate is back in the measuring path — an installed app must run exactly the " +
    "same code as a tab");

  // Structural: `start()` must be reachable unconditionally. Any `return` before
  // it inside the effect is a platform opting itself out.
  const effectAt = hook.indexOf("const touchPrimary");
  const startAt = hook.lastIndexOf("start();");
  const between = hook.slice(effectAt, startAt);
  const guardedReturns = (between.match(/^\s{4}return\b/gm) ?? []).length;
  assert.equal(guardedReturns, 0,
    "an early `return` sits between the effect body and start() — that is how the PWA ended " +
    "up running none of this file. Only the two top-of-effect capability bails (no touch, " +
    "no visualViewport) may skip it, and those precede this slice");

  const css = read("app/globals.css");
  assert.match(css, /\.h-app \{ height: 100dvh; \}/,
    "the CSS fallback tier changed. Nothing sets overlaysContent now, so env(keyboard-inset-" +
    "height) is permanently 0 and subtracting it would be dead arithmetic");
});

// ── The measured root cause of a choppy keyboard ──────────────────────────────
//
// This gets the strictest guard in the file. A `setH` that writes a custom
// property (`--app-vh`) on document.documentElement makes every frame of the
// keyboard a whole-document style recalc: custom properties INHERIT, so a
// per-frame write on the root forces Blink to recalculate computed style for
// every element that inherits it. Measured (390x844 mobile emulation, 4x CPU
// throttle, 12-frame sweep; 10.0ms is the vsync floor):
//
//     --app-vh on :root ......... 39.5 / 42.5 / 39.9 / 40.5 ms   (~25fps)
//     height on html + body ..... 10.0 / 10.0 / 10.0 ms          (= idle)
//
// and proven by SCOPE: the same write costs 10.0ms on a leaf element, 26.1ms on
// the chat aside (1939 descendants), ~40ms on :root (2121). It is invalidation,
// not evaluation — a property NO stylesheet reads still cost 30.4ms.
//
// It hides on an unthrottled DESKTOP, where the frame delta is 10.3 vs 10.0.
// Only the phone (or a throttled emulation) shows it.
test("the shell height is written DIRECTLY, never as a custom property on the root", () => {
  const hook = readCode("app/lib/useViewportHeightVar.ts");

  // Both .h-app elements are written, and both are cleared. layout.tsx puts the
  // class on <html> AND <body>; missing one leaves half the shell stuck.
  assert.match(hook, /root\.style\.height = v;/, "the <html> height write is gone");
  assert.match(hook, /body\.style\.height = v;/,
    "the <body> height write is gone — <body> also carries .h-app, so half the shell would stay put");
  assert.match(hook, /root\.style\.height = "";/, "clearH must release <html> back to the CSS tier");
  assert.match(hook, /body\.style\.height = "";/, "clearH must release <body> back to the CSS tier");

  // THE REGRESSION GUARD. No custom property may be written from this hook at
  // all — not `--app-vh`, not a renamed one, not a registered one. `@property`
  // does NOT make this cheap: it makes a custom property interpolable, but the
  // inheritance still cascades a whole-document style recalc.
  assert.doesNotMatch(hook, /style\.setProperty\(/,
    "a per-frame custom property is back on the shell path — this is the 4x frame-time " +
    "regression that made the keyboard choppy (D-2). Write `height` directly instead.");
  assert.doesNotMatch(hook, /--app-vh/,
    "`--app-vh` is back. It cannot interpolate (unregistered custom properties animate " +
    "DISCRETELY) and writing it per frame invalidates style for the entire document.");

  // And the CSS tier must not reintroduce the indirection either.
  const css = read("app/globals.css");
  assert.doesNotMatch(css, /var\(--app-vh/,
    "globals.css is reading --app-vh again — nothing writes it, so this is dead indirection at best");
});

// ── The shell PINS at baseHeight, and the motion lives on the lifted panels'
// own transform transitions (useKeyboardLift). There is no shell CSS
// transition or arm/disarm class — keyboardLiftWiring.test.ts pins that. What
// is worth a guard here is that the COMMIT stays discrete. ───────────────────
test("the shell commits once and PINS at baseHeight — no per-frame chase", () => {
  const hook = readCode("app/lib/useViewportHeightVar.ts");

  // The commit writes the PIN, never the keyboard-derived height — the panels'
  // lift math (K = baseHeight − committedH) assumes the shell never shows it.
  const commitStart = hook.indexOf("const commit = (px: number) => {");
  const commitEnd = hook.indexOf("const release = () => {", commitStart);
  assert.ok(commitStart !== -1 && commitEnd > commitStart, "commit() moved — re-anchor this excision");
  const commit = hook.slice(commitStart, commitEnd);
  assert.match(commit, /setH\(baseHeight\)/,
    "commit() no longer pins the shell at baseHeight — the panels' lift (K = baseHeight − " +
    "committedH) assumes the shell never shows the keyboard-derived height");
  assert.doesNotMatch(commit, /setH\(next\)/,
    "commit() writes the keyboard-derived height again — the shell must PIN, not follow");

  // And the reason the DECISION is discrete at all: the height is committed,
  // not followed. A bare `setH(h)` inside apply()'s keyboard branch would be a
  // per-frame chase.
  const applyStart = hook.indexOf("const apply = () => {");
  const applyEnd = hook.indexOf("const schedule =", applyStart);
  assert.ok(applyStart !== -1 && applyEnd > applyStart, "apply() moved — re-anchor this excision");
  const apply = hook.slice(applyStart, applyEnd);
  assert.doesNotMatch(apply, /setH\(/,
    "apply() writes the height directly again. Every platform value during the keyboard's " +
    "travel is an intermediate one, and the signal is non-monotonic (Chrome 691->1026->691, " +
    "crbug 40924170) — following it IS the choppy two-stage motion. Commit once, correct at settle.");
  assert.match(apply, /if \(committedH === null\) commit\(h\);/,
    "apply() no longer commits a keyboard that appeared without a focusin we saw");
});

// There is no env() tier and so no watchdog to tear it down when
// `geometrychange` never fires, and no `keyboardUp()` helper. The invariant
// that matters — no per-platform branch at all — is asserted above.
test("no threshold re-derives 'is the keyboard up' behind the shared truth's back", () => {
  const hook = readCode("app/lib/useViewportHeightVar.ts");
  assert.doesNotMatch(hook, /const keyboardUp =/,
    "a second answer to 'is the keyboard up' is back. There is one truth — `committedH` for " +
    "the shell's own state, `publishKbOpen`/`isKeyboardOpen()` for everyone else — and two " +
    "state machines answering one question — there is one machine");
});

test("keyboard maths use a STABLE reference, never window.innerHeight", () => {
  // The Firefox overshoot. A measurement relative to `window.innerHeight`
  // assumes the LAYOUT viewport stays full while the keyboard is up. That
  // holds on some browser/interactive-widget combinations and not others —
  // and where the browser shrinks the layout viewport too, `innerHeight -
  // guess` subtracts a keyboard from a viewport that ALREADY excludes it,
  // lifting the composer about a keyboard too far, and the learned height
  // comes out ~0 so it never improves on the seed.
  const hook = readCode("app/lib/useViewportHeightVar.ts");
  // The ?kbdebug diagnostics box DISPLAYS innerHeight for comparison — that
  // is the point of a diagnostic. The invariant is that no MEASUREMENT uses
  // it, so the diagnostics section is excised before the scan (and both
  // markers are asserted, so silently scanning everything cannot pass).
  const dbgAt = hook.indexOf("let dbgTimer");
  const dbgEnd = hook.indexOf("const stopDbg");
  assert.ok(dbgAt !== -1 && dbgEnd !== -1 && dbgAt < dbgEnd, "the diagnostics block moved — re-anchor this excision");
  const measuring = hook.slice(0, dbgAt) + hook.slice(dbgEnd);
  assert.doesNotMatch(measuring, /window\.innerHeight/,
    "no measurement may depend on the layout viewport's height");
  assert.match(hook, /let baseHeight = measured\(\);/,
    "the reference is the tallest viewport seen with no keyboard up");
  assert.match(hook, /const inset = \(\) => Math\.max\(0, baseHeight - measured\(\)\);/,
    "and the keyboard inset is expressed against it");
  // The growth is gated on `!focusedEditable`. baseHeight is "the tallest
  // viewport seen WHILE NOTHING IS FOCUSED", and Chrome Android is documented
  // to report a spuriously LARGER viewport mid-animation (crbug 40924170: 691
  // -> 1026 -> 691 on a keyboard show). Ungated, one overshoot would
  // permanently inflate the reference, after which the keyboard would read as
  // up with no keyboard and the prediction would be skipped forever. The
  // downward recovery below could never clear it, because that recovery is
  // ITSELF gated on !focusedEditable.
  assert.match(hook, /if \(!focusedEditable && h > baseHeight\) baseHeight = h;/,
    "the reference may only GROW inside apply() while nothing is focused — unguarded, one " +
    "Chrome mid-animation overshoot inflates it for the whole session; shrinking it here " +
    "would absorb the keyboard into the baseline");
  assert.match(hook, /commit\(baseHeight - guess\)/, "prediction is relative to it too");
});

test("Firefox toolbar fixes: hand back to CSS, learn only on focus, heal the reference", () => {
  // The input bar's top border must not shimmer while scrolling in Firefox
  // Android: a hook that rewrites the shell height on EVERY
  // visualViewport.resize chases the collapsing URL bar from JS a frame
  // behind the compositor. Three rules, each pinned:
  const hook = readCode("app/lib/useViewportHeightVar.ts");

  // 1. Sub-keyboard deltas are the dvh tier's job: with no keyboard in play
  //    (and no prediction pending) the hook must RELEASE the height, not track
  //    the toolbar. Matched as ONE sequence — slicing to end-of-file would
  //    match stop()'s own clear and pass with the branch gutted (the
  //    region-too-wide shape).
  assert.match(hook, /\} else if \(!predicting\) \{\s*release\(\);/,
    "toolbar-only movement is being tracked from JS again — the border shimmer is back");
  //    `release()` must stay idempotent, or every toolbar resize re-arms the
  //    transition and re-writes the height — the shimmer by another route.
  assert.match(hook, /const release = \(\) => \{\s*if \(committedH === null\) return;/,
    "release() lost its idempotence guard — it now churns on every toolbar resize");

  // 2. KB_KEY may only be learned while an editable is FOCUSED. A keyboard-
  //    sized inset with nothing focused is an inflated baseline (URL bar hidden
  //    at reference time), and writing it poisons the prediction per DEVICE —
  //    a bad Firefox-tab sample made even the PWA overshoot.
  const learnAt = hook.indexOf("lsSet(KB_KEY");
  const gateAt = hook.indexOf("if (!focusedEditable) return;");
  assert.ok(learnAt !== -1, "learning disappeared entirely");
  assert.ok(gateAt !== -1 && gateAt < learnAt,
    "the learned keyboard height is written without a focused editable — toolbar junk can poison it");
  //    And it is learned from a SETTLED viewport, never mid-travel, so one of
  //    Chrome's documented overshoots can never become this device's keyboard
  //    height (crbug 40924170). Scoped to the two function bodies rather than
  //    index-ordering, which says nothing: `learn` is DEFINED before `settle`.
  const settleAt = hook.indexOf("const settle = () => {");
  assert.ok(settleAt !== -1, "settle() moved — re-anchor this excision");
  const settleBody = hook.slice(settleAt, hook.indexOf("\n    };", settleAt));
  assert.match(settleBody, /learn\(kb\);/,
    "the settled viewport is no longer what gets learned");
  const applyAt = hook.indexOf("const apply = () => {");
  const applyBody = hook.slice(applyAt, hook.indexOf("const schedule =", applyAt));
  assert.doesNotMatch(applyBody, /learn\(/,
    "learning is back inside apply(), so a mid-animation overshoot can be recorded as " +
    "this device's keyboard height and will then mis-predict every future open");

  // 3. The reference recovers DOWNWARD on a stable, unfocused viewport —
  //    without this, one sample taken with the URL bar hidden inflates
  //    baseHeight forever and the keyboard reads as up with no keyboard.
  //    Its OWN timer: `settleTimer` belongs to the commit path, and the
  //    two can be pending simultaneously.
  assert.match(hook, /baseHeight = now;/,
    "the inflated-baseline recovery is gone — one bad sample poisons the session");
  assert.match(hook, /baseTimer = setTimeout\(/,
    "recovery must wait for the viewport to SETTLE, not adopt every dip");
});

test("the keyboard is MEASURABLE everywhere: resizes-content meta, and no env() tier at all", () => {
  // The settled design.
  //
  // 1. The meta ships resizes-content — the canonical bottom-composer mode
  //    and Firefox Android's native model: the LAYOUT viewport shrinks with
  //    the keyboard, so visual == layout and the page CANNOT be panned while
  //    typing (under resizes-visual, dragging grows the chat and pushes the
  //    video panel off screen). Under overlays-content, Firefox (which honours
  //    it, 132+, no VirtualKeyboard API) is completely signal-less — every
  //    prediction rolls back after 500ms. Regressing this meta re-breaks one
  //    browser or the other.
  const layout = readCode("app/layout.tsx");
  assert.match(layout, /interactiveWidget: "resizes-content"/,
    "the viewport meta regressed — either Firefox goes signal-less (overlays) or typing makes the page pannable (visual)");
  assert.doesNotMatch(layout, /"overlays-content"|"resizes-visual"/,
    "a superseded interactive-widget value is back in the meta");

  // 2. There is NO env() tier, in the PWA or anywhere else. It measures
  //    a constant ~16 CSS px short of the real occlusion in tabs (nav-gesture
  //    zone; safe-area-inset-bottom is 0, so CSS cannot recover it), the same
  //    under-lap shows in the installed app, and a branch for it would return
  //    before start(), so the PWA would run none of the keyboard work at all.
  //
  //    The meta only stays in charge because nothing sets overlaysContent:
  //    per spec, `virtualKeyboard.overlaysContent = true` OVERRIDES
  //    interactive-widget entirely. Asserting the meta without asserting this is
  //    asserting nothing — the JS would silently win.
  const hook = readCode("app/lib/useViewportHeightVar.ts");
  assert.doesNotMatch(hook, /overlaysContent\s*=/,
    "something assigns virtualKeyboard.overlaysContent again, which overrides the meta above " +
    "per spec — the viewport contract asserted in part 1 becomes a lie");
  assert.doesNotMatch(hook, /usePwaEnv/,
    "the PWA-only gate is back; an installed app must run the same code as a tab");
  // No per-browser special case may return: the whole point is ONE measuring
  // mechanism confirmed by real geometry.
  assert.doesNotMatch(hook, /signalless|chromeTabMeasure/,
    "a per-browser special case crept back into the measuring path");
});

test("the bars HIDE ANIMATED when the keyboard opens — never snap away", () => {
  // Hiding must animate: a top bar that display:none's and a meta row that
  // unmounts the instant the keyboard-open flag flips is a full-width reflow
  // landing mid-keyboard-animation (flicker). Both are Bars: hidden is an
  // animated distance (a negative edge margin on the shared tokens), still
  // mounted, inert while hidden.
  const embed = readCode("app/components/StreamEmbedBar.tsx");
  assert.match(embed, /<Bar[\s\S]{0,80}hidden=\{hidden\}/,
    "the top bar hides through Bar's animated distance — display:none has no transition");
  assert.doesNotMatch(embed, /hidden \? "hidden"/, "the display:none toggle is back on the top bar");

  const meta = readCode("app/components/StreamMetaBar.tsx");
  assert.match(meta, /<Bar[\s\S]{0,80}hidden=\{hidden\}/, "the bottom bar hides through Bar's animated distance");
  assert.doesNotMatch(meta, /collapse-row|\{showMeta && \(/, "no fold, no unmount — one row");

  // The shared mechanism itself lives in chrome.css now — one distance per
  // Bar (the negative edge margin), animated on the shared tokens, and it
  // must obey reduced motion like every other entrance.
  // stripCssComments, NOT a local block-comment regex: every test file strips
  // through the one shared helper (testSource.test.ts refuses a private copy
  // anywhere under app/).
  const chrome = stripCssComments(readFileSync(join(process.cwd(), "app", "components", "chrome", "chrome.css"), "utf8"));
  assert.match(chrome, /\.chrome-bar\s*\{[^}]*transition-property:\s*margin-top, margin-bottom, translate, opacity;/, "the hide is animated on the shared tokens");
  assert.match(chrome, /transition-duration:\s*var\(--anim-default\)/);
  assert.match(chrome, /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.chrome-bar/, "reduced motion kills the slide AND the reveal delay");
});

test("ONE keyboard truth: the detection hook subscribes, it does not re-detect", () => {
  // ONE detector. A second one (its own baseline, thresholds, focus
  // listeners, a blur debounce) driving the bar collapse would fold the bars
  // on a different frame than the shell moves, and the two machines could
  // disagree outright. useViewportHeightVar's own state publishes the answer;
  // the hook is a subscriber.
  const det = readCode("app/lib/useKeyboardOpenDetection.ts");
  assert.match(det, /useSyncExternalStore\(subscribeKeyboardOpen, isKeyboardOpen/,
    "the detection hook no longer reads the shared truth");
  assert.doesNotMatch(det, /visualViewport|innerHeight|focusin|baseline/,
    "a second keyboard detector grew back — the bars will fold on a different frame than the shell");

  // There is exactly ONE publisher, and that is the point. A PWA
  // `geometrychange` listener would be a second one; the bars are served
  // because the measuring path runs in the installed app too. Two publishers
  // is the thing to avoid, so this asserts the count, not just the presence.
  const hook = readCode("app/lib/useViewportHeightVar.ts");
  assert.match(hook, /publishNow\(predicting \|\| kb > MIN_KB\);/,
    "the measuring path stopped publishing — bars freeze in their last state");
  // ONE low-level publisher, reached from exactly two places: publishNow (which
  // derives the pair from state) and stop() (which zeroes it on teardown).
  const publishers = (hook.match(/^\s+publishKb\(/gm) ?? []).length;
  assert.equal(publishers, 2,
    "the number of publishKb call sites changed. Exactly two are correct: publishNow's " +
    "derivation and stop()'s teardown. A third usually means a second detector grew back");

  // The pair — open + inset — must only ever be published from an ENTRY
  // POINT, once the state has finished changing. commit()/release() each change
  // half of it, so publishing from inside them hands subscribers a frame that
  // says "the keyboard is up and it is 0px tall": every layer positioned on the
  // inset renders at rest, then jumps. Pinned in source because the runtime test
  // (useViewportHeightVar.render.test.ts) can only catch the orderings it
  // happens to exercise.
  for (const fn of ["commit", "release"]) {
    const body = hook.match(new RegExp(`const ${fn} = [^\\n]*\\{\\n([\\s\\S]*?)\\n    \\};`))?.[1] ?? "";
    assert.ok(body.length > 0, `setup: could not find ${fn}()'s body — the regex needs updating`);
    assert.doesNotMatch(body, /publish/,
      `${fn}() publishes the keyboard truth. It only changes ONE of the two facts, so its ` +
      "subscribers see the pair half-updated. Publish from the entry point instead");
  }

  // The tab bar occludes on the same truth, never in the overlay form
  // (occlusion, not a fold — a margin pull inside the lifting panel
  // would shift the list mid-lift, two motions where the model wants one).
  const tabbar = readCode("app/features/chat/ChatTabBar.tsx");
  assert.match(tabbar, /const foldForKeyboard = keyboardOpen && !compactOverlay;/,
    "the tab bar no longer occludes with the keyboard (or occludes the desktop overlay, which must never collapse)");
  // Leading \s so this pins the Bar PROP — a bare /occluded=/ would also match a
  // future `aria-occluded=`-shaped attribute, same guard as the old hidden= check.
  assert.match(tabbar, /\soccluded=\{foldForKeyboard\}/,
    "the tab bar's keyboard fold no longer occludes — occluded is inert + aria-hidden with NO " +
    "geometry change, which is the whole point (the panel does the moving now)");
});

test("the composer row is pinned to the control diameter — no first-letter dip", () => {
  // The bar must not shift 1-2px when the first letter arrives (the
  // composing-collapse border/width changes let the tallest child dip). Both
  // composers pin the ROW with min-height (min-, so multi-line still grows).
  for (const f of ["app/features/chat/ChatInput.tsx", "app/components/MatrixInput.tsx"]) {
    assert.match(readCode(f), /minHeight: "var\(--composer-ctl\)"/,
      `${f}: the row can dip again when composing-collapse fires`);
  }
});

test("pinch-zoom stands the hook down — a zoomed viewport poisons every measurement", () => {
  // A pinch-zoom must not strand the composer off-screen after a refresh. At
  // scale ≠ 1, vv.height is the zoomed-in window — learning from it writes a
  // garbage per-device keyboard height and sizing the shell from it crops the
  // app. Both entry points must check: apply() (measurement/learning) and
  // onFocusIn (prediction).
  const hook = readCode("app/lib/useViewportHeightVar.ts");
  assert.match(hook, /const zoomed = \(\) => Math\.abs\(\(vv\.scale \?\? 1\) - 1\) > 0\.01;/,
    "the zoom detection is gone");
  // apply() must stand down BEFORE taking any measurement — one sequence, so
  // a check placed after the measurement cannot satisfy it.
  assert.match(hook, /raf = 0;\s*if \(zoomed\(\)\) \{[\s\S]{0,300}?return;\s*\}\s*const h = measured\(\);/,
    "apply() measures while pinch-zoomed — the learned keyboard height can be poisoned again");
  assert.match(hook, /focusedEditable = true;\s*if \(zoomed\(\)\) return;/,
    "the focus prediction fires while pinch-zoomed — the shell will be sized from zoomed geometry");
});

test("the non-Chromium path predicts, because it cannot react in time", () => {
  const hook = readCode("app/lib/useViewportHeightVar.ts");
  assert.match(hook, /addEventListener\("focusin", onFocusIn\)/, "focus is the pre-emption trigger");
  assert.match(hook, /lsSet\(KB_KEY/, "the measured height must be learned");
  assert.match(hook, /window\.innerHeight \* 0\.38|baseHeight \* SEED_FRACTION/,
    "an unlearned device must still predict from a seed");
  assert.doesNotMatch(hook, /if \(guess < MIN_KB\) return;/,
    "no bail-out may leave the first open unpredicted");
  assert.match(hook, /if \(predicting\) \{ cancelPrediction\(\); apply\(\); \}/,
    "an unconfirmed guess must roll back");
  assert.match(hook, /vv!\.addEventListener\("scroll", schedule\)/,
    "scroll matters: on iOS it is often the ONLY signal the keyboard opened");
});
