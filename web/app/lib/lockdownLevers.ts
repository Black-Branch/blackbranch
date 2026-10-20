// The lockdown's levers, as data both the route and the panel read. Pure.

/** The platforms whose chat ingest can be paused (v147). The site's own chat is never one. */
export const INGEST_PLATFORMS = ["twitch", "youtube", "kick", "streamplace"] as const;
export type IngestPlatform = (typeof INGEST_PLATFORMS)[number];

/** The expiry choices: none · 15 min · 1 hour · until the stream ends (only while one is live) ·
 *  a custom moment. */
export const LOCKDOWN_EXPIRY = [
  { key: "none", label: "No expiry" },
  { key: "15", label: "15 min" },
  { key: "60", label: "1 hour" },
  { key: "stream", label: "Until the stream ends" },
  { key: "custom", label: "Custom…" },
] as const;
export type ExpiryChoice = (typeof LOCKDOWN_EXPIRY)[number]["key"];

/** The route's longest expiry: 7 days. */
const MAX_MINUTES = 7 * 24 * 60;

/** The request fields a choice sends, or why it cannot be sent. `customAt` is the custom moment
 *  (a datetime-local value); `live` whether a stream is live now. */
export function expiryBody(choice: ExpiryChoice, opts: { customAt?: string; live?: boolean; now?: number } = {}):
  { expiresInMinutes: number | null } | { untilStreamEnd: true } | { error: string } {
  const now = opts.now ?? Date.now();
  switch (choice) {
    case "none": return { expiresInMinutes: null };
    case "15": return { expiresInMinutes: 15 };
    case "60": return { expiresInMinutes: 60 };
    case "stream": return opts.live ? { untilStreamEnd: true } : { error: "No stream is live." };
    case "custom": {
      const at = opts.customAt ? Date.parse(opts.customAt) : NaN;
      if (Number.isNaN(at)) return { error: "Pick a date and time." };
      const minutes = Math.ceil((at - now) / 60_000);
      if (minutes < 1) return { error: "Pick a moment in the future." };
      if (minutes > MAX_MINUTES) return { error: "At most 7 days ahead." };
      return { expiresInMinutes: minutes };
    }
  }
}
