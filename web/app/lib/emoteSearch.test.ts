// Run: node --test app/lib/emoteSearch.test.ts
//
// The paste that motivates this is the whole test: the autocomplete writes
// `Name ` into the composer, the user copies it back out, and the picker must
// still find it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";
import { emoteQuery } from "./emoteSearch.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, "..", "..", p), "utf8");

const matches = (name: string, search: string) => name.toLowerCase().includes(emoteQuery(search));

test("the copied-back autofill still finds its emote", () => {
  // The exact shape: ctrl+a ctrl+c out of the chat bar.
  assert.equal(matches("PandaHype", "PandaHype "), true);
  assert.equal(matches("PandaHype", " PandaHype"), true);
  assert.equal(matches("PandaHype", "  PandaHype  "), true);
});

test("whitespace anywhere in the term is dropped, not just the ends", () => {
  assert.equal(emoteQuery("Panda Hype"), "pandahype");
  assert.equal(emoteQuery("\tPanda\nHype "), "pandahype");
});

test("case is folded, so the term matches however it was typed", () => {
  assert.equal(emoteQuery("PANDAhype"), "pandahype");
  assert.equal(matches("PandaHype", "PANDAHYPE"), true);
});

test("an all-whitespace term is empty, i.e. matches everything", () => {
  // Not 'matches nothing' — an empty query is how the grid shows the full list,
  // so a stray space must not blank the picker.
  assert.equal(emoteQuery("   "), "");
  assert.equal(matches("PandaHype", "   "), true);
});

test("the one live name that carries whitespace is still reachable", () => {
  // `"PandaAlert "` is real, straight out of /api/emotes (1175 names, exactly
  // one with whitespace — a trailing artifact from the provider). Stripping the
  // QUERY only is what keeps a substring match finding it.
  assert.equal(matches("PandaAlert ", "PandaAlert"), true);
  assert.equal(matches("PandaAlert ", "PandaAlert "), true);
});

test("a non-match is still a non-match", () => {
  // Guards the obvious over-correction: stripping whitespace must not turn the
  // filter into 'accept anything'.
  assert.equal(matches("PandaHype", "Kappa"), false);
});

test("the picker filters through emoteQuery, not a raw toLowerCase", () => {
  // The section/tab builder lives in lib/emotePickerSections.ts, outside the
  // component, so it's
  // unit-testable headless — see emotePickerSections.test.ts.
  const src = stripComments(read("app/lib/emotePickerSections.ts"));
  assert.match(src, /const q = emoteQuery\(search\)/);
  assert.doesNotMatch(src, /const q = search\.toLowerCase\(\)/);
});
