#!/usr/bin/env node
// Vendors the site's Google fonts into the repo, so `next build` needs no network.
//
//   node scripts/vendor-google-fonts.mjs     (from web/; needs the network, once)
//
// Writes app/fonts/google/files/*.woff2 and app/fonts/google/fonts.css. The build then reads
// only those files: next/font/google fetched every family from Google on every build, and that
// fetch failed intermittently — a fresh install has to build with no network at all.
//
// The request is the one next/font/google made: its own validator, axes, URL builder, CSS
// fetch (with its browser user agent, which selects woff2) and precomputed fallback metrics are
// called below, so the faces, the files and the fallback faces are the same ones it emitted.
// Every subset Google serves is kept (`subsets` only ever chose what to PRELOAD): a username in
// Cyrillic or Vietnamese renders in the chosen face, exactly as before.
//
// Preloaded families (`preload: true`): their preload-subset file is NOT in fonts.css. layout.tsx
// declares it with next/font/local (the only way to get a <link rel="preload"> for a bundled
// file), and fonts.css puts that face first in the family's variable. A family list falls
// through per glyph by unicode-range, so the result is the same face for every character.
//
// To add or change a font: edit FONTS, run this, commit the files. app/lib/settingsFonts.test.ts
// checks every picker font is declared here or in layout.tsx.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const G = "next/dist/compiled/@next/font/dist/google/";
const { validateGoogleFontFunctionCall } = require(G + "validate-google-font-function-call.js");
const { getFontAxes } = require(G + "get-font-axes.js");
const { getGoogleFontsUrl } = require(G + "get-google-fonts-url.js");
const { fetchCSSFromGoogleFonts } = require(G + "fetch-css-from-google-fonts.js");
const { fetchFontFile } = require(G + "fetch-font-file.js");
const { getFallbackFontOverrideMetrics } = require(G + "get-fallback-font-override-metrics.js");

