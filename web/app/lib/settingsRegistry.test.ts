// The three phone switches (client polish Task 17): community text at 16 px, the app edge to edge,
// and Return = new line in the community composer. Each is a new switch with today's look as its
// default (ADR 0116 — flipping one is the owner's call), so the first thing pinned is that an
// untouched browser sees nothing new.
//
// The registry effects run for real here (jsdom <html>), and so does the REAL pre-paint script from
// app/layout.tsx — the restore a hard reload depends on. What jsdom cannot do is evaluate a media
// query, so "only under 608 px" is pinned on the stylesheet's rule here and measured in a real
// browser by the Look (look/17-phone.mjs).
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G node --test app/lib/settingsRegistry.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { dom, resetStorage } from "./testDom.ts";
import "./testTsx.ts";
import { stripComments, stripCssComments } from "./testSource.ts";

const { ENTRIES, DEFAULTS, applyEffect, readValues, settingSet, LOOK_KEYS, SITE_SCOPED_LS } = await import("./settingsRegistry.ts");
const { SECTIONS } = await import("./settingsMenu.ts");

const html = () => dom.window.document.documentElement;
const ctx = { get: <K extends keyof typeof DEFAULTS>(k: K) => DEFAULTS[k] };

test.beforeEach(() => {
  resetStorage();
  html().removeAttribute("style");
  html().className = "";
});

// ── defaults: nothing changes for anyone who has not touched them ─────────────
test("the three switches default to today's look and behaviour", () => {
  assert.equal(DEFAULTS.communityPhoneText, "chat");
  assert.equal(DEFAULTS.phoneEdgeToEdge, false);
  assert.equal(DEFAULTS.communityReturnKey, "send");
  const v = readValues();
  assert.equal(v.communityPhoneText, "chat");
  assert.equal(v.phoneEdgeToEdge, false);
  assert.equal(v.communityReturnKey, "send");
});

test("the two look switches restore before paint; the Return key is behaviour only", () => {
  assert.equal(ENTRIES.communityPhoneText.prePaint, true);
  assert.equal(ENTRIES.phoneEdgeToEdge.prePaint, true);
  assert.equal(ENTRIES.communityReturnKey.prePaint, false);
  assert.equal(ENTRIES.communityReturnKey.behavior, true, "Reset and saved looks leave the Return key alone");
  assert.ok(LOOK_KEYS.includes("communityPhoneText") && LOOK_KEYS.includes("phoneEdgeToEdge"));
  assert.ok(SITE_SCOPED_LS.has(ENTRIES.communityReturnKey.ls), "follows the site on /chat like the other Behavior keys");
});

test("an unknown stored value reads as the default", () => {
  settingSet(ENTRIES.communityPhoneText.ls, "huge");
  settingSet(ENTRIES.communityReturnKey.ls, "maybe");
  const v = readValues();
  assert.equal(v.communityPhoneText, "chat");
  assert.equal(v.communityReturnKey, "send");
});

// ── phone text ────────────────────────────────────────────────────────────────
test("phone text sets --mx-font-size: 1rem and leaves --chat-font-size", () => {
  html().style.setProperty("--chat-font-size", "1.352rem");
  applyEffect("communityPhoneText", "16", ctx);
  assert.equal(html().style.getPropertyValue("--mx-font-size"), "1rem");
  assert.equal(html().style.getPropertyValue("--chat-font-size"), "1.352rem", "the live chat's size is untouched");
  applyEffect("communityPhoneText", "chat", ctx);
  assert.equal(html().style.getPropertyValue("--mx-font-size"), "", "back to the chat size: the override is removed");
  assert.equal(html().style.getPropertyValue("--chat-font-size"), "1.352rem");
});

test("retry: switching phone text on twice, off twice, leaves one clean state", () => {
  applyEffect("communityPhoneText", "16", ctx);
  applyEffect("communityPhoneText", "16", ctx);
  assert.equal(html().style.getPropertyValue("--mx-font-size"), "1rem");
  applyEffect("communityPhoneText", "chat", ctx);
  applyEffect("communityPhoneText", "chat", ctx);
  assert.equal(html().getAttribute("style") ?? "", "");
});

test("the timestamp size also writes its multiplier, so the community scope can re-derive it", () => {
  applyEffect("tsSize", 0.7, ctx);
  assert.equal(html().style.getPropertyValue("--chat-ts-scale"), "0.7");
  assert.match(html().style.getPropertyValue("--chat-ts-size"), /\* 0\.7\)$/);
  const restored = prepaint({ [ENTRIES.tsSize.ls]: "0.7" });
  assert.equal(restored.style.getPropertyValue("--chat-ts-scale"), "0.7", "a reload restores it before paint");
});

// ── edge to edge ──────────────────────────────────────────────────────────────
test("edge to edge marks <html>, and off removes the mark", () => {
  applyEffect("phoneEdgeToEdge", true, ctx);
  assert.equal(html().classList.contains("phone-edge"), true);
  applyEffect("phoneEdgeToEdge", false, ctx);
  assert.equal(html().classList.contains("phone-edge"), false);
});

const css = stripCssComments(readFileSync(join(process.cwd(), "app", "globals.css"), "utf8"));

