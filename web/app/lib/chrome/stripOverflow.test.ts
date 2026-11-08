// web/app/lib/chrome/stripOverflow.test.ts
// The section strip's overflow arithmetic. Run: node --test app/lib/chrome/stripOverflow.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { overflowEdges, wholeTabs, restFor, pageTarget, revealTarget, fadeCovers, PEEK_MIN_CHARS, STRIP_EDGE_PX, type LabelSpan } from "./stripOverflow.ts";

test("a strip that fits says nothing — including the Mod panel's 1px-short case at 390 px", () => {
  assert.equal(overflowEdges(0, 768, 768), null, "desktop Admin Panel: everything fits, no fade, no chevron");
  assert.equal(overflowEdges(0, 358, 359), null, "a trailing 1px divider is not 'more' (measured: Mod panel, 390 px)");
});

test("the sides that hold more tabs are the sides that say so", () => {
  assert.equal(overflowEdges(0, 358, 525), "end", "Admin Panel at 390 px on load: more to the right only");
  assert.equal(overflowEdges(80, 358, 525), "both");
  assert.equal(overflowEdges(167, 358, 525), "start", "scrolled to the end: more to the left only");
  assert.equal(overflowEdges(166.5, 358, 525), "start", "a fractional scrollLeft at the end still counts as the end");
});

// The phone chat strip at 390 px, DERIVED from its terms (measured on the throwaway pair, Task 5b round 1):
//   bar        362 = 390 − 2 × 14 (the chat panel's inset)
//   lead        44 = 4 (band bar inset) + 40 (compact toggle, touch box)
//   trail       44 = 40 (Unfold player, touch box) + 4 (band bar inset)
//   strip      274 = 362 − 44 − 44   (the "+" is no longer a fixed button: it scrolls as the list's last item)
//   tabs            Home 69 · Live 57 · Matrix 72 · Stream 79 (14 px padding each side + a 1 px divider)
//   "+"         40 (touch box) after the last tab
//   the "›" box overlays the strip's last 40 px (= STRIP_EDGE_PX), so a tab is clear at rest when it ends ≤ 274 − 40 = 234.
//   Home + Live + Matrix = 198 ≤ 234: all three whole, 36 px to spare. Stream PEEKS (198…277) under the fade.
const STRIP = 362 - 44 - 44;
const FOUR = [{ x: 0, w: 69 }, { x: 69, w: 57 }, { x: 126, w: 72 }, { x: 198, w: 79 }, { x: 277, w: 40 }]; // …and the "+"
// Forums armed (it sits before Stream); the pair then has nothing left to arm, so no "+".
const FIVE = [{ x: 0, w: 69 }, { x: 69, w: 57 }, { x: 126, w: 72 }, { x: 198, w: 81 }, { x: 279, w: 79 }];
const CW = STRIP;
const sw = (tabs: typeof FOUR) => tabs[tabs.length - 1]!.x + tabs[tabs.length - 1]!.w;

test("the default four tabs at 390 px: Home, Live and Matrix are whole at rest, clear of the › box", () => {
  assert.equal(CW, 274, "the strip width, from the bar and its fixed boxes");
  assert.deepEqual(wholeTabs(FOUR, 0, CW, sw(FOUR)).slice(0, 3), [true, true, true]);
  assert.ok(FOUR[2]!.x + FOUR[2]!.w <= CW - STRIP_EDGE_PX, "Matrix ends at 198, before the › box at 234");
  assert.equal(wholeTabs(FOUR, 0, CW, sw(FOUR))[3], false, "Stream peeks under the fade (it is not hidden: nothing is)");
  // A strip that fits says every tab is whole: no band (the desktop strip).
  assert.deepEqual(wholeTabs(FOUR, 0, 400, sw(FOUR)), [true, true, true, true, true]);
});

// The "no hole" guard lives in stripWhole.render.test.ts: it drives the mounted strip and checks every
// position the strip moves ITSELF to against the items it measured (an arithmetic copy here only checked
// its own fixture — Task 5b review M2).

test("the strip's rest positions: an item's start just clear of the start band, clamped to the scroll range", () => {
  assert.equal(restFor(0, CW, sw(FIVE)), 0, "the first tab rests flush at 0 — there is no band before it");
  assert.equal(restFor(69, CW, sw(FIVE)), 29, "Live rests 40 px in, clear of the ‹ box");
  assert.equal(restFor(198, CW, sw(FIVE)), sw(FIVE) - CW, "a tab near the end clamps to the end");
});

