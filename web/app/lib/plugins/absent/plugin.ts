import type { WebPlugin } from "../types.ts";

// What @owner/plugin resolves to when this install has no owner folder (next.config.ts and
// tsconfig.json fall back to this file): no contributions.
export const ownerPlugin: WebPlugin | null = null;
