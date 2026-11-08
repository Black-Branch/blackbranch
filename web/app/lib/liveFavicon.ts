// The tab icon wears a small red dot while the stream is live (ticket #190).
//
// Drawn in the browser from the icon the page already links (whatever the install's icon set
// serves, an uploaded one included), never a second baked file. The page's own <link rel="icon">
// keeps its original address in data-plain-href while it shows the dotted copy, so ending the
// stream puts the exact original back. useLiveFavicon.ts is the React side.
//
// Pure apart from the DOM passed in, so liveFavicon.test.ts runs it in Node: the dot is painted
// into raw RGBA pixels rather than with canvas drawing calls, which Node has no implementation of.

import type { PublicSnapshot } from "./platformLiveness.generated.mjs";

export type LiveState = "live" | "offline" | "unknown";

/** Live when any platform is live; offline when every platform the snapshot names has no
 *  broadcast (offline or only scheduled); unknown otherwise (nothing reported yet, a platform not
 *  read, or the reports went silent). Unknown changes nothing on the page. */
export function liveStateOf(snap: PublicSnapshot): LiveState {
  const states = Object.values(snap.platforms).map((p) => p?.state);
  if (states.includes("live")) return "live";
  if (states.length > 0 && states.every((s) => s === "offline" || s === "upcoming")) return "offline";
  return "unknown";
}

/** The dot's colour and its ring's: the ring keeps a red dot readable on a red or light icon. */
const RED = [235, 32, 38] as const;
const RING = [12, 16, 32] as const;

/** Where the dot sits on a `size`-pixel square icon: bottom-right, about 28 % of the icon wide,
 *  with a dark ring of one pixel at 32 px (scaled with the icon).
 *  @test-only exported so liveFavicon.render.test.ts checks the pixels against the same geometry;
 *  paintLiveDot below is its runtime reader. */
export function dotGeometry(size: number): { cx: number; cy: number; r: number; ring: number } {
  const ring = Math.max(1, Math.round(size / 32));
  const r = size * 0.14;
  const c = size - r - ring;
  return { cx: c, cy: c, r, ring };
}

/** Paints the dot over `data`, the RGBA pixels of a `size` x `size` image, in place. Edges are
 *  blended over a pixel's width so the dot is round at 16 px, not a staircase.
 *  @test-only exported so liveFavicon.render.test.ts paints raw pixels in Node (no canvas there);
 *  dottedIcon below is its runtime caller. */
export function paintLiveDot(data: Uint8ClampedArray, size: number): void {
  const { cx, cy, r, ring } = dotGeometry(size);
  const outer = r + ring;
  const x0 = Math.max(0, Math.floor(cx - outer - 1));
  const y0 = Math.max(0, Math.floor(cy - outer - 1));
  for (let y = y0; y < size; y++) {
    for (let x = x0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const cover = Math.min(1, Math.max(0, outer + 0.5 - d));
      if (cover <= 0) continue;
      const red = Math.min(1, Math.max(0, r + 0.5 - d));
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) {
        const ink = RING[c]! + (RED[c]! - RING[c]!) * red;
        data[i + c] = data[i + c]! * (1 - cover) + ink * cover;
      }
      data[i + 3] = data[i + 3]! * (1 - cover) + 255 * cover;
    }
  }
}

/** The page's tab icons (rel="icon" and "shortcut icon"; never the apple-touch-icon, which is
 *  the home-screen picture and is not shown in a tab). */
export function iconLinks(doc: Document): HTMLLinkElement[] {
  return Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'));
}

/** Swaps every tab icon to its dotted copy (`dotted` answers an icon's original address with the
 *  dotted copy's, or null when it could not be drawn: that icon is left as it is). True when
 *  every icon wears the dot. `wanted` is asked again once the drawing is done: a stream that
 *  ended meanwhile must not get its dot back. */
export async function showLiveIcons(
  doc: Document, dotted: (href: string) => Promise<string | null>, wanted: () => boolean = () => true,
): Promise<boolean> {
  const links = iconLinks(doc);
  const done = await Promise.all(links.map(async (el) => {
    const plain = el.dataset.plainHref ?? el.getAttribute("href");
    if (!plain) return false;
    const url = await dotted(plain);
    if (!url || !wanted()) return false;
    el.dataset.plainHref = plain;
    el.setAttribute("href", url);
    return true;
  }));
  return links.length > 0 && done.every(Boolean);
}

/** Puts every tab icon back to the address the page linked. */
export function showPlainIcons(doc: Document): void {
  for (const el of iconLinks(doc)) {
    const plain = el.dataset.plainHref;
    if (plain === undefined) continue;
    el.setAttribute("href", plain);
    delete el.dataset.plainHref;
  }
}

const drawn = new Map<string, string>();

/** The dotted copy of one icon, as a PNG data address; null when the icon cannot be loaded or
 *  read (a failure is not remembered, so the next live report tries again). Browser only. */
export function dottedIcon(href: string): Promise<string | null> {
  const hit = drawn.get(href);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const size = 64;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, size, size);
        const px = ctx.getImageData(0, 0, size, size);
        paintLiveDot(px.data, size);
        ctx.putImageData(px, 0, 0);
        const url = canvas.toDataURL("image/png");
        drawn.set(href, url);
        resolve(url);
      } catch {
        resolve(null); // a cross-origin icon taints the canvas: keep the plain one
      }
    };
    img.onerror = () => resolve(null);
    img.src = href;
  });
}
