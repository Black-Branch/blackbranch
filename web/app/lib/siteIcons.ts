import { installValue } from "./installValues.ts";

// The install's icons (install key site.iconSet, env SITE_ICON_SET). Universal: the layout, the
// manifest and the player's media-session artwork read it.
//
// The key names a FOLDER under public/ holding the icon files by fixed names. On a bundled install
// that folder is the box's own /opt/blackbranch/site-files/, mounted read-only into the image at
// public/site-files (SITE_ICON_SET=/site-files) — an install's files never have to be in the image.
// Unset = the product's own set in public/brand/ (the product's mark). A value that is not a
// plain absolute path (a URL, "..", a query) is not a folder this site serves, and falls back to
// the neutral set rather than linking somewhere else.

export type SiteIconFile = "icon.png" | "icon-192.png" | "icon-512.png" | "icon-maskable-512.png" | "apple-touch-icon.png";

/** The icon folder's path with no trailing slash ("" = the site root). */
function iconBase(raw: string): string {
  const v = raw.trim();
  if (!v || !/^\/[A-Za-z0-9/_-]*$/.test(v) || v.includes("//")) return "/brand";
  return v.replace(/\/+$/, "");
}

/** The URL of one of the install's icon files. `raw` = the site.iconSet value (default: this install's). */
export function siteIcon(file: SiteIconFile, raw: string = installValue("site.iconSet")): string {
  return `${iconBase(raw)}/${file}`;
}

/** The product's own favicon.ico, linked only while the install uses the product's set: an
 *  operator's folder is asked for the five PNGs above and nothing else, so it is never linked to
 *  a file it may not hold (and a site whose folder is the root keeps its head exactly as it was). */
export function productFavicon(raw: string = installValue("site.iconSet")): string | null {
  return iconBase(raw) === "/brand" ? "/brand/favicon.ico" : null;
}

/** The product's mark (the Admin Panel and setup page headers) — always the product's, whatever
 *  icons the install itself uses. */
export const PRODUCT_MARK = "/brand/mark.png";
