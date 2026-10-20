import { readFileSync } from "node:fs";
// Unit tests for the pure emote-URL tier logic. Run with:
//   node --test app/lib/emoteRes.test.ts
// (Node ≥ 23 strips the TS types natively — no build step or test deps.)
// Only the pure exports are exercised; rightSizeEmoteUrl reads the DOM and is covered
// live instead.

import { test } from "node:test";
import assert from "node:assert/strict";
import { sizeEmoteUrl, stepDownEmoteUrl, lowerResEmoteUrl, stickerResEmoteUrl, twitchStillUrl, rungHeight, baselineEmoteUrl, emoteUrlOnHost } from "./emoteRes.ts";

const STV = "https://cdn.7tv.app/emote/01F/2x.webp";
const TW = "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0";
const FFZ = "https://cdn.frankerfacez.com/emote/28136/2";
const BTTV = "https://cdn.betterttv.net/emote/5f/2x";

// No 2x floor. The rule is exactly "the smallest rung whose native height is
// at least the drawn device pixels" — never one below it (never blurry), never
// more than that (the bytes).
test("sizeEmoteUrl picks the smallest rung that covers the target — no floor", () => {
  assert.equal(sizeEmoteUrl(STV, 10), "https://cdn.7tv.app/emote/01F/1x.webp");
  assert.equal(sizeEmoteUrl(STV, 31), "https://cdn.7tv.app/emote/01F/1x.webp"); // default chat at DPR1 (30.3 px)
  assert.equal(sizeEmoteUrl(STV, 32), "https://cdn.7tv.app/emote/01F/1x.webp"); // the picker at DPR1
  assert.equal(sizeEmoteUrl(STV, 33), "https://cdn.7tv.app/emote/01F/2x.webp");
  assert.equal(sizeEmoteUrl(TW, 28), "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0");
  assert.equal(sizeEmoteUrl(TW, 31), "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0"); // 1.0 is only 28 px
  assert.equal(sizeEmoteUrl(FFZ, 10), "https://cdn.frankerfacez.com/emote/28136/1");
});

test("sizeEmoteUrl upgrades toward the display", () => {
  assert.equal(sizeEmoteUrl(STV, 128), "https://cdn.7tv.app/emote/01F/4x.webp");
  assert.equal(sizeEmoteUrl(STV, 90), "https://cdn.7tv.app/emote/01F/3x.webp");
  assert.equal(sizeEmoteUrl(STV, 91), "https://cdn.7tv.app/emote/01F/3x.webp"); // default chat at DPR3
  assert.equal(sizeEmoteUrl(STV, 500), "https://cdn.7tv.app/emote/01F/4x.webp"); // beyond the top → the top
  assert.equal(sizeEmoteUrl(TW, 57), "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/3.0");
  assert.equal(sizeEmoteUrl(TW, 200), "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/3.0");
  assert.equal(sizeEmoteUrl(FFZ, 128), "https://cdn.frankerfacez.com/emote/28136/4");
});

// The measured blur without per-emote heights: a wide 7TV emote's 1x file is
// only 21 px tall, so its "2x" is 42 px — drawn at 60.6 device px on a DPR2
// screen (ratio 0.69). The manifest now carries each emote's real 1x height.
test("sizeEmoteUrl sizes from the emote's REAL 1x height when known", () => {
  assert.equal(sizeEmoteUrl(STV, 61, 21), "https://cdn.7tv.app/emote/01F/3x.webp"); // 2x = 42 < 61
  assert.equal(sizeEmoteUrl(STV, 31, 20), "https://cdn.7tv.app/emote/01F/2x.webp"); // 1x = 20 < 31
  assert.equal(sizeEmoteUrl(STV, 31, 32), "https://cdn.7tv.app/emote/01F/1x.webp");
  // BTTV 1x heights run 28–40 px (its API gives width/height when not 28×28).
  assert.equal(sizeEmoteUrl(BTTV, 31), "https://cdn.betterttv.net/emote/5f/2x"); // unknown h: assume 25 < 31
  assert.equal(sizeEmoteUrl(BTTV, 31, 40), "https://cdn.betterttv.net/emote/5f/1x");
  assert.equal(sizeEmoteUrl(BTTV, 61), "https://cdn.betterttv.net/emote/5f/3x");
  assert.equal(sizeEmoteUrl(FFZ, 31, 18), "https://cdn.frankerfacez.com/emote/28136/2"); // 18 → 36
});

