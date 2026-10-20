// web/app/lib/settingsFonts.test.ts
// Fonts, grouped and trimmed. Fonts nobody picked are gone; a browser still
// holding one moves to the closest kept font.
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/settingsFonts.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FONTS, FONT_GROUPS, REMOVED_FONTS, remapFont } from "./settingsFonts.ts";
import { stripComments, stripCssComments } from "./testSource.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => stripComments(readFileSync(path.join(here, "..", rel), "utf8"));
const GONE = ["nunito", "raleway", "plus-jakarta", "work-sans", "karla", "manrope", "rubik", "noto-sans", "lexend", "cabin", "comfortaa", "kanit", "source-sans", "lora"];

test("the 14 unused fonts are gone from the list; every used one stays", () => {
  const vals = new Set(FONTS.map((f) => f.value));
  for (const g of GONE) assert.ok(!vals.has(`var(--font-${g})`), g);
  for (const kept of ["ibm-plex", "inter", "titillium", "open-sans", "quicksand", "barlow", "urbanist", "bitter", "dm-sans", "poppins", "merriweather", "montserrat", "oswald", "russo", "anton", "public-sans", "jost", "bebas", "figtree", "outfit", "space-mono", "arvo", "playfair", "varela", "exo2", "teko", "roboto", "chivo", "lato", "mulish", "josefin"]) {
    assert.ok(vals.has(`var(--font-${kept})`), `${kept} is in use and must stay`);
  }
});

test("every font is in a known group; Default leads", () => {
  assert.equal(FONTS[0]?.value, "inherit");
  for (const f of FONTS) assert.ok((FONT_GROUPS as readonly string[]).includes(f.group), `${f.label}: ${f.group}`);
});

test("a removed font maps to a kept one; anything else passes through", () => {
  const vals = new Set(FONTS.map((f) => f.value));
  for (const g of GONE) {
    const to = REMOVED_FONTS[`var(--font-${g})`];
    assert.ok(to && vals.has(to), `${g} → ${to}`);
    assert.equal(remapFont(`var(--font-${g})`), to);
  }
  assert.equal(remapFont("var(--font-inter)"), "var(--font-inter)");
  assert.equal(remapFont("inherit"), "inherit");
});

// The added fonts.
const ADDED = ["atkinson", "onest", "instrument-sans", "hanken", "albert-sans", "mona-sans", "schibsted", "golos", "funnel-sans", "red-hat-text", "be-vietnam", "fredoka", "baloo", "mplus-rounded", "space-grotesk", "bricolage", "sora", "literata", "source-serif", "newsreader", "geist-mono", "jetbrains-mono", "fira-code", "recursive"];

test("the 24 picked fonts are in the picker", () => {
  const vals = new Set(FONTS.map((f) => f.value));
  for (const a of ADDED) assert.ok(vals.has(`var(--font-${a})`), a);
  assert.equal(new Set(FONTS.map((f) => f.label)).size, FONTS.length, "no duplicate labels");
});

// The Google families are self-hosted (scripts/vendor-google-fonts.mjs → fonts/google/), so a
// picker font is loaded when fonts/google/fonts.css declares its variable on :root, or when a
// next/font/local call in layout.tsx declares it and puts it on <html>.
const fontsCssRaw = () => readFileSync(path.join(here, "..", "fonts/google/fonts.css"), "utf8");
const rootVars = () => {
  const root = fontsCssRaw().match(/:root \{\n([\s\S]*?)\n\}/)?.[1] ?? "";
  return new Map([...root.matchAll(/^\s*(--font-[\w-]+): (.+);$/gm)].map((m) => [m[1], m[2]]));
};

