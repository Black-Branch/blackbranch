import type { MetadataRoute } from "next";
import { installValue } from "@/app/lib/installValues";

// Stable public content pages only — the home/watch surface plus the
// human-facing About and Terms/Privacy pages (the latter is also the OAuth
// consent-screen home/privacy URL). Auth, settings, mod, billing-return, and
// the OBS overlay/popout routes are intentionally excluded (see robots.ts).
// Request time: the addresses are this install's (nothing is prerendered).
export const dynamic = "force-dynamic";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = installValue("site.origin");
  return [
    { url: `${base}/`, changeFrequency: "daily", priority: 1 },
    { url: `${base}/about`, changeFrequency: "monthly", priority: 0.6 },
    { url: `${base}/legal`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/community`, changeFrequency: "weekly", priority: 0.7 },
  ];
}
