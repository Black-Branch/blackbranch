import type { MetadataRoute } from "next";
import { installValue } from "@/app/lib/installValues";
import { siteName } from "@/app/lib/siteName";
import { siteIcon } from "@/app/lib/siteIcons";
import { MANIFEST_SHORTCUTS } from "@/app/lib/plugins/site";

// The install prompt's manifest (/manifest.webmanifest), generated from the install keys so it
// names this install's site and stream. Request time: every value is this install's (nothing is
// prerendered).
export const dynamic = "force-dynamic";

export default function manifest(): MetadataRoute.Manifest {
  const name = siteName();
  return {
    id: "/",
    name,
    short_name: installValue("site.shortName") || name,
    description: installValue("site.description") || `${name} — a live stream and its community.`,
    start_url: "/",
    display: "standalone",
    background_color: "#08080a",
    theme_color: "#0c1020",
    // An install's plugin may add long-press shortcuts (app/lib/plugins/site.ts); none without one.
    ...(MANIFEST_SHORTCUTS.length ? { shortcuts: MANIFEST_SHORTCUTS } : {}),
    icons: [
      { src: siteIcon("icon-192.png"), sizes: "192x192", type: "image/png" },
      { src: siteIcon("icon-512.png"), sizes: "512x512", type: "image/png" },
      { src: siteIcon("icon-maskable-512.png"), sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
