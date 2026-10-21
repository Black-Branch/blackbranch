// filterMenuSections — the appearance rail's search.
//
// Pure-function tests with fake labels/visibility, plus one run against the
// real SECTIONS to anchor the wiring the fakes can't see.
//
// Run: node --test app/lib/settingsSearch.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { filterMenuSections, SECTIONS, type MenuSection, type MenuItem } from "./settingsMenu.ts";

const item = (key: string, showWhen?: (v: Record<string, unknown>) => boolean) =>
  ({ type: "setting", key, showWhen } as unknown as MenuItem);

const FAKE: MenuSection[] = [
  { title: "Alpha", tab: "text", items: [item("a1"), item("a2")] },
  { title: "Beta", tab: "colours", items: [item("b1"), item("hidden1")] },
] as MenuSection[];

const labels: Record<string, string> = { a1: "Font family", a2: "Line height", b1: "Glow colour", hidden1: "Glow width" };
const labelOf = (k: string) => labels[k] ?? "";
const allVisible = () => true;

test("empty or whitespace query returns [] — the tab filter is the normal path", () => {
  assert.deepEqual(filterMenuSections(FAKE, "", labelOf, allVisible), []);
  assert.deepEqual(filterMenuSections(FAKE, "   ", labelOf, allVisible), []);
});

test("a title match keeps the whole section's visible items", () => {
  const out = filterMenuSections(FAKE, "alph", labelOf, allVisible);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.title, "Alpha");
  assert.equal(out[0]!.items.length, 2);
});

test("a title match still applies the visibility filter — hidden items stay hidden", () => {
  // The mutation that would survive otherwise: dropping
  // `.filter(visible)` from the TITLE branch passes every other test here,
  // and would list showWhen-gated dead controls under a matched group —
  // e.g. searching "timestamps" with showTs off showing its four tuners.
  const onlyA1 = (it: MenuItem) => (it as { key: string }).key === "a1";
  const out = filterMenuSections(FAKE, "alpha", labelOf, onlyA1);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0]!.items.map((i) => (i as { key: string }).key), ["a1"]);
});

test("a label match keeps only the matching items, case-insensitively", () => {
  const out = filterMenuSections(FAKE, "GLOW C", labelOf, allVisible);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.title, "Beta");
  assert.deepEqual(out[0]!.items.map((i) => (i as { key: string }).key), ["b1"]);
});

test("an invisible item never matches, and a section left empty is dropped", () => {
  const onlyA = (it: MenuItem) => (it as { key: string }).key.startsWith("a");
  assert.deepEqual(filterMenuSections(FAKE, "glow", labelOf, onlyA), []);
});

test("no match at all returns [] (the empty state's contract)", () => {
  assert.deepEqual(filterMenuSections(FAKE, "zzz-no-such-setting", labelOf, allVisible), []);
});

test("against the real SECTIONS: a title query finds its group", () => {
  // Real-data anchor: "timestamp" must surface the Timestamps group by its
  // title alone (labels are blanked).
  const out = filterMenuSections(SECTIONS, "timestamp", () => "", () => true);
  assert.deepEqual(out.map((s) => s.title), ["Timestamps"], "the Timestamps group did not match its own title");
  assert.ok(out[0]!.items.length >= 5, "a title match lost the group's items");
});
