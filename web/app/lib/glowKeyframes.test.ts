// The Pulse name glow costs the compositor, not the page.
//
// The defect, measured on the throwaway pair (2026-11-06; phone 390 px, CPU 4×, idle Live tab,
// eight Pulse names on screen): the page drew 60 frames a second with ~17 paints per frame and
// the main thread busy ~28 % of the time, doing nothing; with name animations switched off it
// drew 0 frames. `un-pulse` animated `text-shadow`, which re-rasterizes the glyphs every frame.
//
// The fix keeps the look and moves the motion: the halo is drawn ONCE on two layers behind the
// name — its resting 3px glow and its 50% bloom — and only their OPACITY animates (crossfaded),
// which the compositor runs without a repaint. These checks are computed from the CSS itself.
//
// Run: node --test app/lib/glowKeyframes.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments, stripCssComments, cssAtRuleBodies } from "./testSource.ts";
import { usernameStyleCSS, usernameStyleAnimClass } from "./usernameStyles.ts";

const HERE = new URL(".", import.meta.url).pathname;
const RAW = readFileSync(join(HERE, "../globals.css"), "utf8");
const CSS = stripCssComments(RAW);

/** Every @keyframes block: name → the set of properties it animates. */
function keyframes(css: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    let i = m.index! + m[0].length;
    for (let depth = 1; depth > 0; i++) depth += css[i] === "{" ? 1 : css[i] === "}" ? -1 : 0;
    const body = css.slice(m.index! + m[0].length, i - 1);
    const props = new Set([...body.matchAll(/([a-z-]+)\s*:/g)].map((p) => p[1]!));
    out.set(m[1]!, props);
  }
  return out;
}
/** The declarations of the top-level rule whose whole selector is `selector`. */
function rule(selector: string): string {
  for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1]!.trim() === selector) return m[2]!;
  }
  return "";
}
const decl = (body: string, prop: string) => new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(body)?.[1]?.trim() ?? null;

test("the CSS was read to its end (vacuity anchor for the negative checks below)", () => {
  assert.match(RAW.slice(-400), /@keyframes timer-delta-fade[^\n]*\n\}\s*$/, "globals.css did not end as expected — a short read");
  assert.ok(keyframes(CSS).size >= 30, `parsed only ${keyframes(CSS).size} @keyframes blocks`);
});

test("no keyframes animate text-shadow — a halo animated that way repaints every frame", () => {
  for (const [name, props] of keyframes(CSS)) {
    assert.ok(!props.has("text-shadow"), `@keyframes ${name} animates text-shadow`);
  }
});

test("glow keyframes animate only opacity/transform", () => {
  const layers = ["::before", "::after"].map((p) => decl(rule(`.un-pulse${p}`), "animation"));
  assert.ok(layers.every(Boolean), `both glow layers must animate, got ${JSON.stringify(layers)}`);
  const frames = keyframes(CSS);
  for (const anim of layers) {
    const name = /^([\w-]+)/.exec(anim!)![1]!;
    const props = frames.get(name);
    assert.ok(props && props.size > 0, `no @keyframes ${name}`);
    for (const p of props) assert.ok(p === "opacity" || p === "transform", `@keyframes ${name} animates ${p}`);
    assert.match(anim!, /1\.8s ease-in-out infinite/, "the pulse keeps its 1.8 s breath");
  }
});

test("the layers are the old first frame and the old 50% frame; at rest they show the first", () => {
  const rest = rule(".un-pulse::before"), bloom = rule(".un-pulse::after");
  assert.equal(decl(rest, "text-shadow"), "0 0 3px var(--un-c)");
  assert.equal(decl(bloom, "text-shadow"), "0 0 6px var(--un-c), 0 0 12px color-mix(in srgb, var(--un-c) 40%, transparent)");
  // With every animation off (reduced motion, the toggle) the name rests on the first frame.
  assert.equal(decl(rest, "opacity"), "1");
  assert.equal(decl(bloom, "opacity"), "0");
  assert.match(CSS, /\.un-pulse::before,\s*\.un-pulse::after\s*\{[^}]*content:\s*var\(--un-text\)/, "the layers draw the name's own text");
});

test("every off-switch reaches the glow layers", () => {
  // The off-screen fence, the "Animate name styles" toggle, reduced motion, and name styles off.
  assert.match(CSS, /\[data-anim-off\] \.un-pulse::before,\s*\[data-anim-off\] \.un-pulse::after,\s*\[data-anim-off\]\.un-pulse::before,\s*\[data-anim-off\]\.un-pulse::after\s*\{\s*animation:\s*none/);
  assert.match(CSS, /\.un-noanim \.un-pulse::before,\s*\.un-noanim \.un-pulse::after\s*\{\s*animation:\s*none/);
  assert.ok(cssAtRuleBodies(CSS, "@media (prefers-reduced-motion: reduce)")
    .some((b) => /\.un-anim\s*\{\s*animation:\s*none/.test(b) && /\.un-pulse::before,\s*\.un-pulse::after\s*\{\s*animation:\s*none/.test(b)),
  "reduced motion must stop the glow layers where it stops the names");
  assert.match(CSS, /\.chat-namestyles-off \.chat-un-style::before,\s*\.chat-namestyles-off \.chat-un-style::after\s*\{\s*content:\s*none !important/);
});

test("a Pulse name hands its text to the layers, sets no animated shadow of its own, and is tagged", () => {
  const css = usernameStyleCSS({ effect: "pulse" }, "#7dd9a8", 'ca"s\\ey') as Record<string, unknown>;
  assert.equal(css["--un-text"], '"ca\\"s\\\\ey"', "the name as a CSS string, quote and backslash escaped");
  assert.equal(css.animation, undefined, "the element itself no longer animates");
  assert.equal(css.textShadow, "none", "the row's shadow stays off the name, as when the keyframes overrode it");
  assert.equal(usernameStyleAnimClass({ effect: "pulse" }), "un-anim un-pulse");
  // With an entrance the two animations still compose.
  assert.match(String((usernameStyleCSS({ effect: "pulse", entrance: "stamp" }, "#7dd9a8", "casey") as Record<string, unknown>).animation), /var\(--un-enter\)/);
  assert.equal(usernameStyleAnimClass({ effect: "pulse", entrance: "stamp" }), "un-anim un-arrive un-pulse");
  // A gradient name keeps its clipped fill and its filter shadows.
  const grad = usernameStyleCSS({ effect: "pulse", gradient: "duo" }, "#7dd9a8", "casey") as Record<string, unknown>;
  assert.equal(grad.backgroundClip, "text");
  assert.match(String(grad.filter), /chat-shadow-filter/);
});

test("census: every component that renders a styled name hands it the name's text", () => {
  const files = [
    "../components/profileCardParts.tsx", "../components/CreditOverlay.tsx", "../components/PinnedBanner.tsx",
    "../components/MatrixMessageRow.tsx", "../features/chat/ChatMessage.tsx",
    "../features/home/widgets/BoardsWidget.tsx", "../components/ProfileEditor.tsx",
  ];
  let calls = 0;
  for (const f of files) {
    const src = stripComments(readFileSync(join(HERE, f), "utf8"));
    const found = [...src.matchAll(/usernameStyleCSS\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)];
    assert.ok(found.length > 0, `${f} no longer calls usernameStyleCSS — update this census`);
    for (const m of found) {
      calls++;
      assert.equal(m[1]!.split(",").length, 3, `${f}: usernameStyleCSS(${m[1]}) — pass the name, or a Pulse name has no glow`);
    }
  }
  assert.equal(calls, 7);
});
