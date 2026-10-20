import { normalizePlatform } from "./nativePlatform.ts";
// Brand accent colors for chat platforms.
//
// Lives in lib/ (core), NOT in the PlatformIcon component, because core modules
// need it too — app/lib/streamView.ts reads it to color the stream meta bar, and
// core importing UI is the dependency-direction violation `check-structure.mjs`
// now blocks. PlatformIcon re-exports it so every existing
// `import { PLATFORM_COLORS } from "./PlatformIcon"` keeps working.

export const PLATFORM_COLORS: Record<string, string> = {
  twitch:      "#e697ce",
  youtube:     "#c06060",
  tiktok:      "#69c9d0",
  discord:     "#5865f2",
  kick:        "#7dd9a8",
  // Matches the official stream.place mark (public/streamplace.svg) — magenta,
  // not the old cyan, so accents don't clash with the logo.
  streamplace: "oklch(0.6803 0.2158 339.7)",
  native:      "#a5c8f7",
  // Donation/monetization sources (alert cards) — single home so a Ko-fi card
  // matches anywhere else the platform's color is shown.
  kofi:        "#29abe0",
  patreon:     "#ff6155",
  streamlabs:  "#5de8df",
};

// The platforms' own brand colours — the "Default" choice of the Platform
// colours setting. PLATFORM_COLORS above stays the site's own set.
// stream.place and the site's own are the same in both. Mirrored in the layout.tsx
// pre-paint; platformPalette.test.ts pins the mirror.
export const BRAND_PLATFORM_COLORS: Record<string, string> = {
  twitch: "#9146FF", youtube: "#FF0000", kick: "#53FC18", tiktok: "#FE2C55", discord: "#5865F2",
};

/** A platform colour as a CSS value that follows the Platform colours setting. */
export function platformColorVar(platform: string): string {
  const p = String(normalizePlatform(platform));
  return `var(--pc-${p}, ${PLATFORM_COLORS[p] ?? "#71717a"})`;
}
