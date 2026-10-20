import { normalizePlatform } from "@/app/lib/nativePlatform";
// Brand glyphs for chat platforms — single source for anywhere a platform needs
// an icon. The COLORS live in lib/platformColors.ts (core needs them too); they
// are re-exported here so existing component-side imports are unchanged.

export { PLATFORM_COLORS } from "@/app/lib/platformColors";


const PATHS: Record<string, string> = {
  twitch:
    "M4 2 2 6v14h5v3h3l3-3h4l5-5V2H4Zm14 11-3 3h-4l-3 3v-3H5V4h13v9ZM13 7h2v5h-2V7ZM8 7h2v5H8V7Z",
  youtube:
    "M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.4.6A3 3 0 0 0 .5 6.2 31.6 31.6 0 0 0 0 12a31.6 31.6 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.6 9.4.6 9.4.6s7.5 0 9.4-.6a3 3 0 0 0 2.1-2.1A31.6 31.6 0 0 0 24 12a31.6 31.6 0 0 0-.5-5.8ZM9.6 15.6V8.4L15.8 12l-6.2 3.6Z",
  kick:
    "M4 2h6v5h2V5h2V2h6v7h-2v2h-2v2h2v2h2v7h-6v-3h-2v-2h-2v5H4V2Z",
  tiktok:
    "M19.6 7.3a5.7 5.7 0 0 1-3.4-1.1 5.7 5.7 0 0 1-2.1-3.5h-3.7v13a2.9 2.9 0 1 1-2.9-2.9c.3 0 .6 0 .9.1V9.1a6.6 6.6 0 0 0-.9-.1 6.6 6.6 0 1 0 6.6 6.6v-5.7a9.3 9.3 0 0 0 5.5 1.8V7.3Z",
  discord:
    "M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.3.5a15 15 0 0 1 4.3 2.1 14 14 0 0 0-12.8 0A15 15 0 0 1 11 3.5L10.6 3a19.8 19.8 0 0 0-4.9 1.4C2.6 9 1.8 13.4 2.2 17.8a19.9 19.9 0 0 0 6 3l1.2-1.7a13 13 0 0 1-2-1l.5-.4a14.2 14.2 0 0 0 12.2 0l.5.4a13 13 0 0 1-2 1l1.2 1.7a19.9 19.9 0 0 0 6-3c.5-5.1-.8-9.4-3.5-13.4ZM9.1 15.1c-1.2 0-2.1-1.1-2.1-2.4 0-1.3.9-2.4 2.1-2.4 1.2 0 2.2 1.1 2.1 2.4 0 1.3-.9 2.4-2.1 2.4Zm5.8 0c-1.2 0-2.1-1.1-2.1-2.4 0-1.3.9-2.4 2.1-2.4 1.2 0 2.2 1.1 2.1 2.4 0 1.3-.9 2.4-2.1 2.4Z",
  // streamplace uses the official full-color mark (public/streamplace.svg),
  // rendered below — it is not a single currentColor path like the others.
  native:
    "M6 3h4v14h8v4H6V3Z",
  // Not a platform — the featured-streamer source in the player bar. Two people,
  // which is what "community" means here: someone else's stream, hosted by us.
  community:
    "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm0 1.6c-3 0-6 1.5-6 3.4V20h12v-4c0-1.9-3-3.4-6-3.4Zm7.5-1.6a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm.5 1.6c-.6 0-1.2.1-1.7.2 1.3.9 2.2 2 2.2 3.2v4h4v-3.6c0-1.8-2.6-3.8-4.5-3.8Z",
  // Donation sources — simple monochrome approximations (swap for official SVGs
  // anytime). Ko-fi = mug, Patreon = bar+circle, Streamlabs = rounded square+smile.
  kofi:
    "M4 5h11v8a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V5Zm11 2v4h1.5a2 2 0 0 0 0-4H15Z",
  patreon:
    "M2 3h3.2v18H2V3Zm12.4 0a6.4 6.4 0 1 0 0 12.8 6.4 6.4 0 0 0 0-12.8Z",
  streamlabs:
    "M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Zm2.5 9a3.5 3.5 0 0 0 7 0h-7Z",
  // Element (the Matrix client) — a circle with the four-bar pinwheel cut out
  // (an approximation like the donation marks; swap for the official SVG anytime).
  element:
    "M12 1a11 11 0 1 0 0 22 11 11 0 0 0 0-22ZM6.25 7h5.5a1.25 1.25 0 0 1 0 2.5h-5.5a1.25 1.25 0 0 1 0-2.5Zm9.5-1.5a1.25 1.25 0 0 1 1.25 1.25v5.5a1.25 1.25 0 0 1-2.5 0v-5.5a1.25 1.25 0 0 1 1.25-1.25Zm-3.5 9h5.5a1.25 1.25 0 0 1 0 2.5h-5.5a1.25 1.25 0 0 1 0-2.5ZM8.25 10.5a1.25 1.25 0 0 1 1.25 1.25v5.5a1.25 1.25 0 0 1-2.5 0v-5.5a1.25 1.25 0 0 1 1.25-1.25Z",
};

export default function PlatformIcon({
  platform,
  size = "1em",
  className,
}: {
  platform: string;
  size?: number | string;
  className?: string;
}) {
  // stream.place ships an official full-color, multi-path SVG (magenta, layered
  // opacity) that can't render as a single currentColor path. Serve it as an
  // asset so the dev can swap the file without touching this component. Sized
  // like the inline glyphs (em or px) and center-aligned for inline contexts.
  if (platform === "streamplace") {
    const dim = typeof size === "number" ? `${size}px` : size;
    return (
      <img
        src="/streamplace.svg"
        alt=""
        aria-hidden="true"
        className={className}
        style={{ width: dim, height: dim, display: "inline-block", verticalAlign: "middle", objectFit: "contain" }}
      />
    );
  }

  const d = PATHS[String(normalizePlatform(platform))];
  if (!d) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d={d} fillRule="evenodd" />
    </svg>
  );
}
