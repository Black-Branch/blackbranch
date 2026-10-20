// The appearance page is a Rail, not band tabs.
//
// Source-scan pins, each with an end-of-file vacuity anchor: a truncated read
// must fail loudly, not pass an absence assertion over a hole.
//
// Run: node --test app/lib/appearanceRail.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

const readRaw = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

test("AccountCard's band carries the title again — no tabs prop on Window", () => {
  const raw = readRaw("app", "components", "AccountCard.tsx");
  assert.ok(raw.trimEnd().endsWith("}"), "AccountCard.tsx truncated — anchors below are vacuous");
  const src = stripComments(raw);
  assert.ok(src.includes('storageKey="bb_profilecard_geom"'), "not the account-card Window any more?");
  assert.ok(!/\btabs=\{/.test(src),
    "AccountCard passes tabs to Window again — the sections belong to the body rail, and " +
    "with tabs present the band's one text slot drops the title");
  assert.ok(src.includes("title={top.title}"), "the page title left the band");
  assert.ok(src.includes("onTab={setAppearanceTab}"), "the rail's section state is no longer threaded");
});

test("ChatAppearanceBody hosts the rail: chrome door, five sections, search wired", () => {
  const raw = readRaw("app", "components", "ChatAppearanceBody.tsx");
  assert.ok(raw.trimEnd().endsWith("}"), "ChatAppearanceBody.tsx truncated");
  const src = stripComments(raw);
  assert.ok(src.includes('import { Rail, RailLayout } from "@/app/components/chrome"'),
    "the rail must come through the chrome index door");
  assert.ok(src.includes("<Rail"), "no Rail rendered");
  assert.ok(src.includes("items={TABS}"), "the rail does not list the five menu sections");
  assert.ok(src.includes('aria-label="Search settings"'), "the search field is gone again");
  assert.match(src, /setSearch\(""\);\s*onTab\(t\);/,
    "picking a section must clear the search — otherwise the rail selects while the query filters, two lenses at once");
  assert.ok(src.includes("activeTab={q ? undefined : tab}"),
    "search must suspend the tab filter or matches outside the active section never show");
});

test("ChatSettings filters through filterMenuSections and owns the empty state", () => {
  const raw = readRaw("app", "components", "ChatSettings.tsx");
  assert.ok(raw.trimEnd().endsWith("}"), "ChatSettings.tsx truncated");
  const src = stripComments(raw);
  assert.ok(src.includes("filterMenuSections(INSTALLED_SECTIONS, q,"),
    "search no longer goes through the pure, tested filter");
  assert.ok(src.includes("No settings match"),
    "an empty result renders nothing at all — a search with no feedback reads as broken");
});

test("the appearance floor is the derived 632, not an eyeball", () => {
  const raw = readRaw("app", "lib", "accountPages.ts");
  assert.ok(raw.trimEnd().endsWith(";"), "accountPages.ts truncated");
  assert.match(stripComments(raw), /appearance:\s*632,/,
    "the appearance floor moved — re-derive it (436 content + 160 rail + 12 gap + 24 padding) and update both sites");
});

test("phones get an icon rail: RailLayout switches by container width and shows the section name", () => {
  // A container query cannot match its own container, so the size container
  // is declared on the layout's PARENT (ChatAppearanceBody's wrapper) — that is
  // what lets the query re-grid `.chrome-rail-layout` itself.
  const cssRaw = readRaw("app", "components", "chrome", "chrome.css");
  assert.ok(cssRaw.trimEnd().endsWith("}"), "chrome.css truncated");
  assert.match(cssRaw, /@container \(max-width: 607px\) \{[\s\S]*?\.chrome-rail-layout \{ grid-template-columns: 44px/);
  assert.match(cssRaw, /@container \(max-width: 607px\) \{[\s\S]*?\.chrome-rail \.chrome-tab-label \{ display: none; \}/);
  assert.doesNotMatch(cssRaw, /\.chrome-rail-layout \{[^}]*container-type/,
    "the layout declares itself a container — its own query can then never re-grid it");
  const bodyRaw = readRaw("app", "components", "ChatAppearanceBody.tsx");
  assert.ok(bodyRaw.trimEnd().endsWith("}"), "ChatAppearanceBody.tsx truncated");
  const body = stripComments(bodyRaw);
  assert.match(body, /<div data-scroll-inner className="p-3" style=\{\{ containerType: "inline-size" \}\}>\s*<input[\s\S]*?\/>\s*<div ref=\{setHeaderSlot\} className="shrink-0" \/>\s*<RailLayout/,
    "the rail layout's parent must be the size container, with the search field above the layout");
  // Search is full width ABOVE the layout at every width — never inside the
  // rail column, where the icon rail squeezes it to a 44px sliver.
  const railProp = body.match(/rail=\{([\s\S]*?)\n {8}\}/)?.[1] ?? "";
  assert.ok(railProp.includes("<Rail"), "could not read the rail prop — the negative below is vacuous");
  assert.ok(!railProp.includes("Search settings"), "the search field is back inside the rail column");
  assert.match(body, /compactHeading=\{/);
  const layout = stripComments(readRaw("app", "components", "chrome", "RailLayout.tsx"));
  assert.match(layout, /compactHeading && <div className="chrome-rail-compact-heading">/);
  const rail = stripComments(readRaw("app", "components", "chrome", "Rail.tsx"));
  assert.match(rail, /t\.icon && <span className="chrome-rail-icon" aria-hidden="true">/);
});
