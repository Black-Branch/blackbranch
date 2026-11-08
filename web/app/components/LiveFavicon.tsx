"use client";

import { useLiveFavicon } from "@/app/lib/useLiveFavicon";

/** The red dot on the tab icon while the stream is live. Renders nothing; mounted once, in the
 *  root layout's first commit (useLiveFavicon.ts says why). */
export default function LiveFavicon() {
  useLiveFavicon();
  return null;
}