test("sizeEmoteUrl keeps stills and extensions: 7TV _static, BTTV /static/ and .png/.gif", () => {
  assert.equal(sizeEmoteUrl("https://cdn.7tv.app/emote/01F/2x_static.webp", 31), "https://cdn.7tv.app/emote/01F/1x_static.webp");
  assert.equal(sizeEmoteUrl("https://cdn.7tv.app/emote/01F/1x_static.webp", 91), "https://cdn.7tv.app/emote/01F/3x_static.webp");
  assert.equal(sizeEmoteUrl("https://cdn.betterttv.net/emote/5f/static/3x.webp", 31), "https://cdn.betterttv.net/emote/5f/static/2x.webp");
  assert.equal(sizeEmoteUrl("https://cdn.betterttv.net/emote/5f/3x.gif", 20), "https://cdn.betterttv.net/emote/5f/1x.gif");
  assert.equal(sizeEmoteUrl("https://cdn.betterttv.net/emote/5f/3x.png", 50), "https://cdn.betterttv.net/emote/5f/2x.png");
});

test("sizeEmoteUrl leaves unrecognized URLs untouched", () => {
  assert.equal(sizeEmoteUrl("https://example.com/x.png", 128), "https://example.com/x.png");
  assert.equal(sizeEmoteUrl("", 128), "");
});

test("rungHeight: what a URL's rung actually paints", () => {
  assert.equal(rungHeight("https://cdn.7tv.app/emote/01F/2x.webp"), 64);
  assert.equal(rungHeight("https://cdn.7tv.app/emote/01F/2x.webp", 21), 42);
  assert.equal(rungHeight("https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/3.0"), 112);
  assert.equal(rungHeight("https://cdn.betterttv.net/emote/5f/3x.png"), 75); // unknown h → the smallest BTTV 1x seen (25)
  assert.equal(rungHeight("https://cdn.betterttv.net/emote/5f/3x.png", 28), 84);
  assert.equal(rungHeight("https://example.com/x.png"), null);
});

test("baselineEmoteUrl is the 2x rung for every provider (what the server HTML carries)", () => {
  assert.equal(baselineEmoteUrl("https://cdn.7tv.app/emote/a/3x.webp"), "https://cdn.7tv.app/emote/a/2x.webp");
  assert.equal(baselineEmoteUrl("https://cdn.betterttv.net/emote/x/3x.png"), "https://cdn.betterttv.net/emote/x/2x.png");
});

test("stepDownEmoteUrl walks 7TV down one rung at a time to 1x, then null", () => {
  const a = "https://cdn.7tv.app/emote/01F/4x.webp";
  const b = stepDownEmoteUrl(a);
  assert.equal(b, "https://cdn.7tv.app/emote/01F/3x.webp");
  const c = stepDownEmoteUrl(b!);
  assert.equal(c, "https://cdn.7tv.app/emote/01F/2x.webp");
  const d = stepDownEmoteUrl(c!);
  assert.equal(d, "https://cdn.7tv.app/emote/01F/1x.webp");
  assert.equal(stepDownEmoteUrl(d!), null); // already at the bottom
});

test("stepDownEmoteUrl respects each provider's ladder (FFZ skips 3)", () => {
  assert.equal(stepDownEmoteUrl("https://cdn.frankerfacez.com/emote/28136/4"), "https://cdn.frankerfacez.com/emote/28136/2");
  assert.equal(stepDownEmoteUrl("https://cdn.frankerfacez.com/emote/28136/2"), "https://cdn.frankerfacez.com/emote/28136/1");
  assert.equal(stepDownEmoteUrl("https://cdn.frankerfacez.com/emote/28136/1"), null);
  assert.equal(stepDownEmoteUrl("https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0"), "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0");
  assert.equal(stepDownEmoteUrl("https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0"), null);
});

test("stepDownEmoteUrl: BTTV now has a ladder; unrecognized → null (caller shows name text)", () => {
  assert.equal(stepDownEmoteUrl(BTTV), "https://cdn.betterttv.net/emote/5f/1x");
  assert.equal(stepDownEmoteUrl("https://cdn.betterttv.net/emote/5f/1x"), null);
  assert.equal(stepDownEmoteUrl("https://example.com/x.png"), null);
  assert.equal(stepDownEmoteUrl(""), null);
});

