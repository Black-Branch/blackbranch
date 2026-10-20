import type { CommandNode } from "../../commands/spec.ts";

// What @owner/commands resolves to when this install has no owner folder: no commands beyond the site's own.
export const chatCommands: readonly CommandNode[] = [];
