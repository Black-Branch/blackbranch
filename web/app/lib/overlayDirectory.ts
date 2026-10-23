import { installValue } from "./installValues.ts";

// The overlay directory: every OBS browser source, and the exact string OBS is
// given for each. Three kinds of home, because that is where the sources live:
//   site        — a page of this web app under /overlay/… (the page IS the app,
//                 so names render with chat's real style engine)
//   stream-api  — served by stream-api itself, public, reachable on the same
//                 host the radio and the chat socket use
//   rig         — an HTML file OBS loads from disk on the streaming PC: an
//                 install's own files, listed by its site plugin (RigOverlays)
// overlayDirectory.test.ts pins each entry to its home: a site page that
// exists, a PUBLIC GET on the route surface.

export type OverlaySource = {
  id: string;
  name: string;
  /** One line: what is on screen. */
  shows: string;
  served: "site" | "stream-api" | "rig";
  /** site: the path under this origin · stream-api: the path on its host · rig: the file name. */
  path: string;
  /** Recommended browser-source size, or how it sizes. */
  size: string;
  notes?: string;
  status: "live" | "retiring";
};

/** Files OBS loads from disk on the streaming PC — an install's own, so they come from the site
 *  plugin (app/lib/plugins/site.ts): the folder (absolute — OBS's Local file field does not expand
 *  `~`) and the sources in it. A public install has none. */
export type RigOverlays = { dir: string; sources: OverlaySource[] };

/** The public stream-api host (install key site.apiOrigin). */
const STREAM_API_PUBLIC = installValue("site.apiOrigin");

export const OVERLAY_SOURCES: OverlaySource[] = [
  {
    id: "rig",
    name: "Rig page",
    shows: "The bot's voice and the sound alerts (into the OBS mix), its avatar, and scene switching.",
    served: "site",
    path: "/overlay/rig?key=…",
    size: "1920×1080. Tick “Control audio via OBS”; Page permissions “Advanced access to OBS”.",
    notes: "Its address carries this site's key: copy it from Admin Panel → Utility → OBS, which also shows whether it is connected.",
    status: "live",
  },
  {
    id: "chat",
    name: "Chat",
    shows: "Live chat, newest at the bottom, transparent behind. It always follows the feed.",
    served: "site",
    path: "/overlay/chat?scale=1.5",
    size: "Any — ?scale= multiplies the text (0.5–4, default 1.5).",
    notes: "Its look is tuned with the gear on the page itself, separately from the site chat.",
    status: "live",
  },
  {
    id: "credit",
    name: "Credit line",
    shows: "“This stream is made possible by”: the rotating sponsor credit, styled like chat names.",
    served: "site",
    path: "/overlay/credit",
    size: "800×600 (the design space scales with the source width; widen it for a long name).",
    status: "live",
  },
  {
    id: "poll",
    name: "Poll",
    shows: "The current poll and its live tallies.",
    served: "stream-api",
    path: "/overlay/poll",
    size: "As the card: try 600×400.",
    status: "live",
  },
  {
    id: "sticker",
    name: "Sticker",
    shows: "Sticker sends and boosts, as they land.",
    served: "stream-api",
    path: "/overlay/sticker",
    size: "Full canvas: 1920×1080.",
    status: "live",
  },
  // The generic money overlays, served by stream-api like the poll and the sticker, driven by the
  // same socket frames. The meter's page is the owner's module (a finance table outside the
  // product), so it never moves on a standard install and is not listed.
  {
    id: "alert",
    name: "Alerts",
    shows: "Each tip, subscription and gift as a pop-up alert on stream.",
    served: "stream-api",
    path: "/overlay/alert",
    size: "Full canvas: 1920×1080.",
    status: "live",
  },
  {
    id: "support-bar",
    name: "Support bar",
    shows: "The stream's support bar, filling as support comes in.",
    served: "stream-api",
    path: "/overlay/support-bar",
    size: "Full canvas: 1920×1080.",
    status: "live",
  },
  {
    id: "bubble",
    name: "Support bubble",
    shows: "The reminder bubble that asks viewers to support the stream.",
    served: "stream-api",
    path: "/overlay/bubble",
    size: "Full canvas: 1920×1080.",
    status: "live",
  },
];

/** The string OBS is given: a URL for a served source (site paths against
 *  `origin`), the full file path for a rig file (in `rigDir`). */
export function sourceHref(s: OverlaySource, origin: string, rigDir = ""): string {
  if (s.served === "site") return origin + s.path;
  if (s.served === "stream-api") return STREAM_API_PUBLIC + s.path;
  return `${rigDir}/${s.path}`;
}
