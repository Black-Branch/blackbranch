// Which HLS implementation to play with, what an HLS failure means, and where
// the playlist lives.
//
// WHY THIS IS A PURE MODULE. Both decisions are easy to get wrong as inline
// branches in StreamplaceThinPlayer, where a source scan reads them as correct
// and no test can see what a browser actually answers:
//
// Chromium answers "maybe" to canPlayType("application/vnd.apple.mpegurl") —
//    on desktop Linux as well as Android. Testing canPlayType BEFORE
//    Hls.isSupported() would send every Chromium viewer down the native branch
//    and never import hls.js; only Firefox, which answers "", would fall
//    through to hls.js.
//
// stream.place's getLivePlaylist answers 404 {"message":"StreamNotLive"} once
//    the broadcast is over, which must read as "the stream ended" — not as
//    "Playback isn't reachable from this network right now", which blames the
//    viewer's network.

export type HlsImpl = "mse" | "native" | "none";

/**
 * Which HLS implementation to play with.
 *
 * ORDER IS THE WHOLE POINT, and it is the order hls.js's own README uses:
 * MSE first, native second. `canPlayType` is not a statement of support you can
 * act on — Chromium says "maybe" and then plays nothing useful — so it is
 * consulted only where MSE is genuinely unavailable (Safari / iOS).
 */
export function chooseHlsImpl(env: { mseSupported: boolean; nativeSupported: boolean }): HlsImpl {
  if (env.mseSupported) return "mse";
  if (env.nativeSupported) return "native";
  return "none";
}

/**
 * What an HLS failure means.
 *
 * A 404 on the MANIFEST is stream.place saying the broadcast is over, not a
 * network the viewer can do anything about. Null — the probe itself failed — is
 * deliberately "failed": an answer we could not read must never be reported to
 * the viewer as a clean ending, which would hide a real outage behind
 * "Stream has ended".
 */
export function hlsFailureKind(manifestStatus: number | null): "ended" | "failed" {
  return manifestStatus === 404 ? "ended" : "failed";
}

/**
 * stream.place's HLS master playlist — the embed's "regular", non-low-latency
 * path. CORS-open and it accepts the public channel handle, so no proxy is
 * needed; hls.js (or Safari natively) can point straight at it.
 *
 * The media element loading this URL is governed by `media-src`, NOT
 * `connect-src`. next.config.ts must list this origin there or the native path
 * is refused with "Media load rejected by URL safety check" —
 * playerApiReach.test.ts derives the origin from this function and asserts it.
 */
export function hlsPlaylistUrl(channel: string): string {
  return `https://stream.place/xrpc/place.stream.playback.getLivePlaylist?streamer=${encodeURIComponent(channel)}`;
}
