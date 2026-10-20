// Tests for redacted messages: the glyph set, the `||mark||` parser, finding
// hidden runs again, and the bars.
//
// Run: node --test app/lib/redactedMessage.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
import {
  REDACT_GLYPHS, parseRedaction, splitRedacted,
  REDACT_MIN_CREDIT, REDACT_ANIMATE_MS, REDACT_REVEAL_MS, redactSegments, redactFiller, revealRefusal,
} from "./redactedMessage.ts";

/** A whole-message redaction's public text — what `scramble` used to return. */
const scramble = (t: string) => parseRedaction(t, true).publicText;
/** The exact wording for a hidden part on a platform. */
const REDACTED_LABEL = "[REDACTED]";

test("the glyph set contains no letters or digits", () => {
  // THE ONE THAT MATTERS. A scramble drawn from an alphanumeric alphabet can
  // spell a real word by accident — including a slur — and it would be rendered
  // to every viewer, attributed to the sender, in a feature whose whole promise
  // is that nobody can read the message.
  assert.match(REDACT_GLYPHS, /^[^\p{L}\p{N}]+$/u);
  assert.ok(REDACT_GLYPHS.length >= 8, "too few glyphs to look random");
  assert.equal(new Set(REDACT_GLYPHS).size, [...REDACT_GLYPHS].length, "duplicate glyphs skew the draw");
});

test("every glyph is inside the range the served font file actually contains", () => {
  // THE INVARIANT.
  //
  // next/font SUBSETS Google fonts, so the woff2 actually served holds only part
  // of the typeface. For Geist Mono the @font-face declares Latin plus exactly
  // `U+23B8-23BD, U+2500-259F` — Box Drawing and Block Elements — and nothing
  // else. A glyph outside that falls back to a SYSTEM font and brings its
  // advance width along, so the line reflows mid-reveal on whichever devices
  // happen to have a differently-proportioned fallback.
  //
  // Re-derive after any font change:
  //   grep -o '@font-face{[^}]*}' .next/static/chunks/*.css \
  //     | grep -i mono | sed 's/.*unicode-range://' | sort -u
  //
  // DO NOT "verify" this by measuring widths in a browser. Comparing the glyph
  // under two font stacks agrees whenever BOTH fall through to the same system
  // last-resort font, which looks exactly like coverage — a set can measure
  // perfect on desktop and break on Android. Only the unicode-range answers the
  // question.
  for (const ch of REDACT_GLYPHS) {
    const cp = ch.codePointAt(0)!;
    assert.ok(cp >= 0x2500 && cp <= 0x259f,
      `U+${cp.toString(16).toUpperCase()} is outside U+2500-259F, the only symbol range the served Geist Mono contains`);
  }
});

test("the alphabet is block elements, with no near-blank glyphs", () => {
  // AESTHETIC, and deliberately NARROWER than the safety range above. The font
  // also covers all 128 Box Drawing characters, but they are mostly thin single
  // lines, so the scramble reads as a TABLE rather than as redacted text, and
  // at 128-of-152 glyphs they swamp the blocks completely.
  //
  // Widening back toward U+2500 would still be width-safe — this assertion is
  // about how it LOOKS, and is the one to relax if that judgement changes.
  for (const ch of REDACT_GLYPHS) {
    const cp = ch.codePointAt(0)!;
    assert.ok(cp >= 0x2580, `U+${cp.toString(16).toUpperCase()} is box drawing, not a block element`);
  }
  assert.ok(REDACT_GLYPHS.length >= 24, `only ${REDACT_GLYPHS.length} glyphs — repeats visibly in one message`);
  assert.equal(new Set(REDACT_GLYPHS).size, [...REDACT_GLYPHS].length, "duplicate glyphs skew the draw");
  // The one-eighth blocks are covered and correctly sized, but read as blank —
  // sprinkling them through a scramble invents word gaps that are not in the
  // message, which is exactly the shape the seal is meant to preserve.
  for (const faint of ["▁", "▔", "▏", "▕"]) {
    assert.ok(!REDACT_GLYPHS.includes(faint), `${faint} is near-blank and fakes a word gap`);
  }
  // The dithered shades OVERFLOW THE LINE BOX, measured against the real chat
  // cell (21.632px text / 30.28px line box at the default line-height of 1.4).
  // Geist Mono draws them with more ink than the box they sit in, so they
  // bleed into the lines above and below.
  //
  //   ▓ 1.4531em tall, 0.6563em wide in a 0.6em cell   EXCEEDS both
  //   ▒ 1.4063em tall                                   EXCEEDS the line box
  //   ░ 1.3750em tall                                   half a pixel of clearance
  //
  // Everything remaining tops out at 1.3125em. This is a property of the FONT,
  // not of the codepoints — re-measure before re-admitting any of them, and
  // certainly if the served font ever changes.
  for (const tall of ["░", "▒", "▓"]) {
    assert.ok(!REDACT_GLYPHS.includes(tall),
      `${tall} has more ink than the chat line box and overlaps the rows around it`);
  }
});

