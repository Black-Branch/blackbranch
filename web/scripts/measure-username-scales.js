// Re-measure the username-font scale table. Prints app/lib/usernameFontMetrics.ts.
//
// HOW TO RUN. This has to execute in a real browser with the real webfonts
// loaded — next/font hashes the family names and serves subsetted woff2, so
// there is nothing on disk to parse and no headless shortcut worth trusting.
// Paste the function body into the console on the live site (or a local
// `npm run dev`), or drive it over CDP:
//
//   evaluate_script with the exported `measure` function below.
//
// WHY IT EXISTS. Scales tuned by eye leave faces nobody re-measured — a script
// face can end up with its lowercase at 0.72 of a plain name, unreadable. A
// number that can only be changed by re-running this cannot rot the same way.
//
// THE TRAP THIS SCRIPT IS SHAPED AROUND. `document.fonts.load()` must be given
// ONE family, not the whole stack. Handed `"Great Vibes", "Great Vibes Fallback"`
// it matches the metric-override fallback, `check()` still returns true, and the
// canvas silently measures the fallback — most faces reporting identical
// metrics, and derived scales that look entirely plausible. The `word` column is
// the control: if two faces share an advance width for "Handgloves", at least one
// did not load. usernameStyles.test.ts asserts all 19 are distinct.
//
// Reference is Geist at weight 600 — what a name with NO equipped font renders
// in (--chat-username-font defaults to inherit, --chat-username-weight to 600).
// Measuring the reference at 400 would inflate every scale by a few percent.

