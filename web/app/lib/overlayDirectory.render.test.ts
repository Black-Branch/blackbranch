// OverlayDirectory — the /overlay page's body. Every source renders with its
// name, what it shows, and the exact string OBS takes (a URL or a file path),
// plus a copy button for it.
//
// Run: node --test app/lib/overlayDirectory.render.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "./testInstallValues.ts";
import { OVERLAY_SOURCES, sourceHref } from "./overlayDirectory.ts";
import "./testTsx.ts";
// The rig files are the install plugin's (resolved like the build does: the owner folder, else none).
const { RIG_OVERLAYS } = await import("./plugins/site.ts");
const SOURCES = [...OVERLAY_SOURCES, ...RIG_OVERLAYS.sources];
const { default: OverlayDirectory } = await import("../components/OverlayDirectory.tsx");

const html = renderToStaticMarkup(createElement(OverlayDirectory));
const unescape = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'");

test("every source is on the page with its name and what OBS is given", () => {
  const text = unescape(html);
  for (const s of SOURCES) {
    assert.ok(text.includes(s.name), `${s.id}: name missing`);
    assert.ok(text.includes(s.shows), `${s.id}: description missing`);
    // At SSR the origin is unknown; the site's own URLs render relative and the
    // client fills the origin in. The others are complete already.
    const expect = s.served === "site" ? s.path : sourceHref(s, "", RIG_OVERLAYS.dir);
    assert.ok(text.includes(expect), `${s.id}: OBS string "${expect}" missing`);
  }
  if (RIG_OVERLAYS.sources.length) assert.ok(text.includes(RIG_OVERLAYS.dir), "a rig file shows the directory OBS loads it from");
  else assert.doesNotMatch(text, /Files on the streaming PC/, "no plugin, no rig section");
});

test("each source has a copy control, and a served source is a link", () => {
  const copies = html.match(/aria-label="Copy [^"]+"/g) ?? [];
  assert.equal(copies.length, SOURCES.length, "one copy button per source");
  const served = SOURCES.filter((s) => s.served !== "rig");
  const links = html.match(/<a [^>]*href="[^"]*overlay\/[^"]*"/g) ?? [];
  assert.equal(links.length, served.length, "every served source opens in a tab, and no rig file pretends to");
});

test("a retiring source says so", () => {
  if (SOURCES.some((s) => s.status === "retiring")) assert.match(html, /Retiring/);
  else assert.doesNotMatch(html, /Retiring/);
});
