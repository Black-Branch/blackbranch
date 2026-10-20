// The colour a name wears in the site chat — one derivation for the chat row and for the
// terminal's chat, so the username colours work in both. Native users carry a validated
// site colour or a member tint; platform names use only the platform's own per-user colour (Twitch
// isMember does not reliably mean "subscriber"). Readable on the dark theme (readableColor). Null =
// no colour of its own: the chat paints the viewer's fallback, the terminal its own palette.
import { PLATFORM_COLORS } from "./platformColors.ts";
import { readableColor } from "./colors.ts";
import { isNativePlatform, normalizePlatform } from "./nativePlatform.ts";

export function chatNameColor(m: { platform: string; usernameColor?: string | null; isMember?: boolean }): string | null {
  const native = isNativePlatform(m.platform);
  const own = native
    ? (m.usernameColor ?? (m.isMember ? PLATFORM_COLORS[normalizePlatform(m.platform)] ?? "#71717a" : null))
    : (m.usernameColor ?? null);
  return own == null ? null : readableColor(own);
}
