import type { MetadataRoute } from "next";
import { installValue } from "@/app/lib/installValues";

// Public site — allow crawling, point at the sitemap. Keep API, the chat
// window, the OBS overlay directory, the popout and the mod and admin pages out of the
// index (they're not content pages).
// Request time: the sitemap address is this install's (nothing is prerendered).
export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/chat", "/overlay", "/popout", "/mod", "/admin"],
    },
    sitemap: `${installValue("site.origin")}/sitemap.xml`,
    host: installValue("site.origin"),
  };
}
