// What the install's plugin adds to the site as a whole — read through `@owner/site`
// (app/(owner)/site.ts, or ./absent/site.ts with no owner folder).
import type { MetadataRoute } from "next";
import { manifestShortcuts, rigOverlays } from "@owner/site";
import type { RigOverlays } from "../overlayDirectory.ts";

/** Long-press shortcuts on the installed app's icon, from the plugin (none without one). */
export const MANIFEST_SHORTCUTS: NonNullable<MetadataRoute.Manifest["shortcuts"]> = manifestShortcuts;

/** The overlay files OBS loads from disk on the streaming PC, from the plugin (none without one). */
export const RIG_OVERLAYS: RigOverlays = rigOverlays;
