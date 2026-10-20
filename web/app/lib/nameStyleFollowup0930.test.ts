// Three rules for the name-style previews:
//   1. previews in the points store must not cut off — a 3-across tile is ~85px, and
//      a long name plus its badges needs a zoom under fitZoom's floor, so the
//      end would be cut. Tiles are 2-across, show the name alone (the badges do not
//      change with the style; the big preview still shows them), floor 0.4.
//   2. long shadow and the 3d effect must not stretch further than in the tryout or
//      cover the name of the effect — em steps grow with the face and the preview
//      zoom, so they are fixed px.
//   3. entry effects like stamp, focus in, and type in have their own
//      section and show the animation — a fourth category, `entrance`,
//      worn alongside an effect, replayed in the pickers.
// Run: node --test app/lib/nameStyleFollowup0930.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STYLE_GROUPS, styleById, usernameStyleCSS, usernameStyleAnimClass, USERNAME_STYLES } from "./usernameStyles.ts";
import { fitZoom } from "./nameInk.ts";
import { stripComments, stripCssComments } from "./testSource.ts";

const read = (...p: string[]) => stripComments(readFileSync(join(process.cwd(), ...p), "utf8"));
const css = stripCssComments(readFileSync(join(process.cwd(), "app", "globals.css"), "utf8"));
const S = (x: object) => x as Record<string, string | undefined>;
const ENTRANCES = ["typein", "focusin", "stamp"];

test("entrances are their own category, listed after Effects", () => {
  for (const id of ENTRANCES) assert.equal(styleById(id)?.category, "entrance", `"${id}" is not an entrance`);
  assert.deepEqual(STYLE_GROUPS.map((g) => g.category), ["font", "effect", "entrance", "gradient"]);
  assert.equal(STYLE_GROUPS.find((g) => g.category === "entrance")?.label, "Entrances");
  assert.equal(USERNAME_STYLES.filter((s) => s.category === "entrance").length, 3);
});

test("an entrance is worn WITH an effect: both animate", () => {
  const c = S(usernameStyleCSS({ effect: "bounce", entrance: "stamp" }, "#9fd4ff"));
  assert.match(String(c.animation), /^un-bounce [^,]+, var\(--un-enter\)$/);
  assert.match(String(c["--un-enter"]), /^un-stamp 0\.45s ease-out backwards$/);
  assert.equal(c.display, "inline-block", "stamp scales — an inline box ignores transform");
  const alone = S(usernameStyleCSS({ entrance: "typein" }, "#9fd4ff"));
  assert.equal(alone.animation, "var(--un-enter)");
  assert.match(String(alone["--un-enter"]), /steps\(var\(--un-n, 10\)\)/);
  assert.doesNotMatch(String(alone["--un-enter"]), /infinite/, "an entrance loops in chat");
});

test("an entrance alone is a style (not dropped as empty)", () => {
  assert.ok(Object.keys(usernameStyleCSS({ entrance: "focusin" }, "#fff")).length > 0);
  assert.equal(usernameStyleAnimClass({ entrance: "focusin" }), "un-anim un-arrive");
  assert.equal(usernameStyleAnimClass({ effect: "bounce", entrance: "stamp" }), "un-anim un-arrive");
  assert.equal(usernameStyleAnimClass({ effect: "bounce" }), "un-anim");
});