test("lowerResEmoteUrl forces the smallest rung across all providers", () => {
  assert.equal(lowerResEmoteUrl("https://cdn.7tv.app/emote/01F/4x.webp"), "https://cdn.7tv.app/emote/01F/1x.webp");
  assert.equal(lowerResEmoteUrl(STV), "https://cdn.7tv.app/emote/01F/1x.webp"); // 2x → 1x
  assert.equal(lowerResEmoteUrl("https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/3.0"), "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0");
  assert.equal(lowerResEmoteUrl("https://cdn.frankerfacez.com/emote/28136/4"), "https://cdn.frankerfacez.com/emote/28136/1"); // FFZ now shrinks too
  assert.equal(lowerResEmoteUrl(BTTV), BTTV); // untouched
});

test("stickerResEmoteUrl forces the largest rung", () => {
  assert.equal(stickerResEmoteUrl(STV), "https://cdn.7tv.app/emote/01F/4x.webp"); // 2x → 4x
  assert.equal(stickerResEmoteUrl("https://cdn.7tv.app/emote/01F/1x.webp"), "https://cdn.7tv.app/emote/01F/4x.webp");
  assert.equal(stickerResEmoteUrl(BTTV), BTTV); // untouched (BTTV isn't a sticker source)
});

// ── overlay scope ────────────────────────────────────────────────────────────
// renderedEmoteHeightPx must not read a bare localStorage key: on the /chat OBS
// overlay it would read the SITE emote size while the element renders from the
// isolated `ov:` key. Site 1.4x + overlay 3.0x would mean sizing for 1.4x,
// requesting a CDN tier around half the pixels needed — every emote on stream
// upscaled and blurry, with the warmer prefetching the wrong bytes too.
//
// It reads the rendered `--chat-emote-size` custom property instead, which
// cannot disagree with what the browser is actually drawing. The helper needs a
// DOM and isn't exported, so this pins the source it reads from.
test("emote sizing reads the rendered CSS var, not raw localStorage", () => {
  const src = readFileSync(new URL("./emoteRes.ts", import.meta.url), "utf8")
    .split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");

  assert.match(src, /getPropertyValue\("--chat-emote-size"\)/,
    "the rendered-value read is gone");
  assert.doesNotMatch(src, /localStorage/,
    "emoteRes reads localStorage again — on /chat that is the SITE value, not the overlay's, " +
    "so emotes would be sized for the wrong scale and render blurry on stream");
});

test("renderText sizes the element from that same var, so the two cannot diverge", () => {
  const src = readFileSync(new URL("./renderText.tsx", import.meta.url), "utf8");
  assert.match(src, /var\(--chat-emote-size/,
    "renderText no longer sizes from --chat-emote-size — emoteRes would be measuring " +
    "something the element does not use");
});

test("twitchStillUrl: a message's Twitch emote pauses via the static format", () => {
  assert.equal(twitchStillUrl("https://static-cdn.jtvnw.net/emoticons/v2/emotesv2_abc/default/dark/3.0"),
    "https://static-cdn.jtvnw.net/emoticons/v2/emotesv2_abc/static/dark/3.0");
  assert.equal(twitchStillUrl("https://static-cdn.jtvnw.net/emoticons/v2/25/animated/dark/1.0"),
    "https://static-cdn.jtvnw.net/emoticons/v2/25/static/dark/1.0");
  assert.equal(twitchStillUrl("https://cdn.7tv.app/emote/01F/2x.webp"), undefined);
});

test("a provider is recognised by the URL's HOST, never by a substring anywhere in it", () => {
  assert.equal(emoteUrlOnHost("https://cdn.7tv.app/emote/a/2x.webp", "7tv.app"), true);
  assert.equal(emoteUrlOnHost("https://7tv.app/x", "7tv.app"), true);
  assert.equal(emoteUrlOnHost("//static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0", "jtvnw.net"), true, "protocol-relative");
  assert.equal(emoteUrlOnHost("https://CDN.FrankerFaceZ.com/emote/1/2", "frankerfacez.com"), true, "case-insensitive");
  for (const lookalike of [
    "https://evil.test/7tv.app/emote/a/2x.webp",
    "https://7tv.app.evil.test/emote/a/2x.webp",
    "https://not7tv.app/emote/a/2x.webp",
    "https://evil.test/?u=cdn.7tv.app",
    "", "not a url",
  ]) {
    assert.equal(emoteUrlOnHost(lookalike, "7tv.app"), false, lookalike);
  }
  // …so a lookalike gets no rung treatment at all.
  assert.equal(sizeEmoteUrl("https://evil.test/7tv.app/emote/a/2x.webp", 128), "https://evil.test/7tv.app/emote/a/2x.webp");
  assert.equal(stepDownEmoteUrl("https://evil.test/jtvnw.net/2.0"), null);
});
