// A style preview must predict the chat row, not approximate it — a viewer
// should see the username at the same size and with badges, exactly as it
// will look, before saving or purchasing.
//
// There are THREE places a styled username renders — chat's row, the profile
// editor's preview, and the store's purchase tile. A preview that renders the
// STYLE'S LABEL ("Blackletter", "Rainbow") at a hardcoded `text-xs`/`text-base`
// with no badges and no username font shows a viewer on Barlow at a large
// chat size a different word, in a different face, at a different size, from
// what they are buying.
//
// THE INVARIANT IS SINGLE-SOURCING, NOT PIXELS. A test that asserted the
// preview's font-size would pass happily against a second hand-rolled copy that
// merely happened to match. What these pin is that every preview goes
// THROUGH StyledName, and that StyledName reads the same custom properties the
// chat row does — so the two cannot drift apart without a failure here.
//
// Run: node --test app/lib/stylePreview.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments, stripCssComments } from "./testSource.ts";
import { previewStyleSet } from "./usernameStyles.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => stripComments(readFileSync(join(here, rel), "utf8"));
/** stripComments must never touch CSS — it deletes every `--custom-property` line. */
const readCss = (rel: string) => stripCssComments(readFileSync(join(here, rel), "utf8"));

/** The properties a chat row's username is actually rendered with. */
const CHAT_NAME_VARS = [
  "--chat-username-font",
  "--chat-username-weight",
  // `.chat-msg-row` sets `text-shadow: var(--chat-shadow)` and
  // `.chat-msg-body .chat-badges` sets `filter: var(--chat-shadow-filter)`
  // (globals.css); a StyledName that applied neither would understate, with
  // the shadow on, the weight of the face it previews. The same drift, one
  // property later, which is why the list lives here and grows rather than
  // the pixels being asserted.
  "--chat-shadow",
  "--chat-shadow-filter",
];

test("StyledName renders with the same custom properties the chat row uses", () => {
  const src = read("../components/profileCardParts.tsx");
  const fn = src.slice(src.indexOf("export function StyledName"));
  for (const v of CHAT_NAME_VARS) {
    // Anchored on the var's TERMINATOR, not `includes`. A bare substring check
    // lets `--chat-shadow-filter` satisfy the `--chat-shadow` case, so removing
    // the name's text-shadow would still pass.
    assert.match(
      fn, new RegExp(`${v}\\s*[,)]`),
      `StyledName does not apply ${v} — the preview renders the name differently ` +
      `from the chat row it is meant to predict`
    );
  }
  assert.match(
    fn, /fontSize: CHAT_FONT/,
    "StyledName is not sized from the reader's own chat font size"
  );
  assert.doesNotMatch(
    fn, /text-base|text-xs|text-sm/,
    "StyledName has a hardcoded type size again — it must inherit chat's"
  );
  assert.match(
    fn, /--chat-badge-scale/,
    "the badges are not sized the way chat sizes them"
  );
});

test("badges come BEFORE the name, the way chat orders them", () => {
  // ChatMessage renders badges then the username; StyledName must not trail
  // them. Order is not cosmetic in a preview whose whole job is prediction.
  const src = read("../components/profileCardParts.tsx");
  const fn = src.slice(src.indexOf("export function StyledName"));
  const badgeIdx = fn.indexOf("badges.map");
  const nameIdx = fn.indexOf("{name}");
  assert.ok(badgeIdx !== -1 && nameIdx !== -1, "anchors lost in StyledName");
  assert.ok(
    badgeIdx < nameIdx,
    "badges render after the name — chat puts them in front (ChatMessage), so the " +
    "preview shows a layout that never occurs"
  );
});

test("both preview surfaces go through StyledName rather than re-deriving it", () => {
  for (const [file, what] of [
    ["../components/ProfileEditor.tsx", "the settings preview"],
    ["../features/store/StoreSpend.tsx", "the store's purchase tiles"],
  ] as const) {
    const src = read(file);
    assert.match(
      src, /<StyledName/,
      `${what} still hand-rolls a styled username — it drifts from chat`
    );
  }
});