test("no glow at all — hover only brightens the bar's grey edge", () => {
  // No glow at rest OR on hover — a coloured hover glow is too much.
  const css = readFileSync(join(HERE, "../globals.css"), "utf8");
  const at = css.search(/^\.redact-bar \{/m);
  assert.notEqual(at, -1, ".redact-bar has no rule of its own in globals.css");
  const bar = css.slice(at, css.indexOf("\n}", at));
  assert.match(bar, /text-shadow:\s*none/, "the row's inherited shadow would outline the hidden glyphs");
  const hAt = css.indexOf('.redact-text[data-sealed="true"]:hover .redact-bar {');
  assert.notEqual(hAt, -1, "the hover rule is gone");
  const hover = css.slice(hAt, css.indexOf("}", hAt));
  assert.match(hover, /--redact-rim:\s*var\(--color-redact-edge-hover\)/, "hover must brighten the edge");
  for (const r of [bar, hover]) {
    assert.doesNotMatch(r, /drop-shadow|box-shadow|filter|color-mix|--color-encrypted/, `a glow or a colour is back:\n${r}`);
  }
});

test("the flat bar: a band with an edge on all four sides, one bar per line", () => {
  // Bars filled ~1.3em of a 1.4 line and touched between lines; then the
  // gradient band lost its SIDE edges. Two sized layers fix both: the edge
  // colour at the band's size, the black 1px smaller on every side inside it.
  const css = readFileSync(join(HERE, "../globals.css"), "utf8");
  const at = css.search(/^\.redact-bar \{/m);
  assert.notEqual(at, -1, ".redact-bar has no rule of its own");
  const bar = css.slice(at, css.indexOf("\n}", at));
  assert.match(bar, /background-image:\s*linear-gradient\(var\(--color-redact\), var\(--color-redact\)\),\s*linear-gradient\(var\(--redact-rim\), var\(--redact-rim\)\);/,
    "the black layer must sit over the edge layer");
  const size = /background-size:\s*calc\(100% - 2px\) calc\((\d+)% - 2px\),\s*100% (\d+)%;/.exec(bar);
  assert.ok(size, "the black layer must be 1px inside the edge on all four sides");
  assert.equal(size![1], size![2], "the two layers must be the same band");
  assert.ok(Number(size![2]) <= 90, `a ${size![2]}% band leaves no gap between wrapped lines`);
  assert.match(bar, /background-repeat:\s*no-repeat/, "a repeating layer would fill the whole box again");
  assert.match(bar, /box-decoration-break:\s*clone/, "each wrapped line needs its own full edge");
  assert.doesNotMatch(bar, /border-radius/, "the flat bar is square");
});

test("opened text is the message's own colour — no redacted colour setting", () => {
  // "the old encrypted color thing doesn't need to exist, the uncovered text
  // can be the same color as the rest of the font."
  const css = readFileSync(join(HERE, "../globals.css"), "utf8");
  assert.ok(css.includes(".redact-bar {"), "vacuity: the redact rules were found");
  assert.equal(css.indexOf(".redact-text {"), -1, ".redact-text has a rule again — opened text must inherit the row's look");
  assert.equal(css.indexOf("--chat-encrypted-color"), -1, "the retired colour setting's var is still read");
  const registry = readFileSync(join(HERE, "./settingsRegistry.ts"), "utf8");
  assert.ok(registry.includes("chatStyle_tsColor"), "vacuity: the registry was read");
  assert.equal(registry.indexOf("encryptedColor"), -1, "the redacted colour setting is back in the registry");
});

test("a hidden part uses the chat's own font and size", () => {
  // A hidden part mid-sentence matches its neighbours' font and size: the mono
  // stack and 0.92em scale belonged only to the glyph cipher.
  const css = readFileSync(join(HERE, "../globals.css"), "utf8");
  const rules = [...css.matchAll(/^\.redact-(?:text|bar)[^{]*\{[^}]*\}/gm)].map((m) => m[0]);
  assert.ok(rules.length >= 2, `found only ${rules.length} redact rules — the scan is looking in the wrong place`);
  for (const r of rules) {
    for (const metric of ["font-family", "font-size", "line-height", "letter-spacing"]) {
      assert.ok(!new RegExp(`\\b${metric}:`).test(r), `${metric} set on a redact rule:\n${r}`);
    }
  }
});
test("a scramble reveals nothing but the shape of the message", () => {
  const plain = "meet me at the usual place";
  const out = scramble(plain);
  assert.equal(out.length, plain.length, "length is preserved so the reveal can morph in place");
  assert.ok(!out.includes("meet"), "leaked plaintext");
  assert.match(out, /^[^\p{L}\p{N}]+$/u, "a scramble must never contain a letter");
});

test("whitespace survives, everything else does not", () => {
  // Word shape is preserved on purpose (it reads as a message rather than a wall
  // of noise) — but ONLY whitespace, so punctuation, URLs and emote names cannot
  // be inferred from the placeholder.
  const out = scramble("a b\tc\nd");
  assert.equal(out.length, 7);
  assert.equal(out[1], " ");
  assert.equal(out[3], "\t");
  assert.equal(out[5], "\n");
  for (const i of [0, 2, 4, 6]) assert.ok(REDACT_GLYPHS.includes(out[i]!), `position ${i} not scrambled`);
});

test("punctuation is scrambled, not passed through", () => {
  // It would otherwise leak sentence structure — and a message of pure
  // punctuation would pass through completely intact.
  const out = scramble("?!.,:;-—'\"()");
  assert.ok([...out].every((c) => REDACT_GLYPHS.includes(c)), `punctuation survived: ${out}`);
});

test("an empty message scrambles to empty rather than throwing", () => {
  assert.equal(scramble(""), "");
});

test("a scramble carries each letter's rough shape, and nothing finer", () => {
  // k traded word SHAPE for a width that never changes: "if it means that the
  // only way to have an unchanging width is to give away the shape of a word,
  // I'm not sure this is that big of a deal." So the scramble is deterministic
  // by design now (it replaced "scrambles differ run to run") — but it must
  // still carry only the shape class, never the letter: words of one outline
  // seal identically.
  assert.equal(scramble("cat"), scramble("ear"), "same outline must seal the same — the letters must not show");
  assert.equal(scramble("Hi"), scramble("Bl"), "capital + thin");
  assert.notEqual(scramble("ill"), scramble("mow"), "thin and wide letters must seal differently, or the bars cannot match");
  const classes = new Set([...scramble("il ft ae mw NB MW 07 \u{1F600}\u200d")].filter((c) => c !== " "));
  assert.ok(classes.size <= 8, `a scramble may carry at most 8 shape classes, found ${classes.size}`);
});

test("every stored shape glyph maps back to a filler letter; unknown glyphs fall back", () => {
  // The browser draws the bar over the filler for the stored glyph's shape.
  // A message stored before shapes (random glyphs) must still render.
  for (const [plain, filler] of [["i", "l"], ["t", "t"], ["a", "e"], ["m", "m"], ["N", "N"], ["W", "M"], ["7", "0"], ["\u200d", ""]] as [string, string][]) {
    assert.equal(redactFiller(scramble(plain)), filler, `${JSON.stringify(plain)} must fill as ${JSON.stringify(filler)}`);
  }
  assert.equal(redactFiller("\u2591"), "s", "an old random glyph must fall back to the average filler");
  assert.equal(redactFiller(" "), " ", "whitespace stays itself");
});

test("a scramble only ever draws glyphs from the set", () => {
  const out = scramble("x".repeat(400));
  for (const ch of out) assert.ok(REDACT_GLYPHS.includes(ch), `${ch} is not in REDACT_GLYPHS`);
});

test("an emote name is sealed like any other word, and survives in the plaintext", () => {
  // Emotes encrypt and decrypt with the message. Two halves. The scramble must
  // not leave `catJAM` sitting in the ciphertext for anyone to read — an emote
  // name is content, and a message that is only an emote would otherwise be
  // fully legible while "encrypted".
  const plain = "catJAM this is huge catJAM";
  const sealed = scramble(plain);
  assert.ok(!sealed.includes("catJAM"), "the emote name survived into the ciphertext");
  assert.match(sealed, /^[^\p{L}\p{N}]+$/u);
  // The other half is that the name is UNTOUCHED in what gets stored — the
  // plaintext is passed through verbatim, so renderText can resolve it back to
  // an image on reveal. Word shape is all the scramble preserves.
  assert.equal(sealed.length, plain.length);
  assert.equal(sealed.split(" ").map((w: string) => w.length).join(","),
               plain.split(" ").map((w: string) => w.length).join(","));
});

test("redactSegments bars every word past the reveal point and never a space", () => {
  // Split by word, not one bar per phrase.
  const msg = "meet me at noon";
  // Sealed: one bar per word, the real gaps between them.
  assert.deepEqual(redactSegments(msg, 0), [
    { text: "meet", bar: true }, { text: " ", bar: false }, { text: "me", bar: true },
    { text: " ", bar: false }, { text: "at", bar: true }, { text: " ", bar: false }, { text: "noon", bar: true },
  ]);
  // Mid-walk: the uncovered prefix merges with its spaces; a word can be half lifted.
  assert.deepEqual(redactSegments(msg, 6), [
    { text: "meet m", bar: false }, { text: "e", bar: true }, { text: " ", bar: false },
    { text: "at", bar: true }, { text: " ", bar: false }, { text: "noon", bar: true },
  ]);
  // Fully open: no bars at all.
  assert.deepEqual(redactSegments(msg, msg.length), [{ text: msg, bar: false }]);
  // Width is preserved: the segments always rejoin to the exact input.
  for (const n of [0, 3, 7, 15]) {
    assert.equal(redactSegments(msg, n).map((g: { text: string }) => g.text).join(""), msg);
  }
});

test("the reveal fits inside the readable window", () => {
  // The reveal must finish well inside the readable window, or the message
  // starts re-sealing before it has finished opening.
  assert.ok(REDACT_ANIMATE_MS * 2 < REDACT_REVEAL_MS,
    "reveal + re-seal must fit inside the time the message is meant to be readable");
});

test("the gate constants are the decided values", () => {
  // Threshold-only: redaction costs nothing to use.
  assert.equal(REDACT_MIN_CREDIT, 1);
});

test("there is no cooldown, and the 🔒 toggle stays armed after a send", () => {
  // No cooldown, so no one accidentally posts a non-redacted message: a
  // cooldown disarms the toggle after each send, and a disarmed toggle is how
  // the NEXT message goes out in the clear.
  const lib = stripComments(readFileSync(join(HERE, "./redactedMessage.ts"), "utf8"));
  assert.ok(lib.trimEnd().endsWith("}"), "redactedMessage.ts truncated — the negatives below are vacuous");
  assert.doesNotMatch(lib, /COOLDOWN/, "a cooldown constant is back");
  const route = stripComments(readFileSync(join(HERE, "../api/chat/send/route.ts"), "utf8"));
  assert.ok(route.includes("return new Response(\"OK\");\n}"), "send route truncated — the negatives below are vacuous");
  assert.doesNotMatch(route, /encrypt_cooldown|encryptCooldown/, "the send route still enforces a redaction cooldown");
  const input = stripComments(readFileSync(join(HERE, "../features/chat/ChatInput.tsx"), "utf8"));
  assert.ok(input.trimEnd().endsWith("}"), "ChatInput.tsx truncated");
  assert.doesNotMatch(input, /if \(encryptArmed\) resetDest\(\)/,
    "the composer disarms 🔒 after a send again — the next message would go out in the clear");
});

// ── partial redaction ───────────────────────────────────────────────────────

test("||marks|| hide just that part, for every audience", () => {
  const r = parseRedaction("the ending is ||he was dead|| lol");
  assert.equal(r.redacted, true);
  assert.equal(r.plain, "the ending is he was dead lol", "the marks are removed from the plaintext");
  assert.equal(r.platformText, `the ending is ${REDACTED_LABEL} lol`);
  // The public text: visible words verbatim, hidden ones glyphs with their gaps.
  assert.ok(r.publicText.startsWith("the ending is "));
  assert.ok(r.publicText.endsWith(" lol"));
  for (const w of ["he", "was", "dead"]) {
    assert.ok(!new RegExp(`\\b${w}\\b`).test(r.publicText.slice(14, -4)), `hidden word "${w}" leaked`);
  }
  assert.match(r.publicText.slice(14, -4), /^[^\p{L}\p{N}]+ [^\p{L}\p{N}]+ [^\p{L}\p{N}]+$/u);
});

test("public and plain text line up code point for code point", () => {
  // RedactedText lifts each bar over the plaintext at the SAME offsets; a
  // misalignment would open the wrong characters. Emoji are the trap: two
  // UTF-16 units, one code point, one glyph.
  for (const raw of ["a ||b 😀 c|| d", "||x|| mid ||yz||", "🎉 ||🎉🎉|| 🎉", "||whole||"]) {
    const r = parseRedaction(raw);
    assert.equal([...r.publicText].length, [...r.plain].length, raw);
    [...r.plain].forEach((ch, i) => {
      const pub = [...r.publicText][i]!;
      if (/\s/.test(ch)) assert.equal(pub, ch, `${raw}: whitespace moved at ${i}`);
    });
  }
});

test("an unpaired or empty mark is ordinary text, not a redaction", () => {
  for (const raw of ["a || b", "true || false", "|| ||", "||||", "x ||"]) {
    const r = parseRedaction(raw);
    assert.equal(r.redacted, false, raw);
    assert.equal(r.plain, raw);
    assert.equal(r.publicText, raw);
    assert.equal(r.platformText, raw);
  }
});

test("a whole-message redaction hides everything and reads [REDACTED] on a platform", () => {
  const r = parseRedaction("meet me ||at|| noon", true);
  assert.equal(r.redacted, true);
  assert.equal(r.plain, "meet me at noon", "marks inside a whole redaction are just removed");
  assert.equal(r.platformText, REDACTED_LABEL);
  assert.match(r.publicText, /^[^\p{L}\p{N}\s]+( [^\p{L}\p{N}\s]+){3}$/u);
});

test("splitRedacted finds the hidden runs again in the stored text", () => {
  const r = parseRedaction("the ending is ||he was dead|| lol");
  const runs = splitRedacted(r.publicText);
  assert.deepEqual(runs.map((x) => x.hidden), [false, true, false]);
  assert.equal(runs[0]!.text, "the ending is ");
  assert.equal(runs[2]!.text, " lol");
  assert.equal(runs[1]!.start, 14);
  assert.equal([...runs[1]!.text].length, [..."he was dead"].length, "the gaps between hidden words belong to the run");
  // A message sealed whole — and every one sent before partial redaction — is one run.
  const whole = splitRedacted(parseRedaction("an older fully sealed message", true).publicText);
  assert.deepEqual(whole.map((x) => x.hidden), [true]);
  // Two hidden parts stay two runs.
  assert.deepEqual(splitRedacted(parseRedaction("||a|| and ||b||").publicText).map((x) => x.hidden), [true, false, true]);
  // An ordinary message has none.
  assert.deepEqual(splitRedacted("just words").map((x) => x.hidden), [false]);
});

test("revealRefusal: the chat's words for a refused open, by status — one spelling, shared with the terminal", () => {
  assert.equal(revealRefusal(403), "Supporters can read this one.");
  assert.equal(revealRefusal(429), "Slow down a moment.");
  assert.equal(revealRefusal(404), "That message is gone.");
  assert.equal(revealRefusal(401), "Sign in to read this.");
  assert.equal(revealRefusal(0), "Couldn't open it — try again.");
  assert.equal(revealRefusal(500), "Couldn't open it — try again.");
  const comp = stripComments(readFileSync(join(HERE, "../components/RedactedText.tsx"), "utf8"));
  assert.match(comp, /setError\(revealRefusal\(status\)\)/, "the chat row uses it");
  assert.doesNotMatch(comp, /"Supporters can read this one\."/, "and does not spell the words itself");
});
