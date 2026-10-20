// The rig page's avatar slot — read from the install's plugin through `@owner/rig`
// (app/(owner)/rig.ts, or ./absent/rig.ts when there is none). Null = the product's default
// avatar.
import { rigAvatar } from "@owner/rig";
import type { RigAvatar } from "./types.ts";

export const OWNER_RIG_AVATAR: RigAvatar | null = rigAvatar;
