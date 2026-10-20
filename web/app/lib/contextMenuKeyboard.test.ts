// The shared context menu must have a keyboard/SR path in AND out.
//
// ContextMenu.tsx is the one shell both message menus render through, which is
// what makes these assertions worth their weight: fixing the shell fixes live
// chat and Matrix/forum at once. The menu passes `escape: true` to the same
// hook the row toolbar uses, has a role (a portal at body end with no
// semantics is invisible to a SR user), and takes focus when opened from the
// keyboard, so a keyboard can operate it.
//
// The counterweight: a long-press menu must NOT steal focus — the whole
// keepFocus system exists so the composer keeps the soft keyboard up. So focus
// is taken only when the OPENER held visible focus (`:focus-visible`), which is
// true for keyboard activation and false for taps and mouse clicks.
//
// Run: node --test app/lib/contextMenuKeyboard.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(join(webRoot, p), "utf8");

/** Whole-file proof at the END — truncation makes later assertions vacuous. */
function readWhole(path: string, tailAnchor: RegExp): string {
  const src = read(path);
  assert.match(
    src.slice(-400), tailAnchor,
    `${path} did not end as expected — the read is truncated, and every assertion below it is vacuous`,
  );
  return stripComments(src);
}

const MENU = "app/components/ContextMenu.tsx";
const MENU_TAIL = /{children}\s*<\/button>\s*\)\s*;\s*}\s*$/;

test("Escape closes the menu (the hook's option, not a second listener)", () => {
  const src = readWhole(MENU, MENU_TAIL);
  assert.match(src, /useOutsideClick\(ref, onClose, \{ escape: true \}\)/,
    "ContextMenu leaves useOutsideClick at escape:false — the row toolbar one level up passes " +
    "escape:true to the same hook, so the deeper surface dismisses on Escape and the menu doesn't");
});

test("the menu and its items carry menu semantics", () => {
  const src = readWhole(MENU, MENU_TAIL);
  assert.match(src, /role="menu"/,
    "the portal div has no role — a menu portaled to body end with no semantics is just a div to a SR");
  assert.match(src, /role="menuitem"/, "MenuItem lost role=menuitem");
  assert.match(src, /tabIndex={-1}/,
    "menuitems must be tabIndex -1 — the ARIA menu pattern is ONE stop, arrows inside; " +
    "tabbable items would make a portal at body end a tab-order trap");
});

test("arrow keys walk the items, Tab closes", () => {
  const src = readWhole(MENU, MENU_TAIL);
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) {
    assert.match(src, new RegExp(`"${key}"`), `no ${key} handling in the menu`);
  }
  // Tab does not cycle a menu — it closes it (and the restore below puts focus
  // back where the user was). Without this, Tab from a focused item lands in
  // browser chrome, because nothing follows the portal.
  assert.match(src, /"Tab"[\s\S]{0,80}onClose\(\)/,
    "Tab inside the menu no longer closes it — focus walks off the end of the document");
});

test("focus is stolen ONLY from a :focus-visible opener, and returned to it", () => {
  const src = readWhole(MENU, MENU_TAIL);
  // The keepFocus boundary: a tap or mouse click must leave the composer's focus
  // alone. `:focus-visible` on the opener is what separates a keyboard
  // activation from a pointer one.
  assert.match(src, /matches\(":focus-visible"\)/,
    "the menu no longer checks the opener for :focus-visible — either it now steals focus from " +
    "taps (breaking the keyboard-stays-up contract) or it never takes focus at all (no keyboard path in)");
  assert.match(src, /\.focus\(\)/, "nothing in the menu ever moves focus — no keyboard path in or out");
});

test("keyboard-opened menus keep the toolbar mounted for the focus return", () => {
  // The restore target is the ⋯ button INSIDE .row-actions. If the bar closes
  // when the menu opens (the pointer flow's closeBar), the button is
  // display:none by restore time and focus() on it silently no-ops — focus
  // falls to body and the keyboard user is lost. So a keyboard activation
  // (click detail 0) holds the bar open via its data-open flag instead.
  const chat = readWhole("app/features/chat/ChatMessage.tsx", /<\/div>\s*\)\s*;\s*}\s*\)\s*;\s*$/);
  assert.match(chat, /if \(e\.detail === 0\) setBarOpen\(true\); else closeBar\(\);/,
    "ChatMessage's ⋯ closes the bar on keyboard open — the menu's focus return lands on a display:none button");

  const matrix = readWhole(
    "app/components/MatrixMessageRow.tsx",
    /export const MatrixMessageRow = memo\(MatrixMessageRowImpl, rowPropsEqual\);\s*$/);
  assert.match(matrix, /if \(e\.detail === 0\) setBarOpen\(true\); else closeBar\(\);/,
    "MatrixMessageRow's ⋯ closes the bar on keyboard open — the menu's focus return lands on a display:none button");
  // And a keyboard click carries clientX/Y = 0,0 — the menu must anchor to the
  // button's rect for detail 0, not open in the screen corner.
  assert.doesNotMatch(matrix, /onClick={\(e\) => \{ setCtxMenu\(\{ x: e\.clientX, y: e\.clientY \}\); closeBar\(\); \}}/,
    "MatrixMessageRow's ⋯ anchors on clientX/Y unconditionally — a keyboard activation opens the menu at 0,0");
});
