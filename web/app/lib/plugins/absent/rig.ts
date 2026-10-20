import type { RigAvatar } from "../types.ts";

// What @owner/rig resolves to when this install has no owner folder (or its folder has no rig.ts):
// no avatar of its own, so the rig page draws the product's default one.
export const rigAvatar: RigAvatar | null = null;
