import { installValue } from "./installValues.ts";

// The install's VOD playlist (install key platform.youtube.vodPlaylist, env YOUTUBE_VOD_PLAYLIST),
// as this install sets it. Universal: the server reads the playlist through it and Home
// decides whether a VODs card exists at all.
//
// No default on purpose: a built-in playlist is somebody else's broadcasts on a fresh install's
// front page. Unset or "none" = this install has no VODs, and nothing about VODs is shown.

/** This install's VOD playlist id, or null when it has none. */
export function vodPlaylist(raw: string = installValue("platform.youtube.vodPlaylist")): string | null {
  const v = raw.trim();
  return v && v.toLowerCase() !== "none" ? v : null;
}
