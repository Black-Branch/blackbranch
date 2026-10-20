// Glass and transparency are two different things.
//
// Glass and transparency must each be able to be switched completely off, both
// default off for mobile glass, and only the pop-ups may use glass — panels
// using transparency must not carry glass logic for no reason.
//
// WHY, from a census of every glass surface:
//   • Gating non-pop-up glass behind `!narrow` makes "off on mobile" true by
//     accident, not by a setting.
//   • A blur whose backdrop is the scrolling chat (the pinned banner)
//     re-rasterizes on every scroll frame.
//   • Theatre-mode bars blurring over LIVE VIDEO — a backdrop that changes every
//     frame — are the most expensive glass there can be.
//   • Tailwind `backdrop-blur-*` utilities read no custom property at all, so no
//     setting can reach them.
//   • The two knobs that look like switches are not: `blur(0px)` is still a
//     backdrop-filter (promotion + readback survive a zero radius), and at 100%
//     opacity `.glass` still blurs a backdrop it has completely occluded —
//     glass logic for no reason.
//
// SO:
//   • ONE spelling: `--glass-filter`, declared once in globals.css, consumed by
//     `.glass` and the row hover bar and nowhere else.
//   • `glassOn` / `transparencyOn` — two registry keys, both pre-paint, both in
//     the Effects section. glassOn defaults OFF on phones; transparencyOn is ON
//     everywhere (model B panels).
//   • Every non-pop-up has no blur and keeps its translucent fill.
//
// The tests below are mostly bans. That is deliberate: a convention that many
// files can break is not a rule.
//
// Run: node --test app/lib/glassSurface.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { stripComments, stripCssComments } from "./testSource.ts";

const APP = join(process.cwd(), "app");
const read = (...p: string[]) => stripComments(readFileSync(join(process.cwd(), ...p), "utf8"));
// CSS gets its OWN stripper — stripComments deletes every line starting with
// `--`, which in a stylesheet is every custom-property declaration. See the
// note in panelShadow.test.ts.
const CSS = stripCssComments(readFileSync(join(APP, "globals.css"), "utf8"));
const CSSN = CSS.replace(/\s+/g, " ");
const REG = read("app", "lib", "settingsRegistry.ts");
const LAYOUT = read("app", "layout.tsx");
const MENU = read("app", "lib", "settingsMenu.ts");
const DEVICE = read("app", "lib", "deviceQueries.ts");

/** Every .ts/.tsx under app/, tests excluded, comments stripped. */
function sources(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.tsx?$/.test(e) || /\.test\.tsx?$/.test(e)) continue;
      out.push([relative(process.cwd(), p), stripComments(readFileSync(p, "utf8"))]);
    }
  };
  walk(APP);
  return out;
}

// ── The single spelling ─────────────────────────────────────────────────────

test("--glass-filter is declared exactly once, and it is a blur", () => {
  const decls = CSS.match(/^\s*--glass-filter\s*:/gm) ?? [];
  assert.equal(decls.length, 1, "--glass-filter must have exactly one definition");
  assert.match(CSSN, /--glass-filter: blur\(var\(--glass-blur, 14px\)\);/);
});