export async function measure() {
  const FACES = [
    ["gothic", "--font-pirata"], ["arcade", "--font-press-start"],
    ["script", "--font-pacifico"], ["comic", "--font-bangers"],
    ["horror", "--font-creepster"], ["western", "--font-rye"],
    ["street", "--font-bungee"], ["cyber", "--font-audiowide"],
    ["typewriter", "--font-special-elite"], ["imperial", "--font-cinzel"],
    ["hand", "--font-caveat"], ["neon", "--font-monoton"],
    ["terminal", "--font-vt323"], ["marker", "--font-permanent-marker"],
    ["elegant", "--font-alex-brush"], ["bubble", "--font-chewy"],
    ["stencil", "--font-black-ops"], ["retro", "--font-bowlby"],
    ["relief", "--font-rampart"],
    // Name Font Browser picks.
    ["scrawl", "--font-gloria"], ["crafty", "--font-crafty"],
    ["friendly", "--font-shantell"], ["brush", "--font-kaushan"],
    ["cursive", "--font-sofia"], ["rounded", "--font-name-comfortaa"],
    ["quirky", "--font-barriecito"], ["spray", "--font-lacquer"],
    ["fantasy", "--font-metamorphous"], ["calligraphy", "--font-quintessential"],
    ["notched", "--font-nova-cut"], ["jersey", "--font-jersey"],
  ];
  // 400px, not 16: actualBoundingBoxAscent is reported in whole device pixels,
  // so a small size quantises the ratio badly (at 16px, one pixel is 6%).
  const SIZE = 400;
  const cs = getComputedStyle(document.documentElement);
  const ctx = document.createElement("canvas").getContext("2d");

  // Draw `text` alone on a canvas sized to its ink box; hand the pixels to `read`.
  function inked(spec, text, read) {
    const c = document.createElement("canvas");
    const g = c.getContext("2d", { willReadFrequently: true });
    g.font = spec;
    const tm = g.measureText(text);
    const w = Math.ceil(tm.actualBoundingBoxLeft + tm.actualBoundingBoxRight);
    const h = Math.ceil(tm.actualBoundingBoxAscent + tm.actualBoundingBoxDescent);
    c.width = w;
    c.height = h;
    g.font = spec; // resizing the canvas resets its whole 2D state
    g.fillStyle = "#fff";
    g.fillText(text, tm.actualBoundingBoxLeft, tm.actualBoundingBoxAscent);
    return read(g.getImageData(0, 0, w, h).data, w, h);
  }

  // Alpha-weighted ink fraction over the ink box. Scale-invariant (a ratio), so
  // it measures the face, not the size we render it at. The height rule cannot
  // see that Pacifico is a fat connected script and Rampart One a hollow
  // outline — same extent, very different ink.
  const coverage = (spec, text) =>
    inked(spec, text, (px, w, h) => {
      let ink = 0;
      for (let i = 3; i < px.length; i += 4) ink += px[i];
      return +(ink / 255 / (w * h)).toFixed(4);
    });

  // Median ink-run count across sample rows of a glyph — the hollow-face
  // detector's raw input (see isHollow in usernameFontMetrics.ts). Median across
  // five rows so one noisy row (distress speckle, a swash tail) cannot decide.
  const runs = (spec, text, fracs) =>
    inked(spec, text, (px, w, h) => {
      const counts = fracs.map((frac) => {
        const y = Math.floor(h * frac);
        let n = 0, inRun = false;
        for (let col = 0; col < w; col++) {
          const a = px[(y * w + col) * 4 + 3];
          if (a > 127 && !inRun) { n++; inRun = true; }
          else if (a <= 127) inRun = false;
        }
        return n;
      });
      counts.sort((a, b) => a - b);
      return counts[2];
    });

  async function metrics(family, weight) {
    const spec = `${weight} ${SIZE}px ${family}`;
    await document.fonts.load(spec, "Hx");
    ctx.font = spec;
    const asc = (g) => ctx.measureText(g).actualBoundingBoxAscent / SIZE;
    return {
      capH: +asc("H").toFixed(4),
      x: +asc("x").toFixed(4),
      word: +(ctx.measureText("Handgloves").width / SIZE).toFixed(4),
      // x-band-only strip (no ascenders/descenders): the reading band's ink.
      xCov: coverage(spec, "oneruxvzmscw"),
      capCov: coverage(spec, "H"),
      // 'i' rows sit BELOW the dot (0.55+); '.' rows span the blob. Two glyphs
      // because each alone false-positives — see isHollow's docblock.
      iRuns: runs(spec, "i", [0.55, 0.62, 0.7, 0.78, 0.85]),
      dotRuns: runs(spec, ".", [0.3, 0.4, 0.5, 0.6, 0.7]),
      // Advance of one space, in em (a name with a space: a monospace space is
      // a full letter cell — 2.2× a plain one). Measured as the difference so
      // kerning around the pair cancels.
      space: +((ctx.measureText("a b").width - ctx.measureText("ab").width) / SIZE).toFixed(4),
    };
  }

  // WORST-CASE sideways spill over [a-zA-Z0-9_], at weight 600 (what chat
  // renders). Only the pre-font-load FALLBACK — once the face has loaded,
  // nameInk.ts measures the actual name.
  async function spill(family) {
    const spec = `600 ${SIZE}px ${family}`;
    await document.fonts.load(spec, "Hx");
    ctx.font = spec;
    let left = 0, right = 0;
    for (const g of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_") {
      const m = ctx.measureText(g);
      left = Math.max(left, m.actualBoundingBoxLeft / SIZE);
      right = Math.max(right, (m.actualBoundingBoxRight - m.width) / SIZE);
    }
    return { left: +left.toFixed(2), right: +right.toFixed(2) };
  }

  const ref = await metrics("Geist", 600);
  const out = {};
  const ink = {};
  for (const [id, cssVar] of FACES) {
    // FIRST family only — see the trap above.
    const first = cs.getPropertyValue(cssVar).trim().split(",")[0].trim();
    if (!first) throw new Error(`${cssVar} is not declared on <html>`);
    out[id] = await metrics(first, 400);
    ink[id] = await spill(first);
  }

  const words = Object.values(out).map((m) => m.word);
  if (new Set(words).size !== words.length) {
    throw new Error("two faces share an advance width — at least one fell back; do not use this run");
  }

  // This script deliberately does NOT compute scales. A copy of the rule here
  // would live in two places with only one of them tested — so when the rule
  // changed, this would print confident, wrong numbers. It is the MEASURING
  // INSTRUMENT; `scaleFor` in app/lib/usernameFontMetrics.ts is the only
  // definition of what the numbers mean, and usernameStyles.test.ts is what
  // proves the shipped table matches it.
  // Paste `fixture` in, run the tests, and they will tell you every scale that moved.
  return {
    reference: ref,
    metrics: out,
    // Worst-case spill per face, for FONT_STACKS' `ink` (values under 0.03em are
    // dropped there — they round to nothing at chat size).
    ink,
    // Paste-ready block for usernameFontMetrics.ts.
    fixture:
      `export const REFERENCE_METRICS: FaceMetrics =\n  ${JSON.stringify(ref).replace(/"/g, "").replace(/,/g, ", ").replace(/:/g, ": ")};\n\n` +
      `export const FONT_METRICS: Record<string, FaceMetrics> = {\n` +
      Object.entries(out)
        .map(([id, m]) => `  ${(id + ":").padEnd(12)} ${JSON.stringify(m).replace(/"/g, "").replace(/,/g, ", ").replace(/:/g, ": ")},`)
        .join("\n") +
      `\n};`,
  };
}