test("the gap BETWEEN badges is derived from the indicator gap, in both renderers", () => {
  // Indicator gap as a reciprocal buffer between individual badges (multiple
  // badges need padding between them).
  //
  // A hardcoded gap in TWO places — the chat row and StyledName — is the same
  // drift again, and a fixed value does not move when a reader widens
  // --chat-pi-gap, so the setting would only apply to one of the two gaps in
  // the same cluster.
  const css = readCss("../globals.css");
  // Identical distance, not a cluster effect: the badge gap equals the
  // indicator gap (ratio 1). The value must still be DERIVED from --chat-pi-gap
  // so it moves when the reader adjusts that setting.
  const badgeGap = /--chat-badge-gap:\s*var\(--chat-pi-gap[^)]*\)/.exec(css);
  assert.ok(
    badgeGap,
    "--chat-badge-gap is not derived from --chat-pi-gap — badge spacing has " +
    "stopped tracking the reader's indicator-gap setting"
  );

  for (const [file, what] of [
    ["../features/chat/ChatMessage.tsx", "the chat row"],
    ["../components/profileCardParts.tsx", "StyledName"],
  ] as const) {
    const src = read(file);
    assert.match(
      src, /gap: "var\(--chat-badge-gap\)"/,
      `${what} does not space badges with --chat-badge-gap`
    );
    assert.doesNotMatch(
      src, /gap: "2px"/,
      `${what} has a hardcoded inter-badge gap again — it must derive from --chat-pi-gap`
    );
  }
});

test("a preview never renders the STYLE'S LABEL as the name", () => {
  // `{s.label}` inside the styled span was the original bug: it showed what the
  // word "Blackletter" looks like in Blackletter. The label survives as a
  // caption — outside any styled element — so tiles stay identifiable.
  for (const [file, what] of [
    ["../components/ProfileEditor.tsx", "the settings picker"],
    ["../features/store/StoreSpend.tsx", "the store tiles"],
  ] as const) {
    const src = read(file);
    // Find every element that carries a style-generated appearance, and check
    // none of them contains the label.
    for (const m of src.matchAll(/usernameStyleCSS\(eq[\s\S]{0,400}?<\/span>/g)) {
      assert.doesNotMatch(
        m[0], /\{s\.label\}/,
        `${what} still previews the style on its own label instead of the user's name`
      );
    }
    assert.match(
      src, /\{s\.label\}/,
      `${what} dropped the style label entirely — the tiles are now unidentifiable`
    );
  }
});

// ── The tile previews must show what you would GET, not the style alone ──────
// With a custom font and/or gradient selected, the stackable tiles show what
// the name would look like with them.
//
// A picker that builds `{ [category]: id }` — the style on its own — shows a
// name the user cannot actually have, because the three categories STACK. It
// also makes the effect tiles render visibly LARGER than the font tiles: a
// bare effect carries no `scale`, so it falls back to the unscaled default
// face while every font tile is optically normalised.

test("previewStyleSet keeps the rest of the equipped set", () => {
  const worn = { font: "elegant", effect: "glow", gradient: "duo", gradientColor: "#123456" };
  const swapped = previewStyleSet(worn, { id: "gothic", category: "font" });
  assert.equal(swapped.font, "gothic", "the tile's own category did not win");
  assert.equal(swapped.effect, "glow", "the worn effect was dropped from the preview");
  assert.equal(swapped.gradient, "duo");
  assert.equal(
    swapped.gradientColor, "#123456",
    "gradientColor was dropped — the duo tile would preview against the white default"
  );
});

test("previewStyleSet works from a bare set, and does not mutate it", () => {
  const worn = { font: "elegant" };
  const out = previewStyleSet(worn, { id: "glow", category: "effect" });
  assert.deepEqual(worn, { font: "elegant" }, "the caller's equipped set was mutated");
  assert.equal(out.font, "elegant");
  assert.equal(out.effect, "glow");
  assert.equal(previewStyleSet(null, { id: "glow", category: "effect" }).effect, "glow");
});

test("both pickers preview through previewStyleSet and share STYLE_GROUPS", () => {
  for (const [file, what] of [
    ["../components/ProfileEditor.tsx", "the profile editor"],
    ["../features/store/StoreSpend.tsx", "the Qorm store"],
  ] as const) {
    const src = read(file);
    assert.match(
      src, /previewStyleSet\(/,
      `${what} builds its preview set by hand — an effect tile will render on the ` +
      `default face instead of the one the user wears`
    );
    assert.doesNotMatch(
      src, /const eq(: EquippedStyle)? = \{ \[/,
      `${what} is back to previewing a style in isolation`
    );
    // `.map(` and not the bare name: an unused IMPORT satisfies the bare
    // check, so replacing the list with a literal would still pass — a
    // substring check that proves nothing.
    assert.match(
      src, /STYLE_GROUPS\.map\(/,
      `${what} hardcodes the category order/labels — the two pickers can drift apart`
    );
  }
});
