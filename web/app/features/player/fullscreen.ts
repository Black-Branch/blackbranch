// Every fullscreen request the player makes, as ONE promise whatever the engine returns.
//
// Engines differ in three ways, and the player met each of them:
//  · the standard methods return a Promise — but a Mac Safari has returned nothing, so `.catch`
//    on the result threw (`requestFullscreen().catch is not a function`);
//  · older WebKit has only the `webkit`-prefixed names (request, exit and the current element);
//  · an iPhone has no element fullscreen at all, only the video's own `webkitEnterFullscreen`.
// A refusal (rejected promise or a synchronous throw) resolves false and never escapes.

/** The parts of `document` the helper reads. */
type FullscreenDoc = {
  fullscreenElement?: Element | null;
  webkitFullscreenElement?: Element | null;
  exitFullscreen?: () => unknown;
  webkitExitFullscreen?: () => unknown;
};
/** The element that goes fullscreen (the player's frame). */
type FullscreenTarget = {
  requestFullscreen?: () => unknown;
  webkitRequestFullscreen?: () => unknown;
};
/** The video — the iPhone fallback. */
type FullscreenVideo = { webkitEnterFullscreen?: () => unknown };

// Promise.resolve adopts a real promise and wraps anything else, so `undefined` is a success.
function settle(call: () => unknown): Promise<boolean> {
  try {
    return Promise.resolve(call()).then(() => true, () => false);
  } catch {
    return Promise.resolve(false);
  }
}

/** Leave fullscreen if the page is in it, else enter it. Resolves whether the engine took the request. */
export function toggleFullscreen(
  doc: FullscreenDoc,
  target: FullscreenTarget | null,
  // `object`: an HTMLVideoElement's types do not name the webkit method this reads.
  videoEl: object | null,
): Promise<boolean> {
  const video = videoEl as FullscreenVideo | null;
  if (doc.fullscreenElement || doc.webkitFullscreenElement) {
    if (doc.exitFullscreen) return settle(() => doc.exitFullscreen!());
    if (doc.webkitExitFullscreen) return settle(() => doc.webkitExitFullscreen!());
    return Promise.resolve(false);
  }
  if (target?.requestFullscreen) return settle(() => target.requestFullscreen!());
  if (target?.webkitRequestFullscreen) return settle(() => target.webkitRequestFullscreen!());
  if (video?.webkitEnterFullscreen) return settle(() => video.webkitEnterFullscreen!());
  return Promise.resolve(false);
}
