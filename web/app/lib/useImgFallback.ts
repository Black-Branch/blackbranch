"use client";

import { useCallback, useState } from "react";

// A picture that is missing or fails shows the coloured letter circle (Discord's), never the
// browser's broken-image icon. `onError` alone cannot promise that: an image whose request failed
// BEFORE React attached its handler — a server-rendered <img> whose 404 landed while the JS was
// still loading, or a cached 404 that settles before commit — fires its error event into nothing.
// So the hook also reads the image the moment its ref attaches: `complete && naturalWidth === 0`
// is an image that has finished and has no pixels. An image still loading (`complete` false) is
// left to its own load/error events.
//
// The suspicion is confirmed with `decode()` where the browser has it: a picture with no
// intrinsic width (an SVG without width/height) also reports naturalWidth 0 in some browsers, and
// decode() resolves for that and rejects only for an image that is really broken.

type ImgFallback = {
  /** Show the picture; false = show the letter circle. */
  ok: boolean;
  /** Attach to the <img>: catches a picture that failed before React listened. */
  ref: (img: HTMLImageElement | null) => void;
  /** Attach to the <img>'s onError. */
  onError: () => void;
};

/** An <img> that has already finished loading with no pixels (or null/unset). */
function imgAlreadyFailed(img: HTMLImageElement | null): img is HTMLImageElement {
  return !!img && !!img.getAttribute("src") && img.complete && img.naturalWidth === 0;
}

/** Call `fail` if `img` has already failed (confirmed by decode() where the browser has it). */
export function checkImgFailed(img: HTMLImageElement | null, fail: () => void): void {
  if (!imgAlreadyFailed(img)) return;
  if (typeof img.decode === "function") img.decode().catch(fail);
  else fail();
}

/**
 * Picture-or-letter state for one <img>. `resetKey` is the picture's identity (its src or
 * version): a new one is tried again after a failure — an avatar change gets its chance.
 */
export function useImgFallback(resetKey?: unknown): ImgFallback {
  // The key that failed, not a boolean: a failure belongs to one picture, and a new key is
  // `ok` again on the very render that brings it (no reset effect, no stale frame).
  const [failed, setFailed] = useState<{ key: unknown } | null>(null);
  const ok = !(failed && Object.is(failed.key, resetKey));
  const onError = useCallback(() => setFailed({ key: resetKey }), [resetKey]);
  const ref = useCallback((img: HTMLImageElement | null) => checkImgFailed(img, onError), [onError]);
  return { ok, ref, onError };
}
