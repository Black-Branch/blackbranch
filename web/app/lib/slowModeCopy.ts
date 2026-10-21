// What the slow-mode controls say, by where the setting is copied. Today only Twitch takes a copy
// (platformMod/twitch.ts setSlowModeOnTwitch, 3–120 s there), and only on an install with a Twitch
// channel; everywhere else the setting is the site's own. Pure (slowModeCopy.test.ts).

/** Where slow mode is copied on this install: the platform labels, [] = nowhere. */
export function slowModeMirrors(v: { twitchBroadcasterId: string | null }): string[] {
  return v.twitchBroadcasterId ? ["Twitch"] : [];
}

/** The line under the presets. */
export function slowModeHint(site: string, mirrors: readonly string[]): string {
  return mirrors.includes("Twitch")
    ? `Applies to ${site} chat for non-mods and is copied to Twitch (3–120s there).`
    : `Applies to ${site} chat for non-mods.`;
}

/** The note after a change. */
export function slowModeNote(seconds: number, mirrors: readonly string[]): string {
  const copied = mirrors.length ? ` (copied to ${mirrors.join(" and ")})` : "";
  return seconds > 0 ? `Slow mode set to ${seconds}s${copied}.` : `Slow mode off${copied}.`;
}
