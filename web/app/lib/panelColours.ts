// Panel colours, model B: one page gradient behind everything; bars and chat
// body are see-through tints over it. The gradient strings live here so the
// registry and a test share them; the layout.tsx pre-paint mirrors them by
// hand (it cannot import) and panelColours.test.ts pins the mirror.
export const BG_DIRS = ["glow", "down", "right", "diag-down", "diag-up"] as const;
export type BgDir = (typeof BG_DIRS)[number];

const A = "var(--bg-body-start)";
const B = "var(--bg-body-end)";
const GRADIENTS: Record<BgDir, string> = {
  // "glow" is the page background as it was before model B (layout.tsx body).
  glow: `radial-gradient(ellipse 140% 65% at 50% 0%, ${A} 0%, ${B} 72%)`,
  down: `linear-gradient(to bottom, ${A}, ${B})`,
  right: `linear-gradient(to right, ${A}, ${B})`,
  "diag-down": `linear-gradient(to bottom right, ${A}, ${B})`,
  "diag-up": `linear-gradient(to top right, ${A}, ${B})`,
};

export function pageGradient(dir: BgDir): string {
  return GRADIENTS[dir] ?? GRADIENTS.glow;
}