test("only .glass and the row hover bar consume backdrop-filter", () => {
  // Anchored on the property, so a new rule anywhere in the file trips this.
  // `.row-actions`: the hover bar is glass, and its display gate means one bar
  // on screen at most.
  const uses = [...CSSN.matchAll(/((?:[.#][\w-]+ )*[.#][\w-]+)\s*\{[^}]*?backdrop-filter/g)].map((m) => m[1]);
  assert.deepEqual(new Set(uses), new Set([".glass", ".row-actions"]),
    `unexpected backdrop-filter rule(s): ${uses.join(", ")}`);
  // ...and each through the switch, never a literal blur().
  for (const sel of [".glass", ".row-actions"]) {
    const rule = new RegExp(`${sel.replace(/\./g, "\\.")} \\{[^}]*\\}`).exec(CSSN)?.[0] ?? "";
    assert.match(rule, /backdrop-filter: var\(--glass-filter\)/,
      `${sel} must read --glass-filter, not a literal blur()`);
  }
});

test("no component hand-rolls a blur — not inline, not via a utility", () => {
  const offenders: string[] = [];
  for (const [file, src] of sources()) {
    if (/backdropFilter|WebkitBackdropFilter/.test(src)) offenders.push(`${file} (inline style)`);
    if (/backdrop-blur/.test(src)) offenders.push(`${file} (Tailwind utility)`);
  }
  assert.deepEqual(offenders, [],
    "glass belongs to .glass in globals.css so one switch can reach it; " +
    "these bypass it:\n  " + offenders.join("\n  "));
});

test("the five stripped surfaces keep their translucent fill", () => {
  // The point was to drop the BLUR, not to make the app opaque. If a later edit
  // deletes the fill too, these panels lose their look and this catches it.
  for (const f of [
    ["app", "components", "StreamEmbedBar.tsx"],
    ["app", "components", "StreamMetaBar.tsx"],
    ["app", "features", "chat", "ChatTabBar.tsx"],
    ["app", "features", "chat", "ChatSidebar.tsx"],
    ["app", "components", "PinnedBanner.tsx"],
  ]) {
    assert.match(read(...f), /var\(--glass-bg/, `${f.join("/")} lost its --glass-bg fill`);
  }
});

// ── The two switches ────────────────────────────────────────────────────────

test("glassOn writes the keyword when off and REMOVES the override when on", () => {
  const fn = /function applyGlass\(ctx: ApplyCtx\)\s*\{([\s\S]*?)\n/.exec(REG)?.[1] ?? "";
  assert.ok(fn, "applyGlass not found");
  assert.match(fn, /rmProp\("--glass-filter"\)/, "ON must remove the override, not restate it");
  assert.match(fn, /setProp\("--glass-filter", "none"\)/);
  // The whole point: a zero radius is not off.
  assert.doesNotMatch(fn, /blur\(0/, "OFF must be `none` — blur(0px) still costs the readback");
});

test("transparencyOn forces alpha to 1 without touching the stored sliders", () => {
  assert.match(REG, /function alphaOf\(ctx: ApplyCtx, o: number\): number \{ return ctx\.get\("transparencyOn"\) \? o : 1; \}/);
  // Every translucent surface must route through it — that is what makes the
  // switch a switch rather than a list someone has to remember to extend.
  for (const fn of ["glassAlpha", "applyPanel"]) {
    const body = new RegExp(`function ${fn}\\(ctx: ApplyCtx\\)(?:: number)?\\s*\\{([\\s\\S]*?)\\n(?=function|\\n)`).exec(REG)?.[1] ?? "";
    assert.ok(body, `${fn} not found`);
    assert.match(body, /alphaOf\(ctx,/, `${fn} does not honour transparencyOn`);
  }
});

test("the glass fill keeps its solid phone default while transparency is untouched", () => {
  // Glass surfaces are unchanged by model B. Only an ABSENT stored
  // value on a phone takes the solid arm; an explicit "1" or desktop gets alphaOf.
  const body = /function glassAlpha\(ctx: ApplyCtx\): number \{([\s\S]*?)\n\}/.exec(REG)?.[1] ?? "";
  assert.ok(body, "glassAlpha not found");
  assert.match(body, /if \(deviceClass\(\) === "mobile" && settingGet\("theme_transparencyOn"\) === null\) return 1;/);
  assert.match(body, /return alphaOf\(ctx, ctx\.get\("glassOpacity"\)\);/);
  assert.match(REG, /function applyGlassBg\(ctx: ApplyCtx\)\{ setProp\("--glass-bg", hexToRgba\(ctx\.get\("glassColor"\), glassAlpha\(ctx\)\)\); \}/);
  // The panel tint must NOT inherit the phone arm — it stays alphaOf-only.
  const panel = /function applyPanel\(ctx: ApplyCtx\)\s*\{([\s\S]*?)\n\}/.exec(REG)?.[1] ?? "";
  assert.ok(panel, "applyPanel not found");
  assert.doesNotMatch(panel, /deviceClass|glassAlpha|=== null/);
});

test("glass blur defaults OFF on phones; transparency is ON everywhere", () => {
  // Model B only flows when bars are see-through, so phones get
  // transparency too; the heat cost is the blur, which glassOn keeps off.
  assert.match(REG, /const MOBILE_DEFAULTS: Partial<Values> = \{[^}]*glassOn: false[^}]*\}/);
  assert.doesNotMatch(REG, /const MOBILE_DEFAULTS: Partial<Values> = \{[^}]*transparencyOn[^}]*\}/);
  assert.match(REG, /^\s*glassOn:\s*true,/m);
  assert.match(REG, /^\s*transparencyOn:\s*true,/m);
});

test("both appear in the Effects menu, and only there", () => {
  // Every switch has ONE home in the menus — the Effects section.
  // `s("key")` is the menu's item form.
  const effects = /\{ title: "Effects", tab: "effects", items: \[([\s\S]*?)\] \}/.exec(MENU)?.[1] ?? "";
  assert.ok(effects, "Effects section not found");
  for (const key of ["glassOn", "transparencyOn"]) {
    assert.match(effects, new RegExp(`s\\("${key}"\\)`), `${key} missing from Effects`);
    const count = (MENU.match(new RegExp(`(?<![A-Za-z])s\\("${key}"`, "g")) ?? []).length;
    assert.equal(count, 1, `${key} is listed ${count} times — Effects is its one home`);
  }
});

// ── The pre-paint mirror ────────────────────────────────────────────────────

test("pre-paint mirrors both switches, with deviceClass()'s query character for character", () => {
  // A drifting query is the nastiest failure mode here: the page paints glass
  // for one frame and then drops it, or the toggle reads "on" while nothing
  // blurs. check-prepaint proves the keys are READ; only this pins the query.
  const q = /export const Q_DEVICE_MOBILE = "([^"]+)"/.exec(DEVICE)?.[1];
  assert.ok(q, "could not read Q_DEVICE_MOBILE out of deviceQueries.ts");
  const inLayout = [...LAYOUT.matchAll(/matchMedia\('([^']+)'\)/g)].map((m) => m[1]);
  const glassQs = inLayout.filter((x) => x === q);
  // Shadow + glassOn. Transparency has no device test (ON everywhere).
  assert.ok(glassQs.length >= 2,
    `expected the shadow query plus glassOn's, got ${inLayout.length} matchMedia calls ` +
    `of which ${glassQs.length} match deviceClass()`);

  assert.match(LAYOUT, /theme_glassOn/);
  assert.match(LAYOUT, /theme_transparencyOn/);
  // Transparency: only an explicit '0' turns it off, on every device.
  assert.match(LAYOUT, /var _trOff = localStorage\.getItem\('theme_transparencyOn'\) === '0';/);
  // The PANEL tint has no device-dependent default any more (model B) …
  assert.doesNotMatch(LAYOUT, /_trOff[^;\n]*null|_trOff[^;\n]*_mobQ/, "the panel _trOff must stay '0'-only");
  assert.doesNotMatch(LAYOUT, /_trOff\s*=\s*[^;]*matchMedia/, "the panel _trOff must not test the device");
  // … but the GLASS fill keeps its old phone default: absent on a phone = solid.
  assert.match(LAYOUT, /if \(_tr2 === '0' \|\| \(_tr2 === null && _mobQ\)\) _go = 1;/,
    "the glass fill lost its solid phone default");
  assert.equal((LAYOUT.match(/_tr2 === null/g) ?? []).length, 1, "the null/mobile arm belongs to the glass block only");
  // OFF writes the keyword; ON writes nothing, so "absent" already means ON and
  // there is no first-paint window with the wrong value live.
  assert.match(LAYOUT, /setProperty\('--glass-filter','none'\)/);
  assert.equal((LAYOUT.match(/--glass-filter/g) ?? []).length, 1,
    "the pre-paint script should write --glass-filter exactly once, and only the OFF value");
  assert.doesNotMatch(LAYOUT, /--glass-filter','blur/);
});

test("pre-paint zeroes the alphas rather than clearing the stored opacities", () => {
  // Round-tripping the switch must give the viewer their theme back.
  assert.match(LAYOUT, /if \(_trOff\) \{ _bs = 1; _ys = 1; \}/);
  assert.match(LAYOUT, /if \(_tr2 === '0' \|\| \(_tr2 === null && _mobQ\)\) _go = 1;/);
});

test("the pre-paint script still contains no backtick", () => {
  // The whole script is one JS template literal; a backtick ends it early and
  // the file stops parsing. Cheap to check, expensive to discover.
  const script = /dangerouslySetInnerHTML=\{\{ __html: `([\s\S]*?)`\}\}/.exec(
    readFileSync(join(APP, "layout.tsx"), "utf8"))?.[1];
  assert.ok(script, "pre-paint script not found");
  assert.ok(!script.includes("`"));
});

// ── The dead branch P4 removed ──────────────────────────────────────────────

test("VodList has no embedded prop and no glass", () => {
  const v = read("app", "components", "VodList.tsx");
  assert.doesNotMatch(v, /embedded/, "the prop was only ever true — do not reintroduce it");
  assert.doesNotMatch(v, /\bglass\b/);
});