const PRELOAD_SUBSET = "latin";
// One entry per next/font/google call the site made. Every family: subsets ["latin"], display swap.
const FONTS = [
  { fn: "Geist", variable: "--font-geist-sans", preload: true },
  { fn: "Geist_Mono", variable: "--font-geist-mono", preload: true },
  { fn: "Inter", variable: "--font-inter", weight: ["400", "500", "700"] },
  { fn: "Roboto", variable: "--font-roboto", weight: ["400", "500", "700"] },
  { fn: "Open_Sans", variable: "--font-open-sans", weight: ["400", "500", "700"] },
  { fn: "DM_Sans", variable: "--font-dm-sans", weight: ["400", "500", "700"] },
  { fn: "Figtree", variable: "--font-figtree", weight: ["400", "500", "700"] },
  { fn: "Outfit", variable: "--font-outfit", weight: ["400", "500", "700"] },
  { fn: "Lato", variable: "--font-lato", weight: ["400", "700"] },
  { fn: "Poppins", variable: "--font-poppins", weight: ["400", "500", "700"] },
  { fn: "Mulish", variable: "--font-mulish", weight: ["400", "600", "700"] },
  { fn: "Quicksand", variable: "--font-quicksand", weight: ["400", "500", "700"] },
  { fn: "Montserrat", variable: "--font-montserrat", weight: ["400", "500", "700"] },
  { fn: "Urbanist", variable: "--font-urbanist", weight: ["400", "500", "700"] },
  { fn: "Barlow", variable: "--font-barlow", weight: ["400", "500", "700"] },
  { fn: "Chivo", variable: "--font-chivo", weight: ["400", "500", "700"] },
  { fn: "Public_Sans", variable: "--font-public-sans", weight: ["400", "500", "700"] },
  { fn: "IBM_Plex_Sans", variable: "--font-ibm-plex", weight: ["400", "500", "700"] },
  { fn: "Jost", variable: "--font-jost", weight: ["400", "500", "700"] },
  { fn: "Josefin_Sans", variable: "--font-josefin", weight: ["400", "500", "700"] },
  { fn: "Varela_Round", variable: "--font-varela", weight: "400" },
  { fn: "Oswald", variable: "--font-oswald", weight: ["400", "500", "700"] },
  { fn: "Exo_2", variable: "--font-exo2", weight: ["400", "500", "700"] },
  { fn: "Teko", variable: "--font-teko", weight: ["400", "500", "700"] },
  { fn: "Anton", variable: "--font-anton", weight: "400" },
  { fn: "Russo_One", variable: "--font-russo", weight: "400" },
  { fn: "Titillium_Web", variable: "--font-titillium", weight: ["400", "600", "700"] },
  { fn: "Bebas_Neue", variable: "--font-bebas", weight: "400" },
  { fn: "Merriweather", variable: "--font-merriweather", weight: ["400", "700"] },
  { fn: "Playfair_Display", variable: "--font-playfair", weight: ["400", "700"] },
  { fn: "Bitter", variable: "--font-bitter", weight: ["400", "500", "700"] },
  { fn: "Arvo", variable: "--font-arvo", weight: ["400", "700"] },
  { fn: "Space_Mono", variable: "--font-space-mono", weight: ["400", "700"] },
  { fn: "Onest", variable: "--font-onest", weight: ["400", "500", "700"] },
  { fn: "Instrument_Sans", variable: "--font-instrument-sans", weight: ["400", "500", "700"] },
  { fn: "Hanken_Grotesk", variable: "--font-hanken", weight: ["400", "500", "700"] },
  { fn: "Albert_Sans", variable: "--font-albert-sans", weight: ["400", "500", "700"] },
  { fn: "Mona_Sans", variable: "--font-mona-sans", weight: ["400", "500", "700"] },
  { fn: "Schibsted_Grotesk", variable: "--font-schibsted", weight: ["400", "500", "700"] },
  { fn: "Golos_Text", variable: "--font-golos", weight: ["400", "500", "700"] },
  { fn: "Funnel_Sans", variable: "--font-funnel-sans", weight: ["400", "500", "700"] },
  { fn: "Red_Hat_Text", variable: "--font-red-hat-text", weight: ["400", "500", "700"] },
  { fn: "Be_Vietnam_Pro", variable: "--font-be-vietnam", weight: ["400", "500", "700"] },
  { fn: "Fredoka", variable: "--font-fredoka", weight: ["400", "500", "700"] },
  { fn: "Baloo_2", variable: "--font-baloo", weight: ["400", "500", "700"] },
  { fn: "Space_Grotesk", variable: "--font-space-grotesk", weight: ["400", "500", "700"] },
  { fn: "Bricolage_Grotesque", variable: "--font-bricolage", weight: ["400", "500", "700"] },
  { fn: "Sora", variable: "--font-sora", weight: ["400", "500", "700"] },
  { fn: "Literata", variable: "--font-literata", weight: ["400", "500", "700"] },
  { fn: "Source_Serif_4", variable: "--font-source-serif", weight: ["400", "500", "700"] },
  { fn: "Newsreader", variable: "--font-newsreader", weight: ["400", "500", "700"] },
  { fn: "JetBrains_Mono", variable: "--font-jetbrains-mono", weight: ["400", "500", "700"] },
  { fn: "Fira_Code", variable: "--font-fira-code", weight: ["400", "500", "700"] },
  { fn: "Recursive", variable: "--font-recursive", weight: ["400", "500", "700"] },
  { fn: "Pirata_One", variable: "--font-pirata", weight: "400" },
  { fn: "Press_Start_2P", variable: "--font-press-start", weight: "400" },
  { fn: "Pacifico", variable: "--font-pacifico", weight: "400" },
  { fn: "Bangers", variable: "--font-bangers", weight: "400" },
  { fn: "Creepster", variable: "--font-creepster", weight: "400" },
  { fn: "Rye", variable: "--font-rye", weight: "400" },
  { fn: "Bungee", variable: "--font-bungee", weight: "400" },
  { fn: "Audiowide", variable: "--font-audiowide", weight: "400" },
  { fn: "Special_Elite", variable: "--font-special-elite", weight: "400" },
  { fn: "Cinzel", variable: "--font-cinzel", weight: ["400", "700"] },
  { fn: "Caveat", variable: "--font-caveat", weight: ["400", "700"] },
  { fn: "Monoton", variable: "--font-monoton", weight: "400" },
  { fn: "VT323", variable: "--font-vt323", weight: "400" },
  { fn: "Permanent_Marker", variable: "--font-permanent-marker", weight: "400" },
  { fn: "Alex_Brush", variable: "--font-alex-brush", weight: "400" },
  { fn: "Chewy", variable: "--font-chewy", weight: "400" },
  { fn: "Black_Ops_One", variable: "--font-black-ops", weight: "400" },
  { fn: "Bowlby_One", variable: "--font-bowlby", weight: "400" },
  { fn: "Rampart_One", variable: "--font-rampart", weight: "400" },
  { fn: "Gloria_Hallelujah", variable: "--font-gloria", weight: "400" },
  { fn: "Crafty_Girls", variable: "--font-crafty", weight: "400" },
  { fn: "Shantell_Sans", variable: "--font-shantell", weight: "600" },
  { fn: "Kaushan_Script", variable: "--font-kaushan", weight: "400" },
  { fn: "Sofia", variable: "--font-sofia", weight: "400" },
  { fn: "Comfortaa", variable: "--font-name-comfortaa", weight: "600" },
  { fn: "Barriecito", variable: "--font-barriecito", weight: "400" },
  { fn: "Lacquer", variable: "--font-lacquer", weight: "400" },
  { fn: "Metamorphous", variable: "--font-metamorphous", weight: "400" },
  { fn: "Quintessential", variable: "--font-quintessential", weight: "400" },
  { fn: "Nova_Cut", variable: "--font-nova-cut", weight: "400" },
  { fn: "Jersey_25", variable: "--font-jersey", weight: "400" },
];

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "..", "app", "fonts", "google");
const filesDir = path.join(outDir, "files");

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function vendor(entry) {
  const v = validateGoogleFontFunctionCall(entry.fn, {
    variable: entry.variable, subsets: [PRELOAD_SUBSET], display: "swap",
    ...(entry.weight !== undefined ? { weight: entry.weight } : {}),
    preload: !!entry.preload,
  });
  const axes = getFontAxes(v.fontFamily, v.weights, v.styles, v.selectedVariableAxes);
  const url = getGoogleFontsUrl(v.fontFamily, axes, v.display);
  const css = (await fetchCSSFromGoogleFonts(url, v.fontFamily, false)).split("body {", 1)[0];
  const faces = [];
  let subset = "";
  let block = null;
  for (const line of css.split("\n")) {
    const c = /\/\* (.+?) \*\//.exec(line);
    if (c) { subset = c[1]; continue; }
    if (line.startsWith("@font-face")) { block = { subset, lines: [] }; continue; }
    if (block && line.startsWith("}")) { faces.push(block); block = null; continue; }
    if (block && line.trim()) block.lines.push(line.trim());
  }
  if (!faces.length) throw new Error(`${v.fontFamily}: Google returned no @font-face`);
  const fileFor = new Map();
  for (const f of faces) {
    const src = f.lines.find((l) => l.startsWith("src:"));
    const fileUrl = /url\((.+?)\)/.exec(src)?.[1];
    if (!fileUrl || !fileUrl.endsWith(".woff2")) throw new Error(`${v.fontFamily}: unexpected src ${src}`);
    if (!fileFor.has(fileUrl)) {
      const buf = await fetchFontFile(fileUrl, false);
      const preload = entry.preload && f.subset === PRELOAD_SUBSET;
      const name = preload
        ? `preload-${slug(entry.variable.replace(/^--font-/, ""))}-${f.subset}.woff2`
        : `${slug(v.fontFamily)}-${slug(f.subset)}-${createHash("sha256").update(buf).digest("hex").slice(0, 8)}.woff2`;
      writeFileSync(path.join(filesDir, name), buf);
      fileFor.set(fileUrl, { name, preload });
    }
    f.file = fileFor.get(fileUrl);
    f.src = src;
  }
  const m = getFallbackFontOverrideMetrics(v.fontFamily);
  return { entry, family: v.fontFamily, faces, metrics: m };
}

