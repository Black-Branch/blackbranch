// How an m.video message renders.
//
// Synapse ignores Range on media downloads, so there is no cheap "just the
// first frame": any preload fetches the WHOLE file. Bridged events do not
// carry info.thumbnail_url either, so a poster image is not available. Hence
// three modes:
//
//   loop    — a Discord "gif" (tenor/klipy MP4s). mautrix-discord marks them
//             with info["fi.mau.loop"] / info["fi.mau.gif"]; Discord shows
//             them silent, looping, with no controls, and so do we. They are
//             small (median ~140 KB), so downloading them up front is fine.
//   preview — a plain video small enough to download for its first frame,
//             or an encrypted one (already fully downloaded to decrypt it).
//   click   — everything else: the grey box with controls, nothing fetched
//             until play is pressed.

export type VideoPlaybackMode = "loop" | "preview" | "click";

/** A plain video at or under this size shows a first-frame preview. Measured
 *  plain videos ran 0.2–2.5 MB, median 0.76.
 *  @test-only exported so videoPlayback.test.ts can pin the cap's edge
 *  (inclusive at the cap, click-to-play one byte over) without a copied literal. */
export const PREVIEW_MAX_BYTES = 3 * 1024 * 1024;

export function videoPlaybackMode(info: Record<string, unknown> | undefined, encrypted: boolean): VideoPlaybackMode {
  if (info?.["fi.mau.loop"] === true || info?.["fi.mau.gif"] === true) return "loop";
  if (encrypted) return "preview";
  const size = info?.size;
  return typeof size === "number" && size <= PREVIEW_MAX_BYTES ? "preview" : "click";
}
