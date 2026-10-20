// web/app/components/chrome/Band.tsx
"use client";

// The Console band: a translucent shade with a HOLE where the active section
// is, and a 2px cap that slides. Rendered by Bar (band) and by standalone
// Sections; the consumer inside finds this Band through BandContext, measures
// against the published `frame` and hands back a box LIST — one box from a
// Sections, a pair from the split view's Panes. Two holes and two caps exist;
// a single-hole consumer leaves slot 1 empty, and the second mask layer is
// zero-width, so it cuts nothing.
//
// The shade and cap refs never leave this file — `paint` is their only writer.
// That is the point of the split: a Sections that held those refs would be
// mutating elements it reached through context, which is both a layering
// inversion and something React Compiler cannot tell apart from mutating state.
//
// The shade is its OWN layer behind the content (z 0 vs 1/2/3): a CSS mask
// composites an element's whole subtree, so a mask on the frame would swallow
// the active label and the cap too.
import { useCallback, useMemo, useRef, type ReactNode } from "react";
import { BandContext, type BandHandle } from "@/app/lib/chrome/bandContext";
import type { Box } from "@/app/lib/chrome/indicatorBox";

export function Band({ children }: { children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  const shade = useRef<HTMLSpanElement>(null);
  const capA = useRef<HTMLSpanElement>(null);
  const capB = useRef<HTMLSpanElement>(null);
  // Stable for the life of the Band: it reads the refs when it RUNS, so it
  // never needs re-creating — and the Sections whose measurement effect
  // depends on the handle therefore does not re-measure when the container
  // that renders this Band re-renders.
  const paint = useCallback((boxes: readonly Box[], animate: boolean) => {
    const f = frame.current, s = shade.current;
    const caps = [capA.current, capB.current];
    if (!f || !caps[0]) return;
    const dur = animate ? "" : "0s";
    if (s) s.style.transitionDuration = dur;
    // Per slot: a box positions the hole + cap; no box closes the hole and
    // puts the cap out. Slot 1 uses the …2 custom properties (chrome.css's
    // third mask layer, zero-width at rest).
    ([["--ind-x", "--ind-w"], ["--ind-x2", "--ind-w2"]] as const).forEach(([px, pw], i) => {
      const c = caps[i];
      const box = boxes[i];
      if (c) c.style.transitionDuration = dur;
      if (box) {
        f.style.setProperty(px, `${box.x}px`);
        f.style.setProperty(pw, `${box.w}px`);
        if (c) {
          c.style.transform = `translateX(${box.x}px) scaleX(${box.w / 100})`;
          c.style.opacity = "0.85";
        }
      } else {
        f.style.setProperty(pw, "0px");
        if (c) c.style.opacity = "0";
      }
    });
  }, []);
  const handle = useMemo<BandHandle>(() => ({ frame, paint }), [paint]);
  return (
    <BandContext value={handle}>
      <div ref={frame} className="chrome-band">
        <span aria-hidden className="chrome-shade" ref={shade} />
        {children}
        <span aria-hidden className="chrome-cap" ref={capA} />
        <span aria-hidden className="chrome-cap" ref={capB} />
      </div>
    </BandContext>
  );
}
