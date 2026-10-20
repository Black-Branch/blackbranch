/**
 * Deterministic per-username color tokens.
 *
 * One hash function so a given name maps to the same hue everywhere it's shown
 * without a custom color — live-chat avatar, Matrix avatar, and user card.
 * A second implementation anywhere gives the same user different colors in
 * different views.
 */
export function hashHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

/** Avatar fallback background fill (shown when there's no profile picture). */
export function avatarBg(name: string): string {
  return `hsl(${hashHue(name)}, 45%, 45%)`;
}

/** Username text color fallback (when no custom username color is set). */
export function usernameColor(name: string): string {
  return `hsl(${hashHue(name)}, 55%, 68%)`;
}