test("› lands the first item that was not clear at the start (or at the end), never inside a tab", () => {
  const a = pageTarget(FOUR, 0, CW, sw(FOUR), 1);
  assert.equal(a, sw(FOUR) - CW, "Stream's rest (158) is past the end (43): the strip goes to its end");
  assert.deepEqual(wholeTabs(FOUR, a, CW, sw(FOUR)).slice(2), [true, true, true], "Matrix, Stream and the + are clear there");
  assert.equal(pageTarget(FOUR, a, CW, sw(FOUR), 1), a, "at the end › has nowhere to go");
  const b = pageTarget(FIVE, 0, CW, sw(FIVE), 1);
  assert.equal(b, sw(FIVE) - CW);
  assert.deepEqual(wholeTabs(FIVE, b, CW, sw(FIVE)).slice(2), [true, true, true], "five tabs: Matrix, Forums and Stream clear");
});

test("‹ brings back the item just before the view, clear at the end, with as many before it as fit", () => {
  const end = sw(FIVE) - CW;
  assert.equal(pageTarget(FIVE, end, CW, sw(FIVE), -1), 0, "Live and Home fit from the start");
  assert.equal(pageTarget(FIVE, 0, CW, sw(FIVE), -1), 0, "at the start ‹ has nowhere to go");
  // A long strip (eight 80 px tabs): ‹ from the end lands on a tab start, not on 0.
  const long = Array.from({ length: 8 }, (_, i) => ({ x: i * 80, w: 80 }));
  const back = pageTarget(long, 640 - CW, CW, 640, -1);
  assert.ok(long.some((t) => restFor(t.x, CW, 640) === back) && back > 0, `a rest position (${back})`);
});

test("retry: pressing › again and again from the start walks rest positions to the end and every target is a tab start", () => {
  const long = Array.from({ length: 8 }, (_, i) => ({ x: i * 80, w: 80 }));
  for (const tabs of [FOUR, FIVE, long]) {
    const W = sw(tabs), max = W - CW;
    let s = 0;
    for (let press = 0; press < 10 && s < max; press++) {
      const next = pageTarget(tabs, s, CW, W, 1);
      assert.ok(next > s, `press ${press}: › always moves forward (${s} → ${next})`);
      assert.ok(next === max || tabs.some((t) => restFor(t.x, CW, W) === next), `press ${press}: ${next} is a rest position`);
      const was = tabs.findIndex((t, i) => !wholeTabs(tabs, s, CW, W)[i] && t.x + t.w > s + CW - STRIP_EDGE_PX);
      assert.equal(wholeTabs(tabs, next, CW, W)[was], true, `press ${press}: the next tab is shown clear`);
      s = next;
    }
    assert.equal(s, max, "the presses reach the end");
  }
});

test("the selected tab is brought into full view; a tab already clear is left alone", () => {
  assert.equal(revealTarget(FIVE, 0, 0, CW, sw(FIVE)), null, "Home is clear at rest");
  assert.equal(revealTarget(FIVE, 2, 0, CW, sw(FIVE)), null, "so is Matrix");
  assert.equal(revealTarget(FIVE, 4, 0, CW, sw(FIVE)), sw(FIVE) - CW, "Stream selected from the start: the strip goes to the end");
  assert.equal(revealTarget(FIVE, 0, sw(FIVE) - CW, CW, sw(FIVE)), 0, "Home, under the ‹ at the end: back to the start");
});

test("restart: a fresh strip with the last tab selected opens on a position that shows it", () => {
  for (const tabs of [FOUR.slice(0, 4), FIVE]) {
    const W = sw(tabs), last = tabs.length - 1;
    const t = revealTarget(tabs, last, 0, CW, W);
    assert.notEqual(t, null);
    assert.equal(wholeTabs(tabs, t!, CW, W)[last], true);
  }
});

