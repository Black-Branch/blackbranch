// Tests for bidi-control neutralization in displayed identity + link labels.
//
// The live case that prompted this: a real chat username of Mathematical Bold
// Fraktur letters followed by a single trailing U+202E (1016 rows in
// stream.chat_log). Harmless as a joke; the same character in someone else's
// name or in a link label is a spoof, because an unterminated override reverses
// the display of whatever renders AFTER it.
//
// Run: node --test app/lib/bidi.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { stripBidiControls, hasBidiControls } from "./bidi.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const RLO = "‮"; // right-to-left override — the one seen in live data
const LRO = "‭";
const RLE = "‫";
const PDF = "‬";
const FSI = "⁨";
const PDI = "⁩";

test("strips the trailing RLO from the real live username", () => {
  // Fraktur letters are ordinary letters and must survive; only the override goes.
  const live = "\u{1D56D}\u{1D594}\u{1D598}\u{1D598}\u{1D58A}\u{1D599}\u{1D599}" + RLO;
  const out = stripBidiControls(live);
  assert.equal(hasBidiControls(out), false, "override survived");
  assert.equal(
    out,
    "\u{1D56D}\u{1D594}\u{1D598}\u{1D598}\u{1D58A}\u{1D599}\u{1D599}",
    "the name's actual letters must be preserved — we remove the superpower, not the name"
  );
});

test("strips every explicit control, embed/override/isolate alike", () => {
  for (const c of [LRO, RLO, RLE, "‪", PDF, "⁦", "⁧", FSI, PDI]) {
    assert.equal(stripBidiControls(`a${c}b`), "ab", `failed to strip U+${c.codePointAt(0)!.toString(16)}`);
  }
});

test("leaves ordinary and legitimately RTL text untouched", () => {
  // Genuine RTL does NOT need explicit controls — the characters carry their own
  // bidi class — so stripping the controls must not damage real Arabic/Hebrew.
  for (const s of ["Bram", "nessie", "cleo ⁶🤷⁷", "مرحبا", "שלום", "user_123", ""]) {
    assert.equal(stripBidiControls(s), s, `mutated clean input: ${JSON.stringify(s)}`);
  }
});

test("the spoof it exists to stop: reversed label text", () => {
  // RLO makes the following run render right-to-left, so "moc.elpmaxe" reads as
  // "example.com" to the eye while the href points elsewhere.
  const spoof = RLO + "moc.elpmaxe";
  assert.equal(stripBidiControls(spoof), "moc.elpmaxe",
    "with the override gone the label reads as what it literally is");
});

test("regex state does not leak between calls (the /g/ statefulness trap)", () => {
  // A single /g/ regex shared between .test() and .replace() carries lastIndex
  // across calls, so every other call silently returns the wrong answer. This
  // pins the two-regex split in bidi.ts.
  const dirty = `x${RLO}y`;
  for (let i = 0; i < 6; i++) {
    assert.equal(hasBidiControls(dirty), true, `hasBidiControls flipped on call ${i}`);
    assert.equal(stripBidiControls(dirty), "xy", `stripBidiControls flipped on call ${i}`);
    assert.equal(hasBidiControls("clean"), false, `false positive on call ${i}`);
  }
});

// The three choke points are asserted STATICALLY. Importing chatMsg.ts here is
// not possible under `node --test`: its own internal imports are extensionless,
// which Next and tsc resolve but Node's ESM loader does not. Checking the source
// still pins the thing that matters — that each display path calls the helper —
// and it fails loudly if someone removes the call.
const here = dirname(fileURLToPath(import.meta.url));
const reads = (f: string) => readFileSync(join(here, f), "utf8");

test("every display choke point actually applies the strip", () => {
  const cases: [string, string, string][] = [
    ["chatMsg.ts", "normalizeUsername", "chat usernames"],
    ["matrixDisplay.ts", "memberName", "Matrix display names"],
    ["renderText.tsx", "stripBidiControls(seg.label)", "markdown link labels"],
  ];
  for (const [file, needle, what] of cases) {
    const src = reads(file);
    assert.ok(
      src.includes("stripBidiControls"),
      `${file} no longer imports/uses stripBidiControls — ${what} are unprotected again`
    );
    assert.ok(src.includes(needle), `${file}: expected ${needle} to still exist`);
  }
});

test("the link-label phishing check sees the STRIPPED label, not the raw one", () => {
  // Order matters: a bidi control inside the label could otherwise split the
  // domain match and walk past the guard it is supposed to trip.
  const src = reads("renderText.tsx");
  const strip = src.indexOf("const label = stripBidiControls(seg.label)");
  const check = src.indexOf("deceptiveLinkHost(label,");
  assert.ok(strip > 0, "the label is no longer stripped before the link is rendered");
  assert.ok(check > strip, "deceptiveLinkHost must run on the stripped label, not before it");
});