function render(results) {
  const out = [
    "/* GENERATED by web/scripts/vendor-google-fonts.mjs — never edit by hand; rerun it.",
    " * The Google fonts the site offers, self-hosted: the build reads only these files.",
    " * Each face is Google's own rule with its file served from files/; each family's fallback",
    " * face carries next/font's precomputed metrics. */",
    "",
  ];
  const vars = [];
  for (const { entry, family, faces, metrics } of results) {
    out.push(`/* ${family} — ${entry.variable} */`);
    let preloadFace = null;
    for (const f of faces) {
      if (f.file.preload) { preloadFace = f; continue; }
      const body = f.lines.map((l) => (l.startsWith("src:") ? `src: url(./files/${f.file.name}) format('woff2');` : l));
      out.push(`/* ${f.subset} */`, "@font-face {", ...body.map((l) => `  ${l}`), "}");
    }
    if (metrics) {
      out.push("@font-face {", `  font-family: '${family} Fallback';`, `  src: local("${metrics.fallbackFont}");`,
        `  ascent-override: ${metrics.ascentOverride};`, `  descent-override: ${metrics.descentOverride};`,
        `  line-gap-override: ${metrics.lineGapOverride};`, `  size-adjust: ${metrics.sizeAdjust};`, "}");
    }
    const list = [`'${family}'`, ...(metrics ? [`'${family} Fallback'`] : [])];
    if (entry.preload) {
      if (!preloadFace) throw new Error(`${family}: no ${PRELOAD_SUBSET} face to preload`);
      const range = preloadFace.lines.find((l) => l.startsWith("unicode-range:"));
      const weight = preloadFace.lines.find((l) => l.startsWith("font-weight:"));
      // Read by settingsFonts.test.ts, which checks layout.tsx's next/font/local call against it.
      out.push(`/* preload ${entry.variable}-${PRELOAD_SUBSET}: files/${preloadFace.file.name} | ${weight} | ${range} */`);
      list.unshift(`var(${entry.variable}-${PRELOAD_SUBSET})`);
    }
    vars.push(`  ${entry.variable}: ${list.join(", ")};`);
    out.push("");
  }
  out.push(":root {", ...vars, "}", "");
  return out.join("\n");
}

rmSync(filesDir, { recursive: true, force: true });
mkdirSync(filesDir, { recursive: true });
const results = [];
for (const entry of FONTS) {
  results.push(await vendor(entry));
  process.stdout.write(".");
}
writeFileSync(path.join(outDir, "fonts.css"), render(results));
console.log(`\n${results.length} families, ${readdirSync(filesDir).length} files → ${path.relative(process.cwd(), outDir)}`);