// Glyph edges measured on the pair at 390 px (look/05b-glyphs.mjs: a Range per character, 14 px Geist),
// relative to each tab's left edge. NOT the label box: the label's grid cell is as wide as its bold reserve.
const GLYPHS: Record<string, number[]> = {
  Home: [14, 24, 33, 45, 54], // selected (600)
  Live: [14, 21, 25, 33, 42],
  Matrix: [14, 26, 33, 39, 45, 48, 57],
  Stream: [14, 23, 29, 34, 43, 51, 64],
  Forums: [14, 22, 31, 37, 45, 57, 65], // measured selected (600); the five-tab cases only read Live's
};
/** An unread dot adds .5rem + the .375rem gap after the label (measured: 14 px). */
const DOT = 14;
/** The strip's labels, laid out from `tabs` (with a dot on the named ones), as glyph spans. */
function labels(tabs: [string, boolean?][]): LabelSpan[] {
  let at = 0;
  return tabs.map(([name, dot]) => {
    const g = GLYPHS[name]!.map((e) => at + e);
    const n = g.length - 1;
    const tabW = { Home: 69, Live: 57, Matrix: 72, Stream: 79, Forums: 81 }[name]! + (dot ? DOT : 0);
    at += tabW;
    return { x: g[0]!, w: g[n]! - g[0]!, head: g[Math.min(PEEK_MIN_CHARS, n)]!, tail: g[Math.max(n - PEEK_MIN_CHARS, 0)]! };
  });
}
const sumW = (tabs: [string, boolean?][]) => tabs.reduce((a, [n, d]) => a + { Home: 69, Live: 57, Matrix: 72, Stream: 79, Forums: 81 }[n]! + (d ? DOT : 0), 0) + 40; // + the "+"

test("end side: a label that cannot show three characters clear of the fade band is covered from its first letter", () => {
  // No dots: "Str" ends at 232, before the band at 234 — three clear characters, the standard fade ("Strea›").
  const none: [string, boolean?][] = [["Home"], ["Live"], ["Matrix"], ["Stream"]];
  assert.deepEqual(fadeCovers(labels(none), 0, CW, sumW(none)), { start: null, end: null });
  // One dot (Live): Stream's label starts at 226 and "Str" would end at 246, past 234 — covered from 226.
  const one: [string, boolean?][] = [["Home"], ["Live", true], ["Matrix"], ["Stream"]];
  assert.deepEqual(fadeCovers(labels(one), 0, CW, sumW(one)), { start: null, end: CW - 226 });
  // Two dots (Live and Matrix — both light during a stream): the label STARTS inside the band, at 240,
  // where the old rule called it "wholly inside the fade" and left "S›" at 70→30 %. Covered from 240.
  const two: [string, boolean?][] = [["Home"], ["Live", true], ["Matrix", true], ["Stream"]];
  assert.deepEqual(fadeCovers(labels(two), 0, CW, sumW(two)), { start: null, end: CW - 240 });
  // The review's failing input, by itself: a label at x = 240 with its first three glyphs to 260.
  assert.equal(fadeCovers([{ x: 240, w: 50, head: 260, tail: 269 }], 0, CW, 400).end, 34, "covered, not 'needs nothing'");
  // "Clear" carries the strip's 1 px tolerance (SLACK): Forums at rest with five tabs ends "For" 0.4 px into
  // the band (measured on the pair) — its "r" at ≥ 98 % reads whole, so the standard fade. Covering it would
  // blank 62 px in front of the ›. A head a full 1.5 px into the band is covered.
  assert.equal(fadeCovers([{ x: 212, w: 50, head: 234.4, tail: 243 }], 0, CW, 400).end, null);
  assert.equal(fadeCovers([{ x: 212, w: 50, head: 235.5, tail: 243 }], 0, CW, 400).end, CW - 212);
  // Starting at or past the transparent point (254) it shows nothing: nothing to cover.
  assert.equal(fadeCovers([{ x: 254, w: 50, head: 274, tail: 283 }], 0, CW, 400).end, null);
  // A label wholly before the band needs nothing; nothing past the end, no end fade at all.
  assert.equal(fadeCovers([{ x: 140, w: 43, head: 165, tail: 171 }], 0, CW, 400).end, null);
  assert.equal(fadeCovers(labels(two), sumW(two) - CW, CW, sumW(two)).end, null);
});