test("history rows skip only the entrance, never the effect worn with it", () => {
  assert.match(css, /\.chat-msg-row:not\(\.chat-msg-in\) \.un-arrive \{ --un-enter: none !important; \}/);
  assert.doesNotMatch(css, /\.un-arrive \{ animation: none/, "a history row would freeze the effect too");
});

test("the style API and the live frame both carry the entrance", () => {
  const route = read("app", "api", "me", "style", "route.ts");
  assert.match(route, /const CATEGORIES: StyleCategory\[\] = \["font", "effect", "entrance", "gradient"\];/);
  assert.match(route, /const empty = !next\.font && !next\.effect && !next\.entrance && !next\.gradient;/);
  const chat = stripComments(readFileSync(join(process.cwd(), "..", "stream-api", "chat.js"), "utf8"));
  assert.match(chat, /entrance: pickStyleId\(rawStyle\.entrance\),/, "live chat frames drop the entrance");
  assert.match(chat, /if \(s\.font \|\| s\.effect \|\| s\.entrance \|\| s\.gradient\) usernameStyle = s;/);
});

test("the pickers replay an entrance so it can be seen", () => {
  const store = read("app", "features", "store", "StoreSpend.tsx");
  assert.match(store, /fit=\{1\.35\}\s+replay\b/, "the big store preview");
  assert.match(store, /replay=\{cat === "entrance"\}/, "the entrance tiles");
  const editor = read("app", "components", "ProfileEditor.tsx");
  assert.match(editor, /fit=\{1\}\s+replay\b/, "the Edit profile preview");
  assert.match(editor, /replay=\{s\.category === "entrance"\}/, "the Edit profile entrance tiles");
  const hook = read("app", "lib", "nameInk.ts");
  assert.match(hook, /function restartEntrance\(el: HTMLElement\)/);
  assert.match(hook, /setProperty\("--un-enter", "none"\);\s*void el\.offsetWidth;/, "no reflow between = no restart");
});

test("long shadow and block 3D step in fixed px, as in the tryout", () => {
  const ls = String(S(usernameStyleCSS({ effect: "longshadow" }, "#9fd4ff")).textShadow);
  for (let i = 1; i <= 5; i++) assert.ok(ls.includes(`${i}px ${i}px 0 `), `long shadow step ${i}`);
  assert.doesNotMatch(ls, /\d+\.\d+em/, "long shadow still grows with the face");
  const bl = String(S(usernameStyleCSS({ effect: "block" }, "#9fd4ff")).textShadow);
  for (let i = 1; i <= 4; i++) assert.ok(bl.includes(`0 ${i}px 0 `), `block step ${i}`);
  assert.ok(bl.includes("0 6px 6px rgba(0,0,0,0.6)"));
  assert.doesNotMatch(bl, /\d+\.\d+em/, "block 3D still grows with the face");
});

test("store tiles: two across, name alone, and a long name fits", () => {
  const store = read("app", "features", "store", "StoreSpend.tsx");
  assert.match(store, /grid grid-cols-2 gap-1\.5 max-h-64 overflow-y-auto/);
  const tile = store.slice(store.indexOf("overflowClipMargin"), store.indexOf("{s.label}"));
  assert.match(tile, /badges=\{NO_BADGES\}/, "tiles still squeeze the badges in");
  // 18 characters (a long real styled name) in a wide face ≈ 240px into
  // a ~125px tile.
  assert.ok(fitZoom(240, 125, 1) * 240 <= 125, "a long name is still cut at the floor");
  assert.equal(fitZoom(1000, 100, 1), 0.4, "the floor");
});

// On a duo-gradient name, long shadow and block 3D must not run over the
// caption. A clipped fill takes its shadows as drop-shadow() FILTERS, and
// filters chain — each one shadows everything before it, its shadow included
// — so 1..5px steps would sum to 15px. Filter steps are the DELTAS between
// layers.
const dropOffsets = (filter: string) =>
  [...filter.matchAll(/drop-shadow\((-?[\d.]+)(?:px)? (-?[\d.]+)(?:px)? (-?[\d.]+)(?:px)?/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
test("on a gradient name, long shadow and block reach as far as on a plain one", () => {
  const duo = { gradient: "duo", gradientColor: "#302c68" };
  const ls = dropOffsets(String(S(usernameStyleCSS({ effect: "longshadow", ...duo }, "#9fd4ff")).filter));
  assert.equal(ls.length, 5, `parsed ${ls.length}`);
  assert.deepEqual(ls.reduce((a, [x, y]) => [a[0]! + x!, a[1]! + y!], [0, 0]), [5, 5], "the steps compound");
  const bl = dropOffsets(String(S(usernameStyleCSS({ effect: "block", ...duo }, "#9fd4ff")).filter));
  assert.equal(bl.length, 5, `parsed ${bl.length}`);
  assert.equal(bl.slice(0, 4).reduce((a, [, y]) => a + y!, 0), 4, "the block's stack compounds");
  assert.equal(bl.reduce((a, [, y]) => a + y!, 0), 6, "the soft shadow sits 6px under the letters, as on a plain name");
});

test("a tile leaves room under the name for a squiggle before the caption", () => {
  const store = read("app", "features", "store", "StoreSpend.tsx");
  assert.match(store, /className="whitespace-nowrap px-1 pb-1\.5 flex justify-center-safe overflow-x-clip overflow-y-visible"/);
  const editor = read("app", "components", "ProfileEditor.tsx");
  assert.match(editor, /<span className="flex flex-col items-center gap-1\.5">/);
});

test("Top messages does not cut a descender off the name (a j's tail)", () => {
  const src = read("app", "features", "home", "widgets", "BoardsWidget.tsx");
  // `truncate` is overflow:hidden on a 20px line; a display face is taller. The
  // padding widens what it keeps, the negative margin keeps the row where it was.
  assert.equal((src.match(/className="flex-1 min-w-0 truncate py-1 -my-1">\{name\}/g) ?? []).length, 2);
});

test("a gradient name gets paintable room above and below its line (a j's tail is not cut off)", () => {
  // In a flex row (cards, store tiles, chat) the name span is BLOCKIFIED, one
  // line tall at line-height ≈ 1 — and background-clip: text paints nothing
  // outside that box, so every descender and tall cap was cut flat. Padding
  // widens the paintable box; the equal negative margin keeps the layout.
  for (const g of [{ gradient: "duo" }, { gradient: "rainbow" }, { effect: "shimmer" }, { effect: "outline", gradient: "duo" }]) {
    const c = S(usernameStyleCSS({ font: "hand", ...g }, "#9fd4ff"));
    assert.equal(c.backgroundClip, "text", JSON.stringify(g));
    assert.equal(c.paddingBlock, "0.35em", JSON.stringify(g));
    assert.equal(c.marginBlock, "-0.35em", JSON.stringify(g));
  }
  assert.equal(S(usernameStyleCSS({ font: "hand" }, "#9fd4ff")).paddingBlock, undefined, "a solid name paints its ink anyway");
});
