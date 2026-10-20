import type { MetadataRoute } from "next";
import type { RigOverlays } from "../../overlayDirectory.ts";

// What @owner/site resolves to when this install has no owner folder: nothing added to the site's
// installable app.
export const manifestShortcuts: NonNullable<MetadataRoute.Manifest["shortcuts"]> = [];

/** No files on a streaming PC: the overlay directory lists only what the site and stream-api serve. */
export const rigOverlays: RigOverlays = { dir: "", sources: [] };
