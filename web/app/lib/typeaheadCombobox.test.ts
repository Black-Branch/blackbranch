// The two typeahead overlays must be comboboxes, not floating divs.
//
// Both popups (emote/@mention completion, the `/` command palette) are driven
// entirely from the composer: arrows move `selected`, Enter picks. To a sighted
// user that works; to a screen-reader user nothing happens unless the popup is
// a labelled listbox, the selection is announced, and the textarea says a list
// opened. FontPicker.tsx carries the correct pattern (combobox →
// aria-expanded/-controls → listbox → option/aria-selected); these assertions
// hold the same pattern onto the two overlays and the field that drives them.
//
// The listbox id is a REQUIRED prop on EmoteCompletionList because it has three
// consumers (ChatInput, MatrixInput, TipForm — rendered from SupportContent's
// donation section) and two can be mounted at once — a hardcoded id would
// collide, and aria-activedescendant pointing at a duplicate id is a coin flip.
//
// Run: node --test app/lib/typeaheadCombobox.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function readWhole(path: string, tailAnchor: RegExp): string {
  const src = readFileSync(join(webRoot, path), "utf8");
  assert.match(
    src.slice(-400), tailAnchor,
    `${path} did not end as expected — the read is truncated, and every assertion below it is vacuous`,
  );
  return stripComments(src);
}

test("EmoteCompletionList is a listbox with addressable options", () => {
  const src = readWhole("app/components/EmoteCompletionList.tsx",
    /<\/button>\s*\)\)\s*}\s*<\/div>\s*<\/div>\s*\)\s*;\s*}\s*$/);
  assert.match(src, /listboxId: string;/,
    "listboxId is no longer a required prop — three consumers, two mountable at once, means a " +
    "hardcoded id collides and aria-activedescendant resolves to whichever won");
  assert.match(src, /role="listbox"/, "the completion popup has no listbox role");
  assert.match(src, /role="option"/, "completion rows lost role=option");
  assert.match(src, /aria-selected={i === selected}/,
    "the keyboard selection is a background color again — invisible to a SR");
  assert.match(src, /id={`\$\{listboxId\}-opt-\$\{i\}`}/,
    "options lost their ids — aria-activedescendant has nothing to point at");
});

test("CommandPalette is a listbox with addressable options", () => {
  const src = readWhole("app/components/CommandPalette.tsx",
    /<\/div>\s*\)\s*}\s*<\/div>\s*\)\s*;\s*}\s*$/);
  assert.match(src, /role="listbox"/, "the palette suggestion list has no listbox role");
  assert.match(src, /role="option"/, "palette suggestions lost role=option");
  assert.match(src, /aria-selected={i === selected}/, "palette selection is invisible to a SR");
  assert.match(src, /id={`command-palette-list-opt-\$\{i\}`}/,
    "palette options lost their ids — aria-activedescendant has nothing to point at");
});

test("the shared field can wear the combobox role its overlays require", () => {
  const src = readWhole("app/components/ChatComposerField.tsx",
    /onClose={\(\) => setShowEmotePicker\(false\)}[\s\S]*\)\s*;\s*}\s*$/);
  // Conditional ON PURPOSE: the role promises a popup, and only consumers know
  // whether one exists (all three currently do, but the field shouldn't lie if
  // one stops rendering an overlay).
  assert.match(src, /role={combobox \? "combobox" : undefined}/,
    "the textarea no longer declares combobox when its consumer wires one");
  assert.match(src, /aria-autocomplete={combobox \? "list" : undefined}/, "aria-autocomplete gone");
  assert.match(src, /aria-expanded={combobox \? combobox\.expanded : undefined}/, "aria-expanded gone");
  assert.match(src, /aria-controls={combobox\?\.expanded \? combobox\.controls : undefined}/,
    "aria-controls must reference the list only while it is OPEN — a closed popup's id points at nothing");
  assert.match(src, /aria-activedescendant={combobox\?\.expanded \? combobox\.activeDescendant : undefined}/,
    "aria-activedescendant gone — the SR never hears the arrows move");
});

test("ChatInput wires the field to whichever overlay is open", () => {
  const src = readWhole("app/features/chat/ChatInput.tsx", /<\/form>\s*\)\s*;\s*}\s*$/);
  assert.match(src, /listboxId="chat-emote-listbox"/,
    "ChatInput's completion list lost its unique listbox id");
  // The two overlays share one slot (the palette yields to emote matches), so
  // expanded/controls/activeDescendant must follow the SAME precedence the
  // render site uses — a combobox pointing at the overlay that ISN'T shown is
  // worse than none.
  assert.match(src, /const emoteOverlayOpen = overlayMatches\.length > 0;/,
    "the combobox wiring no longer derives from the emote overlay's own render condition");
  assert.match(src, /chat-emote-listbox-opt-\$\{overlaySel\}/,
    "activedescendant no longer tracks the emote selection");
  assert.match(src, /command-palette-list-opt-\$\{cmdSelSafe\}/,
    "activedescendant no longer tracks the palette selection");
});

test("the other two consumers pass distinct listbox ids", () => {
  const matrix = readWhole("app/components/MatrixInput.tsx",
    /<PaperPlaneRight size={CTL_ICON} weight="fill" \/>\s*<\/button>\s*<\/div>\s*<\/div>\s*\)\s*;\s*}\s*$/);
  assert.match(matrix, /listboxId="matrix-emote-listbox"/,
    "MatrixInput lost its listbox id — it can be mounted beside ChatInput, so they must differ");

  // The listboxId lives in TipForm: SupportContent renders TipForm, which
  // renders the emote overlay.
  const tipForm = readWhole("app/features/support/TipForm.tsx",
    /<\/>\s*\)\s*;\s*}\s*$/);
  assert.match(tipForm, /listboxId="support-emote-listbox"/,
    "TipForm lost its listbox id — it can be mounted beside ChatInput, so they must differ");
});