test("edge-to-edge sets --panel-gap 0 only under 608 px", () => {
  const rule = /@media \(max-width: 607px\) \{\s*html\.phone-edge \{([^}]*)\}/.exec(css);
  assert.ok(rule, "no phone-only rule for the edge-to-edge mark");
  // !important: a viewer's own panel gap is an inline style on <html>, which a plain rule loses to.
  assert.match(rule[1]!, /--panel-gap:\s*0px !important;/);
  assert.match(rule[1]!, /--frame-width:\s*0px !important;/, "no frame either");
  // The mark does nothing anywhere else: it is named in exactly that one rule.
  assert.equal(css.split("phone-edge").length - 1, 1, "phone-edge is used outside the phone-only rule");
});

// ── community text scope ──────────────────────────────────────────────────────
test("community surfaces take --mx-font-size under 608 px; :root's own value is the chat size", () => {
  assert.match(css, /:root \{ --mx-font-size: var\(--chat-font-size\); \}/);
  const block = /@media \(max-width: 607px\) \{\s*\.mx-scope \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(block, /--chat-font-size: var\(--mx-font-size\);/);
  // A custom property resolves where it is declared, so the chat scale is declared again in the
  // scope — the same four steps as the theme's, or a 16 px row would keep 21.6 px small print.
  const theme = [...css.matchAll(/^\s*(--text-chat-(?:xs|sm|md|lg): [^;]+;)/gm)].map((m) => m[1]);
  assert.equal(theme.length, 8, "the four steps, in the theme and in the scope");
  assert.deepEqual(theme.slice(4), theme.slice(0, 4), "the scope's chat scale differs from the theme's");
  assert.ok(block.includes(theme[0]!), "the scope's chat scale is not inside the phone rule");
  // The timestamp keeps its Timestamps › Size multiplier against the community's size, not the chat's.
  // No fallback on the multiplier: with Size never set the declaration is invalid, so --chat-ts-size
  // stays unset and every reader keeps its own fallback (the member card's 0.72rem among them).
  assert.match(block, /--chat-ts-size: calc\(var\(--chat-font-size, 0\.875rem\) \* var\(--chat-ts-scale\)\);/);
  const view = stripComments(readFileSync(join(process.cwd(), "app", "features", "community", "MatrixView.tsx"), "utf8"));
  assert.match(view, /" matrix-entrance mx-scope"/, "the community root does not carry the scope");
});

// ── the pre-paint restore (a hard reload) ─────────────────────────────────────
const layout = readFileSync(join(process.cwd(), "app", "layout.tsx"), "utf8");
const start = layout.indexOf("__html: `");
const end = layout.indexOf("`}}", start);
const body = layout.slice(start + "__html: `".length, end).replace("${carryLegacyStorageScript()}", "");
const script = (0, eval)("`" + body + "`") as string;

function prepaint(stored: Record<string, string>): HTMLElement {
  const w = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://site.test/", runScripts: "outside-only" }).window;
  for (const [k, v] of Object.entries(stored)) w.localStorage.setItem(k, v);
  w.matchMedia = (() => ({ matches: false, media: "", addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) as never;
  w.eval(script);
  return w.document.documentElement as unknown as HTMLElement;
}

test("restart: a reload restores both look switches before first paint", () => {
  const on = prepaint({ [ENTRIES.communityPhoneText.ls]: "16", [ENTRIES.phoneEdgeToEdge.ls]: "1" });
  assert.equal(on.style.getPropertyValue("--mx-font-size"), "1rem");
  assert.equal(on.classList.contains("phone-edge"), true);
  const off = prepaint({});
  assert.equal(off.style.getPropertyValue("--mx-font-size"), "", "an untouched browser gets no override");
  assert.equal(off.classList.contains("phone-edge"), false);
  // Vacuity: the script ran to its end (the emote button, on by default, marks itself on).
  assert.equal(off.classList.contains("chat-emote-btn-on"), true);
  const chat = prepaint({ [ENTRIES.communityPhoneText.ls]: "chat", [ENTRIES.phoneEdgeToEdge.ls]: "0" });
  assert.equal(chat.style.getPropertyValue("--mx-font-size"), "");
  assert.equal(chat.classList.contains("phone-edge"), false);
});

test("check-prepaint passes with the two lines", () => {
  const out = execFileSync(process.execPath, [join(process.cwd(), "scripts", "check-prepaint.mjs")], { encoding: "utf8" });
  assert.match(out, /✓/);
  const s = stripComments(script);
  assert.match(s, new RegExp(`getItem\\('${ENTRIES.communityPhoneText.ls}'\\)`));
  assert.match(s, new RegExp(`getItem\\('${ENTRIES.phoneEdgeToEdge.ls}'\\)`));
  assert.doesNotMatch(s, new RegExp(ENTRIES.communityReturnKey.ls + "'\\)"), "the Return key is read only at send time");
});

// ── where the controls are ────────────────────────────────────────────────────
test("the controls: Return key under Community › Composer (#242), the two phone switches in their own group", () => {
  const keysOf = (title: string, tab?: string) => SECTIONS.find((s) => s.title === title && (!tab || s.tab === tab))?.items.map((i) => i.key) ?? [];
  assert.deepEqual(keysOf("Composer", "community"), ["communityReturnKey"]);
  assert.ok(keysOf("Composer", "site").length > 0, "the live chat's Composer group is still there");
  assert.ok(!keysOf("Composer", "site").includes("communityReturnKey"), "no longer under Site & bars");
  assert.deepEqual(keysOf("On a phone"), ["phoneEdgeToEdge", "communityPhoneText"]);
  const all = SECTIONS.flatMap((s) => s.items.map((i) => i.key));
  for (const k of ["communityReturnKey", "phoneEdgeToEdge", "communityPhoneText"] as const) {
    assert.equal(all.filter((x) => x === k).length, 1, `${k} listed once`);
  }
});
