// mxc:// → proxied HTTP URL helpers (extracted from MatrixShared.tsx — audit
// C1/B2 — so components like Avatar can use them without importing the whole
// message-row module). Both route through the app's authenticated media proxy.
//
// An mxc reaching here is user-influenced (a federated server's upload answer, a profile field), and
// the server and media id are pasted into a same-origin path — so each builder parses with the
// strict MXC_RE (alphanumeric-bounded server, plain media id) and returns null for anything else.
// A bare `startsWith("mxc://")` let `mxc://../..\..\api\x` become a same-origin /api GET.

import { MXC_RE } from "./matrixHtml.ts";

/** The (server, media id) of a well-formed mxc URL, or null. */
function mxcParts(mxcUrl: string | null | undefined): [string, string] | null {
  const m = typeof mxcUrl === "string" ? MXC_RE.exec(mxcUrl) : null;
  return m && m[1] && m[2] ? [m[1], m[2]] : null;
}

export function mxcToHttp(mxcUrl: string | null | undefined, size = 40): string | null {
  const parts = mxcParts(mxcUrl);
  if (!parts) return null;
  const [server, mediaId] = parts;
  return `/api/matrix/media/thumbnail/${server}/${mediaId}?width=${size}&height=${size}&method=crop`;
}

/** The profile BANNER and every inline chat image: a scale thumbnail at
 *  Synapse's 800×600 configured size, never the download. A phone upload can
 *  be 6000×4000 (24 MP); decoding that during the account card's entry starves
 *  the raster threads for the whole slide, and the panel's background fills
 *  in tile by tile with no animation. 800×600 scale → an 800×533 JPEG, 41 KB.
 *  `method=crop` at the strip's own aspect returns a 32×32 image — Synapse's
 *  crop sizes are tiny — so scale is mandatory. A GIF banner freezes to its
 *  first frame (accepted). Synapse keeps only its default thumbnail sizes
 *  (crops at 32/96, scales at 320×240 / 640×480 / 800×600), so a
 *  400 crop request serves a 96×96 square; this is the largest aspect-true
 *  thumbnail it will serve. */
export function mxcToScaled(mxcUrl: string | null | undefined): string | null {
  const parts = mxcParts(mxcUrl);
  if (!parts) return null;
  const [server, mediaId] = parts;
  return `/api/matrix/media/thumbnail/${server}/${mediaId}?width=800&height=600&method=scale`;
}

export function mxcToDownload(mxcUrl: string | null | undefined): string | null {
  const parts = mxcParts(mxcUrl);
  if (!parts) return null;
  const [server, mediaId] = parts;
  return `/api/matrix/media/download/${server}/${mediaId}`;
}

/** What a banner <img> should load NEXT after `currentSrc` failed: the full
 *  download when the thumbnail failed, nothing when the download did. Synapse
 *  refuses to thumbnail anything over its `max_image_pixels` (32 MP by
 *  default) — an 8192×4320 upload 404s at every thumbnail size while the
 *  download stays 200, which would show a broken icon. The
 *  download is the floor, not the fix: it is the 24–35 MP decode the thumbnail
 *  exists to keep out of the card's entry. `currentSrc` is the element's
 *  resolved absolute url, so this matches on the path, not on equality. */
function bannerFallbackSrc(currentSrc: string, mxcUrl: string | null | undefined): string | null {
  if (!currentSrc.includes("/api/matrix/media/thumbnail/")) return null;
  return mxcToDownload(mxcUrl);
}

/** The scaled <img>'s onError: swap to the download once, then hide — a sized
 *  <img> with alt="" still paints the broken-image icon in Chrome, so hiding
 *  is what lets the gradient underneath be the failure state. Typed on the
 *  two members it touches so the decision is testable without a DOM. */
export function onScaledError(img: { src: string; style: { display: string } }, mxcUrl: string | null | undefined): void {
  const next = bannerFallbackSrc(img.src, mxcUrl);
  if (next) img.src = next;
  else img.style.display = "none";
}