test("every picker font is actually loaded: declared by the vendored stylesheet, or by a next/font/local call on <html>", () => {
  const layout = read("layout.tsx");
  const html = layout.match(/className=\{\[([\s\S]*?)\]/)?.[1] ?? "";
  assert.ok(html.includes("geistLatin.variable"), "found the <html> class list");
  assert.match(layout, /import "\.\/fonts\/google\/fonts\.css";/, "layout imports the vendored stylesheet");
  const vars = rootVars();
  assert.ok(vars.size >= 80, `fonts.css :root declares ${vars.size} variables`);
  for (const f of FONTS) {
    const v = f.value.match(/^var\((--font-[\w-]+)\)$/)?.[1];
    if (!v) continue;
    if (vars.has(v)) continue;
    const decl = layout.match(new RegExp(`const (\\w+)\\s*=\\s*localFont\\(\\{\\s*variable: "${v}"`));
    assert.ok(decl, `${f.label}: neither fonts.css nor a next/font/local call declares ${v}`);
    assert.ok(new RegExp(`\\b${decl![1]}\\.variable\\b`).test(html), `${f.label}: ${decl![1]}.variable is not on <html>`);
  }
});

test("the build fetches no font: nothing imports next/font/google, and every file fonts.css names is in the repo", () => {
  const layout = read("layout.tsx");
  assert.ok(!layout.includes("next/font/google"), "layout.tsx imports next/font/google");
  const css = fontsCssRaw();
  assert.ok(!/https?:/.test(stripCssComments(css)), "fonts.css points at a remote URL");
  const urls = [...css.matchAll(/url\(\.\/files\/([^)]+)\)/g)].map((m) => m[1] ?? "");
  assert.ok(urls.length >= 400, `fonts.css names ${urls.length} files`);
  for (const u of new Set(urls)) assert.ok(existsSync(path.join(here, "..", "fonts/google/files", u)), `missing fonts/google/files/${u}`);
  assert.match(css, /:root \{[\s\S]*\}\n$/, "vacuity anchor: fonts.css ends with its :root block");
});

test("the two preloaded faces match their generated record, and each family variable lists them first", () => {
  const layout = read("layout.tsx");
  const css = fontsCssRaw();
  const recs = [...css.matchAll(/\/\* preload (--font-[\w-]+): files\/(\S+) \| font-weight: ([^;]+); \| unicode-range: ([^;]+); \*\//g)];
  assert.equal(recs.length, 2, "Geist and Geist Mono");
  const vars = rootVars();
  for (const [, variable = "", file, weight, range] of recs) {
    const call = layout.match(new RegExp(`localFont\\(\\{ variable: "${variable}"[\\s\\S]*?\\}\\] \\}\\);`))?.[0] ?? "";
    assert.ok(call, `no next/font/local call declares ${variable}`);
    assert.ok(call.includes(`./fonts/google/files/${file}`), `${variable}: file`);
    assert.ok(call.includes(`weight: "${weight}"`), `${variable}: weight`);
    assert.ok(call.includes(`value: "${range}"`), `${variable}: unicode-range`);
    assert.ok(!/preload: false/.test(call), `${variable} must preload`);
    const family = variable.replace(/-latin$/, "");
    assert.ok(vars.get(family)?.startsWith(`var(${variable}), `), `${family} lists ${variable} first`);
  }
});

test("M PLUS Rounded ships only its latin files: from Google it adds ~100 KB (gzipped) of Japanese @font-face rules to every page", () => {
  const layout = read("layout.tsx");
  assert.ok(!/\bM_PLUS_Rounded_1c\b/.test(layout), "must not come from next/font/google");
  assert.match(layout, /localFont\(\{\s*variable: "--font-mplus-rounded"/);
  for (const w of ["400", "500", "700"]) assert.ok(layout.includes(`mplus-rounded-1c-${w}-latin.woff2`), w);
});

test("Atkinson Hyperlegible Next is self-hosted: next/font/google has no fallback metrics for it and warns on every build", () => {
  const layout = read("layout.tsx");
  assert.ok(!/\bAtkinson_Hyperlegible_Next\b/.test(layout), "must not come from next/font/google");
  assert.match(layout, /localFont\(\{\s*variable: "--font-atkinson"[\s\S]*?atkinson-hyperlegible-next-latin\.woff2/);
});

test("the font settings parse through the remap; the removed faces are no longer loaded; the picker shows groups", () => {
  const reg = read("lib/settingsRegistry.ts");
  const fontEntries = reg.match(/parse: parseFont,/g) ?? [];
  assert.equal(fontEntries.length, 4, "fontFamily, usernameFont, tsFont, shellFont");
  const layout = read("layout.tsx");
  const css = fontsCssRaw();
  for (const g of GONE) assert.ok(!layout.includes(`--font-${g}`) && !css.includes(`--font-${g}:`), `still loads ${g}`);
  const picker = read("components/FontPicker.tsx");
  assert.match(picker, /FONT_GROUPS/);
  assert.match(picker, /role="presentation"/, "group headings are not options");
  assert.match(picker, /\}\s*$/, "vacuity anchor");
});
