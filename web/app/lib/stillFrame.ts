// A still first frame of an image that may animate, so animated badges pause
// too. Site badges are uploaded images — GIF / animated WebP
// data URLs — with no provider still, and CSS cannot pause an <img>. So the
// first frame is drawn to a canvas ONCE per URL and cached for the page's
// life; every row showing that badge shares it. Cross-origin images taint the
// canvas (toDataURL throws) and simply keep animating.
import { useSyncExternalStore } from "react";

/** Can this image animate at all? GIF, WebP and AVIF can (animated AVIF badges
 *  exist). PNG (APNG is rare here), JPEG and SVG badges are left alone — drawing
 *  them would cost a decode for nothing. A same-origin path counts too: site
 *  badges are served from /api/badges/image/<id>/<hash>.<ext>, with the
 *  extension sniffed from the bytes (badgeImage.ts), and same-origin never taints the canvas.
 *  @test-only production calls it from useStillFrame in this same file; exported so stills.test.ts can pin which images get a drawn frame */
export function mayAnimate(url: string): boolean {
  return /^data:image\/(?:gif|webp|avif)[;,]/i.test(url) || /^(?:https?:\/\/|\/)[^?#]+\.(?:gif|webp|avif)(?:[?#].*)?$/i.test(url);
}

const frames = new Map<string, string | null>(); // url → PNG data URL, or null (not stillable)
const started = new Set<string>();
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };

function draw(url: string) {
  if (started.has(url) || typeof document === "undefined") return;
  started.add(url);
  const img = new Image();
  img.decoding = "async";
  img.onload = () => {
    try {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth || 1;
      c.height = img.naturalHeight || 1;
      c.getContext("2d")?.drawImage(img, 0, 0);
      frames.set(url, c.toDataURL("image/png"));
    } catch {
      frames.set(url, null);
    }
    notify();
  };
  img.onerror = () => { frames.set(url, null); notify(); };
  img.src = url;
}

function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

/** The still frame to show instead of `url` while stills are on, or `url`
 *  itself (not animatable, not drawn yet, stills off, or failed). */
export function useStillFrame(url: string, still: boolean): string {
  const want = still && mayAnimate(url);
  const frame = useSyncExternalStore(
    subscribe,
    () => { if (want) draw(url); return want ? frames.get(url) : undefined; },
    () => undefined,
  );
  return frame ?? url;
}