test("start side, the same rule mirrored: a tail under three characters beside the ‹ is covered through its last letter", () => {
  // Live's rest (29): Home's label ends at 54, 25 px in — its last glyphs would show faintly beside the ‹ ("‹e").
  const four: [string, boolean?][] = [["Home"], ["Live"], ["Matrix"], ["Stream"]];
  assert.deepEqual(fadeCovers(labels(four), 29, CW, sumW(four)), { start: 54 - 29, end: null }, "Home covered through its last letter");
  // Five tabs at the end (84): Live's label ends 111 − 84 = 27 px in ("‹e" in the round-1 shot).
  const five: [string, boolean?][] = [["Home"], ["Live"], ["Matrix"], ["Forums"], ["Stream"]];
  const end5 = sumW(five) - 40 - CW; // no "+" with five tabs on the pair
  assert.equal(fadeCovers(labels(five), end5, CW, sumW(five) - 40).start, 69 + 42 - end5);
  // A long label with three or more glyphs clear of the band keeps the standard fade.
  assert.equal(fadeCovers([{ x: 10, w: 70, head: 35, tail: 55 }], 10, CW, 400).start, null);
  // At the start there is nothing before: no start fade.
  assert.equal(fadeCovers(labels(four), 0, CW, sumW(four)).start, null);
});

test("every rest position on the default four tabs, with 0, 1 or 2 dots, leaves no sliver on either side", () => {
  for (const dots of [[false, false], [true, false], [true, true]]) {
    const tabs: [string, boolean?][] = [["Home"], ["Live", dots[0]], ["Matrix", dots[1]], ["Stream"]];
    const L = labels(tabs), W = sumW(tabs);
    const xs = [0, 69, 69 + 57 + (dots[0] ? DOT : 0)];
    for (const s of [0, W - CW, ...xs.map((x) => restFor(x, CW, W))]) {
      const c = fadeCovers(L, s, CW, W);
      for (const l of L) {
        // End side: shown at all (starts before the transparent point) ⇒ 3 clear glyphs, or covered from it.
        if (s + CW < W - 1 && l.x < s + CW - 20 && l.x + l.w > s + CW - 40)
          assert.ok(l.head <= s + CW - 40 + 1 || (c.end !== null && s + CW - c.end <= l.x), `end, rest ${s}, label at ${l.x}`);
        if (s > 1 && l.x + l.w > s + 20 && l.x < s + 40)
          assert.ok(l.tail >= s + 40 - 1 || (c.start !== null && s + c.start >= l.x + l.w), `start, rest ${s}, label at ${l.x}`);
      }
    }
  }
});

test("the CSS edge band and STRIP_EDGE_PX are the same number", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../../components/chrome/chrome.css", import.meta.url), "utf8");
  const rules = css.match(/\.chrome-sections-wrap\[data-more="[a-z]+"\] > \.chrome-sections \{[^}]*\}/g) ?? [];
  assert.equal(rules.length, 3, "one mask rule per side: end, start, both");
  for (const r of rules) {
    // Each side's stops are custom properties (fadeCovers moves them to cover a sliver) whose fallbacks are the band.
    assert.ok(r.includes(`#000 var(--strip-start-o, ${STRIP_EDGE_PX}px)`) || r.includes(`#000 calc(100% - var(--strip-end-o, ${STRIP_EDGE_PX}px))`), `the fade starts at STRIP_EDGE_PX: ${r}`);
    // …and the text is gone by half of it, under the chevron's glyph.
    for (const px of r.match(/\d+px/g) ?? []) assert.ok(px === `${STRIP_EDGE_PX}px` || px === `${STRIP_EDGE_PX / 2}px`, r);
  }
  // No fade without overflow: the strip itself carries no mask.
  const base = css.match(/\n {2}\.chrome-sections \{[^}]*\}/)?.[0] ?? "";
  assert.ok(base.includes("overflow-x: auto"), "found the strip's own rule");
  // The rest positions restFor computes are the browser's snap positions: a tab's start, STRIP_EDGE_PX in.
  assert.match(base, new RegExp(`scroll-padding-inline: ${STRIP_EDGE_PX}px;`), "the snap padding is the edge band");
  // …and the band is the chevron's own touch box: a whole tab never sits under the "‹" or "›".
  const more = css.match(/\n {2}\.chrome-more \{[^}]*\}/)?.[0] ?? "";
  assert.match(more, new RegExp(`width: ${STRIP_EDGE_PX}px;`), "the chevron box is the edge band wide");
  assert.doesNotMatch(base, /mask-image/, "an always-on fade faded the last label of a strip that fits");
});
